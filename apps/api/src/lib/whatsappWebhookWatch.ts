// СТОРОЖ «ВЕБХУК WHATSAPP ЗАМОЛЧАЛ» (15.11.2026, В4 владельца: сверка «сообщение
// не дошло до CRM» нужна и для WhatsApp).
//
// ПОЧЕМУ НЕ СВЕРКА, КАК У MESSENGER. У WhatsApp Cloud API нет ящика входящих:
// ФАКТ (developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks):
// «The WhatsApp Business Platform uses webhooks to inform you of incoming messages»;
// ни метода «список входящих», ни истории переписки в Graph нет. Сверить одно
// сообщение не с чем — поэтому сторож смотрит на поток целиком.
//
// ЧТО ЛОВИТ. Рабочие часы, канал включён, а входящих WhatsApp нет дольше обычного
// (обычное — самая длинная пауза между входящими в рабочие часы за 7 дней, ×1,5,
// не меньше 3 и не больше 8 часов). Тогда раз в 6 часов — тревога руководству в
// «Здоровье системы» с причиной, которую видно из Graph: номер не подключён,
// маркер не читает номер, приложение не подписано на кабинет WhatsApp — или «номер
// жив, подписка есть, а сообщений нет: проверьте адрес вебхука».
//
// ЧЕГО НЕ ЛОВИТ (честно). Потерю ОТДЕЛЬНЫХ сообщений при живом потоке; тишину
// ночью (политика ночи не меняется) и в первые часы спокойного дня; второй номер
// при живом первом (поток считается по каналу целиком). Людям пушей не шлёт:
// кому отвечать — неизвестно, сообщений-то нет.
import { prisma } from "../db.js";
import { GRAPH_VERSION, isMetaChannelEnabled, loadCredentials } from "../messengers/meta.js";
import { resolveIncomingAccount } from "../messengers/accounts.js";
import { DUSHANBE_OFFSET_MS, dushanbeWallClock, isWithinDushanbeWindow } from "./dushanbeTime.js";
import { logSystemError } from "./systemError.js";

export const WA_SILENCE_MIN_MS = 3 * 60 * 60_000;
export const WA_SILENCE_MAX_MS = 8 * 60 * 60_000;
export const WA_SILENCE_FACTOR = 1.5;
/** Меньше входящих за неделю — «обычного» не знаем, тишину не судим (не врём тревогой). */
export const WA_MIN_HISTORY_MESSAGES = 20;
const HISTORY_MS = 7 * 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const ALARM_WINDOW_MS = 6 * 60 * 60_000;

export interface WorkWindow {
  start: string;
  end: string;
}

/** Момент начала рабочего окна в день (по Душанбе), которому принадлежит `at`. */
export function workStartOf(at: Date, window: WorkWindow): Date {
  const wall = dushanbeWallClock(at);
  const [h, m] = window.start.split(":").map(Number);
  return new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), h ?? 0, m ?? 0) - DUSHANBE_OFFSET_MS);
}

/**
 * Самая длинная тишина в рабочие часы за историю: между двумя входящими одного дня
 * (или от начала окна до первого входящего дня), если конец паузы — в рабочие часы.
 * Ночь не считается. Чистая функция.
 */
export function longestWorkGapMs(times: readonly Date[], window: WorkWindow): number {
  const sorted = [...times].map((t) => t.getTime()).sort((a, b) => a - b);
  let longest = 0;
  for (let i = 0; i < sorted.length; i++) {
    const at = new Date(sorted[i]!);
    if (!isWithinDushanbeWindow(window.start, window.end, at)) continue;
    const dayStart = workStartOf(at, window).getTime();
    const prev = i > 0 ? sorted[i - 1]! : null;
    const from = prev !== null && prev >= dayStart ? prev : dayStart;
    longest = Math.max(longest, sorted[i]! - from);
  }
  return longest;
}

/** Порог тишины: обычная пауза ×1,5 в пределах [3 ч; 8 ч]. */
export function silenceThresholdMs(usualGapMs: number): number {
  return Math.min(WA_SILENCE_MAX_MS, Math.max(WA_SILENCE_MIN_MS, Math.round(usualGapMs * WA_SILENCE_FACTOR)));
}

/** Сколько длится тишина в рабочие часы сегодня: ночь до начала окна не в счёт. */
export function workSilenceMs(lastInbound: Date | null, now: Date, window: WorkWindow): number {
  const start = workStartOf(now, window).getTime();
  const from = Math.max(lastInbound?.getTime() ?? 0, start);
  return Math.max(0, now.getTime() - from);
}

export type GraphGet = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
const defaultGet: GraphGet = (url) => fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

/** Почему может молчать: живость номера и подписка приложения, только чтение Graph. Ключ в текст не попадает. */
export async function diagnoseWhatsappNumber(input: { phoneId: string; token: string; businessAccountId: string | null },
  get: GraphGet = defaultGet): Promise<string> {
  const base = `https://graph.facebook.com/${GRAPH_VERSION}`;
  const auth = `access_token=${encodeURIComponent(input.token)}`;
  try {
    const res = await get(`${base}/${encodeURIComponent(input.phoneId)}?fields=status,quality_rating&${auth}`);
    const body = (await res.json()) as { status?: string; error?: { code?: number } };
    if (!res.ok || body.error) return `маркер WhatsApp не читает номер (код Meta ${body.error?.code ?? "?"}) — проверьте маркер в Настройках → Каналы`;
    if (body.status && body.status !== "CONNECTED") return `номер WhatsApp не подключён у Meta (состояние ${body.status})`;
  } catch {
    return "Meta не ответила на проверку номера — сеть или Graph недоступны";
  }
  if (!input.businessAccountId) return "номер подключён; кабинет WhatsApp не известен CRM, подписку приложения проверить не удалось";
  try {
    const res = await get(`${base}/${encodeURIComponent(input.businessAccountId)}/subscribed_apps?${auth}`);
    const body = (await res.json()) as { data?: unknown[]; error?: { code?: number } };
    if (!res.ok || body.error) return `номер подключён, подписку приложения прочитать не удалось (код Meta ${body.error?.code ?? "?"})`;
    if (!body.data?.length) return "приложение НЕ подписано на кабинет WhatsApp — Meta не шлёт вебхуки; нужна подписка (subscribed_apps)";
  } catch {
    return "номер подключён, Meta не ответила на проверку подписки";
  }
  return "номер подключён и приложение подписано, а сообщений нет — проверьте адрес вебхука в панели Meta и доступность сервера";
}

/** Входящие WhatsApp за неделю: реплики клиентов в переписках + отметки вебхука (на случай записи позже). */
async function inboundTimes(now: Date): Promise<Date[]> {
  const from = new Date(now.getTime() - HISTORY_MS);
  const rows = await prisma.$queryRaw<Array<{ at: Date }>>`
    SELECT (m.elem ->> 'at')::timestamptz AS "at"
    FROM "BotConversation" c,
      jsonb_array_elements(CASE WHEN jsonb_typeof(c."messages")='array' THEN c."messages" ELSE '[]'::jsonb END) AS m(elem)
    WHERE c."channel"='WHATSAPP' AND c."lastMessageAt" >= ${from}
      AND m.elem ->> 'role'='user' AND m.elem ->> 'at' ~ '^\\d{4}-\\d{2}-\\d{2}T'
      AND (m.elem ->> 'silentCapture') IS DISTINCT FROM 'true'
      AND (m.elem ->> 'at')::timestamptz >= ${from} AND (m.elem ->> 'at')::timestamptz <= ${now}
    UNION ALL
    SELECT p."createdAt" AS "at" FROM "ProcessedMessage" p WHERE p."channel"='WHATSAPP' AND p."createdAt" >= ${from} AND p."createdAt" <= ${now}`;
  return rows.map((r) => r.at).filter((d) => d instanceof Date && !Number.isNaN(d.getTime()));
}

export interface WhatsappWatchResult {
  skipped: "off" | "channel_off" | "not_configured" | "off_hours" | "little_history" | null;
  silenceMs: number;
  thresholdMs: number;
  alarmed: boolean;
}

/** Тик крона. Никогда не бросает наружу ничего, кроме сбоя базы. */
export async function runWhatsappWebhookWatch(now: Date = new Date(), get: GraphGet = defaultGet): Promise<WhatsappWatchResult> {
  const result: WhatsappWatchResult = { skipped: null, silenceMs: 0, thresholdMs: 0, alarmed: false };
  const s = await prisma.settings.findUnique({ where: { id: "singleton" },
    select: { whatsappWebhookWatchEnabled: true, workHoursStart: true, workHoursEnd: true, metaWaBusinessAccountId: true } });
  if (!(s?.whatsappWebhookWatchEnabled ?? true)) return { ...result, skipped: "off" };
  if (!(await isMetaChannelEnabled("WHATSAPP"))) return { ...result, skipped: "channel_off" };
  const creds = await loadCredentials();
  // Маркер номера — из «Каналов» (MessengerAccount), запасной — из Настроек; как у шаблонов WhatsApp.
  const token = creds.waPhoneId ? (await resolveIncomingAccount("WHATSAPP", creds.waPhoneId)).token || creds.waToken : undefined;
  if (!creds.waPhoneId || !token) return { ...result, skipped: "not_configured" };
  const window: WorkWindow = { start: s?.workHoursStart ?? "09:30", end: s?.workHoursEnd ?? "18:00" };
  if (!isWithinDushanbeWindow(window.start, window.end, now)) return { ...result, skipped: "off_hours" };

  const times = await inboundTimes(now);
  if (times.length < WA_MIN_HISTORY_MESSAGES) return { ...result, skipped: "little_history" };
  const last = times.reduce<Date | null>((a, b) => (!a || b > a ? b : a), null);
  result.thresholdMs = silenceThresholdMs(longestWorkGapMs(times, window));
  result.silenceMs = workSilenceMs(last, now, window);
  if (result.silenceMs < result.thresholdMs) return result;

  const cause = await diagnoseWhatsappNumber({ phoneId: creds.waPhoneId, token,
    businessAccountId: s?.metaWaBusinessAccountId ?? null }, get);
  const hours = (ms: number) => (ms / 3_600_000).toFixed(1).replace(".", ",");
  void logSystemError("meta",
    `WhatsApp молчит: в рабочие часы нет ни одного входящего уже ${hours(result.silenceMs)} ч (обычно пауза не дольше ` +
      `${hours(result.thresholdMs / WA_SILENCE_FACTOR)} ч). Клиенты могут писать, а CRM их не видит. Проверка: ${cause}.`,
    { dedupKey: "whatsapp-webhook-silent", dedupWindowMs: ALARM_WINDOW_MS });
  result.alarmed = true;
  return result;
}

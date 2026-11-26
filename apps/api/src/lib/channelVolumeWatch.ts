import { prisma } from "../db.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { raiseCriticalAlarm } from "./channelKeyAlarm.js";
import { CLIENT_WAITING_LEADERSHIP } from "./clientWaitingAlert.js";
import { dushanbeWallClock } from "./dushanbeTime.js";
import { isMetaChannelEnabled } from "../messengers/meta.js";

/**
 * КАНАЛ ЗАТИХ — ТРЕВОГА РУКОВОДСТВУ (24.11.2026, ужесточена 26.11.2026 по независимому ревью).
 *
 * ЗАЧЕМ. Поток обращений в Instagram 22.11 упал с 10–18 новых диалогов в день до 2,
 * Facebook с 5–8 до 0. Сообщения могли просто перестать доходить до CRM. Сторожа
 * «клиент ждёт ответа» (lib/clientWaitingAlert.ts) этого не видят: им нужна реплика
 * клиента, а её нет. Здесь сравниваем число НОВЫХ диалогов канала за последние 8 часов
 * со средним за то же окно суток за предыдущие 7 дней.
 *
 * КОГДА ТРЕВОГА (все условия сразу):
 *  1. за все 8 часов ноль новых диалогов;
 *  2. среднее за 7 прошлых окон не меньше WATCH_MIN_AVERAGE;
 *  3. ноль и в окне, сдвинутом на час назад: то есть и прошлый часовой запуск тоже видел ноль.
 *     Это «два запуска подряд» без памяти процесса: берётся из той же базы, переживает выкат;
 *  4. канал включён и настроен (isMetaChannelEnabled), а у Instagram не все включённые
 *     аккаунты закрыты Meta (accessLostAt): об этом тревога уже есть, причина известна.
 * WhatsApp здесь НЕ смотрим: его сторожит lib/whatsappWebhookWatch.ts и называет причину
 * (одна дверь, две тревоги были бы нарушением).
 *
 * КОГДА МОЛЧИМ. Ночью (до 10:00 и с 22:00 по Душанбе) поток пуст всегда. В субботу и
 * воскресенье по Душанбе не тревожим вовсе: поток ниже обычного. Праздники сторож не знает.
 *
 * ПОВТОР: одна тревога на канал не чаще раза в WATCH_ALERT_EVERY_MS через общую дверь
 * `raiseCriticalAlarm` (замок базы + окно по tag): перезапуск и несколько серверов не дублируют.
 *
 * РУБИЛЬНИК: тот же `notifyClientWaitingEnabled` (Настройки → автоматика), что у сторожей
 * «клиент ждёт ответа»: одно семейство уведомлений. Сторож только читает базу и пишет
 * руководству, клиентам ничего не шлёт.
 */

export const WATCHED_CHANNELS = ["INSTAGRAM", "FACEBOOK"] as const;
export const WATCH_WINDOW_HOURS = 8;
export const WATCH_BASELINE_DAYS = 7;
/**
 * Порог средней за окно. ПОДОБРАН БЕЗ ЗАМЕРА (данные прода читать без «да» владельца нельзя):
 * по ревью при средней ровно 3 ложных тревог около 10% в сутки на канал, поэтому взято 5.
 * СВЕРИТЬ ПО ПРОДУ, когда владелец разрешит.
 */
export const WATCH_MIN_AVERAGE = 5;
/** Повтор тревоги по каналу не чаще (чуть меньше суток: «раз в день»). СВЕРИТЬ по проду вместе с порогом. */
export const WATCH_ALERT_EVERY_MS = 20 * 60 * 60_000;
const DAY_FROM_HOUR = 10;
const DAY_TO_HOUR = 22;

/**
 * Чистое решение: тревожить ли по каналу. `baselineTotal` — сумма за 7 прошлых суток,
 * `previous` — новых диалогов в окне, сдвинутом на час назад (что видел прошлый запуск).
 */
export function channelVolumeVerdict(current: number, baselineTotal: number, previous = 0): { alert: boolean; average: number } {
  const average = baselineTotal / WATCH_BASELINE_DAYS;
  const alert = current === 0 && previous === 0 && average >= WATCH_MIN_AVERAGE;
  return { alert, average };
}

/** Днём по Душанбе: ночью поток пуст всегда, и тревога была бы ложной. */
export function isChannelWatchHour(at: Date = new Date()): boolean {
  const hour = dushanbeWallClock(at).getUTCHours();
  return hour >= DAY_FROM_HOUR && hour < DAY_TO_HOUR;
}

/** Будни по Душанбе (понедельник–пятница): в выходные поток ниже обычного, тревога была бы ложной. */
export function isChannelWatchDay(at: Date = new Date()): boolean {
  const weekday = dushanbeWallClock(at).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

type VolumeRow = { channel: string; cur: bigint | number; prev: bigint | number; past: bigint | number };

const HOUR_MS = 60 * 60_000;

/** Instagram: все включённые аккаунты закрыты Meta (accessLostAt) — причина известна, тревога об этом уже есть. */
async function instagramAllAccountsLost(): Promise<boolean> {
  const accounts = await prisma.messengerAccount.findMany({
    where: { channel: "INSTAGRAM", enabled: true },
    select: { accessLostAt: true },
    take: 200,
  });
  return accounts.length > 0 && accounts.every((a) => a.accessLostAt !== null);
}

export async function runChannelVolumeWatchTick(at: Date = new Date()): Promise<{ alerted: string[] }> {
  if (!isChannelWatchHour(at) || !isChannelWatchDay(at)) return { alerted: [] };
  // Прошлый часовой запуск тоже должен был работать (иначе «второго подряд» нет): первый час дня и понедельник утром молчим.
  const previousAt = new Date(at.getTime() - HOUR_MS);
  if (!isChannelWatchHour(previousAt) || !isChannelWatchDay(previousAt)) return { alerted: [] };
  if (!(await automationSwitchOn("notifyClientWaitingEnabled"))) return { alerted: [] };
  const windowSec = WATCH_WINDOW_HOURS * 3600;
  const spanSec = WATCH_BASELINE_DAYS * 86400 + windowSec;
  // elapsed — сколько секунд назад создан диалог. Сейчас: elapsed < окна. Окно прошлого запуска:
  // от часа до окна + часа. Прошлые сутки: elapsed от 24 ч до 7 суток + окно, остаток от деления на сутки < окна.
  const rows = await prisma.$queryRaw<VolumeRow[]>`
    SELECT "channel"::text AS channel,
      COUNT(*) FILTER (WHERE e < ${windowSec}) AS cur,
      COUNT(*) FILTER (WHERE e >= 3600 AND e < ${windowSec + 3600}) AS prev,
      COUNT(*) FILTER (WHERE e >= 86400 AND e < ${spanSec} AND (e % 86400) < ${windowSec}) AS past
    FROM (
      SELECT "channel", EXTRACT(EPOCH FROM (${at}::timestamp - "createdAt"))::bigint AS e
      FROM "BotConversation"
      WHERE "createdAt" > ${at}::timestamp - make_interval(secs => ${spanSec})
        AND "channel"::text = ANY(${[...WATCHED_CHANNELS]})
    ) t
    GROUP BY 1`;
  const alerted: string[] = [];
  for (const channel of WATCHED_CHANNELS) {
    const row = rows.find((r) => r.channel === channel);
    const { alert, average } = channelVolumeVerdict(Number(row?.cur ?? 0), Number(row?.past ?? 0), Number(row?.prev ?? 0));
    if (!alert) continue;
    // Намеренно выключенный или ненастроенный канал не тревожит; Instagram с закрытым доступом тоже.
    if (!(await isMetaChannelEnabled(channel))) continue;
    if (channel === "INSTAGRAM" && (await instagramAllAccountsLost())) continue;
    const { alerted: queued } = await raiseCriticalAlarm({
      tag: `channel-volume-${channel}`,
      title: `📉 ${channelName(channel)}: новых обращений нет`,
      body:
        `За последние ${WATCH_WINDOW_HOURS} ч новых диалогов нет, а обычно в это время около ${average.toFixed(1)}. ` +
        "Сообщения могли перестать доходить до CRM, или выключена реклама. Проверьте Настройки → Каналы.",
      url: "/settings?tab=channels",
      everyMs: WATCH_ALERT_EVERY_MS,
      quiet: true,
      recipientRoles: CLIENT_WAITING_LEADERSHIP,
      now: at,
    });
    if (queued) alerted.push(channel);
  }
  return { alerted };
}

function channelName(channel: string): string {
  return channel === "INSTAGRAM" ? "Instagram" : "Facebook";
}

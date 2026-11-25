/**
 * РУБИЛЬНИКИ И ГОТОВНОСТЬ КНОПКИ ЗВОНКА / ССЫЛКИ НА WHATSAPP (владелец 25.11.2026, ai/operator/contactButton.ts) — одно место
 * чтения. Сбой чтения — всё выключено: обычный текст лучше кнопки, по которой клиент звонит в пустоту.
 *
 * «Звонки готовы» — не догадка: сторож звонков (lib/whatsappCallingHealth.ts, раз в час) пишет `waCallingReadyAt`, когда Meta
 * говорит, что звонки и SIP у номера включены и номер AVAILABLE; выключили, заблокировали — поле гаснет. Отметка старше трёх
 * часов (сторож не отработал два раза подряд) — тоже «не готово».
 */
import { prisma } from "../db.js";
import type { ContactButtonPolicy } from "../ai/operator/contactButton.js";
import { isWithinWorkingHours } from "./workingHours.js";
import { logSystemError } from "./systemError.js";
import type { MetaGraphErrorFields } from "./metaSendBlock.js";

export const WA_CALLING_READY_FRESH_MS = 3 * 60 * 60_000;

export const CONTACT_BUTTONS_OFF: ContactButtonPolicy = { waCallButton: false, waCallReady: false, withinHours: false, igWhatsappLink: false, waNumber: null };

export async function loadContactButtonPolicy(now: Date = new Date()): Promise<ContactButtonPolicy> {
  try {
    const row = await prisma.settings.findUnique({ where: { id: "singleton" },
      select: { botWaCallButton: true, botIgWhatsappLink: true, metaWaDisplayPhone: true, waCallingReadyAt: true } });
    if (!row || (!row.botWaCallButton && !row.botIgWhatsappLink)) return CONTACT_BUTTONS_OFF;
    const readyAt = row.waCallingReadyAt?.getTime() ?? NaN;
    const waCallReady = Number.isFinite(readyAt) && now.getTime() - readyAt >= -60_000 && now.getTime() - readyAt <= WA_CALLING_READY_FRESH_MS;
    const digits = row.metaWaDisplayPhone?.replace(/\D/gu, "") ?? "";
    return { waCallButton: row.botWaCallButton === true, waCallReady,
      withinHours: row.botWaCallButton === true ? await isWithinWorkingHours(now).catch(() => false) : false,
      igWhatsappLink: row.botIgWhatsappLink === true, waNumber: /^\d{9,15}$/u.test(digits) ? digits : null };
  } catch {
    return CONTACT_BUTTONS_OFF;
  }
}

/** Тело запроса — сообщение с нашей кнопкой: звонок WhatsApp или шаблон с кнопкой-ссылкой wa.me. */
export function contactButtonKindOfBody(body: unknown): "voice_call" | "web_url" | null {
  if (!body || typeof body !== "object") return null;
  const interactive = Reflect.get(body, "interactive") as { type?: unknown } | undefined;
  if (Reflect.get(body, "type") === "interactive" && interactive?.type === "voice_call") return "voice_call";
  const payload = (Reflect.get(body, "message") as { attachment?: { payload?: { template_type?: unknown; buttons?: Array<{ type?: unknown; url?: unknown }> } } } | undefined)
    ?.attachment?.payload;
  return payload?.template_type === "button" && payload.buttons?.some(b => b.type === "web_url" && typeof b.url === "string" && b.url.startsWith("https://wa.me/"))
    ? "web_url" : null;
}

/**
 * Отказ не из-за кнопки — рубильник не трогаем: окно 24 ч закрыто (WhatsApp 131047, Instagram/Messenger 10/2534022), сообщение
 * этому человеку не доставить (WhatsApp 131026, 131021, лимит на человека 131049, эксперимент 130472; Instagram 551), ключ и
 * права (190, 102, 200, 10, 131005), частота (4, 17, 32, 613, 130429, 131056) — с такой ошибкой не ушёл бы и обычный текст.
 * Запрет по правилам и «переписку ведёт другое приложение» — флаг вызывающего (messengers/meta.ts, lib/metaEternalTokens.ts).
 */
const RECIPIENT_SIDE_CODES = new Set([131047, 131026, 131021, 131049, 130472, 551, 190, 102, 200, 10, 131005, 4, 17, 32, 613, 130429, 131056]);
const notAboutButton = (e: MetaGraphErrorFields) => (e.code !== null && RECIPIENT_SIDE_CODES.has(e.code)) || e.subcode === 2534022;

/**
 * ЗАЩИТА ПО УМОЛЧАНИЮ: Meta отклонила сообщение С КНОПКОЙ (4xx, не окно 24 ч, не запрет по правилам) — значит, номер или
 * аккаунт кнопку не принимает (звонки сняли, лимит номера, формат). Повтора тем же запросом нет (очередь ядра не шлёт
 * дважды), поэтому ответ этого хода потерян; чтобы он был единственным, рубильник выключается сам и в «Здоровье системы»
 * встаёт тревога с текстом Meta. Включает обратно человек, когда разберётся. Сбой записи — только журнал.
 */
export async function noteContactButtonRejection(body: unknown, status: number, error: MetaGraphErrorFields, notButtonReason: boolean): Promise<void> {
  const kind = contactButtonKindOfBody(body);
  if (!kind || status < 400 || status >= 500 || status === 429 || notButtonReason || notAboutButton(error)) return;
  const field = kind === "voice_call" ? "botWaCallButton" : "botIgWhatsappLink";
  const label = kind === "voice_call" ? "Кнопка «Позвонить» в WhatsApp" : "Ссылка на WhatsApp из Instagram и Facebook";
  try {
    const changed = await prisma.settings.updateMany({ where: { id: "singleton", [field]: true }, data: { [field]: false } });
    if (changed.count === 0) return;
    await logSystemError("meta", `[alarm] ${label}: Meta отклонила сообщение с кнопкой (HTTP ${status}, код ${error.code ?? "?"}` +
      `${error.subcode ? `/${error.subcode}` : ""}${error.message ? `: ${error.message.slice(0, 200)}` : ""}). Рубильник выключен сам, бот пишет ` +
      "обычным текстом. Включите снова в Настройках → Бот, когда причина устранена.", { dedupKey: `contact-button-rejected:${kind}` });
  } catch (err) {
    console.error("[кнопка] рубильник не выключен после отказа Meta:", err instanceof Error ? err.message : err);
  }
}

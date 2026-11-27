import { mentionsJobSeeking } from "../ai/jobSeekerCall.js";
import { BW, EW } from "../ai/wordBoundary.js";
import { logSystemAudit } from "../lib/audit.js";
import { prisma } from "../db.js";
import { automationSwitchOn } from "../lib/automationSwitches.js";
import { staffLinkDeepLink } from "../lib/telegramAgentLink.js";
import { describeError } from "../lib/describeError.js";
import { logSystemError } from "../lib/systemError.js";
import { sendMessageWithButtons, type TelegramInlineButton } from "./api.js";

/**
 * TELEGRAM-БОТ ТОЛЬКО ДЛЯ СОТРУДНИКОВ (27.11.2026, владелец: «это теперь бот только для
 * сотрудников»; ФАКТ с прода: клиентов из Telegram за 60 дней — 0).
 *
 * Случай, с которого началось: учредитель с новой учёткой написал боту /start и получил
 * клиентское приветствие по-таджикски с кнопками «Смотреть объекты» / «Позвать агента» —
 * без единого пути к привязке. Пока рубильник «Telegram-бот только для сотрудников»
 * (Settings.telegramStaffOnlyEnabled) включён, незнакомый личный чат (не привязанный к
 * учётке и не в процессе привязки) получает эту памятку вместо клиентского диалога: ни
 * переписки, ни карточки клиента, ни заявки. Выключен — прежний путь байт в байт
 * (telegram/bot.ts зовёт этот модуль только при включённом рубильнике).
 *
 * Не чаще раза в 10 минут на чат (кроме /start): человек, отправивший пять сообщений
 * подряд, получит одну памятку, а не пять. Счётчик в памяти процесса — бот живёт в API.
 */
export async function telegramStaffOnlyOn(): Promise<boolean> {
  return automationSwitchOn("telegramStaffOnlyEnabled");
}

/**
 * ПАМЯТКА ВМЕСТО ДИАЛОГА — ТОЛЬКО НОВОМУ НЕЗНАКОМЦУ (защита от тихой потери, ревью #506).
 *
 * Прежним путём (запись в чат CRM, бот, оператор) при включённом рубильнике идут:
 *  - переписка с карточкой клиента: живой клиент агента, его сообщение обязано лечь в CRM;
 *  - любая переписка с активностью за последние 30 дней (последнее сообщение, правка,
 *    пауза бота под оператором, квалификация без карточки) — разговор уже идёт;
 *  - кандидат на работу: черновик с намерением «работа» или слова соискателя в сообщении
 *    («ищу работу», «кор ҳаст?») — анкета кандидата из Telegram не теряется.
 * Остальное — памятка, а каждое такое входящее записывается в журнал действий
 * (TELEGRAM_STAFF_ONLY_INBOUND, chatId и начало текста), чтобы его можно было найти.
 */
export const STAFF_ONLY_ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60_000;
const CANDIDATE_EXTRA = new RegExp(
  String.raw`${BW}(?:кор\s+(?:ҳаст|хаст|бор)|работ\p{L}*\s+(?:есть|ест)|есть\s+работ\p{L}*|ваканси\p{L}*\s+есть)${EW}`,
  "iu",
);

export function looksLikeCandidate(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  return mentionsJobSeeking(t) || CANDIDATE_EXTRA.test(t);
}

export async function staffOnlyGateApplies(chatId: string, text?: string | null, now = new Date()): Promise<boolean> {
  if (!(await telegramStaffOnlyOn())) return false;
  if (looksLikeCandidate(text)) return false;
  const conversation = await prisma.telegramConversation.findUnique({
    where: { chatId },
    select: { clientId: true, lastMessageAt: true, updatedAt: true, pausedUntil: true, botPausedAt: true, leadDraft: true },
  });
  if (!conversation) return true;
  if (conversation.clientId) return false;
  const since = now.getTime() - STAFF_ONLY_ACTIVE_WINDOW_MS;
  const recent = (d: Date | null) => d !== null && d.getTime() >= since;
  if (recent(conversation.lastMessageAt) || recent(conversation.updatedAt) || recent(conversation.botPausedAt)) return false;
  if (conversation.pausedUntil && conversation.pausedUntil.getTime() > now.getTime()) return false;
  if ((conversation.leadDraft as { intent?: unknown } | null)?.intent === "job") return false;
  return true;
}

/** Входящее незнакомца, получившего памятку: не теряем молча — строка в журнале действий. */
export function recordStaffOnlyInbound(chatId: string, info: { username?: string | null; text?: string | null; kind: "message" | "callback" }): void {
  logSystemAudit("TELEGRAM_STAFF_ONLY_INBOUND", "TelegramConversation", chatId, {
    kind: info.kind,
    ...(info.username ? { username: info.username } : {}),
    ...(info.text ? { text: info.text.slice(0, 500) } : {}),
  });
}

export const STAFF_ONLY_NOTICE_COOLDOWN_MS = 10 * 60_000;
const lastNoticeAt = new Map<string, number>();

/** Для тестов. */
export function resetStaffOnlyNoticeCooldown(): void {
  lastNoticeAt.clear();
}

function siteUrl(): string {
  return (process.env.SITE_PUBLIC_URL || "https://royalhome.tj").replace(/\/$/, "");
}

/** Текст памятки: по-таджикски и по-русски, на «шумо»/«вы», без длинного тире. */
export function staffOnlyNoticeText(withStaffButton: boolean): string {
  const site = siteUrl();
  const tgStaff = withStaffButton
    ? "Агар корманди Royal Home бошед, тугмаи «Я сотрудник»-ро пахш кунед ё дар CRM: Профил → «Личный чат с ботом CRM в Telegram» → «Привязать»."
    : "Агар корманди Royal Home бошед, дар CRM пайваст кунед: Профил → «Личный чат с ботом CRM в Telegram» → «Привязать».";
  const ruStaff = withStaffButton
    ? "Если вы сотрудник Royal Home, нажмите «Я сотрудник» или привяжите Telegram в CRM: Профиль → «Личный чат с ботом CRM в Telegram» → «Привязать»."
    : "Если вы сотрудник Royal Home, привяжите Telegram в CRM: Профиль → «Личный чат с ботом CRM в Telegram» → «Привязать».";
  return [
    "Ассалому алейкум! Ин боти кории Royal Home барои кормандон аст.",
    tgStaff,
    `Агар мизоҷ бошед, лутфан ба мо дар сомона нависед: ${site}`,
    "",
    "Здравствуйте! Это рабочий бот Royal Home для сотрудников.",
    ruStaff,
    `Если вы клиент, напишите нам на сайте: ${site}`,
  ].join("\n");
}

/**
 * Отправить памятку незнакомому чату. `force` — на /start (человек явно начал разговор).
 * Сбой отправки не роняет разбор апдейта: в журнал ошибок, клиентский путь не включается.
 */
export async function sendStaffOnlyNotice(chatId: string, opts: { force?: boolean; now?: number } = {}): Promise<"sent" | "throttled" | "failed"> {
  const now = opts.now ?? Date.now();
  const last = lastNoticeAt.get(chatId);
  if (!opts.force && last !== undefined && now - last < STAFF_ONLY_NOTICE_COOLDOWN_MS) return "throttled";
  lastNoticeAt.set(chatId, now);
  try {
    // Кнопка «Я сотрудник» — только когда привязка по номеру включена и имя бота известно:
    // иначе `/start staff` ответил бы «привязка по номеру выключена», и кнопка была бы пустой.
    const link = (await automationSwitchOn("telegramPhoneLinkEnabled")) ? await staffLinkDeepLink() : null;
    const buttons: TelegramInlineButton[][] = link ? [[{ text: "👤 Я сотрудник", url: link }]] : [];
    await sendMessageWithButtons(chatId, staffOnlyNoticeText(!!link), buttons);
    return "sent";
  } catch (err) {
    void logSystemError("telegram", `Памятка «бот только для сотрудников» не отправлена: ${describeError(err)}`, {
      dedupKey: "telegram-staff-only-notice-failed",
    });
    return "failed";
  }
}

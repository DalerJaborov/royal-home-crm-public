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
 * ПАМЯТКА ВМЕСТО ДИАЛОГА — ТОЛЬКО НЕЗНАКОМЦУ (защита от тихой потери).
 *
 * Переписка Telegram, уже привязанная к карточке клиента, — это живой клиент агента:
 * его новое сообщение обязано лечь в чат CRM, как раньше, иначе агент его не увидит
 * вовсе (Telegram второй раз не пришлёт). Поэтому такой чат идёт прежним путём даже при
 * включённом рубильнике; памятку получают только чаты без карточки клиента.
 */
export async function staffOnlyGateApplies(chatId: string): Promise<boolean> {
  if (!(await telegramStaffOnlyOn())) return false;
  const conversation = await prisma.telegramConversation.findUnique({ where: { chatId }, select: { clientId: true } });
  return !conversation?.clientId;
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

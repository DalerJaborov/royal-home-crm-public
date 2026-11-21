import {
  TelegramApiError,
  getChatMemberStatus,
  getChatTitle,
  probeChatAction,
  telegramMigratedChatId,
} from "../telegram/api.js";
import { describeError } from "./describeError.js";

/**
 * ОСМОТР ЧАТА TELEGRAM: «БОТ НА МЕСТЕ / ЧАТ ПЕРЕЕХАЛ / БОТА НЕТ / НЕ ЯСНО» (20.11.2026).
 *
 * Общий для двух сторожей: групп помощницы (assistantGroupWatchdog.ts) и чатов из Настроек — группы
 * комментариев канала, дополнительных чатов публикации, основного канала (settingsTelegramChatWatchdog.ts).
 * Сам ничего не меняет и в чат не пишет ни строки.
 *
 *  1. getChatMember о самом боте. «member»/«administrator»/«creator» — бот на месте.
 *  2. Отказ с parameters.migrate_to_chat_id (от ЛЮБОГО метода) — обычную группу превратили в супергруппу.
 *  3. Бот «left»/«kicked» — именно так Telegram отвечает по старому id переехавшей группы. Тогда, если вызывающий
 *     разрешил, спрашиваем sendChatAction: бота в чате нет, индикатор никто не увидит, а на переехавшую группу
 *     Telegram отвечает отказом с тем же параметром. Нет параметра — бота в чате правда нет.
 *  4. Сетевой сбой, таймаут, 429/5xx — «не ясно»: это не ответ Telegram про чат.
 */
export type TelegramChatVerdict =
  | { kind: "present" }
  | { kind: "migrated"; newChatId: string }
  | { kind: "absent"; detail: string }
  | { kind: "unknown"; detail: string };

/** Отказ, в котором Telegram ясно сказал «этого чата для бота нет»; всё прочее — сбой связи, не ответ про чат. */
const isDefiniteRefusal = (err: unknown): boolean =>
  err instanceof TelegramApiError && (err.errorCode === 400 || err.errorCode === 403 || err.errorCode === 404);

/**
 * Обычная (не супер-) группа: отрицательный id без префикса -100. Только такой чат вообще может переехать:
 * супергруппы и каналы (-100…, @username) не переезжают, личные чаты (положительный id) тоже.
 */
export function isBasicGroupChatId(chatId: string): boolean {
  return /^-\d+$/.test(chatId) && !chatId.startsWith("-100");
}

export interface InspectOptions {
  /**
   * Спрашивать ли sendChatAction, когда бот «left»/«kicked». Группы помощницы — всегда (как с 20.11); чаты из
   * Настроек — только обычные группы: каналы и супергруппы не переезжают, и слать им что-либо незачем.
   */
  probeWhenLeft?: boolean;
}

export async function inspectTelegramChat(chatId: string, options: InspectOptions = {}): Promise<TelegramChatVerdict> {
  const probeWhenLeft = options.probeWhenLeft ?? true;
  let status: string;
  try {
    status = (await getChatMemberStatus(chatId)).status;
  } catch (err) {
    const moved = telegramMigratedChatId(err);
    if (moved) return { kind: "migrated", newChatId: moved };
    return isDefiniteRefusal(err) ? { kind: "absent", detail: describeError(err) } : { kind: "unknown", detail: describeError(err) };
  }
  if (status !== "left" && status !== "kicked") return { kind: "present" };
  if (!probeWhenLeft) return { kind: "absent", detail: `статус бота «${status}»` };
  try {
    await probeChatAction(chatId);
    return { kind: "present" };
  } catch (err) {
    const moved = telegramMigratedChatId(err);
    if (moved) return { kind: "migrated", newChatId: moved };
    return isDefiniteRefusal(err) ? { kind: "absent", detail: `статус бота «${status}»: ${describeError(err)}` } : { kind: "unknown", detail: describeError(err) };
  }
}

/** Название чата для журнала; не узнали — «чат <id>», как и раньше у сторожа групп помощницы. */
export async function telegramChatLabel(chatId: string): Promise<string> {
  try {
    return (await getChatTitle(chatId)) ?? `чат ${chatId}`;
  } catch {
    return `чат ${chatId}`;
  }
}

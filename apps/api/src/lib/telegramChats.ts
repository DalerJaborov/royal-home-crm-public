/**
 * ДОПОЛНИТЕЛЬНЫЕ ЧАТЫ TELEGRAM (26.09.2026, «ролик уходит в несколько
 * Telegram-групп и каналов, а не в один»).
 *
 * Основной канал (`Settings.telegramChannelId`) работает ровно как раньше —
 * этот модуль только разбирает СВЕРХ него текстовое поле
 * `Settings.telegramExtraChatIds` (chat_id/@username через запятую, пробел
 * или перевод строки) в список валидных адресатов. Чистая функция, без
 * обращения к БД и без побочных эффектов — публикация и запись результатов
 * живут в lib/socialPublish.ts.
 */

/** Не бесконечный список — иначе одна публикация превращается в рассылку по
 *  всей записной книжке бота, и любой временный сбой одного чата держит
 *  публикацию основного канала минутами. */
export const TELEGRAM_EXTRA_CHATS_MAX = 20;

const USERNAME_RE = /^@[A-Za-z0-9_]{5,32}$/;
/** chat_id — целое число, каналы/группы Telegram отдают отрицательные вида
 *  -100xxxxxxxxxx, но формально годится любое целое (личные chat_id тоже
 *  числа). */
const NUMERIC_ID_RE = /^-?\d+$/;

/**
 * Разбирает текст поля «Дополнительные группы и каналы» в список chat_id/@username.
 *
 * - Разделители: запятая, пробел, перевод строки (`\s`, включая `\r\n`).
 * - Обрезает пробелы, убирает пустые и повторы (сравнение без учёта регистра —
 *   Telegram username регистронезависим, а числовой id сравнивается как текст).
 * - Отбрасывает то, что не похоже ни на `@username` ([A-Za-z0-9_]{5,32}), ни на
 *   целое число (в т.ч. отрицательное `-100…`) — молча: это чистая функция без
 *   журнала, невалидные строки просто не долетают до публикации.
 * - Исключает адрес, совпадающий с основным каналом (`mainChannelId`) — чтобы
 *   одна и та же публикация не задваивалась в собственный канал.
 * - Ограничивает результат `TELEGRAM_EXTRA_CHATS_MAX` записями.
 */
export function parseTelegramChatIds(raw: string | null | undefined, mainChannelId?: string | null): string[] {
  if (!raw) return [];
  const mainKey = mainChannelId?.trim().toLowerCase() || null;
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rawPart of raw.split(/[\s,]+/)) {
    const part = rawPart.trim();
    if (!part) continue;
    if (!USERNAME_RE.test(part) && !NUMERIC_ID_RE.test(part)) continue;

    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    if (mainKey && key === mainKey) continue;

    seen.add(key);
    result.push(part);
    if (result.length >= TELEGRAM_EXTRA_CHATS_MAX) break;
  }

  return result;
}

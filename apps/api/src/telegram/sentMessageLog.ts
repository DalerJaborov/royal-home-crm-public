/**
 * НОМЕРА СВОИХ СООБЩЕНИЙ В ЛИЧНЫХ ЧАТАХ (17.11.2026, «удали всё, что прислала»).
 *
 * Telegram Bot API не отдаёт историю чата: удалить своё бот может только по message_id, который
 * он получил в ответ на отправку, и только в пределах 48 часов (deleteMessage). Раньше номера
 * нигде не хранились. Теперь каждый успешный send* в ЛИЧНЫЙ чат (положительный chat_id; группы
 * и каналы отрицательные — их это не касается вовсе, решение владельца: в группе ничего не
 * меняем) записывается сюда, в память процесса. Переживает перезапуск через состояние диалога
 * помощницы (telegram/assistantBot.ts, payload.sent) — без миграции.
 */

export type SentEntry = {
  id: number;
  /** Когда отправлено, мс: старше 48 часов Telegram удалить не даст. */
  at: number;
};

export const TELEGRAM_DELETE_WINDOW_MS = 48 * 3600_000;
const MAX_PER_CHAT = 100;
const MAX_CHATS = 5_000;
const log = new Map<string, SentEntry[]>();

/** Личный чат с человеком: положительный числовой chat_id. */
export function isPrivateChatId(chatId: unknown): boolean {
  return (typeof chatId === "number" && Number.isSafeInteger(chatId) && chatId > 0)
    || (typeof chatId === "string" && /^[1-9]\d{0,19}$/.test(chatId));
}

function keep(chatId: string, entries: SentEntry[], now: number): void {
  const fresh = entries.filter((e) => now - e.at < TELEGRAM_DELETE_WINDOW_MS).slice(-MAX_PER_CHAT);
  log.delete(chatId);
  if (fresh.length === 0) return;
  log.set(chatId, fresh);
  // Самый старый чат уходит первым (Map хранит порядок вставки).
  while (log.size > MAX_CHATS) log.delete(log.keys().next().value as string);
}

export function noteSentMessage(chatId: unknown, messageId: unknown, now = Date.now()): void {
  if (!isPrivateChatId(chatId) || !Number.isSafeInteger(messageId) || (messageId as number) <= 0) return;
  const key = String(chatId);
  const entries = log.get(key) ?? [];
  if (entries.some((e) => e.id === messageId)) return;
  keep(key, [...entries, { id: messageId as number, at: now }], now);
}

/** Ответ send*: одно сообщение или альбом (sendMediaGroup). Сбой здесь не должен ронять отправку. */
export function noteSentResult(method: string, chatId: unknown, result: unknown, now = Date.now()): void {
  try {
    if (!/^(?:send[A-Z]\w*|copyMessage|forwardMessage)$/.test(method)) return;
    const items = Array.isArray(result) ? result : [result];
    for (const item of items) noteSentMessage(chatId, (item as { message_id?: unknown } | null)?.message_id, now);
  } catch {
    /* журнал отправленного — вспомогательный, отправку не трогает */
  }
}

/** Сохранённые в состоянии диалога номера (после перезапуска) — в общий журнал, с проверкой формы. */
export function mergeSentEntries(chatId: string, persisted: unknown, now = Date.now()): void {
  if (!isPrivateChatId(chatId) || !Array.isArray(persisted)) return;
  const known = log.get(chatId) ?? [];
  const extra = persisted.slice(-MAX_PER_CHAT).flatMap((raw) => {
    const e = raw as { id?: unknown; at?: unknown } | null;
    return e && Number.isSafeInteger(e.id) && (e.id as number) > 0 && typeof e.at === "number" && Number.isFinite(e.at)
      && !known.some((k) => k.id === e.id) ? [{ id: e.id as number, at: e.at }] : [];
  });
  keep(chatId, [...extra, ...known].sort((a, b) => a.at - b.at), now);
}

/** Свои сообщения этого чата, которые ещё можно удалить (младше 48 часов). */
export function deletableSentMessages(chatId: string, now = Date.now()): SentEntry[] {
  return (log.get(chatId) ?? []).filter((e) => now - e.at < TELEGRAM_DELETE_WINDOW_MS);
}

export function forgetSentMessages(chatId: string, ids: readonly number[], now = Date.now()): void {
  const drop = new Set(ids);
  keep(chatId, (log.get(chatId) ?? []).filter((e) => !drop.has(e.id)), now);
}

/** Для тестов. */
export function resetSentMessageLogForTests(): void {
  log.clear();
}

/**
 * АРХИВ ЧАТОВ (владелец 26.11.2026): переписка БЕЗ карточки клиента, в которой 30 дней нет новых сообщений,
 * не показывается в «Все / Ждут / Мои», а лежит в «Архиве».
 *
 * Ничего не удаляется и не переносится: архивность не хранится, её каждый раз считает запрос списка
 * (routes/conversations.ts, loadGroupedInboxRows) по этому одному правилу. Новое сообщение клиента двигает
 * `lastMessageAt` вперёд, и чат сам возвращается в основной список. С карточкой клиента чат не архивируется никогда.
 * Поиск (`q`) находит и архивные. Включает правило рубильник `chatArchiveEnabled` (по умолчанию ВКЛ).
 *
 * Срок — ровно 30 суток по 24 часа: разница двух моментов не зависит от часового пояса (Душанбе UTC+5 нужен
 * только там, где считаются календарные границы дня, а здесь их нет).
 */
export const CHAT_ARCHIVE_DAYS = 30;
const CHAT_ARCHIVE_MS = CHAT_ARCHIVE_DAYS * 24 * 60 * 60 * 1000;

/** Граница: всё, что тише этого момента (строго раньше), без карточки уходит в архив. */
export function chatArchiveCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - CHAT_ARCHIVE_MS);
}

/** То же правило над одной строкой: проверка согласованности с SQL и тесты границы. Ровно 30 суток — ещё не архив. */
export function isChatArchived(
  row: { clientId: string | null | undefined; lastActivityAt: Date },
  now: Date = new Date()
): boolean {
  return !row.clientId && row.lastActivityAt.getTime() < chatArchiveCutoff(now).getTime();
}

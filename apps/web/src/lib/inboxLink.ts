/**
 * Ссылка на диалог в разделе «Сообщения». Раздел открывает диалог по
 * `?open=<id>` (pages/Messages.tsx) и узнаёт Telegram по префиксу `tg_`
 * (TG_PREFIX в apps/api/src/lib/conversationId.ts).
 *
 * 23.09.2026, аудит №18: «Бот замолчал» и «Клиент ждёт агента» на пульте
 * вели на `?conversation=<id>`, которого раздел не читает, — открывался
 * самый свежий диалог, то есть чужой.
 */
export function inboxOpenHref(kind: "BOT" | "TELEGRAM", id: string): string {
  return `/messages?open=${kind === "TELEGRAM" ? `tg_${id}` : id}`;
}

/** Grouped detail for a known CRM client, keeping every linked source in one chat. */
export function inboxClientConversationId(clientId: string): string {
  return `client:${clientId}`;
}

export function inboxClientConversationHref(clientId: string): string {
  return `/messages?open=${encodeURIComponent(inboxClientConversationId(clientId))}`;
}

/**
 * Id диалога в общем инбоксе: Telegram с префиксом `tg_`, диалог бота как есть.
 * Так сервер понимает `conversationId` у отправки из карточки клиента, и вкладка
 * канала решает, КУДА уйдёт текст и голосовое (аудит 04.10.2026, WEB-PAGES01).
 */
export function inboxConversationId(channel: string, id: string): string {
  if (channel === "TELEGRAM") return `tg_${id}`;
  if (channel === "TELEGRAM_DIRECT") return `td_${id}`;
  return id;
}

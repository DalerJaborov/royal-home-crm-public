import { isMessagingWindowClosedFor, lastInboundAt, messagingWindowStateOfMessages } from "@royal-home/shared";
import type { ConversationMessage } from "../types";

/**
 * ЗАКРЫТОЕ ОКНО ПЕРЕПИСКИ — ПРЕДУПРЕЖДЕНИЕ ДО ОТПРАВКИ, А НЕ ПОСЛЕ.
 *
 * apps/api/src/lib/messagingWindow.ts узнаёт закрытое окно ПОСТФАКТУМ, по тексту
 * ошибки от Graph API — агент видит предупреждение только после того, как уже
 * напечатал и попытался отправить (владелец 22.08.2026, chat-баннер в
 * pages/Messages.tsx/MobileChatView.tsx). Здесь — то же ограничение платформы
 * (WhatsApp/Instagram/Messenger закрывают приём свободного текста через 24 часа
 * после последней реплики клиента), но посчитанное ЗАРАНЕЕ из уже загруженной
 * переписки: не нужен отдельный запрос, сообщения и их `at` уже на экране.
 *
 * ПОЧЕМУ ТОЛЬКО ЭТИ ТРИ КАНАЛА. Правило 24 часов — ограничение Meta (см. doc-блок
 * messagingWindow.ts на сервере с живыми ответами Graph API), у Telegram/Viber/VK
 * его нет: бот, однажды получивший сообщение, может писать туда когда угодно.
 * Незнакомый канал считается неограниченным намеренно — ложное «нельзя писать»
 * хуже молчаливой отправки, которая просто сработает.
 */
/** Момент последней реплики КЛИЕНТА (role="user") — максимум по времени, общее правило окна. */
export function lastInboundMessageAt(messages: ConversationMessage[]): string | null {
  return lastInboundAt(messages)?.toISOString() ?? null;
}

/**
 * Окно закрыто прямо сейчас? Правило одно с сервером (packages/shared): нет ни
 * одной отметки времени — «неизвестно», не блокируем, решит сервер при отправке.
 */
export function isMessagingWindowClosedForMessages(
  channel: string | null | undefined,
  messages: ConversationMessage[],
): boolean {
  return messagingWindowStateOfMessages(channel, messages) === "closed";
}

export function isMessagingWindowClosed(
  channel: string | null | undefined,
  lastInboundAt: string | null,
  now: Date = new Date(),
): boolean {
  return isMessagingWindowClosedFor(channel, lastInboundAt, now.getTime());
}

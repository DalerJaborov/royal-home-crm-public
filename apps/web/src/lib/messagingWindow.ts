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
const WINDOW_MS = 24 * 60 * 60 * 1000;
const WINDOWED_CHANNELS = new Set(["WHATSAPP", "INSTAGRAM", "FACEBOOK"]);

/** Момент последней реплики КЛИЕНТА (role="user") в уже загруженном списке сообщений. */
export function lastInboundMessageAt(messages: ConversationMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && m.at) return m.at;
  }
  return null;
}

/**
 * Окно закрыто прямо сейчас? `lastInboundAt: null` — клиент ни разу не писал (или
 * дата не сохранилась) — трактуем как «не наш случай», пусть решает сервер при
 * реальной отправке, а не гадаем здесь.
 */
export function isMessagingWindowClosed(
  channel: string | null | undefined,
  lastInboundAt: string | null,
  now: Date = new Date(),
): boolean {
  if (!channel || !WINDOWED_CHANNELS.has(channel)) return false;
  if (!lastInboundAt) return false;
  return now.getTime() - new Date(lastInboundAt).getTime() >= WINDOW_MS;
}

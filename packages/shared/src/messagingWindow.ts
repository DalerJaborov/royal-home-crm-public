/**
 * ОКНО ПЕРЕПИСКИ META (24 часа) — ОДНО ПРАВИЛО НА СЕРВЕР И ЭКРАН (21.11.2026).
 *
 * WhatsApp/Instagram/Messenger дают писать человеку свободным текстом только в
 * течение 24 часов после его последней реплики. Раньше правило считалось в
 * четырёх местах по-разному (экран пропускал реплики без времени, проверка
 * отправки считала «неизвестно» закрытым, кнопка первого сообщения брала
 * последнюю запись, а не самую позднюю) — кнопка говорила «окно открыто», а
 * отправка требовала шаблон. Теперь все зовут эти функции.
 *
 * Правила:
 *  - время последней РЕПЛИКИ КЛИЕНТА — максимум по времени среди его реплик с
 *    отметкой, а не последняя запись списка (порядок записей и времена могут
 *    разойтись, а у старых реплик отметки нет вовсе);
 *  - реплика, которая только что пришла и ещё не легла в переписку, передаётся
 *    отдельно (`justReceivedAt`) и тоже участвует в максимуме;
 *  - нет ни одной отметки — состояние «неизвестно», и оно НЕ блокирует: решает
 *    сама платформа, а её отказ не считается ошибкой системы;
 *  - считать надо в пределах одного нашего номера/аккаунта: окно у каждого своё.
 */
export const META_MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Каналы с 24-часовым правилом. У Telegram, чата на сайте и т. п. его нет. */
export const WINDOWED_CHANNELS: readonly string[] = ["WHATSAPP", "INSTAGRAM", "FACEBOOK"];

export type MessagingWindowState = "open" | "closed" | "unknown";

export interface WindowMessage {
  role?: string | null;
  at?: string | Date | null;
}

function toMs(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Самое позднее время реплики клиента; null — отметок времени нет. */
export function lastInboundAt(
  messages: readonly WindowMessage[],
  justReceivedAt?: string | Date | null,
): Date | null {
  let best: number | null = toMs(justReceivedAt);
  for (const m of messages) {
    if (m?.role !== "user") continue;
    const ms = toMs(m.at);
    if (ms !== null && (best === null || ms > best)) best = ms;
  }
  return best === null ? null : new Date(best);
}

export function messagingWindowState(
  channel: string | null | undefined,
  lastInbound: string | Date | null | undefined,
  now: number = Date.now(),
): MessagingWindowState {
  if (!channel || !WINDOWED_CHANNELS.includes(channel)) return "open";
  const ms = toMs(lastInbound);
  if (ms === null) return "unknown";
  return now - ms < META_MESSAGING_WINDOW_MS ? "open" : "closed";
}

/** Окно ТОЧНО закрыто. «Неизвестно» не блокирует. */
export function isMessagingWindowClosedFor(
  channel: string | null | undefined,
  lastInbound: string | Date | null | undefined,
  now: number = Date.now(),
): boolean {
  return messagingWindowState(channel, lastInbound, now) === "closed";
}

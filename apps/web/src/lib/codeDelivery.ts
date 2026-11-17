/**
 * Как человеку сказать, куда ушёл код входа / подтверждения (19.10.2026).
 *
 * Код сначала приходит ПУШЕМ на уже вошедший телефон с приложением; сервер ждёт
 * подтверждения доставки `fallbackAfterSec` секунд и, если его нет, сам шлёт СМС.
 * Таймер не доказывает доставку: СМС может отказать, и код уйдёт в Telegram.
 * Один модуль на экран входа и окно подтверждения личности — тексты не
 * должны разойтись.
 */

export type DeliveryChannel = "sms" | "telegram" | "push";

export const DEFAULT_PUSH_FALLBACK_SEC = 30;

/** Момент (мс), когда сервер сам отправит СМС; 0 — не пуш, отсчёта нет. */
export function fallbackDeadline(channel: DeliveryChannel, fallbackAfterSec: number | undefined, nowMs: number): number {
  if (channel !== "push") return 0;
  return nowMs + (fallbackAfterSec ?? DEFAULT_PUSH_FALLBACK_SEC) * 1000;
}

/** Keep the server-confirmed channel; a local deadline is not a delivery receipt. */
export function effectiveChannel(channel: DeliveryChannel, _fallbackAt: number, _nowMs: number): "sms" | "telegram" | "push" {
  return channel;
}

/** Канал для кнопки «Отправить ещё раз»: после пуша сервер сам шлёт СМС. */
export function resendChannel(channel: DeliveryChannel): "sms" | "telegram" {
  return channel === "telegram" ? "telegram" : "sms";
}

/** Подпись поля ввода кода. */
export function codeFieldLabel(channel: "sms" | "telegram" | "push"): string {
  if (channel === "push") return "Код входа";
  return channel === "telegram" ? "Код из Telegram" : "Код из СМС";
}

/** Фраза «куда ушёл код». `hint` — маска номера от сервера («•• ••• 06 61»). */
export function deliveryText(channel: DeliveryChannel, fallbackAt: number, nowMs: number, hint: string | null): string {
  const eff = effectiveChannel(channel, fallbackAt, nowMs);
  if (eff === "push") {
    return "Проверьте уведомления, СМС или Telegram. Код действует 5 минут с момента отправки.";
  }
  if (eff === "telegram") return "Код отправлен в Telegram.";
  const to = hint ? ` на ${hint}` : "";
  return `Код отправлен в СМС${to}.`;
}

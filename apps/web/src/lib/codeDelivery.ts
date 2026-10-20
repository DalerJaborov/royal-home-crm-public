/**
 * Как человеку сказать, куда ушёл код входа / подтверждения (19.10.2026).
 *
 * Код сначала приходит ПУШЕМ на уже вошедший телефон с приложением; сервер ждёт
 * подтверждения доставки `fallbackAfterSec` секунд и, если его нет, сам шлёт СМС.
 * Повторно сервер об этом не спрашиваем: по истечении отсчёта просто говорим, что
 * ушла СМС. Один модуль на экран входа и окно подтверждения личности — тексты не
 * должны разойтись.
 */

export type DeliveryChannel = "sms" | "telegram" | "push";

export const DEFAULT_PUSH_FALLBACK_SEC = 30;

/** Момент (мс), когда сервер сам отправит СМС; 0 — не пуш, отсчёта нет. */
export function fallbackDeadline(channel: DeliveryChannel, fallbackAfterSec: number | undefined, nowMs: number): number {
  if (channel !== "push") return 0;
  return nowMs + (fallbackAfterSec ?? DEFAULT_PUSH_FALLBACK_SEC) * 1000;
}

/** Канал, каким код реально придёт сейчас: после отсчёта пуш превращается в СМС. */
export function effectiveChannel(channel: DeliveryChannel, fallbackAt: number, nowMs: number): "sms" | "telegram" | "push" {
  if (channel === "push" && nowMs >= fallbackAt) return "sms";
  return channel;
}

/** Канал для кнопки «Отправить ещё раз»: после пуша сервер сам шлёт СМС. */
export function resendChannel(channel: DeliveryChannel): "sms" | "telegram" {
  return channel === "telegram" ? "telegram" : "sms";
}

/** Подпись поля ввода кода. */
export function codeFieldLabel(channel: "sms" | "telegram" | "push"): string {
  if (channel === "push") return "Код из уведомления";
  return channel === "telegram" ? "Код из Telegram" : "Код из СМС";
}

/** Фраза «куда ушёл код». `hint` — маска номера от сервера («•• ••• 06 61»). */
export function deliveryText(channel: DeliveryChannel, fallbackAt: number, nowMs: number, hint: string | null): string {
  const eff = effectiveChannel(channel, fallbackAt, nowMs);
  if (eff === "push") {
    const sec = Math.max(0, Math.ceil((fallbackAt - nowMs) / 1000));
    return `Отправили код уведомлением на ваш телефон, он действует 5 минут. Если уведомление не придёт — через ${sec} с пришлём СМС сами.`;
  }
  if (eff === "telegram") return "Код отправлен в Telegram.";
  const to = hint ? ` на ${hint}` : "";
  return channel === "push" ? `Отправили СМС${to}.` : `Код отправлен в СМС${to}.`;
}

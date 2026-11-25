import { ApiError } from "./apiError";

/** API errors keep JSON fields in data, not on the Error itself. The transport
 * also exposes Retry-After for locally suppressed requests during cooldown. */
export function loginRetryAfterMs(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.status !== 429) return null;
  const data = error.data as { resendAfterSec?: unknown } | null;
  if (typeof data?.resendAfterSec === "number" && Number.isFinite(data.resendAfterSec) && data.resendAfterSec >= 0) {
    return data.resendAfterSec * 1000;
  }
  return typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs)
    ? Math.max(0, error.retryAfterMs) : 60_000;
}

/** Часы:минуты по Душанбе (UTC+5) для подсказки «подождите до HH:MM». */
export function dushanbeClock(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Dushanbe", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

export interface LoginBlockInfo {
  /** Когда блок «5 кодов за час» снимется сам. */
  retryAt: Date;
  telegramAvailable: boolean;
}

/**
 * 503 «Слишком много кодов за час» (routes/auth.ts, blockedBody): сервер сообщает,
 * когда блок снимется. Без `retryAt` (старый сервер, другая ошибка 503) — null.
 */
export function loginBlockInfo(error: unknown): LoginBlockInfo | null {
  if (!(error instanceof ApiError) || error.status !== 503) return null;
  const data = error.data as { retryAt?: unknown; telegramAvailable?: unknown } | null;
  if (typeof data?.retryAt !== "string") return null;
  const retryAt = new Date(data.retryAt);
  if (Number.isNaN(retryAt.getTime())) return null;
  return { retryAt, telegramAvailable: data.telegramAvailable === true };
}

export function loginBlockText(info: LoginBlockInfo): string {
  return `Код уже запрашивали 5 раз за час. Подождите до ${dushanbeClock(info.retryAt)} (по Душанбе) или попросите директора сбросить блок.`;
}

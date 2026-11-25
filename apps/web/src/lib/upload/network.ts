/**
 * СЕТЬ ДЛЯ ЗАГРУЗОК (25.11.2026): ждать связь, а не жечь попытки; уважать «подождите»
 * сервера (Retry-After); снимок канала для журнала.
 *
 * Общий помощник загрузки частями (lib/chunkedUpload.ts) делал 4 попытки за ~7 секунд и
 * сдавался — в лифте и метро связь пропадает на минуты. Теперь без сети он ждёт события
 * `online`, а не тратит попытки, и паузы берёт из общего расписания (lib/uploadRetry.ts).
 */

export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** Отмена человеком во время ожидания — тот же смысл, что отмена отправки. */
export class WaitAbortedError extends Error {
  constructor() {
    super("Ожидание отменено");
    this.name = "WaitAbortedError";
  }
}

/**
 * Дождаться связи. Есть сеть — сразу. Нет — до события `online` или `pollMs` (браузер на
 * некоторых прошивках `online` не присылает — проверяем `navigator.onLine` сами).
 */
export function waitForOnline(signal?: AbortSignal, pollMs = 15_000): Promise<void> {
  if (!isOffline()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new WaitAbortedError());
      return;
    }
    let timer: ReturnType<typeof setInterval> | null = null;
    const finish = (err?: Error) => {
      if (timer) clearInterval(timer);
      if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onOnline = () => finish();
    const onAbort = () => finish(new WaitAbortedError());
    if (typeof window !== "undefined") window.addEventListener("online", onOnline);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setInterval(() => {
      if (!isOffline()) finish();
    }, pollMs);
  });
}

/** Пауза, которую можно оборвать отменой. */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new WaitAbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new WaitAbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Самая длинная пауза «подождите», которой подчиняемся: дольше — это уже не пауза, а поломка. */
const RETRY_AFTER_CAP_MS = 5 * 60_000;

/**
 * Retry-After — секунды или HTTP-дата (RFC 9110); RateLimit-Reset — секунды. Тот же разбор,
 * что у `api()` (lib/api.ts::parseRetryAfterMs), но по строкам заголовков: XHR, не Response.
 */
export function parseRetryAfterMs(retryAfter: string | null, rateLimitReset: string | null = null, now = Date.now()): number | null {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, secs * 1000));
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, at - now));
  }
  if (rateLimitReset) {
    const secs = Number(rateLimitReset);
    if (Number.isFinite(secs)) return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, secs * 1000));
  }
  return null;
}

/** Retry-After из ответа XHR — только у 429/503, где сервер его и шлёт. */
export function retryAfterFromXhr(xhr: { status: number; getResponseHeader?: (name: string) => string | null }): number | null {
  if (xhr.status !== 429 && xhr.status !== 503) return null;
  if (typeof xhr.getResponseHeader !== "function") return null;
  try {
    return parseRetryAfterMs(xhr.getResponseHeader("Retry-After"), xhr.getResponseHeader("RateLimit-Reset"));
  } catch {
    return null;
  }
}

/** Канал по данным браузера (Network Information API: Chrome/Android; в Safari его нет). */
export interface ConnectionSnapshot {
  effectiveType?: string;
  downlinkMbps?: number;
  saveData?: boolean;
}

export function connectionSnapshot(): ConnectionSnapshot {
  if (typeof navigator === "undefined") return {};
  const c = (navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number; saveData?: boolean } }).connection;
  if (!c) return {};
  const out: ConnectionSnapshot = {};
  if (typeof c.effectiveType === "string") out.effectiveType = c.effectiveType;
  if (typeof c.downlink === "number") out.downlinkMbps = c.downlink;
  if (c.saveData === true) out.saveData = true;
  return out;
}

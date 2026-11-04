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

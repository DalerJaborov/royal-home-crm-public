/** Pure classification of a physical provider outcome for durable customer
 * delivery. Only an outcome that PROVES the request was not processed may be
 * retried; anything else stays UNKNOWN and is resolved by echo, never by resend. */
export type CustomerDeliveryProviderOutcome = "REJECTED" | "NOT_SENT" | "UNKNOWN";

/** Connection never established: the request did not reach the provider. */
export const CUSTOMER_DELIVERY_NOT_SENT_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);
/** HTTP statuses that mean "not processed, try later": rate limit, request
 * timeout (body not fully read) and service unavailable. */
export const CUSTOMER_DELIVERY_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 503]);

/** An ambiguous own send blocks later input only this long after the part was created. */
export const CUSTOMER_DELIVERY_AMBIGUITY_WINDOW_MS = 15 * 60_000;
/** Physical attempts per part; every earlier one must be a provable NOT_SENT. */
export const CUSTOMER_DELIVERY_MAX_ATTEMPTS = 3;
/** A part older than this is no longer retried: the conversation has moved on. */
export const CUSTOMER_DELIVERY_RETRY_WINDOW_MS = 10 * 60_000;

export function classifyCustomerProviderStatus(status: number): CustomerDeliveryProviderOutcome {
  if (CUSTOMER_DELIVERY_RETRYABLE_STATUSES.has(status)) return "NOT_SENT";
  // 500/502/504 may have been processed before failing: ambiguous, never resent.
  return status >= 400 && status < 500 ? "REJECTED" : "UNKNOWN";
}

export function classifyCustomerProviderNetworkFailure(error: unknown): "NOT_SENT" | "UNKNOWN" {
  const cause = error && typeof error === "object" ? Reflect.get(error, "cause") : null;
  const direct = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
  const code = direct ?? (cause && typeof cause === "object" ? Reflect.get(cause, "code") : undefined);
  return typeof code === "string" && CUSTOMER_DELIVERY_NOT_SENT_CODES.has(code) ? "NOT_SENT" : "UNKNOWN";
}

/** errorCode values written for a NOT_SENT attempt that may be retried. */
export function isRetryableCustomerDeliveryErrorCode(code: string | null | undefined): boolean {
  if (!code) return false;
  if (code === "network_failure") return true;
  const match = /^http_(\d{3})$/.exec(code);
  return !!match && CUSTOMER_DELIVERY_RETRYABLE_STATUSES.has(Number(match[1]));
}

/** 5 s, 20 s, 45 s ... for the next physical attempt. */
export function customerDeliveryRetryDelayMs(completedAttempts: number): number {
  return 5_000 * Math.max(1, completedAttempts) ** 2;
}

/** Receipt writes are idempotent; a transient DB failure must not leave an
 * accepted message IN_FLIGHT. Last failure is rethrown for the caller to log. */
export async function withReceiptRetry<T>(write: () => Promise<T>, delaysMs: readonly number[] = [150, 600],
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= delaysMs.length; i++) {
    try { return await write(); } catch (error) { last = error; if (i < delaysMs.length) await sleep(delaysMs[i]); }
  }
  throw last;
}

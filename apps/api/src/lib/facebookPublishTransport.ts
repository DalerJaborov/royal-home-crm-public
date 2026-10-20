const CONNECT_RETRY_DELAYS_MS = [1_000, 2_000];
const BEFORE_CONNECT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT", "EAI_AGAIN", "ENOTFOUND",
]);

/** Only failures before connecting prove that a non-idempotent POST was not sent. */
function failedBeforeConnect(error: unknown, seen = new Set<object>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  // All attempted addresses must have failed before connecting. An unknown or
  // post-connect failure among them makes replay unsafe, regardless of the code.
  if (error instanceof AggregateError) {
    return error.errors.length > 0 && error.errors.every((entry: unknown) => failedBeforeConnect(entry, new Set(seen)));
  }
  const detail = error as { code?: unknown; cause?: unknown };
  if (typeof detail.code === "string" && BEFORE_CONNECT_CODES.has(detail.code)) return true;
  return failedBeforeConnect(detail.cause, seen);
}

/** Retry the current Facebook step, never the whole publication or a lost response. */
export async function fetchFacebookPublish(url: string, init: Omit<RequestInit, "body"> & { body?: string }): Promise<Response> {
  // A redirected POST may have reached the first server before a later
  // connection fails. Refuse redirects so that replay safety remains provable.
  const request: RequestInit = { ...init, redirect: "error" };
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(url, request);
    } catch (error) {
      if (attempt >= CONNECT_RETRY_DELAYS_MS.length || init.signal?.aborted || !failedBeforeConnect(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAYS_MS[attempt]));
      init.signal?.throwIfAborted();
    }
  }
}

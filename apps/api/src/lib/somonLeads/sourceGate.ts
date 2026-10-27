/** A small, explicit throttle state. Persist and share it before enabling workers. */
export type SourceGate = { nextAllowedAt: number; stopped: boolean };

export function reserveSourceRequest(gate: SourceGate, now: number, minIntervalMs: number): SourceGate | null {
  if (gate.stopped || !Number.isFinite(now) || !Number.isFinite(minIntervalMs) || minIntervalMs <= 0 || now < gate.nextAllowedAt) return null;
  return { ...gate, nextAllowedAt: now + minIntervalMs };
}

/** A 429 pauses until Retry-After, a 403 stops for operator review. */
export function applySourceResponse(gate: SourceGate, status: number, now: number, retryAfterMs?: number): SourceGate {
  if (status === 403) return { ...gate, stopped: true };
  if (status === 0 || status === 429 || status >= 500) {
    if (retryAfterMs !== undefined && (!Number.isFinite(retryAfterMs) || retryAfterMs > 7 * 24 * 60 * 60 * 1000)) {
      const farFuture = Date.UTC(9999, 11, 31);
      const until = Number.isFinite(retryAfterMs) ? Math.min(now + retryAfterMs, farFuture) : farFuture;
      return { stopped: true, nextAllowedAt: Math.max(gate.nextAllowedAt, until) };
    }
    const pause = Number.isFinite(retryAfterMs) && retryAfterMs! > 0 ? retryAfterMs! : 60_000;
    return { ...gate, nextAllowedAt: Math.max(gate.nextAllowedAt, now + pause) };
  }
  return gate;
}

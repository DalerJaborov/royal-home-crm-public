import { randomUUID } from "node:crypto";
import { prisma } from "../../db.js";
import { applySourceResponse, reserveSourceRequest } from "./sourceGate.js";

/** A shared lease prevents overlapping source requests across worker processes. */
export async function claimSomonRequest(now: Date, intervalMs: number): Promise<string | null> {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-source-budget'))`;
    const state = await tx.somonMonitor.findUnique({ where: { id: "singleton" } });
    if (!state?.enabled || (state.requestLeaseUntil && state.requestLeaseUntil > now)) return null;
    const next = reserveSourceRequest({ stopped: state.sourceStopped, nextAllowedAt: state.blockedUntil?.getTime() ?? 0 }, now.getTime(), intervalMs);
    if (!next) return null;
    const token = randomUUID();
    await tx.somonMonitor.update({ where: { id: "singleton" }, data: { blockedUntil: new Date(next.nextAllowedAt), requestLeaseToken: token, requestLeaseUntil: new Date(now.getTime() + 20000) } });
    return token;
  });
}

/** A late adverse response still stops/pauses the source, but may not release a newer lease. */
export async function recordSomonResponse(token: string, status: number, now: Date, retryAfterMs?: number): Promise<void> {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-source-budget'))`;
    const state = await tx.somonMonitor.findUnique({ where: { id: "singleton" } });
    if (!state) return;
    const failure = status === 0 || status === 429 || status >= 500;
    const matching = state.requestLeaseToken === token;
    const stable = matching && status >= 200 && status < 300 && state.sourceLastFailureAt && now.getTime() - state.sourceLastFailureAt.getTime() >= 30 * 60_000;
    const failures = failure ? state.sourceFailures + 1 : stable ? 0 : state.sourceFailures;
    const backoff = failure ? Math.min(60_000 * 2 ** Math.min(failures - 1, 6), 60 * 60_000) : 0;
    const pause = failure ? Math.max(backoff, retryAfterMs ?? 0) : retryAfterMs;
    const next = applySourceResponse({ stopped: state.sourceStopped, nextAllowedAt: state.blockedUntil?.getTime() ?? 0 }, status, now.getTime(), pause);
    await tx.somonMonitor.update({ where: { id: "singleton" }, data: { sourceStopped: next.stopped || failures >= 5, sourceFailures: failures, ...(failure ? { sourceLastFailureAt: now } : stable ? { sourceLastFailureAt: null } : {}), blockedUntil: new Date(next.nextAllowedAt), ...(matching ? { requestLeaseToken: null, requestLeaseUntil: null } : {}) } });
  });
}

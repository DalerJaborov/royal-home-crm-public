import { randomUUID } from "node:crypto";
import { prisma } from "../../db.js";
import { applySourceResponse, reserveSourceRequest } from "./sourceGate.js";

/**
 * Фоновый (рыночный) обход уступает минутному парсеру лидов: берёт слот только
 * через этот запас после конца общего интервала. Парсер делает паузу 10,2 с при
 * интервале 10 с, поэтому слот, занятый посреди его тика, ему не достаётся лишь
 * когда обход вклинился бы в его паузу, а запас в 3 с этого не допускает.
 */
export const BACKGROUND_YIELD_MS = 3000;

export interface ClaimOptions {
  /** Рыночный обход: работает и при выключенных лидах, но всегда уступает им. */
  background?: boolean;
}

/** Источник остановлен оператором-условием (403 или 5 сбоев подряд): ждать бессмысленно. */
export async function isSomonSourceStopped(): Promise<boolean> {
  const state = await prisma.somonMonitor.findUnique({ where: { id: "singleton" }, select: { sourceStopped: true } });
  return state?.sourceStopped === true;
}

/** A shared lease prevents overlapping source requests across worker processes. */
export async function claimSomonRequest(now: Date, intervalMs: number, options: ClaimOptions = {}): Promise<string | null> {
  const background = options.background === true;
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-source-budget'))`;
    let state = await tx.somonMonitor.findUnique({ where: { id: "singleton" } });
    // Строка бюджета общая для лидов и обхода; без неё (лиды ни разу не включали)
    // создаём её выключенной: парсер лидов по enabled=false ничего не делает.
    if (!state && background) state = await tx.somonMonitor.create({ data: { id: "singleton" } });
    if (!state || (!background && !state.enabled) || (state.requestLeaseUntil && state.requestLeaseUntil > now)) return null;
    if (background) {
      // Лиды включены: пока идёт стартовая разметка или есть аренда регулярного скана — не мешаем.
      if (state.enabled && (!state.baselineAt || (state.scanLeaseUntil && state.scanLeaseUntil > now))) return null;
      if (state.blockedUntil && now.getTime() < state.blockedUntil.getTime() + BACKGROUND_YIELD_MS) return null;
    }
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

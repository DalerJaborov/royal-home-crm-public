import { randomUUID } from "node:crypto";
import { prisma } from "../../db.js";
import { applySourceResponse, reserveSourceRequest } from "./sourceGate.js";

/**
 * Фоновый (рыночный) обход и кнопка номера «по клику» уступают минутному парсеру лидов.
 *
 * 1. Только после конца общего интервала плюс запас `BACKGROUND_YIELD_MS`.
 * 2. Лиды включены: пока идёт стартовая разметка или аренда регулярного скана — не мешаем.
 * 3. Тишина `LEAD_QUIET_MS`: тик лидов в фазе обработки найденных объявлений делает запросы
 *    с паузами до 20,4 с (страница автора, потом номер). Слот, взятый обходом в такой паузе,
 *    отдал бы лиду `not_ready` на номере — лид застрял бы, и каждый тик перекачивал бы
 *    карточку заново. Поэтому, если последний запрос был НЕ рыночным (токен без метки
 *    `bg:`), обход ждёт 25 с после него. Свои последовательные запросы обход этим не задерживает.
 * 4. Обход (но не клик) не берёт слот в последние секунды минуты: тик лидов стартует на
 *    границе минуты, и 10-секундный интервал, занятый обходом, отнял бы у него старт.
 *
 * Поведение самих лидов не меняется: они по-прежнему берут слот без этих условий.
 */
export const BACKGROUND_YIELD_MS = 3000;
export const LEAD_QUIET_MS = 25_000;
/** С какой секунды минуты обход не берёт слот (интервал 10 с не должен залезть на старт тика лидов). */
export const BACKGROUND_BLACKOUT_FROM_SECOND = 50;
/** Метка токена слота, взятого не парсером лидов (обход рынка, кнопка номера). */
const NON_LEAD_TOKEN_PREFIX = "bg:";

export interface ClaimOptions {
  /** Рыночный обход: работает и при выключенных лидах, но всегда уступает им. */
  background?: boolean;
  /**
   * Запрос по клику агента (кнопка «показать номер»): тоже работает при выключенных лидах и
   * соблюдает остановку источника и общий интервал, но уступает скану и обработке лидов.
   */
  interactive?: boolean;
}

/** Источник остановлен оператором-условием (403 или 5 сбоев подряд): ждать бессмысленно. */
export async function isSomonSourceStopped(): Promise<boolean> {
  const state = await prisma.somonMonitor.findUnique({ where: { id: "singleton" }, select: { sourceStopped: true } });
  return state?.sourceStopped === true;
}

/** A shared lease prevents overlapping source requests across worker processes. */
export async function claimSomonRequest(now: Date, intervalMs: number, options: ClaimOptions = {}): Promise<string | null> {
  const background = options.background === true;
  const nonLead = background || options.interactive === true;
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-source-budget'))`;
    let state = await tx.somonMonitor.findUnique({ where: { id: "singleton" } });
    // Строка бюджета общая для лидов и обхода; без неё (лиды ни разу не включали)
    // создаём её выключенной: парсер лидов по enabled=false ничего не делает.
    if (!state && nonLead) state = await tx.somonMonitor.create({ data: { id: "singleton" } });
    if (!state || (!nonLead && !state.enabled) || (state.requestLeaseUntil && state.requestLeaseUntil > now)) return null;
    if (nonLead) {
      // Лиды включены: пока идёт стартовая разметка или есть аренда регулярного скана — не мешаем.
      if (state.enabled && (!state.baselineAt || (state.scanLeaseUntil && state.scanLeaseUntil > now))) return null;
      if (state.blockedUntil && now.getTime() < state.blockedUntil.getTime() + BACKGROUND_YIELD_MS) return null;
      if (state.enabled) {
        // Последний запрос — лидов (метки нет): ждём тишину, пока тик не закончит свои паузы.
        const lastWasNonLead = state.requestLeaseToken?.startsWith(NON_LEAD_TOKEN_PREFIX) === true;
        const lastRequestAt = state.blockedUntil ? state.blockedUntil.getTime() - intervalMs : 0;
        if (!lastWasNonLead && now.getTime() - lastRequestAt < LEAD_QUIET_MS) return null;
        if (background && now.getUTCSeconds() >= BACKGROUND_BLACKOUT_FROM_SECOND) return null;
      }
    }
    const next = reserveSourceRequest({ stopped: state.sourceStopped, nextAllowedAt: state.blockedUntil?.getTime() ?? 0 }, now.getTime(), intervalMs);
    if (!next) return null;
    const token = `${nonLead ? NON_LEAD_TOKEN_PREFIX : ""}${randomUUID()}`;
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
    await tx.somonMonitor.update({ where: { id: "singleton" }, data: { sourceStopped: next.stopped || failures >= 5, sourceFailures: failures, ...(failure ? { sourceLastFailureAt: now } : stable ? { sourceLastFailureAt: null } : {}), blockedUntil: new Date(next.nextAllowedAt), ...(matching ? { requestLeaseToken: token.startsWith(NON_LEAD_TOKEN_PREFIX) ? token : null, requestLeaseUntil: null } : {}) } });
  });
}

/**
 * КРЮЧОК ВМЕСТО ИМПОРТА services/leads/selection.js — ЛОМАЕТ ПОСЛЕДНИЙ ЦИКЛ
 * В КЛАСТЕРЕ ТЕЛЕФОНИИ (аудит циклов 03.09.2026).
 *
 * Тот же приём, что onNewSystemError/liveIncomingLookupHook/rewardFirstCallHook.
 * qualifyIncoming.ts брал pickAgentForLead напрямую из selection.ts — а тот
 * приходит обратно в qualifyIncoming.ts через agentOccupancyShield.ts →
 * callTracker.ts → callRecordings.ts → autoLeadFromCall.ts, поэтому прямой
 * импорт замыкал цикл на agentOccupancyShield.ts.
 *
 * kpiQueueRouting.ts и callTracker.ts продолжают импортировать pickAgentForLead
 * напрямую из selection.ts — их путь до agentOccupancyShield.ts не возвращается
 * (проверено madge), крючок здесь нужен только qualifyIncoming.ts.
 *
 * src/index.ts и src/worker.ts регистрируют настоящую функцию один раз при
 * старте — там оба модуля встречаются без цикла.
 */

type PickAgentForLead = (excludeAgentIds?: string | string[], kind?: "BUYER" | "SELLER") => Promise<string | null>;

let pick: PickAgentForLead | null = null;

export function setPickAgentForLeadHook(fn: PickAgentForLead): void {
  pick = fn;
}

/** До регистрации (модульный тест без index.ts) — не назначает агента, как
 *  если бы стратегия распределения была "manual". */
export async function pickAgentForLead(
  excludeAgentIds?: string | string[],
  kind?: "BUYER" | "SELLER"
): Promise<string | null> {
  if (!pick) return null;
  return pick(excludeAgentIds, kind);
}

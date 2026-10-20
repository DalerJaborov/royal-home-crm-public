/**
 * КРЮЧОК ВМЕСТО ИМПОРТА services/leads/firstCall.js — ЛОМАЕТ ЦИКЛ ИМПОРТОВ.
 *
 * Тот же приём, что onNewSystemError в lib/systemError.ts и liveIncomingLookupHook.ts
 * (см. комментарии там). callTracker.ts раньше брал rewardFirstCallIfOnTime
 * напрямую из services/leads/firstCall.ts — а тот приходит обратно в
 * callTracker.ts через shared.ts → selection.ts → agentOccupancyShield.ts,
 * поэтому прямой импорт замыкал цикл (аудит циклов 03.09.2026).
 *
 * src/index.ts и src/worker.ts регистрируют настоящую функцию через
 * setRewardFirstCallHook один раз при старте — там оба модуля встречаются
 * без цикла.
 */

type RewardFirstCall = (clientId: string, agentId: string, talkedSeconds: number, now?: Date) => Promise<void>;

let reward: RewardFirstCall | null = null;

export function setRewardFirstCallHook(fn: RewardFirstCall): void {
  reward = fn;
}

/** До регистрации (модульный тест, который не поднимает index.ts) — молча
 *  ничего не начисляет, как и раньше в тех же тестах (функция вызывается
 *  fire-and-forget через void ...catch(), отсутствие награды не валит вызов). */
export async function rewardFirstCallIfOnTime(
  clientId: string,
  agentId: string,
  talkedSeconds: number,
  now?: Date
): Promise<void> {
  if (!reward) return;
  await reward(clientId, agentId, talkedSeconds, now);
}

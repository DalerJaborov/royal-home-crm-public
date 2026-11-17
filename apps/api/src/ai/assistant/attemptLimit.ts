/**
 * «turn» — кончился предел попыток ОДНОГО хода (этот модуль); «budget» — дневной счётчик,
 * деньги или учёт расходов недоступен (moneyPolicy.ts, attemptBudget.ts). Первое — не сбой:
 * человек получает честное «что успела / что не вышло» (ai/assistant.ts), второе — остановка.
 */
export type AssistantAttemptLimitScope = "turn" | "budget";

export class AssistantAttemptLimitError extends Error {
  readonly code = "assistant_attempt_limit";
  readonly status = 402; // Terminal locally; never retry a failed reservation.
  constructor(readonly scope: AssistantAttemptLimitScope = "budget") { super("Достигнут лимит вызовов ИИ или недоступен учёт расходов"); }
}

/**
 * ПРЕДЕЛ ПОПЫТОК ХОДА — ИЗ ЧИСЛА ШАГОВ НАСТРОЕК, А НЕ ОТДЕЛЬНОЙ КОНСТАНТОЙ (17.11.2026).
 * Было 9 попыток при Settings.aiAssistantMaxRounds = 30: каждый повтор после 503 и каждая
 * запасная модель тратят тот же счётчик (geminiClient.ts, callGeminiToolsWithRetries), и
 * оба сбоя attempt_limit на проде случились на 4–5 шаге, задолго до тридцатого. Теперь —
 * попытка на шаг плюс запас на повторы (половина шагов, не меньше шести).
 */
export function assistantTurnAttemptCap(maxRounds: number): number {
  const rounds = Number.isSafeInteger(maxRounds) && maxRounds > 0 ? maxRounds : 1;
  return rounds + Math.max(6, Math.ceil(rounds / 2));
}

/** Reservations are intentionally not refunded after an uncertain provider outcome. */
export function createAssistantAttemptLimit(reserve: () => Promise<boolean>, maximum = 9) {
  let used = 0;
  const take = async () => {
    if (used >= maximum) throw new AssistantAttemptLimitError("turn");
    used++;
    let allowed = false;
    try { allowed = await reserve(); } catch { /* Accounting unavailable: fail closed. */ }
    if (!allowed) throw new AssistantAttemptLimitError("budget");
  };
  /** Сколько попыток хода осталось: на последней модель получает приказ «ответь по найденному». */
  return Object.assign(take, { remaining: () => Math.max(0, maximum - used) });
}

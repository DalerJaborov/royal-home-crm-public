export class AssistantAttemptLimitError extends Error {
  readonly code = "assistant_attempt_limit";
  readonly status = 402; // Terminal locally; never retry a failed reservation.
  constructor() { super("Достигнут лимит вызовов ИИ или недоступен учёт расходов"); }
}

/** Reservations are intentionally not refunded after an uncertain provider outcome. */
export function createAssistantAttemptLimit(reserve: () => Promise<boolean>, maximum = 6) {
  let used = 0;
  return async () => {
    if (used >= maximum) throw new AssistantAttemptLimitError();
    used++;
    let allowed = false;
    try { allowed = await reserve(); } catch { /* Accounting unavailable: fail closed. */ }
    if (!allowed) throw new AssistantAttemptLimitError();
  };
}

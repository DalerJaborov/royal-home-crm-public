/** A rejected cost control must never silently restore the provider's default high reasoning. */
export function requestThinkingConfig(defaultConfig: Record<string, unknown>, rejected: boolean, requireLow = false): Record<string, unknown> {
  if (requireLow) return { thinkingConfig: { thinkingLevel: "low" } };
  return rejected ? {} : { thinkingConfig: defaultConfig };
}

export function assertCompletedAssistantTurn(finishReason?: string, blockReason?: string): void {
  if (finishReason === "STOP" && !blockReason) return;
  // Причину (MAX_TOKENS, SAFETY, MALFORMED_FUNCTION_CALL…) кладём в текст и поля: 23.11.2026 журнал
  // прода показывал только «действия не исполнены», и разобрать, что оборвало ход, было нечем.
  const why = [finishReason ? `finishReason=${finishReason}` : "finishReason пуст", blockReason ? `blockReason=${blockReason}` : ""].filter(Boolean).join(", ");
  throw Object.assign(new Error(`Незавершённый ответ ИИ: действия не исполнены (${why})`), {
    code: "assistant_incomplete_turn", status: 400, finishReason, blockReason,
  });
}

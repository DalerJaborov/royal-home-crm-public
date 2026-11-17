/** A rejected cost control must never silently restore the provider's default high reasoning. */
export function requestThinkingConfig(defaultConfig: Record<string, unknown>, rejected: boolean, requireLow = false): Record<string, unknown> {
  if (requireLow) return { thinkingConfig: { thinkingLevel: "low" } };
  return rejected ? {} : { thinkingConfig: defaultConfig };
}

export function assertCompletedAssistantTurn(finishReason?: string, blockReason?: string): void {
  if (finishReason === "STOP" && !blockReason) return;
  throw Object.assign(new Error("Незавершённый ответ ИИ: действия не исполнены"), {
    code: "assistant_incomplete_turn", status: 400,
  });
}

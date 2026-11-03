/** A rejected cost control must never silently restore the provider's default high reasoning. */
export function requestThinkingConfig(defaultConfig: Record<string, unknown>, rejected: boolean, requireLow = false): Record<string, unknown> {
  if (requireLow) return { thinkingConfig: { thinkingLevel: "low" } };
  return rejected ? {} : { thinkingConfig: defaultConfig };
}

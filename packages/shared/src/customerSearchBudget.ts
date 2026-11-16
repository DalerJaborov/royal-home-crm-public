// Отдельный файл (16.11.2026), не customerAgentPublicReads.ts: тот входит в knowledgeSchemaHash версии бота,
// а он закреплён в паре обновления CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V2.
/** Sane purchase-budget bounds per currency (14.11.2026): "50" or "до 5 комнат" read as money, or an extra zero, must not reach the
 * catalogue as a real ceiling. One source for the model's tool arguments and for the server's own reading of the customer's words. */
export const CUSTOMER_SEARCH_BUDGET_LIMITS = { USD: { min: 1_000, max: 50_000_000 }, TJS: { min: 5_000, max: 500_000_000 } } as const;
export function customerSearchBudgetSane(value: string | number, currency: keyof typeof CUSTOMER_SEARCH_BUDGET_LIMITS): boolean {
  const n = Number(value), limits = CUSTOMER_SEARCH_BUDGET_LIMITS[currency];
  return Number.isFinite(n) && n >= limits.min && n <= limits.max;
}

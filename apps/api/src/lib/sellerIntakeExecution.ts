/** Persisted source mode is immutable. A later switch cannot activate old evidence. */
export function newSellerIntakeMode(sourceAt: Date) {
  const from = Date.parse(process.env.SELLER_CONTROL_LIVE_FROM ?? "");
  return process.env.SELLER_CONTROL_INTERNAL_LIVE === "explicitly-approved" && Number.isFinite(from)
    && sourceAt.getTime() >= from ? "LIVE" : "PREVIEW";
}

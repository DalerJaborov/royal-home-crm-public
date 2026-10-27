/** A listing is only new when its original publication time is known and after activation.
 * Updated/promoted timestamps cannot establish that a listing is new. */
export function isNewAfterActivation(activatedAt: Date, originalPublishedAt: Date | null): boolean {
  if (!originalPublishedAt) return false;
  const start = activatedAt.getTime();
  const published = originalPublishedAt.getTime();
  return Number.isFinite(start) && Number.isFinite(published) && published > start;
}

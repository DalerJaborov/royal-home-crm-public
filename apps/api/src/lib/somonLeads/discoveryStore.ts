import { prisma } from "../../db.js";

const validId = (id: string) => /^\d{1,20}$/.test(id);
export type SeenListing = { id: string; slug: string };

/** Store only IDs for the initial scan. Incomplete scans can never activate delivery. */
export async function recordBaselinePage(page: number, lastPage: number, ids: string[], now = new Date()): Promise<"saved" | "complete" | "duplicate" | "disabled"> {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(lastPage) || lastPage < page || lastPage > 10000 || ids.length === 0 || ids.length > 300 || ids.some(id => !validId(id))) throw new Error("Invalid baseline page");
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-owner-delivery'))`;
    const state = await tx.somonMonitor.findUnique({ where: { id: "singleton" } });
    if (!state?.enabled || state.baselineAt) return "disabled";
    if (page < state.baselineNextPage) return "duplicate";
    if (page !== state.baselineNextPage) throw new Error("Baseline pages out of order");
    await tx.somonSeenAdvert.createMany({ data: [...new Set(ids)].map(advertId => ({ advertId, baseline: true, status: "BASELINE" })), skipDuplicates: true });
    const end = Math.max(lastPage, state.baselineLastPage ?? 0);
    const complete = page >= end;
    await tx.somonMonitor.update({ where: { id: "singleton" }, data: { baselineNextPage: page + 1, baselineLastPage: end, ...(complete ? { baselineAt: now, activatedAt: now } : {}) } });
    return complete ? "complete" : "saved";
  }, { timeout: 35000 });
}

/** Finish after a missing next page only after a fresh first-page pagination
 * confirms that the list shrank below the already processed cursor. */
export async function finishShrunkBaseline(nextPage: number, currentLastPage: number, now = new Date()): Promise<boolean> {
  if (!Number.isInteger(nextPage) || !Number.isInteger(currentLastPage) || currentLastPage < 1 || currentLastPage >= nextPage) return false;
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-owner-delivery'))`;
    const state = await tx.somonMonitor.findUnique({ where: { id: "singleton" } });
    if (!state?.enabled || state.baselineAt || state.baselineNextPage !== nextPage || nextPage < 2) return false;
    await tx.somonMonitor.update({ where: { id: "singleton" }, data: { baselineAt: now, activatedAt: now, baselineLastPage: currentLastPage } });
    return true;
  }, { timeout: 35000 });
}

/** First observed after the complete baseline, not necessarily first published.
 * Such listings always require the explicitly requested date warning. */
export async function recordNewObservations(listings: SeenListing[], now = new Date()): Promise<number> {
  if (listings.length > 300 || listings.some(x => !validId(x.id) || !new RegExp(`^${x.id}_[\\w%-]{1,180}$`).test(x.slug))) throw new Error("Invalid Somon listings");
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-owner-delivery'))`;
    const state = await tx.somonMonitor.findUnique({ where: { id: "singleton" } });
    if (!state?.enabled || !state.baselineAt || now <= state.baselineAt) return 0;
    const result = await tx.somonSeenAdvert.createMany({ data: listings.map(x => ({ advertId: x.id, slug: x.slug, seenAt: now, lastCheckedAt: now, baseline: false, status: "PENDING" })), skipDuplicates: true });
    return result.count;
  }, { timeout: 35000 });
}

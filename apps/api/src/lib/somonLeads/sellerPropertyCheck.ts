import { z } from "zod";
import { prisma } from "../../db.js";
import { fetchSomon } from "./sourceClient.js";
import { parseSellerProfile, parseSiblingCategory } from "./sellerProfile.js";

const progressSchema = z.object({ sellerId: z.number().int().positive(), expected: z.number().int().min(3).max(30), slugs: z.array(z.string().regex(/^\d+_[\w%-]{1,180}$/)).max(29), cursor: z.number().int().min(0), realtyCount: z.number().int().min(1).max(3) });
type Progress = z.infer<typeof progressSchema>;

/** One bounded request per call. Persist only IDs, slugs and counts, not photos or phones. */
export async function checkSellerProperties(advertId: string, sellerId: number | null, total: number | null): Promise<{ kind: "waiting" } | { kind: "review" } | { kind: "complete"; count: number }> {
  if (!sellerId || !total || total > 30 || total < 3) return { kind: "review" };
  const item = await prisma.somonSeenAdvert.findUnique({ where: { advertId }, select: { status: true, sellerCheck: true } });
  if (!item || item.status !== "PENDING") return { kind: "waiting" };
  let progress: Progress;
  if (item.sellerCheck == null) {
    const response = await fetchSomon(`/items/author/${sellerId}/`);
    const slugs = parseSellerProfile(await response.text(), sellerId, advertId, total);
    if (!slugs) return { kind: "review" };
    progress = { sellerId, expected: total, slugs, cursor: 0, realtyCount: 1 };
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`somon-seller-${advertId}`}))`;
      const existing = await tx.somonSeenAdvert.findUnique({ where: { advertId }, select: { sellerCheck: true, status: true } });
      if (existing?.status === "PENDING" && existing.sellerCheck === null) await tx.somonSeenAdvert.update({ where: { advertId }, data: { sellerCheck: progress, lastCheckedAt: new Date() } });
    });
    return { kind: "waiting" };
  }
  const parsed = progressSchema.safeParse(item.sellerCheck);
  if (!parsed.success || parsed.data.sellerId !== sellerId || parsed.data.expected !== total || parsed.data.slugs.length !== total - 1 || parsed.data.cursor > parsed.data.slugs.length || new Set(parsed.data.slugs).size !== parsed.data.slugs.length) return { kind: "review" };
  progress = parsed.data;
  if (progress.realtyCount > 2) return { kind: "complete", count: progress.realtyCount };
  if (progress.cursor === progress.slugs.length) {
    // Counts alone do not detect an advert being replaced while we inspect categories.
    const response = await fetchSomon(`/items/author/${sellerId}/`);
    const latest = parseSellerProfile(await response.text(), sellerId, advertId, total);
    if (!latest || [...latest].sort().join("\n") !== [...progress.slugs].sort().join("\n")) return { kind: "review" };
    return { kind: "complete", count: progress.realtyCount };
  }
  const slug = progress.slugs[progress.cursor];
  const response = await fetchSomon(`/api/v2/spa/adverts/card/${slug}/`);
  let realty: boolean | null;
  try { realty = parseSiblingCategory(await response.json(), sellerId, slug); } catch { realty = null; }
  if (realty === null) return { kind: "review" };
  const next = { ...progress, cursor: progress.cursor + 1, realtyCount: progress.realtyCount + Number(realty) };
  const saved = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`somon-seller-${advertId}`}))`;
    const current = await tx.somonSeenAdvert.findUnique({ where: { advertId }, select: { status: true, sellerCheck: true } });
    const check = progressSchema.safeParse(current?.sellerCheck);
    if (current?.status !== "PENDING" || !check.success || JSON.stringify(check.data) !== JSON.stringify(progress)) return false;
    await tx.somonSeenAdvert.update({ where: { advertId }, data: { sellerCheck: next, lastCheckedAt: new Date() } });
    return true;
  });
  if (!saved) return { kind: "waiting" };
  return next.realtyCount > 2 ? { kind: "complete", count: next.realtyCount } : { kind: "waiting" };
}

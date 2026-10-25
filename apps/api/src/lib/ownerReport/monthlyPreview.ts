import { narrationConfigSchema } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { findActiveOwnerReportLink, presentOwnerReportLink } from "./link.js";

/** Only explicitly requested owner-report drafts opt in. Never sends or catches up old months. */
export async function prepareMonthlyOwnerReportPreviews(now = new Date()): Promise<{ prepared: number }> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { propertyNarrationConfig: true } });
  const config = narrationConfigSchema.safeParse(settings?.propertyNarrationConfig ?? {});
  if (!config.success || !config.data.ownerReportPreviewEnabled) return { prepared: 0 };
  const period = new Date(now.getTime() + 5 * 3600_000).toISOString().slice(0, 7);
  const optIns = await prisma.ownerReportDelivery.findMany({
    where: { status: "PREVIEW", period: { lt: period } }, distinct: ["propertyId", "sellerClientId"], orderBy: { createdAt: "desc" },
    select: { propertyId: true, sellerClientId: true, createdById: true },
  });
  let prepared = 0;
  for (const optIn of optIns) {
    const property = await prisma.property.findFirst({ where: { id: optIn.propertyId, deletedAt: null, sellerClientId: optIn.sellerClientId }, select: { id: true } });
    if (!property || !await prisma.client.findFirst({ where: { id: optIn.sellerClientId, deletedAt: null }, select: { id: true } })) continue;
    const link = await findActiveOwnerReportLink(property.id);
    if (!link) continue;
    const result = await prisma.ownerReportDelivery.createMany({ data: [{ ...optIn, period, reportUrl: presentOwnerReportLink(link).url, status: "PREVIEW" }], skipDuplicates: true });
    prepared += result.count;
  }
  return { prepared };
}

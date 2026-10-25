import { narrationConfigSchema } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { prepareOwnerReportDelivery, executeQueuedOwnerReports } from "./delivery.js";
import { logSystemError } from "../systemError.js";

/** Consent is explicit; old draft rows are not consent. Current month only, no catch-up. */
export async function prepareMonthlyOwnerReportPreviews(now = new Date()): Promise<{ prepared: number }> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { propertyNarrationConfig: true } });
  const config = narrationConfigSchema.safeParse(settings?.propertyNarrationConfig ?? {});
  if (!config.success || !config.data.ownerReportPreviewEnabled) return { prepared: 0 };
  const optIns = await prisma.ownerReportSubscription.findMany({ where: { active: true, revokedAt: null }, select: { propertyId: true } });
  let prepared = 0;
  for (const optIn of optIns) {
    try { if (await prepareOwnerReportDelivery(optIn.propertyId, now)) prepared++; }
    catch (error) { await logSystemError("cron", `Не удалось подготовить ежемесячный отчёт объекта ${optIn.propertyId}: ${error instanceof Error ? error.message : "неизвестная ошибка"}`); }
  }
  await executeQueuedOwnerReports(now);
  return { prepared };
}

import { prisma } from "../db.js";
import { visibleInteractionWhere } from "./investigationPrivacy.js";

/** Full-table facts; never infer absence of a send from the truncated timeline. */
export async function loadClientCardActivity(clientId: string, viewerRole?: string) {
  const [sent, showingCount, nextStep] = await Promise.all([
    prisma.propertyExposure.aggregate({ where: { clientId }, _max: { sentAt: true }, _count: true }),
    prisma.interaction.count({ where: { clientId, type: "SHOWING", ...visibleInteractionWhere(viewerRole) } }),
    prisma.interaction.findFirst({
      where: { clientId, ...visibleInteractionWhere(viewerRole), OR: [{ nextActionDate: { not: null } }, { nextAction: { not: null } }], completedAt: null, declinedAt: null, taskCancelledAt: null },
      orderBy: [{ nextActionDate: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }, { id: "desc" }],
      select: { type: true, nextAction: true, nextActionDate: true },
    }),
  ]);
  return {
    propertyActivitySummary: { lastSentAt: sent._max.sentAt?.toISOString() ?? null, sentCount: sent._count, showingCount },
    nextStep: nextStep ? { nextAction: nextStep.nextAction || (nextStep.type === "SHOWING" ? "Провести показ" : "Связаться с клиентом"), nextActionDate: nextStep.nextActionDate } : null,
  };
}

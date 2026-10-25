import { canViewInvestigations } from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";

/** Deleted lesson audit rows retain their kind, so historical bumps can still be scoped. */
export async function privateLessonAuditIds(role?: string | null): Promise<string[]> {
  if (canViewInvestigations(role)) return [];
  const [lessons, deleted] = await Promise.all([
    prisma.botLesson.findMany({ where: { investigationOnly: true }, select: { id: true } }),
    prisma.auditLog.findMany({ where: { entityType: "BotLesson", action: "BOT_LESSON_DELETE", OR: [
      { meta: { path: ["kind"], equals: "audit_finding" } },
      { meta: { path: ["kind"], equals: "audit" } },
    ] }, select: { entityId: true } }),
  ]);
  return [...new Set([...lessons.map((row) => row.id), ...deleted.flatMap((row) => row.entityId ? [row.entityId] : [])])];
}

/** Persisted producer identity, never search narrative text for suspicious words. */
export function visibleAuditWhere(role?: string | null, privateLessonIds: string[] = []): Prisma.AuditLogWhereInput {
  if (canViewInvestigations(role)) return {};
  return { AND: [
    ...(privateLessonIds.length ? [{ OR: [
      { entityType: { not: "BotLesson" } },
      { entityId: null },
      { entityId: { notIn: privateLessonIds } },
    ] }] : []),
    { entityType: { notIn: ["PostShowingCall", "SellerProbeCall", "ShowingSurveyCall"] } },
    { action: { notIn: ["CLIENT_SECURITY_REVIEW", "CLIENT_REFUSAL_SUSPECTED"] } },
    { OR: [
      { action: { notIn: ["BOT_AUDIT_RESOLVE", "BOT_AUDIT_RESOLVE_GROUP"] } },
      { action: { in: ["BOT_AUDIT_RESOLVE", "BOT_AUDIT_RESOLVE_GROUP"] }, NOT: { meta: { path: ["type"], equals: "agent_bypassed_crm" } } },
    ] },
  ] };
}

export function publicAuditMeta<T extends { meta: unknown }>(row: T, role?: string | null): T {
  if (canViewInvestigations(role) || !row.meta || typeof row.meta !== "object" || Array.isArray(row.meta)) return row;
  const meta = { ...row.meta } as Record<string, unknown>;
  for (const field of ["securityReview", "securityNote", "securityReviewedAt", "securityReviewedById", "investigationOnly"]) delete meta[field];
  return { ...row, meta };
}

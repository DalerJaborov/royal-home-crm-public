import { isPrivateSettingsField } from "./investigationSettingsAudit.js";
import { canViewInvestigations } from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";

/**
 * Persisted producer identity, never search narrative text for suspicious words.
 *
 * "BotLesson" history (13.11.2026): the bot-learning tables were dropped, so a
 * lesson's investigationOnly flag can no longer be looked up. Its historical
 * audit rows are hidden from every role without investigation access instead
 * of guessing which ones were private.
 */
export function visibleAuditWhere(role?: string | null): Prisma.AuditLogWhereInput {
  if (canViewInvestigations(role)) return {};
  return { AND: [
    { entityType: { notIn: ["PostShowingCall", "SellerProbeCall", "ShowingSurveyCall", "InvestigationControl", "BotLesson"] } },
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
  for (const key of Object.keys(meta)) if (isPrivateSettingsField(key)) delete meta[key];
  if (Array.isArray(meta.fields)) meta.fields = meta.fields.filter(field => typeof field !== "string" || !isPrivateSettingsField(field));
  return { ...row, meta };
}

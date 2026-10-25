import { canViewInvestigations, REFUSAL_REASON_LABELS, REASONS_REQUIRING_SECURITY_REVIEW } from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";

// Explicit producer identifiers, including historical rows. Never infer privacy
// from user-written words, emoji, or the general "oversight" notification kind.
export const INVESTIGATION_NOTIFICATION_PREFIXES = [
  "investigation-", "security-review-", "post-showing-call-",
  "seller-probe-", "seller-property-missing-", "agent-off-crm-", "agent-handoff-anomaly-",
  "client-trash-anomaly-", "alarm-task-reschedule-no-contact-", "alarm-refused-high-score-", "insight-digest-",
] as const;
const LEGACY_REVIEW_REASONS = REASONS_REQUIRING_SECURITY_REVIEW.map((r) => REFUSAL_REASON_LABELS[r]);
type Notice = { tag?: string | null; body?: string | null };

export function isInvestigationNotification(notice: Notice): boolean {
  if (notice.tag === "voice-compliance") return true;
  if (INVESTIGATION_NOTIFICATION_PREFIXES.some((p) => notice.tag?.startsWith(p))) return true;
  // Historical clientRefuse duplicate: only its known tag + generated reason
  // slot, not arbitrary mention of these words in any ordinary notification.
  return !!notice.tag?.startsWith("deal-failed-") && LEGACY_REVIEW_REASONS.some((reason) =>
    notice.body?.includes(`: ${reason}`));
}

export function investigationNotificationWhere(): Prisma.NotificationWhereInput {
  return { OR: [
    ...INVESTIGATION_NOTIFICATION_PREFIXES.map((prefix) => ({ tag: { startsWith: prefix } })),
    { tag: "voice-compliance" },
    ...LEGACY_REVIEW_REASONS.map((reason) => ({ tag: { startsWith: "deal-failed-" }, body: { contains: `: ${reason}` } })),
  ] };
}

export function visibleNotificationsWhere(agentId: string, role: string): Prisma.NotificationWhereInput {
  return canViewInvestigations(role) ? { agentId } : {
    agentId,
    // Nullable tag must be explicitly included (SQL NOT does not include NULL).
    OR: [{ tag: null }, { NOT: investigationNotificationWhere() }],
  };
}

export async function investigationRecipients(): Promise<string[]> {
  return (await prisma.agent.findMany({ where: { isActive: true, role: { in: ["ADMIN", "DIRECTOR"] } }, select: { id: true } })).map((a) => a.id);
}

export async function filterInvestigationRecipients(agentIds: string[], notice: Notice): Promise<string[]> {
  if (!agentIds.length || !isInvestigationNotification(notice)) return agentIds;
  const permitted = new Set(await investigationRecipients());
  return agentIds.filter((id) => permitted.has(id));
}

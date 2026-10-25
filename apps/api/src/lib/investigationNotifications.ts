import { canViewInvestigations, parsePermissionOverrides, resolvePermissions, REFUSAL_REASON_LABELS, REASONS_REQUIRING_SECURITY_REVIEW } from "@royal-home/shared";
import { Prisma } from "../generated/prisma/client.js";
import { prisma, type TxClient } from "../db.js";
import { isPrivateBackgroundJob, publicBackgroundJobSql } from "./backgroundJobPrivacy.js";

// Explicit producer identifiers, including historical rows. Never infer privacy
// from user-written words, emoji, or the general "oversight" notification kind.
export const INVESTIGATION_NOTIFICATION_PREFIXES = [
  "investigation-", "security-review-", "post-showing-call-",
  "seller-probe-", "seller-property-missing-", "agent-off-crm-", "agent-handoff-anomaly-",
  "client-trash-anomaly-", "alarm-task-reschedule-no-contact-", "alarm-refused-high-score-", "insight-digest-",
] as const;
const LEGACY_REVIEW_REASONS = REASONS_REQUIRING_SECURITY_REVIEW.map((r) => REFUSAL_REASON_LABELS[r]);
type Notice = { tag?: string | null; body?: string | null };
export const LEGACY_BACKGROUND_NOTICE_PREFIX = "background-job-given-up:";

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

/** Old inbox rows retain their tag; join the actual producer instead of guessing
 * from prose. Missing jobs cannot establish a public binding and stay AD-only. */
export async function loadVisibleNotificationsWhere(agentId: string, role: string): Promise<Prisma.NotificationWhereInput> {
  const base = visibleNotificationsWhere(agentId, role);
  if (canViewInvestigations(role)) return base;
  const publicLegacy = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT n.id FROM "Notification" n JOIN "BackgroundJob"
      ON n.tag = ${LEGACY_BACKGROUND_NOTICE_PREFIX} || "BackgroundJob".id
    WHERE n."agentId" = ${agentId} AND ${publicBackgroundJobSql()}`);
  return { AND: [base, { OR: [
    { tag: null }, { NOT: { tag: { startsWith: LEGACY_BACKGROUND_NOTICE_PREFIX } } },
    { id: { in: publicLegacy.map(row => row.id) } },
  ] }] };
}

/** Rechecked at delivery too: role changes and historical deferred payloads must
 * not turn an old public-looking tag into permission to reveal a private call. */
export async function isPrivateNotification(notice: Notice): Promise<boolean> {
  if (isInvestigationNotification(notice)) return true;
  if (!notice.tag?.startsWith(LEGACY_BACKGROUND_NOTICE_PREFIX)) return false;
  const id = notice.tag.slice(LEGACY_BACKGROUND_NOTICE_PREFIX.length);
  if (!id) return true;
  const job = await prisma.backgroundJob.findUnique({ where: { id }, select: { type: true, payload: true } });
  return !job || await isPrivateBackgroundJob(job);
}

export async function investigationRecipients(): Promise<string[]> {
  return (await prisma.agent.findMany({ where: { isActive: true, role: { in: ["ADMIN", "DIRECTOR"] } }, select: { id: true } })).map((a) => a.id);
}

export async function filterInvestigationRecipients(agentIds: string[], notice: Notice): Promise<string[]> {
  if (!agentIds.length || !await isPrivateNotification(notice)) return agentIds;
  const permitted = new Set(await investigationRecipients());
  return agentIds.filter((id) => permitted.has(id));
}

/** Transactional private inbox record, never push or external transport. The caller
 * holds its episode lock; a tag lock additionally protects independent retries.
 * Existing rows are retained verbatim, including read state and timestamps. */
export async function recordSellerControlDirectorNotice(tx: TxClient, episodeId: string, buyerCandidate = false) {
  const tag = `investigation-seller-control-${episodeId}`;
  if (!isInvestigationNotification({ tag })) throw new Error("Private notification identity is missing");
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${tag}))`;
  const candidates = await tx.agent.findMany({ where: { isActive: true, role: { in: ["ADMIN", "DIRECTOR"] } },
    select: { id: true, role: true, permissions: true } });
  const recipients = candidates.filter(agent => resolvePermissions(agent.role, parsePermissionOverrides(agent.permissions)).has("clients.securityReview"));
  if (!recipients.length) throw new Error("Нет доступного руководителя с правом закрытого рассмотрения");
  const receipts: Array<{ agentId: string; notificationId: string }> = [];
  for (const agent of recipients) {
    const existing = await tx.notification.findFirst({ where: { agentId: agent.id, tag }, select: { id: true } });
    const row = existing ?? await tx.notification.create({ data: { agentId: agent.id, tag, kind: "insight", level: "INSIGHT",
      title: buyerCandidate ? "Требуется рассмотрение договорённости о показе" : "Требуется рассмотрение работы с продавцом",
      body: "В установленный срок не отмечено получение задачи руководителем либо не подтверждён результат. Проверьте обстоятельства; это не вывод о нарушении.",
      url: "/security" }, select: { id: true } });
    receipts.push({ agentId: agent.id, notificationId: row.id });
  }
  return receipts;
}

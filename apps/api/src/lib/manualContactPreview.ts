import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";

/** Read-only historic context. Missing local evidence never proves an off-CRM
 * conversation, and this evaluator deliberately creates no cases or scores. */
export async function previewManualContactOnly(page: number, now = new Date()) {
  const since = new Date(now.getTime() - 30 * 86400_000);
  const where = { deletedAt: null, assignedAgentId: { not: null }, assignmentCompletedAt: null };
  const [clients, total] = await Promise.all([
    prisma.client.findMany({ where, skip: (page - 1) * 25, take: 25, orderBy: { id: "asc" },
      select: { id: true, assignedAt: true, assignedAgentId: true, interactions: { where: { createdAt: { gte: since, lte: now }, investigationOnly: false },
        select: { id: true, type: true, actorKind: true, callAttempt: true, recordingUrl: true }, take: 501, orderBy: { createdAt: "desc" } } } }),
    prisma.client.count({ where }),
  ]);
  const changed = clients.length ? await prisma.$queryRaw<Array<{ clientId: string }>>`
    SELECT DISTINCT a."entityId" AS "clientId" FROM "AuditLog" a
    WHERE a.action='CLIENT_AGENT_CHANGE' AND a."entityType"='Client' AND a."entityId" IN (${Prisma.join(clients.map(client => client.id))})
      AND a."createdAt" BETWEEN ${since} AND ${now}
      AND (a.meta->>'fromAgentId' IS DISTINCT FROM a.meta->>'toAgentId'
        OR EXISTS (SELECT 1 FROM "ClientWorkflowObservation" o WHERE o.kind='ASSIGNMENT_SNAPSHOT' AND o."sourceType"='OWNERSHIP_AUDIT' AND o."sourceId"=a.id))` : [];
  const changedClients = new Set(changed.map(row => row.clientId));
  const items = await Promise.all(clients.map(async client => {
    const manual = client.interactions.filter(row => row.actorKind === "AGENT" && row.type === "CALL" && !row.callAttempt && !row.recordingUrl);
    const station = client.interactions.some(row => row.type === "CALL" && (!!row.callAttempt || !!row.recordingUrl));
    const [sms, parts, conversations] = await Promise.all([
      prisma.smsMessage.count({ where: { clientId: client.id, createdAt: { gte: since, lte: now }, status: "SENT", providerMessageId: { not: null } } }),
      prisma.customerOutboxPart.count({ where: { conversation: { clientId: client.id }, status: "ACCEPTED", acceptedAt: { gte: since, lte: now } } }),
      prisma.botConversation.findMany({ where: { clientId: client.id }, select: { messages: true }, take: 26 }),
    ]);
    const unknownMessageDate = conversations.some(row => Array.isArray(row.messages) && row.messages.some(value => {
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.mid !== "string" || !value.mid || value.silentCapture === true) return false;
      return typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at));
    }));
    const actualMessage = conversations.some(row => Array.isArray(row.messages) && row.messages.some(value => {
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.at !== "string" || typeof value.mid !== "string" || !value.mid) return false;
      const at = Date.parse(value.at);
      return Number.isFinite(at) && at >= since.getTime() && at <= now.getTime() && value.silentCapture !== true;
    }));
    const evaluation = client.interactions.length > 500 || conversations.length > 25 ? "TRUNCATED_UNKNOWN"
      : changedClients.has(client.id) ? "ASSIGNMENT_CHANGED_IN_WINDOW"
      : client.assignedAt > since ? "INSUFFICIENT_WINDOW"
      : station || sms || parts || actualMessage ? "ELECTRONIC_ACTIVITY_FOUND"
      : unknownMessageDate ? "SOURCE_DATES_UNKNOWN"
      : manual.length ? "MANUAL_ONLY_LOCAL_RECORDS" : "NO_LOCAL_ACTIVITY";
    return { clientId: client.id, subjectAgentId: client.assignedAgentId, assignmentAt: client.assignedAt,
      manualCalls: manual.length, evaluation, coverage: "UNKNOWN", assessment: "NOT_A_VERDICT" };
  }));
  return { mode: "PREVIEW", windowDays: 30, since, page, total, items, escalation: "DISABLED", comparison: "INSUFFICIENT_COHORT" };
}

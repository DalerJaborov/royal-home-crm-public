import { prisma } from "../db.js";

/** Whole local cohort, not merely the current UI page. Missing external channels
 * are explicitly unknown; these counts never create cases or change levels. */
export async function previewWorkflowAgentCounts(now = new Date()) {
  const since = new Date(now.getTime() - 30 * 86400_000);
  const manual = await prisma.$queryRaw<Array<{ subjectAgentId: string; count: bigint }>>`
    SELECT c."assignedAgentId" AS "subjectAgentId", count(*) AS count FROM "Client" c
    WHERE c."deletedAt" IS NULL AND c."assignedAgentId" IS NOT NULL AND c."assignmentCompletedAt" IS NULL AND c."assignedAt" <= ${since}
      AND NOT EXISTS (SELECT 1 FROM "AuditLog" a WHERE a.action='CLIENT_AGENT_CHANGE' AND a."entityType"='Client'
        AND a."entityId"=c.id AND a."createdAt" BETWEEN ${since} AND ${now}
        AND (a.meta->>'fromAgentId' IS DISTINCT FROM a.meta->>'toAgentId'
          OR EXISTS (SELECT 1 FROM "ClientWorkflowObservation" o WHERE o.kind='ASSIGNMENT_SNAPSHOT' AND o."sourceType"='OWNERSHIP_AUDIT' AND o."sourceId"=a.id)))
      AND EXISTS (SELECT 1 FROM "Interaction" i WHERE i."clientId"=c.id AND i."investigationOnly"=false
        AND i."createdAt" BETWEEN ${since} AND ${now} AND i.type='CALL' AND i."actorKind"='AGENT' AND i."callAttempt" IS NULL AND i."recordingUrl" IS NULL)
      AND NOT EXISTS (SELECT 1 FROM "Interaction" i WHERE i."clientId"=c.id AND i."investigationOnly"=false
        AND i."createdAt" BETWEEN ${since} AND ${now} AND i.type='CALL' AND (i."callAttempt" IS NOT NULL OR i."recordingUrl" IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM "SmsMessage" s WHERE s."clientId"=c.id AND s."createdAt" BETWEEN ${since} AND ${now} AND s.status='SENT' AND s."providerMessageId" IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM "CustomerOutboxPart" p JOIN "BotConversation" b ON b.id=p."conversationId"
        WHERE b."clientId"=c.id AND p.status='ACCEPTED' AND p."acceptedAt" BETWEEN ${since} AND ${now})
      AND NOT EXISTS (SELECT 1 FROM "BotConversation" b CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(b.messages)='array' THEN b.messages ELSE '[]'::jsonb END) m
        WHERE b."clientId"=c.id AND COALESCE(m->>'mid','')<>'' AND COALESCE(m->>'silentCapture','false')<>'true'
          AND ((m->>'at') IS NULL OR ((m->>'at') >= ${since.toISOString()} AND (m->>'at') <= ${now.toISOString()})))
    GROUP BY c."assignedAgentId"`;
  const contexts = await prisma.clientWorkflowObservation.findMany({ where: { kind: "SHOWING_DELIVERY_CONTEXT", occurredAt: { gte: since, lte: now } },
    select: { subjectAgentId: true, sourceId: true, payload: true }, take: 10001 });
  const byAgent = new Map<string, Set<string>>();
  for (const row of contexts.slice(0, 10000)) {
    const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload as Record<string, unknown> : {};
    if (!row.subjectAgentId || payload.directDispatchState !== "UNCONFIRMED" || payload.state !== "DELIVERY_UNCONFIRMED") continue;
    const ids = byAgent.get(row.subjectAgentId) ?? new Set<string>(); ids.add(row.sourceId); byAgent.set(row.subjectAgentId, ids);
  }
  const agents = await prisma.agent.findMany({ where: { id: { in: [...new Set([...manual.map(row => row.subjectAgentId), ...byAgent.keys()])] } }, select: { id: true, fullName: true } });
  const names = new Map(agents.map(agent => [agent.id, agent.fullName]));
  return { mode: "PREVIEW", windowDays: 30, coverage: "UNKNOWN", assessment: "NOT_A_VERDICT",
    manual: manual.map(row => ({ subjectAgentId: row.subjectAgentId, agentName: names.get(row.subjectAgentId) ?? "Сотрудник", eligibleLocalCards: Number(row.count), reviewSuggested: row.count > 3n })),
    showingContexts: [...byAgent].map(([subjectAgentId, ids]) => ({ subjectAgentId, agentName: names.get(subjectAgentId) ?? "Сотрудник", recordedUnconfirmedContexts: ids.size,
      reviewSuggested: ids.size >= 2, countCompleteness: contexts.length > 10000 ? "TRUNCATED_LOWER_BOUND" : "LOCAL_RECORDS_ONLY" })),
  };
}

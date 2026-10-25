import type { TxClient } from "../db.js";

/** Audit IDs identify epochs; UUID lexical order never decides transition order.
 * The observation disambiguates real same-owner reassignment from a no-op audit. */
export async function resolveInvestigationAssignmentEpoch(tx: TxClient, input: {
  clientId: string; subjectAgentId: string | null; assignmentAt: Date; at: Date;
}): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; createdAt: Date; toAgentId: string | null }>>`
    SELECT a.id, a."createdAt", a.meta->>'toAgentId' AS "toAgentId"
    FROM "AuditLog" a
    WHERE a.action='CLIENT_AGENT_CHANGE' AND a."entityType"='Client' AND a."entityId"=${input.clientId}
      AND a."createdAt" <= ${input.at}
      AND (a.meta->>'fromAgentId' IS DISTINCT FROM a.meta->>'toAgentId'
        OR EXISTS (SELECT 1 FROM "ClientWorkflowObservation" o WHERE o.kind='ASSIGNMENT_SNAPSHOT'
          AND o."sourceType"='OWNERSHIP_AUDIT' AND o."sourceId"=a.id AND o."clientId"=${input.clientId}))
    ORDER BY a."createdAt" DESC LIMIT 2`;
  if (!rows.length) return `INITIAL:${input.assignmentAt.toISOString()}:${input.subjectAgentId ?? "UNASSIGNED"}`;
  if (rows.length > 1 && rows[0].createdAt.getTime() === rows[1].createdAt.getTime()) return null;
  if (rows[0].toAgentId !== input.subjectAgentId) return null;
  return `AUDIT:${rows[0].id}`;
}

export async function investigationEpochIsCurrent(tx: TxClient, row: {
  clientId: string | null; subjectAgentId: string | null; assignmentAt: Date | null; assignmentEpochKey: string | null;
}) {
  if (!row.clientId || !row.assignmentAt || !row.assignmentEpochKey || row.assignmentEpochKey.startsWith("UNKNOWN:")) return false;
  const epoch = await resolveInvestigationAssignmentEpoch(tx, { clientId: row.clientId, subjectAgentId: row.subjectAgentId,
    assignmentAt: row.assignmentAt, at: new Date() });
  return epoch !== null && epoch === row.assignmentEpochKey;
}

/** A retained source cannot become current again when the same owner/date are reused. */
export async function assignmentSourceEpochIsCurrent(tx: TxClient, input: {
  clientId: string; subjectAgentId: string | null; assignmentAt: Date; sourceAt: Date | null | undefined; now: Date;
}) {
  if (!input.sourceAt || !Number.isFinite(input.sourceAt.getTime()) || input.sourceAt > input.now) return false;
  const source = await resolveInvestigationAssignmentEpoch(tx, { ...input, at: input.sourceAt });
  const current = await resolveInvestigationAssignmentEpoch(tx, { ...input, at: input.now });
  return source !== null && source === current;
}

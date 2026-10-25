import { investigationCaseConfigSchema } from "@royal-home/shared";
import { prisma } from "../db.js";

type Fact = { id: string; kind: string; clientId: string; subjectAgentId: string | null; assignmentAt: Date; occurredAt: Date; payload: unknown };
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function identity(row: Fact) { return [row.clientId, row.subjectAgentId, row.assignmentAt.toISOString()].join(":"); }
export function summarizeNamedAssignments(rows: Fact[], minSample: number | null, completeWindow: boolean) {
  const assignments = rows.filter(row => row.kind === "ASSIGNMENT_SNAPSHOT" && row.subjectAgentId);
  const buckets = new Map<string, number>();
  const relatedByIdentity = new Map<string, Fact[]>();
  for (const row of rows) {
    const key = identity(row); const related = relatedByIdentity.get(key) ?? []; related.push(row); relatedByIdentity.set(key, related);
  }
  for (const row of assignments) buckets.set(identity(row), (buckets.get(identity(row)) ?? 0) + 1);
  const groups = new Map<string, { subjectAgentId: string; sourceCohort: string; allObservedAssignments: number; namedDeclared: number; namedSourceConfirmed: number; ambiguousAssignments: number }>();
  for (const row of assignments) {
    const sourceCohort = typeof object(row.payload).source === "string" ? object(row.payload).source as string : "UNKNOWN_SOURCE";
    const key = `${row.subjectAgentId}:${sourceCohort}`;
    const group = groups.get(key) ?? { subjectAgentId: row.subjectAgentId!, sourceCohort, allObservedAssignments: 0, namedDeclared: 0, namedSourceConfirmed: 0, ambiguousAssignments: 0 };
    group.allObservedAssignments++;
    const related = relatedByIdentity.get(identity(row)) ?? [];
    const declared = related.some(other => other.kind === "NAMED_ASSIGNMENT" && object(other.payload).requestedAgentId === row.subjectAgentId);
    const ambiguous = buckets.get(identity(row)) !== 1;
    if (declared && !ambiguous) group.namedDeclared++;
    if (ambiguous) group.ambiguousAssignments++;
    if (!ambiguous && declared && related.some(other => other.kind === "NAMED_CLIENT_REQUEST"
      && object(other.payload).verification === "AUTHENTICATED_CUSTOMER_TEXT" && object(other.payload).requestedAgentId === row.subjectAgentId)) group.namedSourceConfirmed++;
    groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const peers = [...groups.values()].filter(peer => peer.sourceCohort === group.sourceCohort && peer.subjectAgentId !== group.subjectAgentId);
    const peerAssignments = peers.reduce((sum, peer) => sum + peer.allObservedAssignments, 0);
    const peerNamed = peers.reduce((sum, peer) => sum + peer.namedSourceConfirmed, 0);
    const rate = group.namedSourceConfirmed / group.allObservedAssignments;
    const peerRate = peerAssignments ? peerNamed / peerAssignments : null;
    const evaluation = minSample === null ? "NOT_CONFIGURED" : !completeWindow ? "INSUFFICIENT_WINDOW"
      : group.sourceCohort === "UNKNOWN_SOURCE" || group.ambiguousAssignments || peers.some(peer => peer.ambiguousAssignments) ? "SOURCE_QUALITY_UNKNOWN"
      : group.allObservedAssignments < minSample || peerAssignments < minSample ? "INSUFFICIENT_SAMPLE"
      : peerRate === null || peerRate === 0 ? "ZERO_OR_MISSING_BASELINE"
      : rate > 2 * peerRate ? "PRIVATE_REVIEW_PREVIEW" : "NO_RELATIVE_EXCESS";
    return { ...group, sourceConfirmedRate: rate, peerAssignments, peerSourceConfirmedRate: peerRate, evaluation,
      meaning: "Documented named-source share, not proof of misconduct", automaticLevel: null };
  });
}
export async function previewNamedAssignments(now = new Date()) {
  const [cutover, settings] = await Promise.all([
    prisma.workflowCheckpoint.findUnique({ where: { key: "client-workflow-observations-v1" }, select: { createdAt: true } }),
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { investigationCaseConfig: true } }),
  ]);
  if (!cutover) return { mode: "PREVIEW", evaluation: "NOT_ACTIVATED", groups: [] };
  const parsed = investigationCaseConfigSchema.safeParse(settings?.investigationCaseConfig ?? {});
  const windowDays = parsed.success ? parsed.data.windowDays : 30;
  const fullSince = new Date(now.getTime() - windowDays * 86400_000);
  const since = cutover.createdAt > fullSince ? cutover.createdAt : fullSince;
  const rows = await prisma.clientWorkflowObservation.findMany({ where: { kind: { in: ["ASSIGNMENT_SNAPSHOT", "NAMED_ASSIGNMENT", "NAMED_CLIENT_REQUEST"] },
    occurredAt: { gte: since, lte: now } }, take: 10001, orderBy: { occurredAt: "asc" } });
  if (rows.length > 10000) return { mode: "PREVIEW", evaluation: "TRUNCATED_UNKNOWN", groups: [] };
  const groups = summarizeNamedAssignments(rows, parsed.success ? parsed.data.minSample : null, cutover.createdAt <= fullSince);
  const agents = await prisma.agent.findMany({ where: { id: { in: [...new Set(groups.map(group => group.subjectAgentId))] } }, select: { id: true, fullName: true } });
  const names = new Map(agents.map(agent => [agent.id, agent.fullName]));
  return { mode: "PREVIEW", windowDays, since, cutoverAt: cutover.createdAt, coverage: "FUTURE_ASSIGNMENT_AUDITS_ONLY",
    groups: groups.map(group => ({ ...group, agentName: names.get(group.subjectAgentId) ?? "Сотрудник недоступен" })) };
}

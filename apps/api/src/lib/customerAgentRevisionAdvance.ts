// Append-only owner-approved revision lineage. It routes FUTURE admissions;
// it cannot change an original source, consent, delivery or mutation receipt.
import type { TxClient } from "../db.js";
type Db = Pick<TxClient, "$queryRaw">;
export async function customerAgentRevisionReachable(db: Db, from: { candidateRevisionId: string | null; cohortId: string | null },
  toRevisionId: string, toCohortId?: string): Promise<boolean> {
  if (!from.candidateRevisionId || !from.cohortId) return false;
  const [row] = await db.$queryRaw<Array<{ allowed: boolean }>>`SELECT customer_agent_revision_reachable(
    ${from.candidateRevisionId},${from.cohortId},${toRevisionId},${toCohortId ?? null}) AS allowed`;
  return row?.allowed === true;
}

/** Revision IDs only, not a private-memory grant. The caller still validates
 * original FINAL input, same assignment/owner/scope and own USER statements. */
export async function readApprovedCustomerWordRevisions(db:Db,input:{assignmentId:string;endpointScopeId:string;
  revisionId:string;receivedAt:Date;policyRevision:string}):Promise<ReadonlySet<string>>{
  const [row]=await db.$queryRaw<Array<{path:string[]|null}>>`WITH RECURSIVE target(revision,cohort) AS (
    SELECT p."activeAgentRevisionId",p."rolloutConfig"->>'cohortId' FROM "CustomerRuntimePolicy" p
    WHERE p."id"='singleton' AND p."policyRevision"=${BigInt(input.policyRevision)}
      AND p."activeAgentRevisionId"=${input.revisionId} AND p."rolloutConfig"->>'candidateRevisionId'=${input.revisionId}
  ),lineage(revision,cohort) AS (
    SELECT r."candidateRevisionId",r."cohortId" FROM "CustomerAgentRolloutAssignment" r
    WHERE r."id"=${input.assignmentId} AND r."lane"='CORE' AND r."surface"='dm' AND r."endpointScopeId"=${input.endpointScopeId}
    UNION
    SELECT e."toRevisionId",e."toCohortId" FROM lineage l JOIN "CustomerAgentRevisionAdvance" e
      ON e."fromRevisionId"=l.revision AND e."fromCohortId"=l.cohort CROSS JOIN target t
    WHERE NOT(l.revision=t.revision AND l.cohort=t.cohort) AND e."approvedAt"<=${input.receivedAt}
      AND e."policyRevision"<=${BigInt(input.policyRevision)}
  ) SELECT array_agg(DISTINCT l.revision) AS path FROM lineage l
    WHERE EXISTS(SELECT 1 FROM lineage reached JOIN target t ON reached.revision=t.revision AND reached.cohort=t.cohort)`;
  return new Set((row?.path??[]).filter(id=>id!==input.revisionId));
}

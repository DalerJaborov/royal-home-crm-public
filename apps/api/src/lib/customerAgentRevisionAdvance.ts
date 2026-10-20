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

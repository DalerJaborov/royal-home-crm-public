// Terminal accounting for a failed, unsent public plan. Never a send, retry,
// staff handover, permission factory or successful-reply projection.
import { prisma } from "../db.js";
import { readPublicSourceRow, publicCommentOrigin } from "./customerPublicCommentStore.js";
import { publicCommentSourceDigest } from "./publicCommentSourceIdentity.js";
import type { PublicSourceRef } from "@royal-home/shared";

const technicalReasons = new Set([
  "invalid_model_turn", "mixed_model_protocol", "missing_model_parts", "duplicate_call_id", "invalid_model_call",
  "invalid_call_id", "call_id_reused", "invalid_model_decision", "duplicate_tool_definition", "round_limit",
  "tool_limit", "output_limit", "unsupported_decision_evidence", "turn_unavailable", "public_core_unavailable", "expired",
]);
export async function finishUnsentPublicAgentFailure(ref: PublicSourceRef, reason: string): Promise<boolean> {
  if (ref.table !== "meta" || !technicalReasons.has(reason)) return false;
  return prisma.$transaction(async tx => {
    const source = await readPublicSourceRow(ref, tx, true);
    if (!source || !["PENDING", "WORKING", "ERROR"].includes(source.status)) return false;
    let origin;
    try { origin = publicCommentOrigin(source); } catch { return false; }
    const { target, proof } = origin;
    if (proof.source.table !== ref.table || proof.source.id !== ref.id || proof.sourceRevision !== source.sourceRevision ||
        target.channel !== source.channel || target.accountExternalId !== source.targetResource || target.publicationId !== source.publicationId ||
        target.commentId !== source.commentId || target.parentId !== source.parentId ||
        publicCommentSourceDigest({ source: ref, target, text: source.text }) !== proof.digest ||
        (reason === "expired" && Date.now() < origin.agentPin.providerDeadlineAt)) return false;
    // Source-first lock order matches all planners/dispatchers. Any existing
    // part (including UNKNOWN/ACCEPTED/staff) owns reconciliation forever.
    const [out] = await tx.$queryRaw<Array<{ present: boolean }>>`SELECT EXISTS(SELECT 1 FROM "CustomerOutboxPart"
      WHERE "sourceKey"=${`meta:${ref.id}`} AND "sourceKind" IN ('PUBLIC_COMMENT_REPLY','STAFF_PUBLIC_COMMENT_REPLY')) AS present`;
    if (out?.present) return false;
    const count = await tx.$executeRaw`UPDATE "InstagramComment" SET "status"='FAILED',
      "note"=${`managed_core:failed:${reason}`},"updatedAt"=now()
      WHERE "id"=${ref.id} AND "publicSourceRevision"=${BigInt(source.sourceRevision)} AND "status"=${source.status}`;
    return count === 1;
  });
}

/** Bounded queue maintenance also runs when the agent is OFF. It only closes
 * expired original plans with no delivery part; it never refreshes an origin. */
export async function expireUnsentPublicAgentPlans(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`SELECT c."id" FROM "InstagramComment" c
    WHERE c."publicOriginCiphertext" IS NOT NULL AND c."status" IN ('PENDING','WORKING','ERROR')
      AND c."publicOriginCapturedAt" < ${new Date(Date.now() - 120_000)}
      AND NOT EXISTS(SELECT 1 FROM "CustomerOutboxPart" p WHERE p."sourceKey"='meta:' || c."id"
        AND p."sourceKind" IN ('PUBLIC_COMMENT_REPLY','STAFF_PUBLIC_COMMENT_REPLY'))
    ORDER BY c."publicOriginCapturedAt" LIMIT 25`;
  let count = 0;
  for (const row of rows) if (await finishUnsentPublicAgentFailure({ table: "meta", id: row.id }, "expired")) count++;
  return count;
}

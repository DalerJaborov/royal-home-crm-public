// Terminal accounting for a failed, unsent public plan. Never a send, retry,
// staff handover, permission factory or successful-reply projection.
import { prisma } from "../db.js";
import { readPublicSourceRow, publicCommentOrigin } from "./customerPublicCommentStore.js";
import { publicCommentSourceDigest } from "./publicCommentSourceIdentity.js";
import type { PublicSourceRef } from "@royal-home/shared";

const technicalReasons = new Set([
  "invalid_model_turn", "mixed_model_protocol", "missing_model_parts", "duplicate_call_id", "invalid_model_call",
  "invalid_call_id", "call_id_reused", "invalid_model_decision", "duplicate_tool_definition", "round_limit",
  "tool_limit", "output_limit", "unsupported_decision_evidence", "turn_unavailable", "turn_deadline", "public_core_unavailable", "expired",
]);
const FIRST_REASON_SEPARATOR = ";first=", NOTE_MAX = 200;
/** Mirror of the SQL note above, for tests and diagnostics. */
export function publicAgentFailureNote(reason: string, previousNote: string | null): string {
  const base = `managed_core:failed:${reason}`;
  if (reason !== "expired" || !previousNote || previousNote.startsWith("managed_core:failed:expired")) return base.slice(0, NOTE_MAX);
  return `${base}${FIRST_REASON_SEPARATOR}${previousNote}`.slice(0, NOTE_MAX);
}

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
    // `expired` is bookkeeping, not a cause: the first hold/failure reason already
    // on the row stays readable after it (same note column, no migration).
    const count = await tx.$executeRaw`UPDATE "InstagramComment" SET "status"='FAILED',
      "note"=left(${`managed_core:failed:${reason}`} || CASE WHEN ${reason === "expired"} AND "note" IS NOT NULL AND "note"<>''
        AND "note" NOT LIKE 'managed_core:failed:expired%' THEN ${FIRST_REASON_SEPARATOR} || "note" ELSE '' END, ${NOTE_MAX}),"updatedAt"=now()
      WHERE "id"=${ref.id} AND "publicSourceRevision"=${BigInt(source.sourceRevision)} AND "status"=${source.status}`;
    return count === 1;
  });
}

const EXPIRY_PAGE = 25, EXPIRY_MAX_PAGES = 8;
/** Bounded queue maintenance also runs when the agent is OFF. It only closes
 * expired original plans with no delivery part; it never refreshes an origin.
 * The provider deadline lives inside the encrypted origin, so SQL cannot filter
 * "not yet due" rows: page through the queue by (capturedAt, id) instead of letting
 * 25 not-yet-due old rows starve every row behind them. Scan and work are bounded. */
export async function expireUnsentPublicAgentPlans(): Promise<number> {
  const cutoff = new Date(Date.now() - 120_000);
  let count = 0, after: { at: Date; id: string } | null = null;
  for (let page = 0; page < EXPIRY_MAX_PAGES; page++) {
    const rows: Array<{ id: string; at: Date }> = await prisma.$queryRaw`SELECT c."id", c."publicOriginCapturedAt" AS "at" FROM "InstagramComment" c
      WHERE c."publicOriginCiphertext" IS NOT NULL AND c."status" IN ('PENDING','WORKING','ERROR')
        AND c."publicOriginCapturedAt" < ${cutoff}
        AND (${after?.at ?? null}::timestamptz IS NULL OR (c."publicOriginCapturedAt", c."id") > (${after?.at ?? null}::timestamptz, ${after?.id ?? ""}))
        AND NOT EXISTS(SELECT 1 FROM "CustomerOutboxPart" p WHERE p."sourceKey"='meta:' || c."id"
          AND p."sourceKind" IN ('PUBLIC_COMMENT_REPLY','STAFF_PUBLIC_COMMENT_REPLY'))
      ORDER BY c."publicOriginCapturedAt", c."id" LIMIT ${EXPIRY_PAGE}`;
    for (const row of rows) if (await finishUnsentPublicAgentFailure({ table: "meta", id: row.id }, "expired")) count++;
    if (rows.length < EXPIRY_PAGE || count >= EXPIRY_PAGE) break;
    after = { at: rows[rows.length - 1].at, id: rows[rows.length - 1].id };
  }
  return count;
}

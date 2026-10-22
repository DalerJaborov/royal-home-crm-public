import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma, type TxClient } from "../db.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { legacyMetaDmSourceHash } from "./customerLegacyPhysicalSource.js";
import { currentManualCustomerDeliveryActor } from "./customerManualDeliveryIntent.js";

/** Routing evidence only. This never creates a CORE principal or grants tools.
 * Missing source/endpoint identity is retained as UNATTRIBUTED, not guessed.
 * The control plane has no activation endpoint in this foundation release. */
export const legacyPhysicalChannelSchema = z.enum(["INSTAGRAM", "FACEBOOK", "WHATSAPP", "TELEGRAM", "WEBSITE", "YOUTUBE"]);
const targetSchema = z.object({
  endpointScopeId: z.string().min(1).max(256).nullable(),
  scopeRevision: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
  channel: legacyPhysicalChannelSchema.nullable(),
  surface: z.enum(["dm", "public_comment"]).nullable(),
  targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  operation: z.enum(["message", "reaction"]).default("message"),
  effectKey: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
}).strict().refine(value => Boolean(value.endpointScopeId) === Boolean(value.scopeRevision))
  .refine(value => Boolean(value.effectKey) === Boolean(value.sourceHash));
export type LegacyPhysicalTarget = z.input<typeof targetSchema>;
export type LegacyPhysicalOutcome = "ACCEPTED" | "ACKNOWLEDGED" | "REJECTED" | "NOT_SENT" | "UNKNOWN";
export class CustomerLegacyPhysicalHeld extends Error {
  constructor(readonly reason: string) { super(`Legacy physical output held: ${reason}`); }
}
export function legacyPhysicalDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
async function lockFence(tx: TxClient): Promise<void> {
  if (!isActiveTransactionClient(tx)) throw new CustomerLegacyPhysicalHeld("active_transaction_required");
  // One short lock for every physical admission and future cutover reservation.
  // It is released before HTTP; the committed ADMITTED row remains the fence.
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "CustomerLegacyPhysicalFence" WHERE "id"='singleton' FOR UPDATE`;
  if (rows.length !== 1) throw new CustomerLegacyPhysicalHeld("physical_fence_missing");
}

export async function admitLegacyPhysicalPost(raw: LegacyPhysicalTarget): Promise<string> {
  const target = targetSchema.parse(raw);
  return prisma.$transaction(async tx => {
    await lockFence(tx);
    const actorId = currentManualCustomerDeliveryActor();
    if (actorId) {
      const [actor] = await tx.$queryRaw<Array<{ isActive: boolean }>>`SELECT "isActive" FROM "Agent" WHERE "id"=${actorId} FOR SHARE`;
      if (!actor?.isActive) throw new CustomerLegacyPhysicalHeld("manual_actor_revoked");
    }
    if (target.endpointScopeId) {
      const [scope] = await tx.$queryRaw<Array<{ scopeRevision: bigint }>>`SELECT "scopeRevision"
        FROM "CustomerEndpointScope" WHERE "id"=${target.endpointScopeId} FOR SHARE`;
      if (!scope || scope.scopeRevision.toString() !== target.scopeRevision)
        throw new CustomerLegacyPhysicalHeld("captured_scope_changed");
    }
    const [held] = await tx.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS(SELECT 1
      FROM "CustomerLegacyPhysicalQuiescence" WHERE
      ${target.endpointScopeId}::text IS NULL OR "endpointScopeId"=${target.endpointScopeId}) AS blocked`;
    if (held?.blocked && !actorId) throw new CustomerLegacyPhysicalHeld("scope_quiesced");
    if (!actorId && target.sourceHash) {
      // Advancing a lazy part ordinal is not permission to retry an uncertain
      // original source. Nor is an exact accepted body a newly declared part.
      const [source] = await tx.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS(SELECT 1
        FROM "CustomerLegacyPhysicalAttempt" WHERE "endpointScopeId"=${target.endpointScopeId}
          AND "sourceHash"=${target.sourceHash} AND "actorKind"<>'STAFF' AND (
            "status"='UNKNOWN' OR ("status" IN ('ACCEPTED','ACKNOWLEDGED')
              AND "targetDigest"=${target.targetDigest} AND "payloadDigest"=${target.payloadDigest}
              AND "operation"=${target.operation}))) AS blocked`;
      if (source?.blocked) throw new CustomerLegacyPhysicalHeld("original_physical_effect_already_attempted");
    }
    const prior = await tx.$queryRaw<Array<{ status: string; payloadDigest: string; targetDigest: string }>>`SELECT
      "status","payloadDigest","targetDigest" FROM "CustomerLegacyPhysicalAttempt" WHERE
      (${target.effectKey}::text IS NOT NULL AND "effectKey"=${target.effectKey}) OR
      (${target.effectKey}::text IS NULL AND
        (${target.endpointScopeId}::text IS NULL OR "endpointScopeId" IS NOT DISTINCT FROM ${target.endpointScopeId}) AND "targetDigest"=${target.targetDigest}
        AND "status" IN ('ADMITTED','UNKNOWN')) ORDER BY "createdAt" DESC LIMIT 1`;
    if (!actorId && prior[0] && !["NOT_SENT", "REJECTED"].includes(prior[0].status))
      throw new CustomerLegacyPhysicalHeld("original_physical_effect_already_attempted");
    const id = randomUUID();
    await tx.$executeRaw`INSERT INTO "CustomerLegacyPhysicalAttempt"
      ("id","endpointScopeId","scopeRevision","channel","surface","targetDigest","payloadDigest","operation","effectKey","sourceHash","actorKind","actorId","status")
      VALUES (${id},${target.endpointScopeId},${target.scopeRevision}::bigint,${target.channel},${target.surface},
        ${target.targetDigest},${target.payloadDigest},${target.operation},${actorId ? null : target.effectKey},${actorId ? null : target.sourceHash},
        ${actorId ? "STAFF" : target.sourceHash ? "LEGACY" : "UNATTRIBUTED"},${actorId},'ADMITTED')`;
    return id;
  });
}

/** Stop the existing worker BEFORE another paid model call. A missing original
 * MID is not positive permission; final unattributed admission still quarantines
 * any unresolved target. No stored/native history is modified by this reader. */
export async function legacyMetaDmSourceAlreadyAttempted(endpointScopeId: string, originalMid: string | null | undefined): Promise<boolean> {
  const sourceHash = legacyMetaDmSourceHash(originalMid);
  if (!sourceHash) return false;
  const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS(SELECT 1
    FROM "CustomerLegacyPhysicalAttempt" WHERE "endpointScopeId"=${endpointScopeId} AND "sourceHash"=${sourceHash}
      AND "status" IN ('ADMITTED','UNKNOWN','ACCEPTED','ACKNOWLEDGED')) AS blocked`;
  return row?.blocked === true;
}

/** Provider outcome belongs to the original physical attempt even if policy,
 * credential scope or UI projection changes while the request is in flight.
 * A crash leaves ADMITTED forever: elapsed time is never proof of NOT_SENT. */
export async function settleLegacyPhysicalPost(id: string, status: LegacyPhysicalOutcome,
  providerId: string | null = null): Promise<void> {
  const outcome = z.enum(["ACCEPTED", "ACKNOWLEDGED", "REJECTED", "NOT_SENT", "UNKNOWN"]).parse(status);
  if (outcome === "ACCEPTED" && !providerId) throw new CustomerLegacyPhysicalHeld("acceptance_receipt_required");
  if (providerId && (!z.string().min(1).max(512).safeParse(providerId).success || /\s/.test(providerId)))
    throw new CustomerLegacyPhysicalHeld("invalid_provider_receipt");
  const changed = await prisma.$executeRaw`UPDATE "CustomerLegacyPhysicalAttempt"
    SET "status"=${outcome},"providerId"=${providerId},"finishedAt"=clock_timestamp()
    WHERE "id"=${id} AND "status"='ADMITTED'`;
  if (changed !== 1) throw new CustomerLegacyPhysicalHeld("attempt_already_terminal_or_missing");
}

/** Internal transaction seam for the later reviewed control plane. NOT CORE
 * activation. No HTTP route, environment flag or model tool calls this function.
 * UNKNOWN blocks the covered endpoint; unattributed work blocks every endpoint.
 * Existing HUMAN ownership, pauses and opt-outs remain enforced by callers. */
export async function quiesceLegacyPhysicalScopeTx(tx: TxClient, endpointScopeId: string,
  expectedScopeRevision: string): Promise<void> {
  await lockFence(tx);
  const [scope] = await tx.$queryRaw<Array<{ scopeRevision: bigint }>>`SELECT "scopeRevision"
    FROM "CustomerEndpointScope" WHERE "id"=${endpointScopeId} FOR SHARE`;
  if (!scope || scope.scopeRevision.toString() !== expectedScopeRevision)
    throw new CustomerLegacyPhysicalHeld("captured_scope_changed");
  const [reserved] = await tx.$queryRaw<Array<{ scopeRevision: bigint }>>`SELECT "scopeRevision"
    FROM "CustomerLegacyPhysicalQuiescence" WHERE "endpointScopeId"=${endpointScopeId}`;
  if (reserved && reserved.scopeRevision.toString() !== expectedScopeRevision)
    throw new CustomerLegacyPhysicalHeld("quiescence_scope_changed");
  const [work] = await tx.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS(SELECT 1
    FROM "CustomerLegacyPhysicalAttempt" WHERE "status" IN ('ADMITTED','UNKNOWN') AND "actorKind"<>'STAFF'
      AND ("endpointScopeId" IS NULL OR "endpointScopeId"=${endpointScopeId})) AS blocked`;
  if (work?.blocked) throw new CustomerLegacyPhysicalHeld("legacy_physical_requires_idle");
  await tx.$executeRaw`INSERT INTO "CustomerLegacyPhysicalQuiescence" ("endpointScopeId","scopeRevision")
    VALUES (${endpointScopeId},${expectedScopeRevision}::bigint) ON CONFLICT ("endpointScopeId") DO NOTHING`;
}

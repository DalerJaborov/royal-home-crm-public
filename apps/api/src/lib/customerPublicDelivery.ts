import { createHash, randomUUID } from "node:crypto";
import { reconcileCustomerStaffPublicOutboxPart } from "./customerPublicManualReply.js";
import { isDeepStrictEqual } from "node:util";
import { publicCommentDeliveryFenceSchema, publicCommentDeliveryTransportSchema, publicCommentFactsWitnessSchema, customerPropertyFactsSchema, type CustomerPropertyFacts, type PublicReplyReceipt, type PublicReplyTarget,
  type PublicSourceRef, type ServerPublicCommentSnapshot } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { encryptSecret } from "../crypto.js";
import { decodeCustomerOutboxPayload, decodeCustomerOutboxPublicData } from "./customerOutbox.js";
import { customerDeliveryPayloadSchema, type CustomerOutboxRow } from "./customerDeliveryContracts.js";
import { recordCustomerDeliveryAttemptOutcome } from "./customerDeliverySettlement.js";
import { inspectPublicCommentPrincipal, revalidatePublicCommentPrincipal, type PublicCommentPrincipal } from "./publicCommentSourceIssuer.js";
import { lockPublicCommentSourceTx, loadPublicCommentSource, readPublicSourceRow, publicCommentOrigin, readPublicCommentPropertyFacts } from "./customerPublicCommentStore.js";
import { samePublicInstallation } from "./publicCommentSourceIdentity.js";
import { publicReplyTargetHash, type PublicReplyLease, type PublicReplyStore } from "../messengers/publicCommentReply.js";

import { serializePublicCustomerAgentDeliveryEvidence, customerAgentStoredPublicDataCurrent,
  type CustomerAgentDeliveryWitness } from "./customerAgentDeliveryEvidence.js";

const LEASE_MS = 90_000;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
interface PublicPart {
  id: string; sourceKey: string; sourceKind: string; originalNativeId: string; endpointScopeId: string; status: string;
  claimRevision: bigint; leaseOwner: string | null; leaseUntil: Date | null; publicSourceRevision: bigint | null;
  publicMetaCommentId: string | null; publicTelegramCommentId: string | null;
  fenceJson: unknown; payloadHash: string; projectionRecordedAt: Date | null;
  payloadVersion: number; payloadEncrypted: string; agentRevisionId: string | null;
}
interface Attempt { errorCode?: string | null; id: string; partId: string; claimRevision: bigint; outcome: string; providerMid: string | null }
interface LeaseContext { partId: string; attemptId: string; owner: string; claimRevision: bigint; original: ServerPublicCommentSnapshot; text: string }
export type PublicCommentReadWitness = Readonly<{ facts: CustomerPropertyFacts }>;
export function publicCommentWireTarget(row: ServerPublicCommentSnapshot): PublicReplyTarget {
  return row.target.channel === "TELEGRAM" ? { channel: "TELEGRAM", groupChatId: row.target.accountExternalId,
    messageId: row.target.commentId, postMessageId: row.target.publicationId }
    : { channel: row.target.channel, accountExternalId: row.target.accountExternalId, mediaId: row.target.publicationId,
      commentId: row.target.commentId, parentId: row.target.parentId };
}
function sameSource(current: ServerPublicCommentSnapshot | null, original: ServerPublicCommentSnapshot): boolean {
  return !!current && current.source.id === original.source.id && current.source.table === original.source.table &&
    current.sourceRevision === original.sourceRevision && current.settings.policyRevision === original.settings.policyRevision &&
    !!current.currentInstallation && !!original.currentInstallation && samePublicInstallation(current.currentInstallation, original.currentInstallation) &&
    isDeepStrictEqual(current.target, original.target) && current.text === original.text &&
    isDeepStrictEqual(current.proof, original.proof);
}
function botMayPost(current: ServerPublicCommentSnapshot): boolean {
  const s = current.settings;
  const enabled = current.target.channel === "INSTAGRAM" ? s.botInstagramEnabled && s.metaEnabled
    : current.target.channel === "FACEBOOK" ? s.botFacebookEnabled && s.metaEnabled : current.target.channel === "TELEGRAM" ? s.botTelegramEnabled : true;
  return current.status === "WORKING" && s.contractVersion === "scoped" && s.rolloutMode === "ACTIVE" && s.publicRead &&
    s.botEnabled && s.botCanAnswerComments && enabled;
}
async function factsCurrent(original: ServerPublicCommentSnapshot, witness?: PublicCommentReadWitness): Promise<boolean> {
  if (!witness) return true;
  const parsed = customerPropertyFactsSchema.safeParse(witness.facts); if (!parsed.success) return false;
  const fresh = await readPublicCommentPropertyFacts({ source: original.source, target: original.target, text: original.text });
  return !!fresh && fresh.propertyId === parsed.data.propertyId && fresh.signature === parsed.data.signature;
}
async function partTx(tx: TxClient, id: string, lock = false): Promise<PublicPart | null> {
  const rows = lock ? await tx.$queryRaw<PublicPart[]>`SELECT * FROM "CustomerOutboxPart" WHERE "id"=${id} FOR UPDATE`
    : await tx.$queryRaw<PublicPart[]>`SELECT * FROM "CustomerOutboxPart" WHERE "id"=${id}`;
  return rows[0] ?? null;
}
export async function publicCommentHasAutomaticAttempt(ref: PublicSourceRef): Promise<boolean> {
  const [row] = await prisma.$queryRaw<Array<{ exists: boolean }>>`SELECT EXISTS(SELECT 1 FROM "CustomerOutboxPart"
    WHERE "sourceKind" IN ('PUBLIC_COMMENT_REPLY','STAFF_PUBLIC_COMMENT_REPLY') AND "sourceKey"=${`${ref.table}:${ref.id}`}) AS exists`;
  return row?.exists === true;
}
/** A public READ identity is not a POST grant. Only the concrete DB issuer,
 * current ACTIVE bot policy/controller, immutable origin and P12 claim authorize this attempt.
 * Manual staff answer uses a separate fresh staff ACL/purpose adapter; no bot-principal fallback. */
export function createCustomerPublicReplyStore(input: { principal: PublicCommentPrincipal; text: string;
  agentRevisionId?: string; publicReadWitness?: PublicCommentReadWitness; publicDataWitness?: CustomerAgentDeliveryWitness }): PublicReplyStore {
  const original = inspectPublicCommentPrincipal(input.principal);
  const capturedInstallation = original?.currentInstallation;
  const knownText = input.text;
  const payload = customerDeliveryPayloadSchema.parse({ kind: "text", text: knownText });
  if (payload.kind !== "text") throw new Error("Public reply requires text payload");

  const leases = new WeakMap<PublicReplyLease, LeaseContext>();
  return {
    async claim(expectedSourceRevision, attemptKey, target, targetHash) {
      if (!original || BigInt(original.sourceRevision) !== expectedSourceRevision || !capturedInstallation ||
          !isDeepStrictEqual(target, publicCommentWireTarget(original)) || targetHash !== publicReplyTargetHash(target) ||
          knownText !== payload.text || !await factsCurrent(original, input.publicReadWitness)) return null;
      if ((await revalidatePublicCommentPrincipal(input.principal)).status !== "current") return null;
      return prisma.$transaction(async tx => {
        const current = await lockPublicCommentSourceTx(tx, original.source);
        if (!sameSource(current, original) || !current || !botMayPost(current)) return null;
        const source = await readPublicSourceRow(original.source, tx); if (!source) return null;
        const origin = publicCommentOrigin(source), now = Date.now();
        if (now < origin.originalReceivedAt || now - origin.originalReceivedAt > 15 * 60_000 || now >= origin.agentPin.providerDeadlineAt ||
            input.agentRevisionId !== undefined && input.agentRevisionId !== origin.agentPin.agentRevisionId) return null;
        const publicData = input.publicDataWitness ? await serializePublicCustomerAgentDeliveryEvidence(tx, {
          principal: input.principal, witness: input.publicDataWitness, text: payload.text }) : null;
        if (publicData && publicData.agentRevisionId !== origin.agentPin.agentRevisionId) return null;
        const plaintext = JSON.stringify(publicData ? { ...payload, publicData } : payload), payloadHash = sha(plaintext);
        // All prior editions of this source block auto retry, even when FK was SET NULL after deletion.
        const sourceKey = `${original.source.table}:${original.source.id}`;
        const [previous] = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "CustomerOutboxPart"
          WHERE "sourceKind" IN ('PUBLIC_COMMENT_REPLY','STAFF_PUBLIC_COMMENT_REPLY') AND "sourceKey"=${sourceKey} FOR UPDATE`;
        if (previous) return null;
        const id = randomUUID(), owner = randomUUID(), revision = 1n;
        const fence = { version: 1, surface: "public_comment", source: original.source, sourceRevision: original.sourceRevision,
          installation: capturedInstallation, policyRevision: original.settings.policyRevision, target: original.target };
        const transport = { version: 1, surface: "public_comment", installation: capturedInstallation, target: original.target };
        const partKey = sha(JSON.stringify(["PUBLIC_COMMENT_REPLY", sourceKey, original.sourceRevision]));
        const leaseUntil = new Date(now + LEASE_MS);
        await tx.$executeRaw`INSERT INTO "CustomerOutboxPart" ("id","partKey","ticketEventKey","inquiryId","originalNativeId","conversationId",
          "publicMetaCommentId","publicTelegramCommentId","publicSourceRevision","turnKey","ordinal","mode","sourceKind","sourceKey","agentRevisionId",
          "channel","endpointScopeId","transportJson","payloadEncrypted","payloadHash","payloadVersion","fenceJson","p03Json","receiptRefsJson",
          "status","claimRevision","leaseOwner","leaseUntil","createdAt","updatedAt")
          VALUES (${id},${partKey},NULL,NULL,${original.source.id},NULL,
            ${original.source.table === "meta" ? original.source.id : null},${original.source.table === "telegram" ? original.source.id : null},${expectedSourceRevision},
            ${`public:${sourceKey}`},0,'LIVE','PUBLIC_COMMENT_REPLY',${sourceKey},${origin.agentPin.agentRevisionId},
            ${original.target.channel},${capturedInstallation.id},${JSON.stringify(transport)}::jsonb,${encryptSecret(plaintext)},${payloadHash},1,
            ${JSON.stringify(fence)}::jsonb,${input.publicReadWitness ? JSON.stringify({ version: 1, kind: "public_facts", facts: input.publicReadWitness.facts }) : null}::jsonb,
            '[]'::jsonb,'IN_FLIGHT',${revision},${owner},${leaseUntil},now(),now())`;
        await tx.$executeRaw`INSERT INTO "CustomerDeliveryAttempt" ("id","partId","endpointScopeId","attemptNo","claimRevision","startedAt","outcome","dispatchFenceJson")
          VALUES (${attemptKey},${id},${capturedInstallation.id},1,${revision},now(),'IN_FLIGHT',${JSON.stringify(fence)}::jsonb)`;
        await tx.backgroundJob.create({ data: { type: "customer-outbox-dispatch", payload: { version: 1, partId: id }, maxAttempts: 5,
          dedupeKey: `customer-outbox-dispatch:${id}`, runAt: leaseUntil } });
        const lease: PublicReplyLease = Object.freeze({ attemptKey, targetHash, sourceRevision: expectedSourceRevision });
        leases.set(lease, { partId: id, attemptId: attemptKey, owner, claimRevision: revision, original, text: knownText });
        return lease;
      });
    },
    async isCurrent(lease) {
      const ctx = leases.get(lease); if (!ctx || !original) return false;
      if ((await revalidatePublicCommentPrincipal(input.principal)).status !== "current" || !await factsCurrent(original, input.publicReadWitness)) return false;
      return prisma.$transaction(async tx => {
        const current = await lockPublicCommentSourceTx(tx, original.source);
        if (!sameSource(current, original) || !current || !botMayPost(current)) return false;
        const row = await partTx(tx, ctx.partId, true);
        const [attempt] = await tx.$queryRaw<Attempt[]>`SELECT * FROM "CustomerDeliveryAttempt" WHERE "id"=${ctx.attemptId}`;
        const source = await readPublicSourceRow(original.source, tx); if (!source) return false;
        const origin = publicCommentOrigin(source);
        if (!row) return false;
        const publicData = decodeCustomerOutboxPublicData(row);
        if (publicData && !await customerAgentStoredPublicDataCurrent(publicData, row.agentRevisionId)) return false;
        return row.status === "IN_FLIGHT" && row.leaseOwner === ctx.owner && row.claimRevision === ctx.claimRevision &&
          !!row.leaseUntil && row.leaseUntil.getTime() > Date.now() && !!attempt && attempt.outcome === "IN_FLIGHT" &&
          attempt.partId === row.id && attempt.claimRevision === row.claimRevision && Date.now() < origin.agentPin.providerDeadlineAt;
      });
    },
    async complete(lease, receipt: PublicReplyReceipt, text) {
      const ctx = leases.get(lease); if (!ctx) throw new Error("Unrecognized public delivery lease");
      // ALWAYS retain the original observed provider result, even after controller/clock/source changes.
      await recordCustomerDeliveryAttemptOutcome(ctx.attemptId,
        receipt.outcome === "accepted" ? "ACCEPTED" : receipt.outcome === "refused" ? "REJECTED" : "UNKNOWN", receipt.providerId, receipt.reason);
      const [associated] = await prisma.$queryRaw<Attempt[]>`SELECT * FROM "CustomerDeliveryAttempt" WHERE "id"=${ctx.attemptId}`;
      if (!associated) throw new Error("Settled public delivery attempt unavailable");
      if (associated.outcome !== "ACCEPTED" || associated.providerMid !== receipt.providerId) {
        const authoritative: PublicReplyReceipt = { outcome: associated.outcome === "REJECTED" ? "refused" : "unknown",
          providerId: null, reason: associated.errorCode ?? "receipt_association_unknown" };
        return { applicable: false, receipt: authoritative };
      }
      if (text !== ctx.text || receipt.outcome !== "accepted") return false;
      return projectPublicReceipt(ctx.partId, ctx.attemptId, ctx.original, ctx.text);
    },
  };
}
/** Receipt projection, no provider I/O, model call or renewed actor grant. Clock expiry alone
 * does not erase an already observed acceptance; exact current source/installation/policy still required. */
async function projectPublicReceipt(partId: string, attemptId: string, original: ServerPublicCommentSnapshot, text: string): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const current = await lockPublicCommentSourceTx(tx, original.source);
    const part = await partTx(tx, partId, true); if (!part) return false;
    if (part.projectionRecordedAt) return true;
    if (!sameSource(current, original) || part.status !== "ACCEPTED" || part.originalNativeId !== original.source.id) return false;
    const [attempt] = await tx.$queryRaw<Attempt[]>`SELECT * FROM "CustomerDeliveryAttempt" WHERE "id"=${attemptId} AND "partId"=${partId}`;
    if (!attempt || attempt.outcome !== "ACCEPTED" || !attempt.providerMid) return false;
    const count = original.source.table === "meta" ? await tx.$executeRaw`UPDATE "InstagramComment" SET "status"='REPLIED',"replyText"=${text},
      "replyCommentId"=${attempt.providerMid},"repliedAt"=now(),"updatedAt"=now()
      WHERE "id"=${original.source.id} AND "publicSourceRevision"=${BigInt(original.sourceRevision)} AND "status" IN ('PENDING','WORKING','ERROR')`
      : await tx.$executeRaw`UPDATE "TelegramGroupComment" SET "status"='REPLIED',"replyText"=${text},"repliedAt"=now(),"updatedAt"=now()
      WHERE "id"=${original.source.id} AND "publicSourceRevision"=${BigInt(original.sourceRevision)} AND "status" IN ('PENDING','WORKING','ERROR')`;
    if (count !== 1) return false;
    await tx.$executeRaw`UPDATE "CustomerOutboxPart" SET "projectionRecordedAt"=now(),"updatedAt"=now() WHERE "id"=${partId} AND "status"='ACCEPTED'`;
    return true;
  });
}

/** Existing outbox job recovery only. Never sends/renews a plan, operation or physical attempt. */
export async function reconcileCustomerPublicOutboxPart(row: CustomerOutboxRow): Promise<{
  status: "accepted" | "unknown" | "suppressed" | "not_sent" | "waiting" | "missing"; projectionPending?: true;
}> {
  if (row.sourceKind === "STAFF_PUBLIC_COMMENT_REPLY") return reconcileCustomerStaffPublicOutboxPart(row);
  if (row.sourceKind !== "PUBLIC_COMMENT_REPLY") return { status: "missing" };
  const parsed = publicCommentDeliveryFenceSchema.safeParse(row.fenceJson), transport = publicCommentDeliveryTransportSchema.safeParse(row.transportJson);
  if (!parsed.success || !transport.success || row.inquiryId !== null || row.ticketEventKey !== null || row.conversationId !== null ||
      row.originalNativeId !== parsed.data.source.id || row.sourceKey !== `${parsed.data.source.table}:${parsed.data.source.id}` ||
      row.endpointScopeId !== parsed.data.installation.id || !isDeepStrictEqual(transport.data.installation, parsed.data.installation) ||
      !isDeepStrictEqual(transport.data.target, parsed.data.target)) return { status: "suppressed" };
  const fence = parsed.data;
  const [attempt] = await prisma.$queryRaw<Attempt[]>`SELECT * FROM "CustomerDeliveryAttempt" WHERE "partId"=${row.id} AND "attemptNo"=1`;
  if (row.status === "IN_FLIGHT") {
    if (row.leaseUntil && row.leaseUntil.getTime() > Date.now()) return { status: "waiting" };
    if (attempt?.outcome === "IN_FLIGHT") await recordCustomerDeliveryAttemptOutcome(attempt.id, "UNKNOWN", null, "public_lease_expired");
    return { status: "unknown" };
  }
  if (row.status === "UNKNOWN") return { status: "unknown" };
  if (row.status === "NOT_SENT") return { status: "not_sent" };
  if (row.status !== "ACCEPTED") return { status: row.status === "SUPPRESSED" ? "suppressed" : "waiting" };
  if (row.projectionRecordedAt) return { status: "accepted" };
  if (!attempt || attempt.outcome !== "ACCEPTED" || !attempt.providerMid) return { status: "accepted", projectionPending: true };
  const current = await loadPublicCommentSource(fence.source);
  // This is conditional receipt projection from the persisted immutable target, not a fresh POST principal.
  if (!current || current.sourceRevision !== fence.sourceRevision || current.settings.policyRevision !== fence.policyRevision ||
      !current.currentInstallation || !samePublicInstallation(current.currentInstallation, fence.installation) ||
      !isDeepStrictEqual(current.target, fence.target) || !current.proof || current.proof.sourceRevision !== fence.sourceRevision) {
    return { status: "accepted", projectionPending: true };
  }
  const payload = decodeCustomerOutboxPayload(row);
  if (payload.kind !== "text") return { status: "accepted", projectionPending: true };
  if (row.p03Json !== null) {
    const witness = publicCommentFactsWitnessSchema.safeParse(row.p03Json);
    if (!witness.success || !await factsCurrent(current, witness.data)) return { status: "accepted", projectionPending: true };
  }
  const projected = await projectPublicReceipt(row.id, attempt.id, current, payload.text);
  return { status: "accepted", ...(!projected ? { projectionPending: true as const } : {}) };
}

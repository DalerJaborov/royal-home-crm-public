import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parsePermissionOverrides, resolvePermissions, isReadOnlyRole, staffPublicCommentDeliveryFenceSchema,
  staffPublicCommentDeliveryTransportSchema, type StaffPublicCommentDeliveryFence, type PublicReplyReceipt } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { encryptSecret } from "../crypto.js";
import { customerDeliveryPayloadSchema, type CustomerOutboxRow, type CustomerAttemptRow } from "./customerDeliveryContracts.js";
import { decodeCustomerOutboxPayload } from "./customerOutbox.js";
import { recordCustomerDeliveryAttemptOutcome } from "./customerDeliverySettlement.js";
import { loadPublicCommentSource, publicCommentOrigin, readPublicSourceRow, readPublicCommentMetaToken } from "./customerPublicCommentStore.js";
import { publicCommentSourceDigest, samePublicInstallation } from "./publicCommentSourceIdentity.js";
import { moderationErrorOutcome } from "../messengers/commentModerationOutcome.js";

export type PublicManualReplyClaim = Readonly<{ sourceId: string; revision: string }>;
interface Claim { partId: string; attemptId: string; owner: string; fence: StaffPublicCommentDeliveryFence;
  text: string; physicalClaimed: boolean; physicalAdmitted: boolean; repeatedPhysicalClaim: boolean }
const claims = new WeakMap<object, Claim>(), sha = (s: string) => createHash("sha256").update(s).digest("hex");
const LEASE_MS = 90_000;
export class PublicManualReplyHeld extends Error {
  constructor(readonly status: 403 | 409, readonly code: "PUBLIC_REPLY_HELD" | "STAFF_PERMISSION_CHANGED" = "PUBLIC_REPLY_HELD") { super(code); }
}
async function staffMayReply(tx: TxClient, id: string): Promise<boolean> {
  const agent = await tx.agent.findUnique({ where: { id }, select: { role: true, isActive: true, permissions: true } });
  if (!agent?.isActive || isReadOnlyRole(agent.role)) return false;
  const p = resolvePermissions(agent.role, parsePermissionOverrides(agent.permissions));
  return p.has("messages.view") && p.has("comments.moderate");
}
async function priorParts(tx: TxClient, id: string) {
  return tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "CustomerOutboxPart"
    WHERE "sourceKind" IN ('PUBLIC_COMMENT_REPLY','STAFF_PUBLIC_COMMENT_REPLY') AND "sourceKey"=${`meta:${id}`} ORDER BY "id" FOR UPDATE`;
}
/** Actual staff purpose. No BOT principal, current bot switch, model operation or fictional Inquiry. */
export async function claimPublicManualCommentReply(sourceId: string, staffId: string, text: string): Promise<PublicManualReplyClaim | null> {
  const payload = customerDeliveryPayloadSchema.parse({ kind: "text", text }), plaintext = JSON.stringify(payload);
  if (payload.kind !== "text") throw new TypeError("Staff public text required");
  return prisma.$transaction(async tx => {
    const source = await readPublicSourceRow({ table: "meta", id: sourceId }, tx, true);
    if (!source) throw new PublicManualReplyHeld(409);
    if (!await staffMayReply(tx, staffId)) throw new PublicManualReplyHeld(403, "STAFF_PERMISSION_CHANGED");
    if (!source.originCiphertext) { if ((await priorParts(tx, sourceId)).length) throw new PublicManualReplyHeld(409); return null; }
    let origin;
    try { origin = publicCommentOrigin(source); } catch { throw new PublicManualReplyHeld(409); }
    await tx.$queryRaw`SELECT "id" FROM "CustomerEndpointScope" WHERE "id"=${origin.proof.installation.id} FOR SHARE`;
    if ((await priorParts(tx, sourceId)).length) throw new PublicManualReplyHeld(409);
    const snapshot = await loadPublicCommentSource({ table: "meta", id: sourceId }, tx);
    if (!snapshot?.currentInstallation || source.sourceRevision !== origin.proof.sourceRevision ||
        !["PENDING", "ERROR"].includes(source.status) || publicCommentSourceDigest(snapshot) !== origin.proof.digest ||
        !samePublicInstallation(origin.proof.installation, snapshot.currentInstallation)) throw new PublicManualReplyHeld(409);
    const changed = await tx.instagramComment.updateMany({ where: { id: sourceId, publicSourceRevision: BigInt(source.sourceRevision), status: source.status },
      data: { status: "WORKING_STAFF", note: "manual_reply_in_progress" } });
    if (changed.count !== 1) throw new PublicManualReplyHeld(409);
    const claimed = await readPublicSourceRow({ table: "meta", id: sourceId }, tx);
    if (!claimed || claimed.status !== "WORKING_STAFF" || BigInt(claimed.sourceRevision) <= BigInt(source.sourceRevision)) throw new PublicManualReplyHeld(409);
    const fence = staffPublicCommentDeliveryFenceSchema.parse({ version: 1, surface: "staff_public_comment", purpose: "staff_public_reply",
      source: snapshot.source, originalSourceRevision: source.sourceRevision, sourceRevision: claimed.sourceRevision,
      originDigest: origin.proof.digest, installation: snapshot.currentInstallation, target: snapshot.target,
      staffAgentId: staffId, claimNonce: randomUUID() });
    const transport = staffPublicCommentDeliveryTransportSchema.parse({ version: 1, surface: "staff_public_comment", installation: fence.installation, target: fence.target });
    const id = randomUUID(), attemptId = randomUUID(), owner = randomUUID(), until = new Date(Date.now() + LEASE_MS), sourceKey = `meta:${sourceId}`;
    const partKey = sha(JSON.stringify(["STAFF_PUBLIC_COMMENT_REPLY", sourceKey, fence.sourceRevision]));
    await tx.$executeRaw`INSERT INTO "CustomerOutboxPart" ("id","partKey","ticketEventKey","inquiryId","originalNativeId","conversationId",
      "publicMetaCommentId","publicTelegramCommentId","publicSourceRevision","turnKey","ordinal","mode","sourceKind","sourceKey","agentRevisionId",
      "channel","endpointScopeId","transportJson","payloadEncrypted","payloadHash","payloadVersion","fenceJson","p03Json","receiptRefsJson",
      "status","claimRevision","leaseOwner","leaseUntil","createdAt","updatedAt") VALUES (${id},${partKey},NULL,NULL,${sourceId},NULL,
      ${sourceId},NULL,${BigInt(fence.sourceRevision)},${`staff-public:${sourceKey}:${fence.sourceRevision}`},0,'LIVE','STAFF_PUBLIC_COMMENT_REPLY',${sourceKey},NULL,
      ${fence.target.channel},${fence.installation.id},${JSON.stringify(transport)}::jsonb,${encryptSecret(plaintext)},${sha(plaintext)},1,
      ${JSON.stringify(fence)}::jsonb,NULL,'[]'::jsonb,'IN_FLIGHT',1,${owner},${until},now(),now())`;
    await tx.$executeRaw`INSERT INTO "CustomerDeliveryAttempt" ("id","partId","endpointScopeId","attemptNo","claimRevision","startedAt","outcome","dispatchFenceJson")
      VALUES (${attemptId},${id},${fence.installation.id},1,1,now(),'IN_FLIGHT',${JSON.stringify(fence)}::jsonb)`;
    await tx.backgroundJob.create({ data: { type: "customer-outbox-dispatch", payload: { version: 1, partId: id }, maxAttempts: 5,
      dedupeKey: `customer-outbox-dispatch:${id}`, runAt: until } });
    const claim = Object.freeze({ sourceId, revision: fence.sourceRevision });
    claims.set(claim, { partId: id, attemptId, owner, fence, text: payload.text, physicalClaimed: false, physicalAdmitted: false, repeatedPhysicalClaim: false });
    return claim;
  });
}
async function lockStaffSource(tx: TxClient, fence: StaffPublicCommentDeliveryFence): Promise<boolean> {
  const source = await readPublicSourceRow(fence.source, tx, true);
  if (!source || source.status !== "WORKING_STAFF" || source.sourceRevision !== fence.sourceRevision) return false;
  await tx.$queryRaw`SELECT "id" FROM "CustomerEndpointScope" WHERE "id"=${fence.installation.id} FOR SHARE`;
  const snapshot = await loadPublicCommentSource(fence.source, tx);
  return !!snapshot?.currentInstallation && !!snapshot.proof && snapshot.proof.sourceRevision === fence.originalSourceRevision &&
    snapshot.proof.digest === fence.originDigest && publicCommentSourceDigest(snapshot) === fence.originDigest &&
    isDeepStrictEqual(snapshot.target, fence.target) && samePublicInstallation(snapshot.currentInstallation, fence.installation);
}
export async function publicManualReplyToken(value: PublicManualReplyClaim): Promise<string> {
  const ctx = claims.get(value); if (!ctx) throw new PublicManualReplyHeld(409);
  const token = await readPublicCommentMetaToken(ctx.fence.installation); if (!token) throw new PublicManualReplyHeld(409); return token;
}
export function publicManualReplyTarget(value: PublicManualReplyClaim) {
  const ctx = claims.get(value); if (!ctx) throw new PublicManualReplyHeld(409);
  return Object.freeze({ ...ctx.fence.target });
}
export function publicManualReplyFailure(value: PublicManualReplyClaim, error: unknown): PublicReplyReceipt {
  const ctx = claims.get(value); if (!ctx) throw new PublicManualReplyHeld(409);
  const failed = moderationErrorOutcome(ctx.fence.target.channel, "delete", error);
  return { outcome: failed.outcome === "refused" ? "refused" : "unknown", providerId: null,
    reason: failed.outcome === "refused" ? failed.reason : "unconfirmed_post" };
}
/** One logical attempt admits at most one physical POST, including retries/concurrent callbacks. */
export async function assertPublicManualReplyCurrent(value: PublicManualReplyClaim): Promise<void> {
  const ctx = claims.get(value); if (!ctx) throw new PublicManualReplyHeld(409);
  if (ctx.physicalClaimed) { ctx.repeatedPhysicalClaim = true; throw new PublicManualReplyHeld(409); }
  ctx.physicalClaimed = true;
  const valid = await prisma.$transaction(async tx => {
    if (!await lockStaffSource(tx, ctx.fence)) return false;
    if (!await staffMayReply(tx, ctx.fence.staffAgentId)) throw new PublicManualReplyHeld(403, "STAFF_PERMISSION_CHANGED");
    const [part] = await tx.$queryRaw<CustomerOutboxRow[]>`SELECT * FROM "CustomerOutboxPart" WHERE "id"=${ctx.partId} FOR UPDATE`;
    const [attempt] = await tx.$queryRaw<CustomerAttemptRow[]>`SELECT * FROM "CustomerDeliveryAttempt" WHERE "id"=${ctx.attemptId}`;
    return !!part && part.status === "IN_FLIGHT" && part.sourceKind === "STAFF_PUBLIC_COMMENT_REPLY" && part.claimRevision === 1n &&
      part.leaseOwner === ctx.owner && !!part.leaseUntil && part.leaseUntil.getTime() > Date.now() && !part.cancelRequestedAt &&
      isDeepStrictEqual(part.fenceJson, ctx.fence) && !!attempt && attempt.partId === part.id && attempt.claimRevision === 1n && attempt.outcome === "IN_FLIGHT";
  });
  if (!valid) throw new PublicManualReplyHeld(409); ctx.physicalAdmitted = true;
}
/** Recording an observed acceptance never requires the old actor/source grant to remain active. */
export async function completePublicManualReply(value: PublicManualReplyClaim, observed: PublicReplyReceipt): Promise<{ receipt: PublicReplyReceipt; applicable: boolean }> {
  const ctx = claims.get(value); if (!ctx) throw new PublicManualReplyHeld(409);
  const receipt: PublicReplyReceipt = observed.outcome === "accepted" && (!ctx.physicalAdmitted || ctx.repeatedPhysicalClaim)
    ? { outcome: "unknown", providerId: null, reason: "physical_post_callback_unconfirmed" } : observed;
  await recordCustomerDeliveryAttemptOutcome(ctx.attemptId, receipt.outcome === "accepted" ? "ACCEPTED" : receipt.outcome === "refused" ? "REJECTED" : "UNKNOWN", receipt.providerId, receipt.reason);
  const [attempt] = await prisma.$queryRaw<CustomerAttemptRow[]>`SELECT * FROM "CustomerDeliveryAttempt" WHERE "id"=${ctx.attemptId}`;
  if (!attempt) throw new Error("Staff public receipt unavailable after settlement");
  const authoritative: PublicReplyReceipt = attempt.outcome === "ACCEPTED" && attempt.providerMid
    ? { outcome: "accepted", providerId: attempt.providerMid, reason: "provider_id" }
    : { outcome: attempt.outcome === "REJECTED" ? "refused" : "unknown", providerId: null, reason: "errorCode" in attempt && typeof attempt.errorCode === "string" ? attempt.errorCode : "staff_receipt_unconfirmed" };
  if (authoritative.outcome !== "accepted") return { receipt: authoritative, applicable: false };
  // DB projection failure is a pending local repair, never loss/reclassification of the committed accepted receipt.
  let applicable = false;
  try { applicable = await projectStaffReceipt(ctx.partId, ctx.attemptId, ctx.fence, ctx.text); } catch { /* Required P12 job repairs; no resend. */ }
  return { receipt: authoritative, applicable };
}
async function projectStaffReceipt(partId: string, attemptId: string, fence: StaffPublicCommentDeliveryFence, text: string): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const sourceCurrent = await lockStaffSource(tx, fence);
    const [part] = await tx.$queryRaw<CustomerOutboxRow[]>`SELECT * FROM "CustomerOutboxPart" WHERE "id"=${partId} FOR UPDATE`;
    if (!part) return false; if (part.projectionRecordedAt) return true;
    if (!sourceCurrent || part.status !== "ACCEPTED" || part.sourceKind !== "STAFF_PUBLIC_COMMENT_REPLY" || !isDeepStrictEqual(part.fenceJson, fence)) return false;
    const [attempt] = await tx.$queryRaw<CustomerAttemptRow[]>`SELECT * FROM "CustomerDeliveryAttempt" WHERE "id"=${attemptId} AND "partId"=${partId}`;
    if (!attempt || attempt.outcome !== "ACCEPTED" || !attempt.providerMid) return false;
    const changed = await tx.instagramComment.updateMany({ where: { id: fence.source.id, status: "WORKING_STAFF", publicSourceRevision: BigInt(fence.sourceRevision) },
      data: { status: "REPLIED", replyText: text, replyCommentId: attempt.providerMid, repliedAt: new Date(), note: "manual_reply" } });
    if (changed.count !== 1) return false;
    await tx.$executeRaw`UPDATE "CustomerOutboxPart" SET "projectionRecordedAt"=now(),"updatedAt"=now() WHERE "id"=${partId} AND "status"='ACCEPTED'`;
    return true;
  });
}
/** Existing public Dispatcher delegates here. Recovery never creates a grant/attempt or performs a POST. */
export async function reconcileCustomerStaffPublicOutboxPart(row: CustomerOutboxRow): Promise<{
  status: "accepted" | "unknown" | "suppressed" | "not_sent" | "waiting" | "missing"; projectionPending?: true;
}> {
  if (row.sourceKind !== "STAFF_PUBLIC_COMMENT_REPLY") return { status: "missing" };
  const parsed = staffPublicCommentDeliveryFenceSchema.safeParse(row.fenceJson), transport = staffPublicCommentDeliveryTransportSchema.safeParse(row.transportJson);
  if (!parsed.success || !transport.success || row.inquiryId !== null || row.conversationId !== null || row.ticketEventKey !== null ||
      row.originalNativeId !== parsed.data.source.id ||
      !(row.publicMetaCommentId === parsed.data.source.id || row.publicMetaCommentId === null && row.cancelRequestedAt !== null) || row.publicTelegramCommentId !== null ||
      row.publicSourceRevision?.toString() !== parsed.data.sourceRevision || row.sourceKey !== `meta:${parsed.data.source.id}` ||
      row.endpointScopeId !== parsed.data.installation.id || !isDeepStrictEqual(transport.data.installation, parsed.data.installation) ||
      !isDeepStrictEqual(transport.data.target, parsed.data.target)) return { status: "suppressed" };
  const [attempt] = await prisma.$queryRaw<CustomerAttemptRow[]>`SELECT * FROM "CustomerDeliveryAttempt" WHERE "partId"=${row.id} AND "attemptNo"=1`;
  if (row.status === "IN_FLIGHT") {
    if (row.leaseUntil && row.leaseUntil.getTime() > Date.now()) return { status: "waiting" };
    if (attempt?.outcome === "IN_FLIGHT") await recordCustomerDeliveryAttemptOutcome(attempt.id, "UNKNOWN", null, "staff_public_lease_expired");
    return { status: "unknown" };
  }
  if (row.status === "UNKNOWN") return { status: "unknown" };
  if (row.status === "NOT_SENT") return { status: "not_sent" };
  if (row.status !== "ACCEPTED") return { status: row.status === "SUPPRESSED" ? "suppressed" : "waiting" };
  if (row.projectionRecordedAt) return { status: "accepted" };
  if (!attempt || attempt.outcome !== "ACCEPTED" || !attempt.providerMid) return { status: "accepted", projectionPending: true };
  const payload = decodeCustomerOutboxPayload(row); if (payload.kind !== "text") return { status: "accepted", projectionPending: true };
  const projected = await projectStaffReceipt(row.id, attempt.id, parsed.data, payload.text);
  return { status: "accepted", ...(!projected ? { projectionPending: true as const } : {}) };
}

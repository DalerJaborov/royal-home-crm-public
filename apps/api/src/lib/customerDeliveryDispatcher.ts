import { customerHandoverAckFenceSchema, customerHandoverAckText } from "@royal-home/shared";
import { lockCustomerHandoverAckSourceTx, validateCustomerHandoverAckPartTx } from "./customerHandoverAck.js";
import { recordCustomerDeliveryAttemptOutcome } from "./customerDeliverySettlement.js";
export { recordCustomerDeliveryAttemptOutcome } from "./customerDeliverySettlement.js";
export { inspectCustomerDeliveryObservation } from "./customerDeliveryObservation.js";
import { randomUUID } from "node:crypto";
import { prisma, type TxClient } from "../db.js";
import { assertCustomerFence, lockCustomerStateSnapshot } from "./customerState.js";
import { resolveCustomerEndpoint } from "./customerConversationScope.js";
import { customerPropertyReplyFactsFresh } from "./customerPropertyDelivery.js";
import { observeManagedCustomerResource } from "./customerActionEffects.js";
import { decodeCustomerOutboxPayload, decodeCustomerOutboxPublicData, readCustomerOutboxPart } from "./customerOutbox.js";
import { customerDeliveryFenceSchema, customerDeliveryTransportSchema, customerDeliveryP03Schema,
  customerDeliveryControllerFence, customerDeliveryReceiptsSchema, type CustomerOutboxRow, type CustomerAttemptRow } from "./customerDeliveryContracts.js";
import { CustomerDeliveryHeldError, withCustomerDeliveryTransport } from "./customerDeliveryTransport.js";
import { sendCustomerDeliveryPayload, projectCustomerDeliveryPartTx, supportsCustomerDeliveryPayload } from "./customerDeliveryAdapters.js";
import { admitOutbound } from "./outboundShield.js";
import { publishMessageNew } from "./livePublish.js";
import { reconcileCustomerPublicOutboxPart } from "./customerPublicDelivery.js";

import { customerAgentStoredPublicDataCurrent } from "./customerAgentDeliveryEvidence.js";
import { hasNewerCustomerInboxInput } from "./customerNewerInboxInput.js";

const LEASE_MS = 90_000;
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);
export type CustomerDispatchResult = { status: "accepted" | "available_widget" | "unknown" | "suppressed" | "not_sent" | "waiting" | "missing"; projectionPending?: true };

/** No model call, new action or target inference. Stored plan is server-issued;
 * fresh canonical/transport/facts/resource checks are repeated per physical POST. */
async function validatePart(tx: TxClient, row: CustomerOutboxRow): Promise<boolean> {
  if (row.sourceKind === "HANDOVER_ACK") {
    if (!await validateCustomerHandoverAckPartTx(tx, row)) return false;
    const witness = customerHandoverAckFenceSchema.parse(row.fenceJson), payload = decodeCustomerOutboxPayload(row);
    return payload.kind === "text" && payload.text === customerHandoverAckText(witness.language) && decodeCustomerOutboxPublicData(row) === null;
  }
  if (!row.inquiryId || !row.ticketEventKey || !row.conversationId || row.sourceKind !== "BOT_TURN" ||
      row.publicMetaCommentId !== null || row.publicTelegramCommentId !== null || row.publicSourceRevision !== null) return false;
  const fence = customerDeliveryFenceSchema.parse(row.fenceJson), transport = customerDeliveryTransportSchema.parse(row.transportJson);
  if (row.mode !== "LIVE" || row.sourceKind !== "BOT_TURN" || row.sourceKey !== row.ticketEventKey ||
      row.cancelRequestedAt || row.supersededAt || row.conversationId !== row.originalNativeId ||
      fence.nativeId !== row.originalNativeId || row.inquiryId !== fence.inquiryId || transport.channel !== row.channel ||
      transport.endpointScopeId !== row.endpointScopeId || row.endpointScopeId !== fence.endpoint.endpointScopeId ||
      transport.accountId !== fence.endpoint.accountId || transport.scopeRevision !== fence.scopeRevision) return false;
  if ((await assertCustomerFence(tx, fence, "outbound")).status !== "current") return false;
  const recovery = await tx.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS(SELECT 1 FROM "RecruitmentRecovery" WHERE "originalConversationId"=${row.originalNativeId} AND "status"='IN_FLIGHT' AND "fenceJson"=${JSON.stringify(customerDeliveryControllerFence(row))}::jsonb) AS blocked`;
  if (recovery[0]?.blocked) return false;
  await resolveCustomerEndpoint({ channel: row.channel, subscriberId: fence.endpoint.peerId, transport }, tx);
  const [ticket] = await tx.$queryRaw<{ current: boolean }[]>`SELECT EXISTS(SELECT 1 FROM "CustomerPropertyIngressTicket" t
    JOIN "CustomerInquiry" i ON i."id"=${row.inquiryId} WHERE t."eventKey"=${row.ticketEventKey}
      AND t."conversationId"=${row.originalNativeId} AND t."endpointScopeId"=${row.endpointScopeId}
      AND i."lastAcceptedEventKey"=t."eventKey" AND i."lastAcceptedOrder"=t."order") AS current`;
  if (!ticket?.current) return false;
  if (row.agentRevisionId && await hasNewerCustomerInboxInput(row.ticketEventKey, tx)) return false;
  const payload = decodeCustomerOutboxPayload(row);
  const publicData = decodeCustomerOutboxPublicData(row);
  if (publicData && !await customerAgentStoredPublicDataCurrent(publicData, row.agentRevisionId)) return false;
  if (!supportsCustomerDeliveryPayload(row, payload)) return false;
  if (row.p03Json !== null) {
    const delivery = customerDeliveryP03Schema.parse(row.p03Json);
    if (delivery.inputEventKey !== row.ticketEventKey || !await customerPropertyReplyFactsFresh({
      conversationId: row.originalNativeId, channel: transport.channel, peer: fence.endpoint.peerId,
      accountId: transport.accountId, endpointScopeId: transport.endpointScopeId, accountExternalId: transport.accountExternalId,
      text: payload.kind === "text" ? payload.text : "", delivery,
    }, tx)) return false;
  }
  for (const receipt of customerDeliveryReceiptsSchema.parse(row.receiptRefsJson)) {
    if (receipt.inquiryId !== row.inquiryId) return false;
    const [action] = await tx.$queryRaw<{ valid: boolean }[]>`SELECT EXISTS(SELECT 1 FROM "CustomerAction" WHERE "id"=${receipt.actionId}
      AND "inquiryId"=${row.inquiryId} AND "kind"=${receipt.kind} AND "generation"=${BigInt(receipt.generation)}
      AND "status"='COMMITTED' AND "supersededAt" IS NULL AND "resourceId"=${receipt.resourceId}
      AND "resourceType"=${receipt.resourceType} AND "bindingRevision"=${BigInt(fence.bindingRevision)}) AS valid`;
    if (!action?.valid) return false;
    if (receipt.kind !== "contact" && receipt.kind !== "new_lead" && await observeManagedCustomerResource(tx, receipt) !== "active") return false;
  }
  return true;
}

async function lockPartState(tx: TxClient, row: CustomerOutboxRow): Promise<boolean> {
  if (row.sourceKind === "HANDOVER_ACK") return lockCustomerHandoverAckSourceTx(tx, row.fenceJson);
  if (!row.inquiryId || !row.ticketEventKey || !row.conversationId || row.sourceKind !== "BOT_TURN" ||
      row.publicMetaCommentId !== null || row.publicTelegramCommentId !== null || row.publicSourceRevision !== null) return false;
  const parsed = customerDeliveryFenceSchema.safeParse(row.fenceJson);
  if (!parsed.success || parsed.data.inquiryId !== row.inquiryId || parsed.data.nativeId !== row.originalNativeId) return false;
  const fence = parsed.data;
  // Match the established native → exact scope → policy → Inquiry → outbox order.
  return !!await lockCustomerStateSnapshot(tx, { inquiryId: fence.inquiryId });
}
async function claimPart(id: string, owner: string): Promise<CustomerOutboxRow | null> {
  const initial = await readCustomerOutboxPart(id);
  if (!initial) return null;
  return prisma.$transaction(async tx => {
    if (!await lockPartState(tx, initial)) {
      const rows = await tx.$queryRaw<CustomerOutboxRow[]>`UPDATE "CustomerOutboxPart" SET "status"='SUPPRESSED',"supersededAt"=now(),"updatedAt"=now()
        WHERE "id"=${id} AND "status"='READY' RETURNING *`;
      return rows[0] ?? await readCustomerOutboxPart(id, tx);
    }
    const [row] = await tx.$queryRaw<CustomerOutboxRow[]>`SELECT * FROM "CustomerOutboxPart" WHERE "id"=${id} FOR UPDATE`;
    if (!row || row.status !== "READY" || row.mode !== "LIVE" || row.nextAttemptAt && row.nextAttemptAt.getTime() > Date.now()) return row ?? null;
    if (!await validatePart(tx, row)) {
      await tx.$executeRaw`UPDATE "CustomerOutboxPart" SET "status"='SUPPRESSED',"supersededAt"=now(),"updatedAt"=now() WHERE "id"=${id}`;
      return { ...row, status: "SUPPRESSED" };
    }
    const [preceding] = await tx.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS(SELECT 1 FROM "CustomerOutboxPart"
      WHERE "turnKey"=${row.turnKey} AND "inquiryId"=${row.inquiryId} AND "mode"='LIVE' AND "ordinal"<${row.ordinal}
      AND "status" NOT IN ('ACCEPTED','AVAILABLE_WIDGET')) AS blocked`;
    if (preceding?.blocked) return null;
    const updated = await tx.$queryRaw<CustomerOutboxRow[]>`UPDATE "CustomerOutboxPart" SET "status"='IN_FLIGHT',
      "claimRevision"="claimRevision"+1,"leaseOwner"=${owner},"leaseUntil"=now()+${LEASE_MS}*interval '1 millisecond',"updatedAt"=now()
      WHERE "id"=${id} AND "status"='READY' RETURNING *`;
    return updated[0] ?? null;
  });
}
async function beginAttempt(row: CustomerOutboxRow, owner: string): Promise<CustomerAttemptRow> {
  return prisma.$transaction(async tx => {
    if (!await lockPartState(tx, row)) throw new CustomerDeliveryHeldError("native_missing");
    const [current] = await tx.$queryRaw<CustomerOutboxRow[]>`SELECT * FROM "CustomerOutboxPart" WHERE "id"=${row.id} FOR UPDATE`;
    if (!current || current.status !== "IN_FLIGHT" || current.leaseOwner !== owner || current.claimRevision !== row.claimRevision ||
      !current.leaseUntil || current.leaseUntil.getTime() <= Date.now() || !await validatePart(tx, current)) throw new CustomerDeliveryHeldError("stale_before_post");
    const [existing] = await tx.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM "CustomerDeliveryAttempt" WHERE "partId"=${row.id}`;
    // No automatic second attempt. NOT_SENT may be retried only by an explicit
    // bounded future recovery decision, never by generic job redelivery.
    if (existing?.count) throw new CustomerDeliveryHeldError("attempt_already_exists");
    const attempts = await tx.$queryRaw<CustomerAttemptRow[]>`INSERT INTO "CustomerDeliveryAttempt"
      ("id","partId","endpointScopeId","attemptNo","claimRevision","startedAt","outcome","dispatchFenceJson")
      VALUES (${randomUUID()},${row.id},${row.endpointScopeId},1,${row.claimRevision},now(),'IN_FLIGHT',${JSON.stringify(row.fenceJson)}::jsonb) RETURNING *`;
    return attempts[0];
  });
}
/** Late provider status must already be correlated with the exact attempt by a
 * server adapter. Text/hash matching or MID-only global lookup is forbidden. */
export async function acceptLateCustomerDeliveryMid(input: { attemptId: string; endpointScopeId: string; mid: string }): Promise<boolean> {
  const rows = await prisma.$queryRaw<CustomerAttemptRow[]>`SELECT * FROM "CustomerDeliveryAttempt" WHERE "id"=${input.attemptId}
    AND "endpointScopeId"=${input.endpointScopeId}`;
  if (rows.length !== 1) return false;
  await recordCustomerDeliveryAttemptOutcome(input.attemptId, "ACCEPTED", input.mid);
  const [associated] = await prisma.$queryRaw<CustomerAttemptRow[]>`SELECT * FROM "CustomerDeliveryAttempt" WHERE "id"=${input.attemptId}`;
  return associated?.outcome === "ACCEPTED" && associated.providerMid === input.mid;
}

async function projectAccepted(row: CustomerOutboxRow): Promise<boolean> {
  const projected = await prisma.$transaction(async tx => {
    // Projection repair requires the original binding; a late receipt does not
    // permit customer OUT after native deletion/rebind. It can remain unprojected.
    if (!await lockPartState(tx, row)) return false;
    const current = await readCustomerOutboxPart(row.id, tx);
    if (!current || !["ACCEPTED", "AVAILABLE_WIDGET"].includes(current.status)) return false;
    if (current.projectionRecordedAt) return true;
    const fence = customerDeliveryControllerFence(current);
    const [binding] = await tx.$queryRaw<{ valid: boolean }[]>`SELECT EXISTS(SELECT 1 FROM "CustomerInquiry" i JOIN "BotConversation" c ON c."id"=i."conversationId"
      WHERE i."id"=${current.inquiryId} AND i."conversationId"=${current.originalNativeId} AND i."closedAt" IS NULL
      AND i."bindingRevision"=${BigInt(fence.bindingRevision)} AND c."endpointScopeId"=${current.endpointScopeId}
      AND c."subscriberId"=${fence.endpoint.peerId} AND c."accountId" IS NOT DISTINCT FROM ${fence.endpoint.accountId}) AS valid`;
    if (!binding?.valid) return false;
    const [attempt] = await tx.$queryRaw<CustomerAttemptRow[]>`SELECT * FROM "CustomerDeliveryAttempt" WHERE "partId"=${row.id} AND "outcome"='ACCEPTED' ORDER BY "attemptNo" DESC LIMIT 1`;
    return projectCustomerDeliveryPartTx(tx, current, decodeCustomerOutboxPayload(current), attempt?.providerMid ?? null);
  });
  if (projected) void publishMessageNew("bot", row.originalNativeId, "OUT");
  return projected;
}

export async function dispatchCustomerOutboxPart(id: string): Promise<CustomerDispatchResult> {
  const initial = await readCustomerOutboxPart(id);
  if (!initial) return { status: "missing" };
  // Public parts are claimed/posted only by the public adapter. A durable job
  // reconciles its existing attempt; it must NEVER enter DM parsing or POST.
  if (initial.sourceKind === "PUBLIC_COMMENT_REPLY" || initial.sourceKind === "STAFF_PUBLIC_COMMENT_REPLY") return reconcileCustomerPublicOutboxPart(initial);
  const owner = randomUUID(), row = await claimPart(id, owner);
  if (!row) return { status: await readCustomerOutboxPart(id) ? "waiting" : "missing" };
  if (row.status === "ACCEPTED" || row.status === "AVAILABLE_WIDGET") {
    const projected = await projectAccepted(row);
    return { status: row.status === "ACCEPTED" ? "accepted" : "available_widget", ...(!projected ? { projectionPending: true as const } : {}) };
  }
  if (row.status !== "IN_FLIGHT" || row.leaseOwner !== owner) return { status: row.status === "UNKNOWN" ? "unknown" : row.status === "SUPPRESSED" ? "suppressed" : row.status === "NOT_SENT" ? "not_sent" : "waiting" };
  if (row.channel === "WEBSITE") {
    const payload = decodeCustomerOutboxPayload(row), fence = customerDeliveryFenceSchema.parse(row.fenceJson);
    if (payload.kind !== "text") return { status: "suppressed" };
    const verdict = await admitOutbound({ channel: "WEBSITE", subscriberId: fence.endpoint.peerId, text: payload.text,
      transport: customerDeliveryTransportSchema.parse(row.transportJson) });
    if (!verdict.allowed) {
      await prisma.$executeRaw`UPDATE "CustomerOutboxPart" SET "status"='SUPPRESSED',"leaseOwner"=NULL,"leaseUntil"=NULL,"updatedAt"=now()
        WHERE "id"=${row.id} AND "status"='IN_FLIGHT' AND "claimRevision"=${row.claimRevision} AND "leaseOwner"=${owner}`;
      return { status: "suppressed" };
    }
    await prisma.$transaction(async tx => {
      if (!await lockPartState(tx, row)) throw new CustomerDeliveryHeldError("website_stale");
      const [current] = await tx.$queryRaw<CustomerOutboxRow[]>`SELECT * FROM "CustomerOutboxPart" WHERE "id"=${row.id} FOR UPDATE`;
      if (!current || current.status !== "IN_FLIGHT" || current.claimRevision !== row.claimRevision || current.leaseOwner !== owner ||
          !current.leaseUntil || current.leaseUntil.getTime() <= Date.now() || !await validatePart(tx, current)) throw new CustomerDeliveryHeldError("claim_changed");
      if (!await projectCustomerDeliveryPartTx(tx, current, decodeCustomerOutboxPayload(current), null)) throw new Error("Widget projection not committed");
      await tx.$executeRaw`UPDATE "CustomerOutboxPart" SET "status"='AVAILABLE_WIDGET',"acceptedAt"=now(),"leaseOwner"=NULL,"leaseUntil"=NULL,"updatedAt"=now() WHERE "id"=${row.id}`;
    });
    void publishMessageNew("bot", row.originalNativeId, "OUT");
    return { status: "available_widget" };
  }
  const attempted: { current: CustomerAttemptRow | null } = { current: null };
  try {
    await withCustomerDeliveryTransport({
      beforePost: async () => {
        if (attempted.current) throw new CustomerDeliveryHeldError("second_physical_post_forbidden");
        attempted.current = await beginAttempt(row, owner);
        if (row.sourceKind === "HANDOVER_ACK" && Date.now() >= customerHandoverAckFenceSchema.parse(row.fenceJson).deadlineAt) {
          await recordCustomerDeliveryAttemptOutcome(attempted.current.id, "NOT_SENT", null, "handover_ack_expired_before_post");
          throw new CustomerDeliveryHeldError("handover_ack_expired_before_post");
        }
        // Any later failure remains tied to this attempt, including no receipt.
      },
      accepted: async mid => {
        if (!attempted.current) throw new Error("Provider response without durable attempt");
        await recordCustomerDeliveryAttemptOutcome(attempted.current.id, mid ? "ACCEPTED" : "UNKNOWN", mid, mid ? null : "missing_or_invalid_mid");
      },
      rejected: async status => {
        if (!attempted.current) throw new Error("Provider rejection without durable attempt");
        await recordCustomerDeliveryAttemptOutcome(attempted.current.id, status >= 400 && status < 500 ? "REJECTED" : "UNKNOWN", null, `http_${status}`);
      },
      networkFailure: async error => {
        if (!attempted.current) throw new Error("Provider failure without durable attempt");
        const cause = error && typeof error === "object" ? Reflect.get(error, "cause") : null;
        const directCode = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
        const code = directCode ?? (cause && typeof cause === "object" ? Reflect.get(cause, "code") : undefined);
        await recordCustomerDeliveryAttemptOutcome(attempted.current.id, typeof code === "string" && NOT_SENT_CODES.has(code) ? "NOT_SENT" : "UNKNOWN", null, "network_failure");
      },
    }, () => sendCustomerDeliveryPayload(row, decodeCustomerOutboxPayload(row)));
  } catch {
    if (!attempted.current) await prisma.$executeRaw`UPDATE "CustomerOutboxPart" SET "status"='SUPPRESSED',"leaseOwner"=NULL,"leaseUntil"=NULL,"updatedAt"=now()
      WHERE "id"=${row.id} AND "status"='IN_FLIGHT' AND "claimRevision"=${row.claimRevision} AND "leaseOwner"=${owner}`;
    // If the receipt write itself failed, leave IN_FLIGHT. Recovery demotes it
    // only to UNKNOWN, never READY; no second physical POST is allowed.
  }
  const current = await readCustomerOutboxPart(id);
  if (current?.status === "ACCEPTED") {
    try { if (await projectAccepted(current)) return { status: "accepted" }; } catch { /* Receipt stays durable; repair never sends again. */ }
    return { status: "accepted", projectionPending: true };
  }
  return { status: current?.status === "NOT_SENT" ? "not_sent" : current?.status === "SUPPRESSED" ? "suppressed" : "unknown" };
}

/** Expiry cannot prove that a request was not sent. A separate scheduler may
 * invoke this bounded observation; it never enqueues or renews a send. */
export async function holdExpiredCustomerDeliveryClaims(): Promise<number> {
  const expired = await prisma.$queryRaw<Array<{ id: string }>>`UPDATE "CustomerOutboxPart" SET "status"='UNKNOWN',"leaseOwner"=NULL,"leaseUntil"=NULL,"updatedAt"=now()
    WHERE "status"='IN_FLIGHT' AND "leaseUntil"<now() AND "id" IN
      (SELECT "id" FROM "CustomerOutboxPart" WHERE "status"='IN_FLIGHT' AND "leaseUntil"<now() ORDER BY "leaseUntil" LIMIT 100) RETURNING "id"`;
  // Never hold part→attempt locks together: receipt commits attempt→part.
  // Part UNKNOWN already prevents resend if this secondary observation fails.
  for (const row of expired) await prisma.$executeRaw`UPDATE "CustomerDeliveryAttempt" SET "outcome"='UNKNOWN',"finishedAt"=now(),"errorCode"='claim_expired'
    WHERE "partId"=${row.id} AND "outcome"='IN_FLIGHT'`;
  return expired.length;
}

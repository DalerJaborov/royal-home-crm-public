import { createHash, randomUUID } from "node:crypto";
import { serializeDmCustomerAgentDeliveryEvidence,
  type CustomerAgentDeliveryWitness } from "./customerAgentDeliveryEvidence.js";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { prisma, type TxClient } from "../db.js";
import { encryptSecret } from "../crypto.js";
export { decodeCustomerOutboxPayload, decodeCustomerOutboxPublicData } from "./customerOutboxCodec.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { isCustomerPrincipal, revalidateCustomerPrincipal, type CustomerPrincipal } from "./customerPrincipal.js";
import { assertCustomerFence, inspectCustomerWriteAuthority, type CustomerWriteAuthority } from "./customerState.js";
import { assertCustomerInboxPlannableTx, markCustomerInboxPlannedTx } from "./customerIngressInbox.js";
import { customerAgentClaimCurrentTx, type CustomerAgentClaim } from "./customerAgentClaim.js";
import { pinCustomerAgentTurnTx } from "./customerAgentRevision.js";
import { customerDeliveryPayloadSchema, customerDeliveryTransportSchema, customerDeliveryReceiptsSchema,
  customerDeliveryP03Schema, customerDeliveryFenceSchema, customerDeliveryMediaEndpointSchema,
  type CustomerDeliveryPayload, type CustomerOutboxRow } from "./customerDeliveryContracts.js";
import type { CustomerPropertyDelivery, CustomerMutationReceipt } from "@royal-home/shared";
import { customerPropertyMediaExecutionMode, customerPropertyMediaFocusCurrent,
  customerPropertyMediaWitnessCurrent, customerPropertyMediaWitnessIssuedBy } from "./customerPropertyMedia.js";
import { customerAgentMediaExecutionMode, customerApprovedFileMediaWitnessCurrent,
  customerDeliveryMediaWitnessIssuedBy, customerVoiceMediaWitnessCurrent } from "./customerDeliveryMedia.js";
import { customerApprovedFileFollowPromptIssuedBy } from "./customerApprovedFiles.js";
import { customerBuyerGuideFollowText } from "../ai/customerAgentRenderer.js";

export const CUSTOMER_OUTBOX_JOB = "customer-outbox-dispatch";
export const customerOutboxJobSchema = z.object({ version: z.literal(1), partId: z.string().uuid() }).strict();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Actual branded principal at creation; persisted JSON is never the authority.
 * STAFF_ANSWER requires its own fresh staff ACL/CAS adapter and is held until
 * that adapter is supplied. Model/core ports cannot insert executable rows. */
export async function createCustomerOutboxPartsTx(tx: TxClient, input: {
  principal: CustomerPrincipal;
  parts: readonly { payload: CustomerDeliveryPayload; property?: CustomerPropertyDelivery; receipts?: readonly CustomerMutationReceipt[];
    publicDataWitness?: CustomerAgentDeliveryWitness; approvedAssetPurpose?: "buyer_guide" | "buyer_guide_follow";
    approvedFileIssue?: unknown }[];
  receiptAuthorities?: readonly CustomerWriteAuthority[];
  /** New core only: the original opaque elected owner, never model JSON. */
  agentClaim?: CustomerAgentClaim;
  mode?: "LIVE" | "SHADOW";
}): Promise<string[]> {
  if (!isActiveTransactionClient(tx) || !isCustomerPrincipal(input.principal) || input.parts.length < 1 || input.parts.length > 16) {
    throw new Error("Server customer delivery context required");
  }
  const principal = input.principal;
  const checked = await revalidateCustomerPrincipal(principal);
  if (checked.status !== "current") throw new Error("Customer delivery principal stale");
  const fence = customerDeliveryFenceSchema.parse(principal.authority.fence);
  const mode = input.mode ?? "LIVE";
  const inbox = await assertCustomerInboxPlannableTx(tx, principal);
  if (!inbox || inbox.eventKey !== principal.admission.eventKey || inbox.order !== principal.admission.order ||
      inbox.originalFence.inquiryId !== fence.inquiryId || inbox.originalFence.nativeId !== fence.nativeId ||
      !isDeepStrictEqual(inbox.originalFence.endpoint, fence.endpoint) || inbox.originalFence.ownerToken !== fence.ownerToken ||
      inbox.originalFence.bindingRevision !== fence.bindingRevision || inbox.originalFence.ownershipEpoch !== fence.ownershipEpoch ||
      inbox.originalFence.scopeRevision !== fence.scopeRevision || inbox.originalFence.policyRevision !== fence.policyRevision) {
    throw new Error("Durable customer input proof unavailable");
  }
  if ((await assertCustomerFence(tx, fence, mode === "SHADOW" ? "public_read" : "outbound")).status !== "current") {
    throw new Error("Customer delivery fence stale");
  }
  let agentRevisionId: string | null = null;
  if (input.agentClaim) {
    if (!await customerAgentClaimCurrentTx(tx, input.agentClaim) || input.agentClaim.eventKey !== inbox.eventKey) {
      throw new Error("Original customer core claim unavailable");
    }
    const pinned = await pinCustomerAgentTurnTx(tx, principal);
    if (pinned.status !== "pinned" || pinned.pin.eventKey !== inbox.eventKey || pinned.pin.order !== inbox.order ||
        pinned.pin.agentRevisionId !== input.agentClaim.pin.agentRevisionId ||
        pinned.pin.providerOperationId !== input.agentClaim.pin.providerOperationId ||
        pinned.pin.providerDeadlineAt !== input.agentClaim.deadlineAt) throw new Error("Original core revision pin changed");
    agentRevisionId = pinned.pin.agentRevisionId;
  }
  // The real resolver returns ScopedCustomerEndpoint (including subscriberId)
  // through a transport-reference type. Validate the additional binding before
  // projecting the immutable reference; never silently strip unknown fields.
  const { subscriberId, ...transport } = customerDeliveryTransportSchema.extend({
    subscriberId: z.string().min(1).max(512).optional(),
  }).strict().parse(checked.snapshot.transport);
  if (subscriberId !== undefined && subscriberId !== fence.endpoint.peerId) throw new Error("Delivery peer mismatch");
  if (transport.endpointScopeId !== fence.endpoint.endpointScopeId || transport.accountId !== fence.endpoint.accountId ||
      transport.channel !== fence.endpoint.channel || transport.scopeRevision !== fence.scopeRevision) throw new Error("Delivery transport mismatch");
  const ids: string[] = [];
  for (const [ordinal, spec] of input.parts.entries()) {
    const rawMediaWitness = spec.payload && typeof spec.payload === "object" && "mediaWitness" in spec.payload
      ? Reflect.get(spec.payload, "mediaWitness") : undefined;
    const rawFocusGeneration = rawMediaWitness && typeof rawMediaWitness === "object" && "focusGeneration" in rawMediaWitness
      ? (rawMediaWitness as { focusGeneration?: unknown }).focusGeneration : undefined;
    const mediaWitnessIssued = !!input.agentClaim && !!agentRevisionId && rawMediaWitness !== undefined &&
      typeof rawFocusGeneration === "string" &&
      customerPropertyMediaWitnessIssuedBy({ witness: rawMediaWitness, eventKey: principal.admission.eventKey,
        agentRevisionId, focusGeneration: rawFocusGeneration });
    const deliveryMediaWitnessIssued = !!input.agentClaim && !!agentRevisionId && rawMediaWitness !== undefined &&
      customerDeliveryMediaWitnessIssuedBy({ payload: spec.payload, eventKey: principal.admission.eventKey,
        agentRevisionId, turnKey: principal.admission.eventKey });
    const payload = customerDeliveryPayloadSchema.parse(spec.payload);
    const approvedAssetPurpose = spec.approvedAssetPurpose ?? null;
    const mediaEndpoint = customerDeliveryMediaEndpointSchema.safeParse({ channel: transport.channel,
      endpointScopeId: transport.endpointScopeId, accountId: transport.accountId, peerId: fence.endpoint.peerId,
      transportKey: transport.transportKey, scopeRevision: transport.scopeRevision });
    if (spec.publicDataWitness && (!input.agentClaim || !agentRevisionId || payload.kind !== "text")) {
      throw new Error("Original core text delivery witness required");
    }
    const publicData = spec.publicDataWitness && input.agentClaim && payload.kind === "text"
      ? await serializeDmCustomerAgentDeliveryEvidence(tx, { principal, claim: input.agentClaim,
        witness: spec.publicDataWitness, text: payload.text }) : null;
    const sealedGuideFollow = publicData && typeof publicData === "object" ? Reflect.get(publicData, "guideFollow") : undefined;
    if ((payload.kind === "text" && !!sealedGuideFollow) !== (approvedAssetPurpose === "buyer_guide_follow")) {
      throw new Error("Buyer-guide follow reservation/evidence mismatch");
    }
    if (payload.kind === "image") {
      const witness = payload.mediaWitness;
      if (mode !== "LIVE" || customerPropertyMediaExecutionMode() !== "LIVE" || !mediaEndpoint.success || !input.agentClaim || !agentRevisionId ||
          witness.scopeKey !== principal.admission.scopeKey ||
          !mediaWitnessIssued ||
          !await customerPropertyMediaFocusCurrent({ db: tx, conversationId: fence.nativeId!, scopeKey: principal.admission.scopeKey,
            eventKey: principal.admission.eventKey, witness }) ||
          !await customerPropertyMediaWitnessCurrent({ witness, endpoint: mediaEndpoint.data, eventKey: principal.admission.eventKey,
            agentRevisionId, focusGeneration: witness.focusGeneration, db: tx }) ||
          witness.endpoint.channel !== transport.channel || witness.endpoint.endpointScopeId !== transport.endpointScopeId ||
          witness.endpoint.accountId !== transport.accountId || witness.endpoint.peerId !== fence.endpoint.peerId ||
          witness.endpoint.transportKey !== transport.transportKey || witness.endpoint.scopeRevision !== transport.scopeRevision ||
          spec.property || spec.receipts?.length) throw new Error("Current server property media witness required");
    }
    if (payload.kind === "audio") {
      const witness = payload.mediaWitness;
      if (mode !== "LIVE" || customerAgentMediaExecutionMode() !== "LIVE" || !mediaEndpoint.success || !input.agentClaim || !agentRevisionId ||
          !deliveryMediaWitnessIssued ||
          witness.eventKey !== principal.admission.eventKey || witness.scopeKey !== principal.admission.scopeKey ||
          witness.turnKey !== principal.admission.eventKey || witness.agentRevisionId !== agentRevisionId ||
          witness.endpoint.channel !== transport.channel || witness.endpoint.endpointScopeId !== transport.endpointScopeId ||
          witness.endpoint.accountId !== transport.accountId || witness.endpoint.peerId !== fence.endpoint.peerId ||
          witness.endpoint.transportKey !== transport.transportKey || witness.endpoint.scopeRevision !== transport.scopeRevision ||
          !await customerVoiceMediaWitnessCurrent({ witness, endpoint: mediaEndpoint.data, eventKey: principal.admission.eventKey,
            scopeKey: principal.admission.scopeKey, turnKey: principal.admission.eventKey, agentRevisionId, db: tx }) ||
          spec.property || spec.receipts?.length || approvedAssetPurpose) throw new Error("Current server voice media witness required");
    }
    if (payload.kind === "file" || payload.kind === "link") {
      const witness = payload.mediaWitness;
      if (mode !== "LIVE" || customerAgentMediaExecutionMode() !== "LIVE" || !mediaEndpoint.success || !input.agentClaim || !agentRevisionId ||
          approvedAssetPurpose !== "buyer_guide" ||
          !deliveryMediaWitnessIssued ||
          witness.eventKey !== principal.admission.eventKey || witness.scopeKey !== principal.admission.scopeKey ||
          witness.turnKey !== principal.admission.eventKey || witness.agentRevisionId !== agentRevisionId ||
          witness.approvedFile.channel !== transport.channel || witness.endpoint.channel !== transport.channel ||
          witness.endpoint.endpointScopeId !== transport.endpointScopeId || witness.endpoint.accountId !== transport.accountId ||
          witness.endpoint.peerId !== fence.endpoint.peerId || witness.endpoint.transportKey !== transport.transportKey ||
          witness.endpoint.scopeRevision !== transport.scopeRevision || spec.property || spec.receipts?.length ||
          !await customerApprovedFileMediaWitnessCurrent({ witness, endpoint: mediaEndpoint.data,
            authority: { endpointScopeId: transport.endpointScopeId, accountId: transport.accountId,
              transportKey: transport.transportKey, scopeRevision: transport.scopeRevision, peer: fence.endpoint.peerId,
              agentRevisionId, eventKey: principal.admission.eventKey, scopeKey: principal.admission.scopeKey, turnKey: principal.admission.eventKey },
            stillCurrent: async authority => authority.agentRevisionId === agentRevisionId &&
              authority.eventKey === principal.admission.eventKey && authority.scopeKey === principal.admission.scopeKey &&
              authority.turnKey === principal.admission.eventKey && await customerAgentClaimCurrentTx(tx, input.agentClaim!) &&
              (await assertCustomerFence(tx, fence, "outbound")).status === "current" })) {
        throw new Error("Current approved customer file witness required");
      }
    }
    if (approvedAssetPurpose === "buyer_guide_follow") {
      const follow = publicData && typeof publicData === "object" ? Reflect.get(publicData, "guideFollow") : undefined;
      const followLanguage = follow && typeof follow === "object" ? Reflect.get(follow, "language") : undefined;
      const expectedText = followLanguage === "tg" || followLanguage === "ru" ? customerBuyerGuideFollowText(followLanguage) : "";
      if (mode !== "LIVE" || customerAgentMediaExecutionMode() !== "LIVE" || !input.agentClaim || !agentRevisionId || payload.kind !== "text" ||
          !expectedText || !payload.text.includes(expectedText) || !spec.approvedFileIssue ||
          !follow || Reflect.get(follow, "version") !== 1 || Reflect.get(follow, "kind") !== "buyer_guide_follow" ||
          !customerApprovedFileFollowPromptIssuedBy(spec.approvedFileIssue, { endpointScopeId: transport.endpointScopeId,
            accountId: transport.accountId, transportKey: transport.transportKey, scopeRevision: transport.scopeRevision,
            peer: fence.endpoint.peerId, agentRevisionId, eventKey: principal.admission.eventKey,
            scopeKey: principal.admission.scopeKey, turnKey: principal.admission.eventKey })) throw new Error("Current buyer-guide follow witness required");
    } else if (approvedAssetPurpose !== null && approvedAssetPurpose !== "buyer_guide") {
      throw new Error("Unsupported approved asset purpose");
    }
    if ((payload.kind === "file" || payload.kind === "link") !== (approvedAssetPurpose === "buyer_guide")) {
      throw new Error("Approved file purpose/payload mismatch");
    }
    const text = JSON.stringify(publicData ? { ...payload, publicData } : payload), payloadHash = hash(text);
    const payloadVersion = approvedAssetPurpose === "buyer_guide_follow" ? 2 : 1;
    const property = spec.property ? customerDeliveryP03Schema.parse(spec.property) : null;
    if (property && (property.inputEventKey !== principal.admission.eventKey || property.scopeKey !== principal.admission.scopeKey)) {
      throw new Error("Delivery property scope mismatch");
    }
    const receipts = customerDeliveryReceiptsSchema.parse(spec.receipts ?? []);
    for (const receipt of receipts) {
      const match = input.receiptAuthorities?.map(inspectCustomerWriteAuthority).some(authority => authority?.purpose === "receipt" &&
        authority.eventKey === principal.admission.eventKey && authority.kind === receipt.kind && authority.generation === receipt.generation &&
        isDeepStrictEqual(authority.fence, fence));
      if (!match || receipt.inquiryId !== fence.inquiryId) throw new Error("Delivery receipt authority required");
    }
    const partIdentity = [fence.inquiryId, "BOT_TURN", principal.admission.eventKey, ordinal, mode];
    // Preserve the established key byte-for-byte for every existing text/photo
    // part. New buyer-guide purposes receive their own suffix so a follow base
    // text cannot collide with the prior ordinary text identity.
    const partKey = hash(JSON.stringify(approvedAssetPurpose === null ? partIdentity
      : [...partIdentity, approvedAssetPurpose, payloadVersion]));
    const id = randomUUID();
    await tx.$executeRaw`INSERT INTO "CustomerOutboxPart" ("id","partKey","ticketEventKey","inquiryId","originalNativeId","conversationId",
      "turnKey","ordinal","mode","sourceKind","sourceKey","channel","endpointScopeId","transportJson","payloadEncrypted","payloadHash",
      "payloadVersion","fenceJson","p03Json","receiptRefsJson","agentRevisionId","approvedAssetPurpose","status","claimRevision","createdAt","updatedAt")
      VALUES (${id},${partKey},${principal.admission.eventKey},${fence.inquiryId},${fence.nativeId},${fence.nativeId},
      ${principal.admission.eventKey},${ordinal},${mode},'BOT_TURN',${principal.admission.eventKey},${transport.channel},${transport.endpointScopeId},
      ${JSON.stringify(transport)}::jsonb,${encryptSecret(text)},${payloadHash},${payloadVersion},${JSON.stringify(fence)}::jsonb,
      ${property ? JSON.stringify(property) : null}::jsonb,${JSON.stringify(receipts)}::jsonb,${agentRevisionId},${approvedAssetPurpose},${mode === "SHADOW" ? "SUPPRESSED" : "READY"},0,now(),now())
      ON CONFLICT ("partKey") DO NOTHING`;
    const [stored] = await tx.$queryRaw<CustomerOutboxRow[]>`SELECT * FROM "CustomerOutboxPart" WHERE "partKey"=${partKey} FOR UPDATE`;
    if (!stored || stored.agentRevisionId !== agentRevisionId || stored.payloadHash !== payloadHash || stored.payloadVersion !== payloadVersion || !isDeepStrictEqual(stored.fenceJson, fence) ||
      !isDeepStrictEqual(stored.transportJson, transport) || !isDeepStrictEqual(stored.p03Json, property) || stored.approvedAssetPurpose !== approvedAssetPurpose ||
      !isDeepStrictEqual(stored.receiptRefsJson, receipts)) throw new Error("Immutable delivery plan mismatch");
    ids.push(stored.id);
    if (stored.id === id && mode === "LIVE") await tx.backgroundJob.create({ data: {
      type: CUSTOMER_OUTBOX_JOB, payload: { version: 1, partId: id }, maxAttempts: 5, dedupeKey: `${CUSTOMER_OUTBOX_JOB}:${id}`,
    } });
  }
  if (mode === "LIVE") await markCustomerInboxPlannedTx(tx, { eventKey: inbox.eventKey, order: inbox.order,
    turnKey: principal.admission.eventKey, headEventKey: principal.admission.eventKey });
  return ids;
}

export async function readCustomerOutboxPart(id: string, tx: Pick<TxClient, "$queryRaw"> = prisma): Promise<CustomerOutboxRow | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  const rows = await tx.$queryRaw<CustomerOutboxRow[]>`SELECT * FROM "CustomerOutboxPart" WHERE "id"=${id}`;
  return rows[0] ?? null;
}

/** Exact CURRENT canonical event only. Historical parts must not suppress an
 * unrelated newer input; legacy retry cannot regenerate an already owned turn. */
export async function currentTurnHasCustomerOutbox(conversationId: string): Promise<boolean> {
  if (!z.string().uuid().safeParse(conversationId).success) return false;
  const [row] = await prisma.$queryRaw<{ owned: boolean }[]>`SELECT EXISTS(SELECT 1 FROM "CustomerInquiry" i
    JOIN "CustomerOutboxPart" p ON p."inquiryId"=i."id" AND p."ticketEventKey"=i."lastAcceptedEventKey"
    JOIN "CustomerPropertyIngressTicket" t ON t."eventKey"=p."ticketEventKey" AND t."order"=i."lastAcceptedOrder"
    WHERE i."conversationId"=${conversationId} AND p."mode"='LIVE'
      AND p."originalNativeId"=${conversationId} AND p."conversationId"=${conversationId}
      AND t."conversationId"=${conversationId}) AS owned`;
  return row?.owned === true;
}

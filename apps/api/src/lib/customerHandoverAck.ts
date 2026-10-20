// One fixed customer ACK for a real committed handover. Ordinary HOLD stays closed.
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { customerHandoverAckFenceSchema, customerHandoverAckText, customerMutationReceiptSchema,
  type CustomerHandoverAckFence, type CustomerMutationReceipt } from "@royal-home/shared";
import type { TxClient } from "../db.js";
import { encryptSecret } from "../crypto.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { assertCustomerFence, inspectCustomerWriteAuthority, lockCustomerStateSnapshot,
  type CustomerWriteAuthority } from "./customerState.js";
import { readVerifiedCustomerFinalOrigin } from "./customerIngressAuthority.js";
import { isCustomerPrincipal, type CustomerPrincipal } from "./customerPrincipal.js";
import { customerAgentClaimAcceptsPrincipal, customerAgentClaimCurrentTx, type CustomerAgentClaim } from "./customerAgentClaim.js";
import { customerDeliveryTransportSchema, type CustomerOutboxRow } from "./customerDeliveryContracts.js";
import { CustomerScopeDenied, resolveCustomerEndpoint } from "./customerConversationScope.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
declare const sourceBrand: unique symbol;
declare const ackBrand: unique symbol;
/** These have no enumerable data and cannot authorize a read/write/model call. */
export type CustomerHandoverAckSource = { readonly [sourceBrand]: true };
export type CustomerHandoverAckAuthority = { readonly [ackBrand]: true };
type Source = { before: Pick<NonNullable<ReturnType<typeof inspectCustomerWriteAuthority>>, "fence" | "generation" | "eventKey" | "order">;
  claim: CustomerAgentClaim; cipherHash: string; receivedAt: number; language: "ru" | "tg";
  transport: ReturnType<typeof customerDeliveryTransportSchema.parse> };
const sources = new WeakMap<object, Source>();
const acknowledgments = new WeakMap<object, { fence: CustomerHandoverAckFence; source: Source }>();

function projectTransport(endpoint: Awaited<ReturnType<typeof resolveCustomerEndpoint>>) {
  return customerDeliveryTransportSchema.parse({ endpointScopeId: endpoint.endpointScopeId, channel: endpoint.channel,
    accountId: endpoint.accountId, accountExternalId: endpoint.accountExternalId,
    transportKey: endpoint.transportKey, scopeRevision: endpoint.scopeRevision });
}

/** BEFORE executeCustomerAction, while the exact own open handover intent is BOT.
 * No new origin, authority upgrade, fallback credential, provider or mutation. */
export async function captureCustomerHandoverAckSourceTx(tx: TxClient, input: {
  principal: CustomerPrincipal; authority: CustomerWriteAuthority; claim: CustomerAgentClaim; language: "ru" | "tg";
}): Promise<CustomerHandoverAckSource | null> {
  if (!isActiveTransactionClient(tx) || !isCustomerPrincipal(input.principal) ||
      !customerAgentClaimAcceptsPrincipal(input.claim, input.principal) || !["ru", "tg"].includes(input.language)) return null;
  const grant = inspectCustomerWriteAuthority(input.authority);
  if (!grant || grant.kind !== "handover" || grant.purpose !== "execute" ||
      !isDeepStrictEqual(grant.fence, input.principal.authority.fence) ||
      grant.provenance !== "meta_signature" || grant.protectedMetaEndpointScopeId !== grant.fence.endpoint.endpointScopeId ||
      grant.protectedMetaAccountId !== grant.fence.endpoint.accountId || input.claim.eventKey !== grant.eventKey ||
      input.principal.admission.eventKey !== grant.eventKey || input.principal.admission.order !== grant.order) return null;
  if ((await assertCustomerFence(tx, grant.fence, "local_write")).status !== "current") return null;
  const origin = await readVerifiedCustomerFinalOrigin(tx, grant.eventKey, true);
  if (!origin || origin.order !== grant.order || origin.input.assurance !== "protected_namespace" ||
      !origin.input.verifierCredential || origin.originalConversationId !== grant.fence.nativeId ||
      !await customerAgentClaimCurrentTx(tx, input.claim)) return null;
  const [row] = await tx.$queryRaw<{ originCiphertext: string }[]>`SELECT "originCiphertext"
    FROM "CustomerPropertyIngressTicket" WHERE "eventKey"=${grant.eventKey}`;
  if (!row?.originCiphertext || origin.input.issuedAt !== input.claim.pin.receivedAt) return null;
  const handle = Object.freeze({}) as CustomerHandoverAckSource;
  const transport = projectTransport(await resolveCustomerEndpoint({ channel: origin.input.channel,
    subscriberId: origin.input.peer, accountExternalId: origin.input.accountExternalId }, tx));
  if (transport.endpointScopeId !== grant.fence.endpoint.endpointScopeId || transport.scopeRevision !== grant.fence.scopeRevision ||
      transport.accountId !== grant.fence.endpoint.accountId) return null;
  sources.set(handle, { before: { fence: structuredClone(grant.fence), generation: grant.generation, eventKey: grant.eventKey, order: grant.order },
    claim: input.claim, cipherHash: sha(row.originCiphertext),
    receivedAt: origin.input.issuedAt, language: input.language, transport });
  return handle;
}

/** Call BEFORE locking a Part/Attempt. Ordinary task SELECT later is safe only
 * because all lifecycle writers hold the same native/Inquiry first; additionally
 * SHARE-lock this task so direct legacy doneAt updates cannot race the POST check.
 * Actual order: native -> scope SHARE -> policy SHARE -> Inquiry UPDATE -> task SHARE -> Ticket UPDATE -> Part.
 * Common settlement keeps attempt -> Part and never acquires source/task locks. */
export async function lockCustomerHandoverAckSourceTx(tx: TxClient, raw: unknown): Promise<boolean> {
  const parsed = customerHandoverAckFenceSchema.safeParse(raw);
  if (!isActiveTransactionClient(tx) || !parsed.success) return false;
  const f = parsed.data;
  const state = await lockCustomerStateSnapshot(tx, { inquiryId: f.after.inquiryId });
  if (!state || state.fence.nativeId !== f.after.nativeId) return false;
  const tasks = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "CallbackRequest"
    WHERE "id"=${f.receipt.resourceId} AND "customerActionId"=${f.receipt.actionId} FOR SHARE`;
  if (tasks.length !== 1) return false;
  const tickets = await tx.$queryRaw<{ eventKey: string }[]>`SELECT "eventKey" FROM "CustomerPropertyIngressTicket"
    WHERE "eventKey"=${f.eventKey} FOR UPDATE`;
  return tickets.length === 1;
}

/** Exact ACK eligibility. This is NOT assertCustomerFence(...,outbound) and
 * never changes BOT/HOLD or mints CustomerPrincipal/CustomerWriteAuthority. */
async function currentAckTx(tx: TxClient, f: CustomerHandoverAckFence, stage: "plan" | "dispatch"): Promise<boolean> {
  if (!isActiveTransactionClient(tx) || Date.now() < f.originalReceivedAt || Date.now() >= f.deadlineAt) return false;
  const state = await lockCustomerStateSnapshot(tx, { inquiryId: f.after.inquiryId });
  if (!state || state.ownerMode !== "HOLD" || state.ownerAgentId !== null || state.ownerLeaseUntil !== null || state.closedAt ||
      state.contractVersion !== "scoped" || state.rolloutMode !== "ACTIVE" ||
      !state.capabilities.publicRead || !state.capabilities.handoverWrite || !isDeepStrictEqual(state.fence, f.after)) return false;
  const [task] = await tx.$queryRaw<{ handoverFence: unknown }[]>`SELECT r."handoverFence" FROM "CallbackRequest" r
    JOIN "CustomerAction" a ON a."id"=r."customerActionId" JOIN "CustomerInquiry" i ON i."id"=a."inquiryId"
    WHERE r."id"=${f.receipt.resourceId} AND r."customerActionId"=${f.receipt.actionId}
      AND r."requestKind"='HUMAN' AND r."lifecycleStatus"='QUEUED' AND r."lifecycleRevision"=1
      AND r."assignedAgentId" IS NULL AND r."acceptedAt" IS NULL AND r."doneAt" IS NULL AND r."closureReason" IS NULL
      AND r."conversationId"=${f.after.nativeId} AND r."channel"=${f.after.endpoint.channel}
      AND a."inquiryId"=${f.after.inquiryId} AND a."kind"='handover' AND a."status"='COMMITTED' AND a."supersededAt" IS NULL
      AND a."generation"=${BigInt(f.receipt.generation)} AND a."resourceType"='CallbackRequest' AND a."resourceId"=r."id"
      AND a."receiptVersion"=2 AND a."publicRef"=${f.receipt.version === 2 ? f.receipt.publicRef : ""}
      AND a."resourceRevision"=1 AND a."committedAt"=${new Date(f.receipt.committedAt)}
      AND a."stateRevision"=${BigInt(f.before.stateRevision)} AND a."intentRevision"=${BigInt(f.before.intentRevision)}
      AND a."ownershipEpoch"=${BigInt(f.before.ownershipEpoch)} AND a."bindingRevision"=${BigInt(f.before.bindingRevision)}
      AND a."scopeRevision"=${BigInt(f.before.scopeRevision)} AND a."policyRevision"=${BigInt(f.before.policyRevision)}
      AND a."evidenceRefs" @> ${JSON.stringify([f.eventKey])}::jsonb
      AND i."lastAcceptedEventKey"=${f.eventKey} AND i."lastAcceptedOrder"=${BigInt(f.order)}
      AND i."actionIntents"->'handover'->>'status'='committed'
      AND i."actionIntents"->'handover'->>'generation'=${f.receipt.generation}
      AND i."actionIntents"->'handover'->'evidenceRefs' @> ${JSON.stringify([f.eventKey])}::jsonb`;
  if (!task || !isDeepStrictEqual(task.handoverFence,
    { version: 1, fence: f.after, ownerMode: "HOLD", ownerAgentId: null })) return false;
  const [ticket] = await tx.$queryRaw<{ originCiphertext: string | null; current: boolean }[]>`SELECT t."originCiphertext",
      (t."conversationId"=${f.after.nativeId} AND t."originalConversationId"=${f.after.nativeId}
       AND t."endpointScopeId"=${f.after.endpoint.endpointScopeId} AND t."order"=${BigInt(f.order)}
       AND t."tombstonedAt" IS NULL AND t."inputRecordedAt" IS NOT NULL AND t."originVersion"=1
       AND t."receivedAt"=${new Date(f.originalReceivedAt)} AND t."originCapturedAt"=t."receivedAt"
       AND t."agentRevisionId"=${f.agentRevisionId} AND t."providerOperationId"=${f.providerOperationId}
       AND t."providerDeadlineAt"=${new Date(f.deadlineAt)}
       AND t."processingState"=${stage === "plan" ? "CLAIMED" : "PLANNED"}
       AND (${stage === "plan"} OR (t."turnKey"=${f.eventKey} AND t."headEventKey"=${f.eventKey}))) AS current
    FROM "CustomerPropertyIngressTicket" t WHERE t."eventKey"=${f.eventKey}`;
  if (!ticket?.current || !ticket.originCiphertext || sha(ticket.originCiphertext) !== f.originCipherHash) return false;
  // Native safety remains active in HOLD; the exception is ONLY the exact local
  // owner transition, never pause/optout/assignment/deletion/disabled-channel.
  const [safety] = await tx.$queryRaw<{ current: boolean }[]>`SELECT EXISTS(SELECT 1 FROM "BotConversation" c
    JOIN "Settings" st ON st."id"='singleton' JOIN "CustomerEndpointScope" s ON s."id"=c."endpointScopeId"
    LEFT JOIN "MessengerAccount" a ON a."id"=s."messengerAccountId"
    LEFT JOIN "Client" cl ON cl."id"=c."clientId" LEFT JOIN "ContactProfile" cp ON cp."id"=c."contactProfileId"
    WHERE c."id"=${f.after.nativeId} AND c."endpointScopeId"=${f.after.endpoint.endpointScopeId}
      AND c."subscriberId"=${f.after.endpoint.peerId} AND c."channel"=${f.after.endpoint.channel}
      AND c."accountId" IS NOT DISTINCT FROM ${f.after.endpoint.accountId}
      AND c."optedOutAt" IS NULL AND c."propertyChatAgentId" IS NULL
      AND (c."pausedUntil" IS NULL OR c."pausedUntil"<=clock_timestamp())
      AND cl."deletedAt" IS NULL AND cp."mergedIntoId" IS NULL AND s."kind"='NORMAL'
      AND (s."messengerAccountId" IS NULL OR a."enabled"=true)
      AND st."botEnabled" AND st."metaEnabled" AND CASE c."channel"
        WHEN 'INSTAGRAM' THEN st."botInstagramEnabled" WHEN 'FACEBOOK' THEN st."botFacebookEnabled"
        WHEN 'WHATSAPP' THEN st."botWhatsappEnabled" ELSE false END) AS current`;
  return safety?.current === true;
}

/** AFTER the handover TX committed its real task, notify job, HOLD witness and
 * V2 receipt. A lost action ACK may call this only after exact journal recovery;
 * the original opaque Source/claim must still exist. No restart reminting. */
export async function issueCustomerHandoverAckTx(tx: TxClient, source: unknown, receipt: CustomerMutationReceipt): Promise<CustomerHandoverAckAuthority | null> {
  const saved = source && typeof source === "object" ? sources.get(source) : null;
  const parsed = customerMutationReceiptSchema.safeParse(receipt);
  if (!isActiveTransactionClient(tx) || !saved || !parsed.success || parsed.data.version !== 2 ||
      parsed.data.kind !== "handover" || parsed.data.generation !== saved.before.generation) return null;
  const state = await lockCustomerStateSnapshot(tx, { inquiryId: saved.before.fence.inquiryId });
  if (!state) return null;
  const checked = customerHandoverAckFenceSchema.safeParse({ version: 1, purpose: "handover_ack", before: saved.before.fence,
    after: state.fence, eventKey: saved.before.eventKey, order: saved.before.order, originCipherHash: saved.cipherHash,
    originalReceivedAt: saved.receivedAt, deadlineAt: saved.claim.deadlineAt, agentRevisionId: saved.claim.pin.agentRevisionId,
    providerOperationId: saved.claim.pin.providerOperationId, receipt: parsed.data, language: saved.language });
  if (!checked.success || !await lockCustomerHandoverAckSourceTx(tx, checked.data) ||
      !await customerAgentClaimCurrentTx(tx, saved.claim) || !await currentAckTx(tx, checked.data, "plan")) return null;
  const authority = Object.freeze({}) as CustomerHandoverAckAuthority;
  acknowledgments.set(authority, { fence: structuredClone(checked.data), source: saved });
  return authority;
}

/** One fixed ACK, no model payload/tools/facts, Part+required job+PLANNED marker
 * are atomic. It is NOT a receipt for staff notification or customer delivery. */
export async function planCustomerHandoverAckTx(tx: TxClient, authority: unknown, signal?: AbortSignal): Promise<string> {
  const assertLive = () => { if (signal?.aborted) throw new Error("Original ACK operation stopped"); };
  assertLive();
  const grant = authority && typeof authority === "object" ? acknowledgments.get(authority) : null;
  if (!isActiveTransactionClient(tx) || !grant) throw new Error("Opaque handover ACK purpose required");
  const f = grant.fence;
  if (!await lockCustomerHandoverAckSourceTx(tx, f) || !await customerAgentClaimCurrentTx(tx, grant.source.claim) ||
      !await currentAckTx(tx, f, "plan")) {
    throw new Error("Current handover ACK purpose required");
  }
  const transport = projectTransport(await resolveCustomerEndpoint({ channel: f.after.endpoint.channel,
    subscriberId: f.after.endpoint.peerId, transport: grant.source.transport }, tx));
  assertLive();
  if (transport.endpointScopeId !== f.after.endpoint.endpointScopeId || transport.accountId !== f.after.endpoint.accountId ||
      transport.scopeRevision !== f.after.scopeRevision) throw new Error("Original ACK namespace changed");
  const partKey = sha(JSON.stringify(["HANDOVER_ACK", f.receipt.actionId])), id = randomUUID();
  const body = JSON.stringify({ kind: "text", text: customerHandoverAckText(f.language) });
  const [other] = await tx.$queryRaw<{ present: boolean }[]>`SELECT EXISTS(SELECT 1 FROM "CustomerOutboxPart"
    WHERE "inquiryId"=${f.after.inquiryId} AND "ticketEventKey"=${f.eventKey} AND "mode"='LIVE') AS present`;
  if (other?.present) throw new Error("Original turn already has a durable delivery plan");
  assertLive();
  await tx.$executeRaw`INSERT INTO "CustomerOutboxPart" ("id","partKey","ticketEventKey","inquiryId","originalNativeId","conversationId",
    "turnKey","ordinal","mode","sourceKind","sourceKey","channel","endpointScopeId","transportJson","payloadEncrypted","payloadHash",
    "payloadVersion","fenceJson","p03Json","receiptRefsJson","agentRevisionId","status","claimRevision","createdAt","updatedAt")
    VALUES (${id},${partKey},${f.eventKey},${f.after.inquiryId},${f.after.nativeId},${f.after.nativeId},${f.eventKey},0,'LIVE','HANDOVER_ACK',
      ${f.receipt.actionId},${transport.channel},${transport.endpointScopeId},${JSON.stringify(transport)}::jsonb,${encryptSecret(body)},${sha(body)},
      1,${JSON.stringify(f)}::jsonb,NULL,${JSON.stringify([f.receipt])}::jsonb,${f.agentRevisionId},'READY',0,now(),now())`;
  await tx.backgroundJob.create({ data: { type: "customer-outbox-dispatch", payload: { version: 1, partId: id }, maxAttempts: 5,
    dedupeKey: `customer-outbox-dispatch:${id}` } });
  assertLive();
  const changed = await tx.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "processingState"='PLANNED',"plannedAt"=clock_timestamp(),
    "turnKey"=${f.eventKey},"headEventKey"=${f.eventKey},"errorCode"=NULL,"leaseOwner"=NULL,"leaseUntil"=NULL
    WHERE "eventKey"=${f.eventKey} AND "order"=${BigInt(f.order)} AND "processingState"='CLAIMED'
      AND "tombstonedAt" IS NULL AND "inputRecordedAt" IS NOT NULL AND "providerDeadlineAt">clock_timestamp()`;
  if (changed !== 1) throw new Error("Handover ACK planning CAS failed");
  assertLive();
  return id;
}

/** Dispatcher-only rehydration from immutable server-issued P12 witness.
 * Parsed JSON alone is never sufficient: full actual task/controller/IN checks
 * run on every claim/physical POST, and after any transport/credential awaits. */
export async function validateCustomerHandoverAckPartTx(tx: TxClient, row: CustomerOutboxRow): Promise<boolean> {
  const parsed = customerHandoverAckFenceSchema.safeParse(row.fenceJson);
  if (!isActiveTransactionClient(tx) || !parsed.success) return false;
  const f = parsed.data, transport = customerDeliveryTransportSchema.safeParse(row.transportJson);
  if (row.sourceKind !== "HANDOVER_ACK" || row.mode !== "LIVE" || row.sourceKey !== f.receipt.actionId ||
      row.partKey !== sha(JSON.stringify(["HANDOVER_ACK", f.receipt.actionId])) || row.ticketEventKey !== f.eventKey ||
      row.turnKey !== f.eventKey || row.ordinal !== 0 || row.inquiryId !== f.after.inquiryId || row.originalNativeId !== f.after.nativeId ||
      row.conversationId !== f.after.nativeId || row.agentRevisionId !== f.agentRevisionId || row.channel !== f.after.endpoint.channel ||
      row.endpointScopeId !== f.after.endpoint.endpointScopeId || row.publicMetaCommentId !== null || row.publicTelegramCommentId !== null ||
      row.publicSourceRevision !== null || row.p03Json !== null || row.cancelRequestedAt || row.supersededAt ||
      !isDeepStrictEqual(row.receiptRefsJson, [f.receipt]) || !transport.success ||
      transport.data.channel !== f.after.endpoint.channel || transport.data.accountId !== f.after.endpoint.accountId ||
      transport.data.endpointScopeId !== f.after.endpoint.endpointScopeId || transport.data.scopeRevision !== f.after.scopeRevision) return false;
  // No cycle: caller also checks decodeCustomerOutboxPayload(row) equals the
  // exact fixed text. Importing customerOutbox here would make a runtime cycle.
  try {
    await resolveCustomerEndpoint({ channel: row.channel, subscriberId: f.after.endpoint.peerId, transport: transport.data }, tx);
  } catch (error) {
    if (error instanceof CustomerScopeDenied) return false;
    throw error; // DB/runtime failures stay visible; no failed-closed row masquerades as a successful query.
  }
  return currentAckTx(tx, f, "dispatch");
}

import { randomUUID } from "node:crypto";
import { recruitmentPostCode, recruitmentKeyword } from "@royal-home/shared";
import { customerRecruitmentTopic, selectedRecruitmentPosition } from "../ai/customerAgentRecruitmentProtocol.js";
import { readRecruitmentPositions } from "./recruitmentPositions.js";
import { Prisma } from "../generated/prisma/client.js";
import {
  customerActionIntentsSchema, customerFenceSchema, customerStateSchema,
  type CustomerActionKind, type CustomerFence, type CustomerStateEvent, type CustomerStateSnapshot,
  type CustomerPropertyAdmission,
  type CustomerCallbackConsent,
} from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { reduceCustomerState, type CustomerReducerState } from "./customerStateReducer.js";
import { authenticatedInputMatchesFence, bindAcceptedCustomerInput, bindDurableCustomerInputAgeTx, inspectAuthenticatedCustomerInput, persistFinalCustomerOriginTx, type AuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { customerPropertyEventKey, customerPropertyScopeKey } from "./customerPropertyScope.js";
import { resolveCustomerEndpoint } from "./customerConversationScope.js";
import { lockCustomerNative } from "./customerNativeLock.js";
import { customerCallbackConsentDecision, type CustomerCallbackConsentDecision } from "./customerCallbackConsent.js";
import { readCustomerActionProperty, type CustomerActionProperty } from "./customerActionProperty.js";
import { readAcceptedCallbackQuestionTx, acceptedCallbackQuestionForCurrentInput, type AcceptedCustomerCallbackQuestion } from "./customerAcceptedCallbackQuestion.js";

export type CustomerStateDb = Pick<TxClient, "$queryRaw" | "$executeRaw">;
export type CustomerStateReference = { inquiryId: string } | { conversationId: string };
export type CustomerFencePurpose = "public_read" | "local_write" | "outbound";
type StateRow = {
  id: string; endpointScopeId: string; peerId: string; threadId: string; conversationId: string | null;
  stateRevision: string; intentRevision: string; ownershipEpoch: string; bindingRevision: string;
  ownerMode: string; ownerAgentId: string | null; ownerToken: string | null; ownerLeaseUntil: Date | null;
  closedAt: Date | null; publicState: unknown; actionIntents: unknown;
  lastAcceptedEventKey: string | null; lastAcceptedOrder: bigint | null; legacyMemoryQuarantined: boolean;
  scopeRevision: string; channel: string; scopeKind: string; scopeAccountId: string | null;
  policyRevision: string; contractVersion: string; rolloutMode: string; capabilities: unknown;
  nativeId: string | null; nativeEndpointScopeId: string | null; nativeChannel: string | null; nativePeer: string | null; nativeAccountId: string | null;
  pausedUntil: Date | null; optedOutAt: Date | null; propertyChatAgentId: string | null;
  accountEnabled: boolean | null; clientDeletedAt: Date | null; profileMergedIntoId: string | null; legacyBotEnabled: boolean | null;
  installedTransportCurrent: boolean | null;
};
function iso(value: Date | null): string | null { return value?.toISOString() ?? null; }
function sameFence(left: CustomerFence, right: CustomerFence): boolean {
  return left.inquiryId === right.inquiryId && left.nativeId === right.nativeId && left.ownerToken === right.ownerToken &&
    left.endpoint.endpointScopeId === right.endpoint.endpointScopeId && left.endpoint.channel === right.endpoint.channel &&
    left.endpoint.accountId === right.endpoint.accountId && left.endpoint.peerId === right.endpoint.peerId &&
    left.endpoint.threadId === right.endpoint.threadId && left.stateRevision === right.stateRevision &&
    left.intentRevision === right.intentRevision && left.ownershipEpoch === right.ownershipEpoch &&
    left.bindingRevision === right.bindingRevision && left.scopeRevision === right.scopeRevision && left.policyRevision === right.policyRevision;
}

async function readState(db: CustomerStateDb, reference: CustomerStateReference, lock: boolean): Promise<{ row: StateRow; state: CustomerReducerState } | null> {
  const where = "inquiryId" in reference ? Prisma.sql`i."id" = ${reference.inquiryId}` : Prisma.sql`i."conversationId" = ${reference.conversationId}`;
  let lockedNativeId: string | null = null;
  let lockedScopeId: string | null = null;
  if (lock) {
    if (!isActiveTransactionClient(db)) return null;
    const candidates = await db.$queryRaw<Array<{ conversationId: string | null; endpointScopeId: string }>>(Prisma.sql`
      SELECT i."conversationId", i."endpointScopeId" FROM "CustomerInquiry" i WHERE ${where}`);
    if (candidates.length !== 1 || !candidates[0].conversationId || !candidates[0].endpointScopeId ||
        !await lockCustomerNative(db, { kind: "bot", id: candidates[0].conversationId })) return null;
    lockedNativeId = candidates[0].conversationId;
    lockedScopeId = candidates[0].endpointScopeId;
    const scope = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "CustomerEndpointScope" WHERE "id"=${lockedScopeId} FOR SHARE`);
    if (scope.length !== 1) return null;
    const policy = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "CustomerRuntimePolicy" WHERE "id"='singleton' FOR SHARE`);
    if (policy.length !== 1) return null;
  }
  // Only implemented native Bot transport here. TG/call/public adapters remain
  // unsupported, rather than fabricating a BotConversation or borrowing state.
  const rows = await db.$queryRaw<StateRow[]>(Prisma.sql`
    SELECT i."id", i."endpointScopeId", i."peerId", i."threadId", i."conversationId",
      i."stateRevision"::text, i."intentRevision"::text, i."ownershipEpoch"::text, i."bindingRevision"::text,
      i."ownerMode", i."ownerAgentId", i."ownerToken", i."ownerLeaseUntil", i."closedAt",
      i."publicState", i."actionIntents", i."lastAcceptedEventKey", i."lastAcceptedOrder", i."legacyMemoryQuarantined",
      s."scopeRevision"::text, s."channel", s."kind" AS "scopeKind", s."messengerAccountId" AS "scopeAccountId",
      p."policyRevision"::text, p."contractVersion", p."rolloutMode", p."capabilities",
      (s."messengerAccountId" IS NULL AND CASE s."channel"
        WHEN 'FACEBOOK' THEN s."transportKey" = ('settings:FACEBOOK:' || COALESCE(NULLIF(st."metaPageId", ''), ${process.env.META_PAGE_ID ?? ''}))
          AND (NULLIF(st."metaPageToken", '') IS NOT NULL OR ${!!process.env.META_PAGE_TOKEN})
        WHEN 'WHATSAPP' THEN s."transportKey" = ('settings:WHATSAPP:' || COALESCE(NULLIF(st."metaWaPhoneId", ''), ${process.env.META_WA_PHONE_ID ?? ''}))
          AND (NULLIF(st."metaWaToken", '') IS NOT NULL OR ${!!process.env.META_WA_TOKEN})
        ELSE FALSE END) AS "installedTransportCurrent",
      c."id" AS "nativeId", c."endpointScopeId" AS "nativeEndpointScopeId", c."channel" AS "nativeChannel", c."subscriberId" AS "nativePeer", c."accountId" AS "nativeAccountId",
      c."pausedUntil", c."optedOutAt", c."propertyChatAgentId", a."enabled" AS "accountEnabled",
      cl."deletedAt" AS "clientDeletedAt", cp."mergedIntoId" AS "profileMergedIntoId",
      (st."botEnabled" AND CASE s."channel"
        WHEN 'WEBSITE' THEN st."botWebsiteChatEnabled"
        WHEN 'INSTAGRAM' THEN st."metaEnabled" AND st."botInstagramEnabled"
        WHEN 'FACEBOOK' THEN st."metaEnabled" AND st."botFacebookEnabled"
        WHEN 'WHATSAPP' THEN st."metaEnabled" AND st."botWhatsappEnabled"
        ELSE FALSE END) AS "legacyBotEnabled"
    FROM "CustomerInquiry" i JOIN "CustomerEndpointScope" s ON s."id" = i."endpointScopeId"
    JOIN "CustomerRuntimePolicy" p ON p."id" = 'singleton'
    LEFT JOIN "BotConversation" c ON c."id" = i."conversationId"
    LEFT JOIN "MessengerAccount" a ON a."id" = s."messengerAccountId"
    LEFT JOIN "Client" cl ON cl."id" = c."clientId"
    LEFT JOIN "ContactProfile" cp ON cp."id" = c."contactProfileId"
    LEFT JOIN "Settings" st ON st."id" = 'singleton'
    WHERE ${where}
    ${lock ? Prisma.sql`FOR UPDATE OF i` : Prisma.empty}`);
  if (rows.length !== 1) return null;
  const row = rows[0];
  if ((lock && (row.nativeId !== lockedNativeId || row.endpointScopeId !== lockedScopeId)) || row.scopeKind !== "NORMAL" || !row.nativeId || row.nativeEndpointScopeId !== row.endpointScopeId || row.nativeChannel !== row.channel || row.nativePeer !== row.peerId ||
      row.nativeAccountId !== row.scopeAccountId || row.threadId !== "") return null;
  const result = customerStateSchema.safeParse({ version: 1,
    fence: { inquiryId: row.id, endpoint: { endpointScopeId: row.endpointScopeId, channel: row.channel,
      accountId: row.scopeAccountId, peerId: row.peerId, threadId: row.threadId }, nativeId: row.nativeId,
      stateRevision: row.stateRevision, intentRevision: row.intentRevision, ownershipEpoch: row.ownershipEpoch,
      bindingRevision: row.bindingRevision, scopeRevision: row.scopeRevision, policyRevision: row.policyRevision, ownerToken: row.ownerToken },
    ownerMode: row.ownerMode, ownerAgentId: row.ownerAgentId, ownerLeaseUntil: iso(row.ownerLeaseUntil), closedAt: iso(row.closedAt),
    publicState: row.publicState, privateAuthorization: "none", legacyMemoryQuarantined: row.legacyMemoryQuarantined,
    contractVersion: row.contractVersion, rolloutMode: row.rolloutMode, capabilities: row.capabilities,
  });
  const intents = customerActionIntentsSchema.safeParse(row.actionIntents);
  if (!result.success || !intents.success) return null;
  return { row, state: { snapshot: result.data, actionIntents: intents.data, lastAcceptedEventKey: row.lastAcceptedEventKey,
    lastAcceptedOrder: row.lastAcceptedOrder?.toString() ?? null } };
}

/** Safe model-facing projection. No claimed contact, profile memory or old receipts. */
export async function loadCustomerStateSnapshot(reference: CustomerStateReference, db: CustomerStateDb = prisma): Promise<CustomerStateSnapshot | null> {
  const value = await readState(db, reference, false);
  return value?.state.snapshot ?? null;
}
/** Internal controller/safety transaction primitive. This is not permission to
 * execute a customer action; it deliberately does not mint an opaque grant. */
export async function lockCustomerStateSnapshot(db: CustomerStateDb, reference: CustomerStateReference): Promise<CustomerStateSnapshot | null> {
  if (!isActiveTransactionClient(db)) return null;
  return (await readState(db, reference, true))?.state.snapshot ?? null;
}
/** A durable routing ticket may exist before FINAL-IN classification. Public
 * tool authority requires its exact canonical accepted event/order as well.
 * These server-only admission refs are not added to the public state JSON. */
export async function loadAcceptedCustomerState(ticket: Pick<CustomerPropertyAdmission, "eventKey" | "order" | "scopeKey" | "conversationId" | "channel" | "accountId" | "endpointScopeId">,
  db: CustomerStateDb = prisma): Promise<CustomerStateSnapshot | null> {
  const value = await readState(db, { conversationId: ticket.conversationId }, false);
  if (!value || value.state.lastAcceptedEventKey !== ticket.eventKey || value.state.lastAcceptedOrder !== ticket.order) return null;
  const endpoint = value.state.snapshot.fence.endpoint;
  if (ticket.accountId === null && ticket.channel !== "WEBSITE" && !ticket.endpointScopeId) return null;
  return endpoint.channel === ticket.channel && endpoint.accountId === ticket.accountId &&
    (!ticket.endpointScopeId || ticket.endpointScopeId === endpoint.endpointScopeId) &&
    customerPropertyScopeKey(endpoint.channel, endpoint.peerId, endpoint.accountId, endpoint.endpointScopeId) === ticket.scopeKey ? value.state.snapshot : null;
}
export type CustomerFenceResult =
  | { status: "current"; snapshot: CustomerStateSnapshot }
  | { status: "stale" | "denied"; reason: string };
function permitted(row: StateRow, snapshot: CustomerStateSnapshot, purpose: CustomerFencePurpose, now: number): boolean {
  if (row.legacyBotEnabled !== true || snapshot.closedAt || snapshot.ownerMode !== "BOT" || row.optedOutAt || row.propertyChatAgentId ||
      (row.pausedUntil && row.pausedUntil.getTime() > now) || row.clientDeletedAt || row.profileMergedIntoId) return false;
  if (row.scopeAccountId ? row.accountEnabled !== true : (row.channel !== "WEBSITE" && row.installedTransportCurrent !== true)) return false;
  if (snapshot.ownerLeaseUntil && Date.parse(snapshot.ownerLeaseUntil) <= now) return false;
  if (purpose === "public_read") return snapshot.rolloutMode !== "OFF" && snapshot.capabilities.publicRead;
  return snapshot.rolloutMode === "ACTIVE" && snapshot.contractVersion === "scoped" &&
    (purpose === "outbound" ? snapshot.capabilities.publicRead : Object.entries(snapshot.capabilities)
      .some(([key, enabled]) => key.endsWith("Write") && enabled));
}
export function customerActionCapability(snapshot: CustomerStateSnapshot, kind: CustomerActionKind): boolean {
  switch (kind) {
    case "contact": case "job_application": return snapshot.capabilities.contactWrite;
    case "callback": return snapshot.capabilities.callbackWrite;
    case "handover": return snapshot.capabilities.handoverWrite;
    case "book_showing": case "reschedule_showing": case "cancel_showing": return snapshot.capabilities.showingWrite;
    case "owner_question": return snapshot.capabilities.ownerQuestionWrite;
  }
}
/** local_write must run on the caller's transaction. Rows used by the fence
 * (inquiry/scope/policy) are locked until that transaction commits or rolls back. */
export async function assertCustomerFence(db: CustomerStateDb, rawFence: CustomerFence, purpose: CustomerFencePurpose): Promise<CustomerFenceResult> {
  const parsed = customerFenceSchema.safeParse(rawFence);
  if (!parsed.success || (purpose === "local_write" && !isActiveTransactionClient(db))) return { status: "denied", reason: "invalid_fence_or_transaction" };
  const value = await readState(db, { inquiryId: parsed.data.inquiryId }, purpose === "local_write");
  if (!value || !permitted(value.row, value.state.snapshot, purpose, Date.now())) return { status: "denied", reason: "scope_owner_or_policy" };
  if (!sameFence(value.state.snapshot.fence, parsed.data)) return { status: "stale", reason: "revision_changed" };
  return { status: "current", snapshot: value.state.snapshot };
}

export type CustomerStateTransitionResult =
  | { status: "applied" | "same_event"; snapshot: CustomerStateSnapshot }
  | { status: "stale" | "denied"; reason: string };
/** For trusted adapter/reconciler events only. This does not mint write authority
 * and is never a customer tool. Native legacy projections are updated by their
 * facade in this same transaction; actual post-trigger revisions are reread. */
export async function transitionCustomerState(db: CustomerStateDb, fence: CustomerFence, event: CustomerStateEvent): Promise<CustomerStateTransitionResult> {
  if (!isActiveTransactionClient(db) || !customerFenceSchema.safeParse(fence).success) return { status: "denied", reason: "transaction_or_valid_fence_required" };
  const value = await readState(db, { inquiryId: fence.inquiryId }, true);
  if (!value || !sameFence(value.state.snapshot.fence, fence)) return { status: "stale", reason: "revision_changed" };
  const result = reduceCustomerState(value.state, event);
  if (result.status === "stale" || result.status === "denied") return { status: result.status, reason: "invalid_or_old_event" };
  if (result.status === "same_event") return { status: "same_event", snapshot: value.state.snapshot };
  const next = result.state; const nextFence = next.snapshot.fence;
  await db.$executeRaw(Prisma.sql`UPDATE "CustomerInquiry" SET
    "stateRevision" = ${BigInt(nextFence.stateRevision)}, "intentRevision" = ${BigInt(nextFence.intentRevision)},
    "ownershipEpoch" = ${BigInt(nextFence.ownershipEpoch)}, "bindingRevision" = ${BigInt(nextFence.bindingRevision)},
    "ownerMode" = ${next.snapshot.ownerMode}, "ownerAgentId" = ${next.snapshot.ownerAgentId}, "ownerToken" = ${nextFence.ownerToken},
    "ownerLeaseUntil" = ${next.snapshot.ownerLeaseUntil ? new Date(next.snapshot.ownerLeaseUntil) : null},
    "closedAt" = ${next.snapshot.closedAt ? new Date(next.snapshot.closedAt) : null},
    "publicState" = ${JSON.stringify(next.snapshot.publicState)}::jsonb, "actionIntents" = ${JSON.stringify(next.actionIntents)}::jsonb,
    "lastAcceptedEventKey" = ${next.lastAcceptedEventKey}, "lastAcceptedOrder" = ${next.lastAcceptedOrder ? BigInt(next.lastAcceptedOrder) : null}
    WHERE "id" = ${fence.inquiryId}`);
  const actual = await readState(db, { inquiryId: fence.inquiryId }, false);
  if (!actual) throw new Error("Customer state lost its native binding during transition");
  return { status: "applied", snapshot: actual.state.snapshot };
}

export interface CustomerWriteEvidence {
  fence: CustomerFence; kind: CustomerActionKind; generation: string; eventKey: string; order: string;
  currentInputText: string; provenance: "meta_signature" | "website_application_key";
  protectedMetaAccountId: string | null;
  protectedMetaEndpointScopeId: string | null;
  issuerSource: "account_secret" | "single_channel_global" | "website_application_key";
  purpose: "execute" | "receipt";
  callbackConsent?: CustomerCallbackConsent;
  commandDigest?: string;
  property?: CustomerActionProperty;
}
const writeAuthorities = new WeakMap<object, Readonly<CustomerWriteEvidence>>();
declare const writeAuthorityBrand: unique symbol;
export type CustomerWriteAuthority = { readonly [writeAuthorityBrand]: true };
export function inspectCustomerWriteAuthority(value: unknown): Readonly<CustomerWriteEvidence> | null {
  const authority = value && typeof value === "object" ? writeAuthorities.get(value) : undefined;
  return authority ? structuredClone(authority) : null;
}
/** Public admissions cannot mint grants. This requires a runtime-authenticated
 * current IN object, exact stable event preimage, current native endpoint and
 * open canonical kind slot. A later retry receives no fresh input authority. */
export async function issueCustomerWriteAuthority(input: AuthenticatedCustomerInput, ticket: CustomerPropertyAdmission,
  kind: CustomerActionKind, db: TxClient = prisma, purpose: "execute" | "receipt" = "execute"): Promise<CustomerWriteAuthority | null> {
  const evidence = inspectAuthenticatedCustomerInput(input);
  if (!evidence || evidence.channel !== ticket.channel || (purpose === "receipt" && evidence.provenance !== "meta_signature")) return null;
  if (evidence.issuerSource === "verified_public_envelope" || evidence.assurance === "public_envelope") return null;
  if (evidence.provenance === "meta_signature" && evidence.assurance !== "protected_namespace") return null;
  const endpoint = await resolveCustomerEndpoint({ channel: evidence.channel, subscriberId: evidence.peer,
    accountExternalId: evidence.accountExternalId }, db);
  const scopeKey = customerPropertyScopeKey(evidence.channel, evidence.peer, endpoint.accountId, endpoint.endpointScopeId);
  if (evidence.provenance === "meta_signature" && (evidence.protectedMetaAccountId !== endpoint.accountId ||
      evidence.protectedMetaEndpointScopeId !== endpoint.endpointScopeId)) return null;
  const eventKey = customerPropertyEventKey(scopeKey, evidence.eventKind, evidence.eventId);
  if (ticket.eventKey !== eventKey || ticket.scopeKey !== scopeKey || ticket.accountId !== endpoint.accountId ||
      (ticket.endpointScopeId && ticket.endpointScopeId !== endpoint.endpointScopeId)) return null;
  const stored = await db.customerPropertyIngressTicket.findUnique({ where: { eventKey }, select: {
    conversationId: true, originalConversationId: true, tombstonedAt: true, order: true, scopeKey: true, endpointScopeId: true, managedOutputRecordedAt: true,
  } });
  if (!stored || stored.tombstonedAt || (stored.originalConversationId && stored.originalConversationId !== ticket.conversationId) || stored.conversationId !== ticket.conversationId || stored.order.toString() !== ticket.order ||
      stored.scopeKey !== scopeKey || (ticket.endpointScopeId && stored.endpointScopeId !== ticket.endpointScopeId) ||
      (purpose === "execute" && stored.managedOutputRecordedAt)) return null;
  const value = await readState(db, { conversationId: ticket.conversationId }, false);
  if (!value || !permitted(value.row, value.state.snapshot, "local_write", Date.now()) ||
      !authenticatedInputMatchesFence(input, value.state.snapshot.fence) ||
      value.state.snapshot.fence.endpoint.endpointScopeId !== endpoint.endpointScopeId ||
      value.state.lastAcceptedEventKey !== eventKey || value.state.lastAcceptedOrder !== ticket.order) return null;
  const slot = value.state.actionIntents[kind];
  if (!slot || slot.status !== (purpose === "execute" ? "open" : "committed") || !slot.evidenceRefs.includes(eventKey) ||
      !customerActionCapability(value.state.snapshot, kind) ||
      ((kind !== "contact" && kind !== "callback") && (!slot.commandDigest || evidence.provenance !== "meta_signature"))) return null;
  const property = kind === "book_showing" || kind === "reschedule_showing" || kind === "owner_question"
    ? await readCustomerActionProperty(value.state.snapshot.fence, db) : null;
  if ((kind === "book_showing" || kind === "reschedule_showing" || kind === "owner_question") && !property) return null;
  const authority = Object.freeze({}) as CustomerWriteAuthority;
  writeAuthorities.set(authority, Object.freeze({ fence: value.state.snapshot.fence, kind, generation: slot.generation,
    eventKey, order: ticket.order, currentInputText: evidence.inputText, provenance: evidence.provenance,
    protectedMetaAccountId: evidence.protectedMetaAccountId, protectedMetaEndpointScopeId: evidence.protectedMetaEndpointScopeId,
    issuerSource: evidence.issuerSource,
    purpose, ...(slot.commandDigest ? { commandDigest: slot.commandDigest } : {}),
    ...(property ? { property } : {}),
    ...(kind === "callback" && "consent" in slot && slot.consent ? { callbackConsent: slot.consent } : {}) }));
  return authority;
}

/** Verified fresh IN can resume a quarantined initial HOLD only if the native
 * thread has no real pause/owner/optout. No old contact/private slots migrate. */
export async function activateCustomerInquiryForInput(input: AuthenticatedCustomerInput, ticket: CustomerPropertyAdmission,
  db: TxClient): Promise<CustomerStateSnapshot | null> {
  const evidence = inspectAuthenticatedCustomerInput(input);
  if (!evidence || evidence.channel !== ticket.channel || !isActiveTransactionClient(db)) return null;
  const endpoint = await resolveCustomerEndpoint({ channel: evidence.channel, subscriberId: evidence.peer, accountExternalId: evidence.accountExternalId }, db);
  const scopeKey = customerPropertyScopeKey(evidence.channel, evidence.peer, endpoint.accountId, endpoint.endpointScopeId);
  if (evidence.provenance === "meta_signature" && (evidence.issuerAccountId !== endpoint.accountId ||
      evidence.issuerEndpointScopeId !== endpoint.endpointScopeId)) return null;
  const eventKey = customerPropertyEventKey(scopeKey, evidence.eventKind, evidence.eventId);
  if (ticket.scopeKey !== scopeKey || ticket.eventKey !== eventKey || ticket.accountId !== endpoint.accountId ||
      (ticket.endpointScopeId && ticket.endpointScopeId !== endpoint.endpointScopeId)) return null;
  const value = await readState(db, { conversationId: ticket.conversationId }, true);
  if (!value || value.row.legacyBotEnabled !== true || value.state.snapshot.closedAt || value.row.optedOutAt || value.row.propertyChatAgentId ||
      (evidence.provenance === "meta_signature" && evidence.issuerScopeRevision !== value.state.snapshot.fence.scopeRevision) ||
      (value.row.pausedUntil && value.row.pausedUntil.getTime() > Date.now()) ||
      value.state.snapshot.fence.ownerToken !== null || value.state.snapshot.fence.ownershipEpoch !== "0" ||
      value.state.snapshot.fence.endpoint.endpointScopeId !== endpoint.endpointScopeId || value.state.lastAcceptedEventKey !== eventKey ||
      value.state.lastAcceptedOrder !== ticket.order || value.state.snapshot.ownerMode !== "HOLD") return value?.state.snapshot ?? null;
  const result = await transitionCustomerState(db, value.state.snapshot.fence, { type: "owner", mode: "BOT", agentId: null,
    token: randomUUID(), leaseUntil: null });
  return result.status === "applied" || result.status === "same_event" ? result.snapshot : null;
}

/** FINAL-IN adapter only. Early durable P03 admission does not call this unless
 * the caller already classified a real customer input. Older completion cannot
 * register a new ordinal or activate a newer owner's inquiry. */
export async function acceptAuthenticatedCustomerAdmission(input: AuthenticatedCustomerInput, ticket: CustomerPropertyAdmission,
  db: TxClient): Promise<CustomerStateSnapshot | null> {
  const evidence = inspectAuthenticatedCustomerInput(input);
  if (!evidence || evidence.channel !== ticket.channel || !isActiveTransactionClient(db)) return null;
  const endpoint = await resolveCustomerEndpoint({ channel: evidence.channel, subscriberId: evidence.peer,
    accountExternalId: evidence.accountExternalId }, db);
  const scopeKey = customerPropertyScopeKey(evidence.channel, evidence.peer, endpoint.accountId, endpoint.endpointScopeId);
  const eventKey = customerPropertyEventKey(scopeKey, evidence.eventKind, evidence.eventId);
  if (ticket.eventKey !== eventKey || ticket.scopeKey !== scopeKey || ticket.accountId !== endpoint.accountId ||
      (ticket.endpointScopeId && ticket.endpointScopeId !== endpoint.endpointScopeId)) return null;
  const stored = await db.customerPropertyIngressTicket.findUnique({ where: { eventKey }, select: {
    conversationId: true, originalConversationId: true, tombstonedAt: true, payloadVersion: true,
    order: true, scopeKey: true, endpointScopeId: true, managedOutputRecordedAt: true,
  } });
  if (!stored || stored.tombstonedAt || (stored.originalConversationId && stored.originalConversationId !== ticket.conversationId) || stored.conversationId !== ticket.conversationId || stored.order.toString() !== ticket.order ||
      stored.scopeKey !== scopeKey || (ticket.endpointScopeId && stored.endpointScopeId !== ticket.endpointScopeId) || stored.managedOutputRecordedAt) return null;
  const value = await readState(db, { conversationId: ticket.conversationId }, true);
  if (!value || value.state.snapshot.fence.endpoint.endpointScopeId !== endpoint.endpointScopeId ||
      (evidence.provenance === "meta_signature" && (evidence.issuerAccountId !== endpoint.accountId ||
        evidence.issuerScopeRevision !== value.state.snapshot.fence.scopeRevision || evidence.issuerPolicyRevision !== value.state.snapshot.fence.policyRevision)) ||
      (evidence.acceptedFence && !authenticatedInputMatchesFence(input, value.state.snapshot.fence))) return null;
  if (stored.payloadVersion != null && !await bindDurableCustomerInputAgeTx(db, input, ticket)) return null;
  // Read prior accepted question before B replaces canonical lastAccepted A.
  // No state/history boolean, new age or model grant enters this boundary.
  const acceptedQuestion = await readAcceptedCallbackQuestionTx(db, { input, ticket, before: value.state.snapshot,
    previousEventKey: value.state.lastAcceptedEventKey, previousOrder: value.state.lastAcceptedOrder });
  const codes = ticket.evidence.flatMap(item => [item.reference, item.secondaryReference].flatMap(ref => ref ? [recruitmentPostCode(ref)].filter((code): code is string => !!code) : []));
  const previousPublic = value.state.snapshot.publicState;
  const word = recruitmentKeyword(evidence.inputText);
  const positions = codes.length || word || previousPublic.topic === "job" || customerRecruitmentTopic(evidence.inputText, previousPublic.topic) === "job" ? await readRecruitmentPositions(db) : [];
  const matchedPosts = positions.filter(position => position.postCodes.some(code => codes.includes(code)) || !!word && position.keywords.includes(word));
  const matchedPublication = matchedPosts.length > 0;
  const topic = customerRecruitmentTopic(evidence.inputText, previousPublic.topic, matchedPublication);
  const selected = topic === "job" ? selectedRecruitmentPosition(positions, evidence.inputText,
    matchedPosts.length === 1 ? matchedPosts[0].key : matchedPosts.length === 0 ? previousPublic.jobPositionKey : undefined) : null;
  const { jobPositionKey: _oldPosition, ...publicWithoutPosition } = previousPublic;
  const publicState = { ...publicWithoutPosition, topic, ...(selected ? { jobPositionKey: selected.key } : {}) };
  const result = await transitionCustomerState(db, value.state.snapshot.fence, { type: "accepted_inbound", eventKey, order: ticket.order,
    ...(JSON.stringify(publicState) !== JSON.stringify(previousPublic) ? { publicState } : {}) });
  if (result.status !== "applied" && result.status !== "same_event") return null;
  const accepted = await activateCustomerInquiryForInput(input, ticket, db);
  if (!accepted || !bindAcceptedCustomerInput(input, accepted.fence)) return null;
  const consent = await reconcileCallbackConsentForInput(input, ticket, db, acceptedQuestion);
  if (stored.payloadVersion != null) await persistFinalCustomerOriginTx(db, input, ticket);
  return consent.snapshot ?? accepted;
}

/** Store only deterministic consent from the actual accepted current IN.
 * Phone-only continuation keeps the existing per-kind generation, and is
 * restricted to a protected Meta controller; a guessed website SID never
 * revives somebody's old consent. No CallbackRequest or dial effect here. */
export async function reconcileCallbackConsentForInput(input: AuthenticatedCustomerInput, ticket: CustomerPropertyAdmission,
  db: TxClient, questionWitness: AcceptedCustomerCallbackQuestion | null = null): Promise<{ decision: CustomerCallbackConsentDecision; snapshot: CustomerStateSnapshot | null }> {
  const evidence = inspectAuthenticatedCustomerInput(input);
  if (!evidence || !isActiveTransactionClient(db)) return { decision: "none", snapshot: null };
  if (evidence.provenance === "meta_signature" && evidence.assurance !== "protected_namespace") return { decision: "none", snapshot: null };
  const value = await readState(db, { conversationId: ticket.conversationId }, true);
  if (!value || !authenticatedInputMatchesFence(input, value.state.snapshot.fence) ||
      value.state.lastAcceptedEventKey !== ticket.eventKey || value.state.lastAcceptedOrder !== ticket.order) return { decision: "none", snapshot: null };
  const decision = customerCallbackConsentDecision(evidence.inputText), fence = value.state.snapshot.fence;
  const acceptedQuestion = acceptedCallbackQuestionForCurrentInput(questionWitness, input, ticket, fence);
  const expectedScope = customerPropertyScopeKey(fence.endpoint.channel, fence.endpoint.peerId,
    fence.endpoint.accountId, fence.endpoint.endpointScopeId);
  if (evidence.channel !== fence.endpoint.channel || evidence.peer !== fence.endpoint.peerId || ticket.channel !== fence.endpoint.channel ||
      ticket.accountId !== fence.endpoint.accountId || (ticket.endpointScopeId && ticket.endpointScopeId !== fence.endpoint.endpointScopeId) ||
      ticket.scopeKey !== expectedScope || ticket.eventKey !== customerPropertyEventKey(expectedScope, evidence.eventKind, evidence.eventId)) {
    return { decision: "none", snapshot: null };
  }
  let event: CustomerStateEvent | null = null;
  if (decision === "cancelled" || decision === "needs_review") {
    event = { type: "intent", kind: "callback", change: decision === "cancelled" ? "cancel" : "review", evidenceRefs: [ticket.eventKey] };
  } else if ((decision === "requested" || (decision === "none" && acceptedQuestion &&
      acceptedQuestion.affirmationEventKey === ticket.eventKey && acceptedQuestion.affirmationOrder === ticket.order)) && fence.nativeId && fence.ownerToken) {
    event = { type: "callback_consent", consent: { matcherVersion: 1, originalEventKey: ticket.eventKey, originalOrder: ticket.order,
      nativeId: fence.nativeId, endpointScopeId: fence.endpoint.endpointScopeId, accountId: fence.endpoint.accountId,
      ownershipEpoch: fence.ownershipEpoch, bindingRevision: fence.bindingRevision, scopeRevision: fence.scopeRevision,
      policyRevision: fence.policyRevision, ownerToken: fence.ownerToken,
      ...(acceptedQuestion && decision === "none" ? { acceptedQuestion } : {}) } };
  } else if (decision === "continue_phone" && evidence.provenance === "meta_signature" &&
      evidence.protectedMetaEndpointScopeId === fence.endpoint.endpointScopeId && evidence.protectedMetaAccountId === fence.endpoint.accountId) {
    const slot = value.state.actionIntents.callback;
    if (slot?.status === "open" && slot.consent) event = { type: "intent_evidence", kind: "callback", generation: slot.generation, eventKey: ticket.eventKey };
  }
  if (!event) return { decision, snapshot: value.state.snapshot };
  const result = await transitionCustomerState(db, fence, event);
  return { decision, snapshot: result.status === "applied" || result.status === "same_event" ? result.snapshot : null };
}

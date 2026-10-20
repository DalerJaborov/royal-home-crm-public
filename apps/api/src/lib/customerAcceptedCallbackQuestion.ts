import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { customerAgentStoredTextPayloadSchema, customerAcceptedCallbackQuestionSchema,
  type CustomerAcceptedCallbackQuestion, type CustomerCallbackConsent, type CustomerFence,
  type CustomerPropertyAdmission, type CustomerStateSnapshot } from "@royal-home/shared";
import type { TxClient } from "../db.js";
import { decryptSecret } from "../crypto.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { customerDeliveryFenceSchema } from "./customerDeliveryContracts.js";
import { inspectAuthenticatedCustomerInput, readVerifiedCustomerFinalOrigin,
  type AuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { isCustomerCallbackAffirmative } from "./customerCallbackConsent.js";
import { customerAgentCallbackQuestionText } from "../ai/customerAgentRenderer.js";
import { decryptCustomerFinalOrigin } from "./customerOriginPayload.js";

type Row = {
  id: string; attemptId: string; providerMid: string; payloadEncrypted: string; payloadHash: string;
  fenceJson: unknown; agentRevisionId: string; questionOrder: bigint;
};
declare const questionBrand: unique symbol;
export type AcceptedCustomerCallbackQuestion = { readonly [questionBrand]: true };
const witnessed = new WeakMap<object, { input: AuthenticatedCustomerInput; ticket: CustomerPropertyAdmission;
  before: CustomerFence; proof: CustomerAcceptedCallbackQuestion }>();
function sameController(old: CustomerFence, current: CustomerFence): boolean {
  return old.inquiryId === current.inquiryId && old.nativeId === current.nativeId &&
    isDeepStrictEqual(old.endpoint, current.endpoint) && old.ownerToken === current.ownerToken &&
    old.ownershipEpoch === current.ownershipEpoch && old.bindingRevision === current.bindingRevision &&
    old.scopeRevision === current.scopeRevision && old.policyRevision === current.policyRevision;
}
function hasSealedQuestion(row: Row): boolean {
  try {
    const plaintext = decryptSecret(row.payloadEncrypted);
    if (createHash("sha256").update(plaintext).digest("hex") !== row.payloadHash) return false;
    const stored = customerAgentStoredTextPayloadSchema.parse(JSON.parse(plaintext));
    const question = stored.publicData?.callbackQuestion;
    return !!question && stored.publicData?.agentRevisionId === row.agentRevisionId &&
      stored.text.endsWith(customerAgentCallbackQuestionText(question.language));
  } catch { return false; }
}

/** Caller holds canonical native→scope→policy→Inquiry locks. These are ordinary
 * snapshot reads, never Part→Attempt locks (settlement uses Attempt→Part).
 * Accepted rows must precede B's ORIGINAL receivedAt, not its later admission. */
async function rowsForQuestion(tx: TxClient, fence: CustomerFence, questionEventKey: string,
  affirmationEventKey: string, affirmationOrder: string, currentEventKey = affirmationEventKey,
  currentOrder = affirmationOrder): Promise<Row[]> {
  if (!fence.nativeId) return [];
  return tx.$queryRaw<Row[]>`SELECT p."id", a."id" AS "attemptId", a."providerMid",
      p."payloadEncrypted",p."payloadHash",p."fenceJson",p."agentRevisionId",q."order" AS "questionOrder"
    FROM "CustomerOutboxPart" p
    JOIN "CustomerDeliveryAttempt" a ON a."partId"=p."id" AND a."endpointScopeId"=p."endpointScopeId"
    JOIN "CustomerPropertyIngressTicket" q ON q."eventKey"=p."ticketEventKey"
    JOIN "CustomerPropertyIngressTicket" b ON b."eventKey"=${affirmationEventKey} AND b."order"=${BigInt(affirmationOrder)}
    JOIN "CustomerPropertyIngressTicket" cur ON cur."eventKey"=${currentEventKey} AND cur."order"=${BigInt(currentOrder)}
    WHERE p."ticketEventKey"=${questionEventKey} AND p."sourceKey"=${questionEventKey}
      AND p."inquiryId"=${fence.inquiryId} AND p."originalNativeId"=${fence.nativeId} AND p."conversationId"=${fence.nativeId}
      AND p."endpointScopeId"=${fence.endpoint.endpointScopeId} AND p."channel"=${fence.endpoint.channel}
      AND p."sourceKind"='BOT_TURN' AND p."mode"='LIVE' AND p."ordinal"=0
      AND p."status"='ACCEPTED' AND p."acceptedAt" IS NOT NULL AND p."acceptedAt"<=b."receivedAt"
      AND p."cancelRequestedAt" IS NULL AND p."supersededAt" IS NULL
      AND a."outcome"='ACCEPTED' AND a."providerMid" IS NOT NULL AND length(a."providerMid") BETWEEN 1 AND 512
      AND a."claimRevision"=p."claimRevision" AND a."finishedAt" IS NOT NULL AND a."finishedAt"<=b."receivedAt"
      AND q."order"<b."order" AND q."agentRevisionId"=p."agentRevisionId" AND q."tombstonedAt" IS NULL
      AND q."conversationId"=${fence.nativeId} AND q."originalConversationId"=${fence.nativeId}
      AND q."endpointScopeId"=${fence.endpoint.endpointScopeId}
      AND b."conversationId"=${fence.nativeId} AND b."originalConversationId"=${fence.nativeId}
      AND b."endpointScopeId"=${fence.endpoint.endpointScopeId} AND b."tombstonedAt" IS NULL AND b."payloadVersion"=1
      AND b."intakeAgentRevisionId"=p."agentRevisionId"
      AND cur."conversationId"=${fence.nativeId} AND cur."originalConversationId"=${fence.nativeId}
      AND cur."endpointScopeId"=${fence.endpoint.endpointScopeId} AND cur."tombstonedAt" IS NULL
      AND cur."intakeAgentRevisionId"=p."agentRevisionId"
      AND NOT EXISTS(SELECT 1 FROM "CustomerOutboxPart" other WHERE other."ticketEventKey"=q."eventKey" AND other."id"<>p."id")
      AND NOT EXISTS(SELECT 1 FROM "CustomerPropertyIngressTicket" intervening
        WHERE intervening."conversationId"=${fence.nativeId} AND intervening."endpointScopeId"=${fence.endpoint.endpointScopeId}
          AND intervening."order">q."order" AND intervening."order"<b."order"
          AND intervening."originVersion"=1 AND intervening."originCiphertext" IS NOT NULL)`;
}

/** Data descriptor only, not a grant. Called before accepted_inbound(B) while
 * A is still the actual current canonical FINAL. No caller/model snapshot can
 * substitute for the opaque current input and actual persisted A proof. */
export async function readAcceptedCallbackQuestionTx(tx: TxClient, args: {
  input: AuthenticatedCustomerInput; ticket: CustomerPropertyAdmission;
  before: CustomerStateSnapshot; previousEventKey: string | null; previousOrder: string | null;
}): Promise<AcceptedCustomerCallbackQuestion | null> {
  const i = inspectAuthenticatedCustomerInput(args.input), f = args.before.fence;
  if (!isActiveTransactionClient(tx) || !i || !isCustomerCallbackAffirmative(i.inputText) ||
      i.provenance !== "meta_signature" || i.assurance !== "protected_namespace" ||
      i.protectedMetaEndpointScopeId !== f.endpoint.endpointScopeId || i.protectedMetaAccountId !== f.endpoint.accountId ||
      i.channel !== f.endpoint.channel || i.peer !== f.endpoint.peerId || args.before.ownerMode !== "BOT" ||
      args.before.closedAt || !args.previousEventKey || !args.previousOrder || args.previousEventKey === args.ticket.eventKey) return null;
  const original = await readVerifiedCustomerFinalOrigin(tx, args.previousEventKey);
  if (!original || original.order !== args.previousOrder || original.originalConversationId !== f.nativeId ||
      original.input.assurance !== "protected_namespace" || !sameController(original.input.acceptedFence, f)) return null;
  const [received] = await tx.$queryRaw<Array<{ receivedAt: Date }>>`
    SELECT "receivedAt" FROM "CustomerPropertyIngressTicket" WHERE "eventKey"=${args.ticket.eventKey} AND "order"=${BigInt(args.ticket.order)}`;
  if (!received || received.receivedAt.getTime() !== i.issuedAt) return null;
  const rows = await rowsForQuestion(tx, f, args.previousEventKey, args.ticket.eventKey, args.ticket.order);
  const row = rows.length === 1 ? rows[0] : null;
  if (!row || row.questionOrder.toString() !== args.previousOrder || !hasSealedQuestion(row) ||
      !isDeepStrictEqual(customerDeliveryFenceSchema.parse(row.fenceJson), f)) return null;
  const proof = customerAcceptedCallbackQuestionSchema.parse({ version: 1, partId: row.id, attemptId: row.attemptId,
    providerMid: row.providerMid, payloadHash: row.payloadHash, questionEventKey: args.previousEventKey,
    questionOrder: args.previousOrder, affirmationEventKey: args.ticket.eventKey, affirmationOrder: args.ticket.order });
  const witness = Object.freeze({}) as AcceptedCustomerCallbackQuestion;
  witnessed.set(witness, { input: args.input, ticket: structuredClone(args.ticket), before: structuredClone(f), proof });
  return witness;
}

/** Serialize only the actual same-frame witness after A→B accepted transition.
 * A JSON copy, another input or later same-controller semantic state is denied. */
export function acceptedCallbackQuestionForCurrentInput(witness: unknown, input: AuthenticatedCustomerInput,
  ticket: CustomerPropertyAdmission, current: CustomerFence): CustomerAcceptedCallbackQuestion | null {
  const value = witness && typeof witness === "object" ? witnessed.get(witness) : null;
  if (!value || value.input !== input || value.ticket.eventKey !== ticket.eventKey || value.ticket.order !== ticket.order ||
      value.ticket.conversationId !== ticket.conversationId || !sameController(value.before, current) ||
      BigInt(current.stateRevision) !== BigInt(value.before.stateRevision) + 1n || current.intentRevision !== value.before.intentRevision) return null;
  return structuredClone(value.proof);
}

/** Reuse only the actual persisted consent reference. Current B or later
 * phone continuation still needs the existing exact current-IN/kernel fences.
 * A's old FINAL is NOT reissued after B; the admission below certified A→B. */
export async function acceptedCallbackQuestionCurrentTx(tx: TxClient, fence: CustomerFence,
  consent: CustomerCallbackConsent, current: { eventKey: string; order: string }): Promise<boolean> {
  if (!isActiveTransactionClient(tx) || !consent.acceptedQuestion) return false;
  const proof = customerAcceptedCallbackQuestionSchema.parse(consent.acceptedQuestion);
  if (proof.affirmationEventKey !== consent.originalEventKey || proof.affirmationOrder !== consent.originalOrder) return false;
  const [b] = await tx.$queryRaw<Array<{ eventKey: string; order: bigint; scopeKey: string; payloadHash: string | null;
    conversationId: string | null; originalConversationId: string | null; receivedAt: Date;
    originVersion: number | null; originCiphertext: string | null; inputRecordedAt: Date | null }>>`
    SELECT "eventKey","order","scopeKey","payloadHash","conversationId","originalConversationId","receivedAt",
      "originVersion","originCiphertext","inputRecordedAt" FROM "CustomerPropertyIngressTicket"
    WHERE "eventKey"=${proof.affirmationEventKey} AND "order"=${BigInt(proof.affirmationOrder)}`;
  if (!b || b.originVersion !== 1 || !b.originCiphertext || !b.inputRecordedAt) return false;
  try {
    // Read the original AEAD FINAL; do not reissue B as current after phone C.
    // Its verified immutable data is not a principal or a new input age.
    const original = decryptCustomerFinalOrigin(b.originCiphertext), i = original.input;
    if (original.eventKey !== b.eventKey || original.order !== b.order.toString() || original.scopeKey !== b.scopeKey ||
        original.payloadHash !== b.payloadHash || original.originalConversationId !== fence.nativeId ||
        b.originalConversationId !== fence.nativeId || b.conversationId !== fence.nativeId ||
        i.issuedAt !== b.receivedAt.getTime() || i.provenance !== "meta_signature" || i.assurance !== "protected_namespace" ||
        i.protectedMetaAccountId !== fence.endpoint.accountId || i.protectedMetaEndpointScopeId !== fence.endpoint.endpointScopeId ||
        !isCustomerCallbackAffirmative(i.inputText) || !sameController(i.acceptedFence, fence)) return false;
  } catch { return false; }
  const rows = await rowsForQuestion(tx, fence, proof.questionEventKey, proof.affirmationEventKey, proof.affirmationOrder,
    current.eventKey, current.order);
  const row = rows.length === 1 ? rows[0] : null;
  return !!row && row.id === proof.partId && row.attemptId === proof.attemptId && row.providerMid === proof.providerMid &&
    row.payloadHash === proof.payloadHash && row.questionOrder.toString() === proof.questionOrder && hasSealedQuestion(row) &&
    sameController(customerDeliveryFenceSchema.parse(row.fenceJson), fence);
}

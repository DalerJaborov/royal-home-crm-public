import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { customerAgentStoredTextPayloadSchema, type CustomerFence, type CustomerPropertyAdmission } from "@royal-home/shared";
import type { TxClient } from "../db.js";
import { decryptSecret } from "../crypto.js";
import { customerAgentNameQuestionText } from "../ai/customerAgentRenderer.js";
import { customerDeliveryFenceSchema } from "./customerDeliveryContracts.js";
import { decryptCustomerFinalOrigin } from "./customerOriginPayload.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { inspectAuthenticatedCustomerInput, type AuthenticatedCustomerInput } from "./customerIngressAuthority.js";

function sameController(a: CustomerFence, b: CustomerFence): boolean {
  return a.inquiryId === b.inquiryId && a.nativeId === b.nativeId && isDeepStrictEqual(a.endpoint, b.endpoint) &&
    a.ownerToken === b.ownerToken && a.ownershipEpoch === b.ownershipEpoch && a.bindingRevision === b.bindingRevision &&
    a.scopeRevision === b.scopeRevision && a.policyRevision === b.policyRevision;
}

/** Only for the already authenticated current-IN contact issuer under its locks.
 * Read a genuine, sealed, provider-accepted name question before B arrived.
 * This proves conversational purpose, never a Client identity or callback consent. */
export async function hasAcceptedCustomerNameQuestionTx(tx: TxClient, fence: CustomerFence,
  ticket: CustomerPropertyAdmission, input: AuthenticatedCustomerInput): Promise<boolean> {
  const current = inspectAuthenticatedCustomerInput(input);
  if (!isActiveTransactionClient(tx) || !fence.nativeId || !current || current.provenance !== "meta_signature" ||
      current.assurance !== "protected_namespace" || !current.verifierCredential) return false;
  const rows = await tx.$queryRaw<Array<{ payloadEncrypted: string; payloadHash: string; fenceJson: unknown;
    agentRevisionId: string; originCiphertext: string; questionEventKey: string; questionOrder: bigint }>>`
    SELECT p."payloadEncrypted",p."payloadHash",p."fenceJson",p."agentRevisionId",q."originCiphertext",
      q."eventKey" AS "questionEventKey",q."order" AS "questionOrder"
    FROM "CustomerOutboxPart" p
    JOIN "CustomerDeliveryAttempt" a ON a."partId"=p."id" AND a."endpointScopeId"=p."endpointScopeId"
    JOIN "CustomerPropertyIngressTicket" q ON q."eventKey"=p."ticketEventKey"
    JOIN "CustomerPropertyIngressTicket" b ON b."eventKey"=${ticket.eventKey} AND b."order"=${BigInt(ticket.order)}
    WHERE p."inquiryId"=${fence.inquiryId} AND p."originalNativeId"=${fence.nativeId} AND p."conversationId"=${fence.nativeId}
      AND p."endpointScopeId"=${fence.endpoint.endpointScopeId} AND p."channel"=${fence.endpoint.channel}
      AND p."sourceKind"='BOT_TURN' AND p."sourceKey"=p."ticketEventKey" AND p."mode"='LIVE' AND p."ordinal"=0
      AND p."status"='ACCEPTED' AND p."acceptedAt" IS NOT NULL AND p."acceptedAt"<=b."receivedAt"
      AND p."cancelRequestedAt" IS NULL AND p."supersededAt" IS NULL
      AND a."outcome"='ACCEPTED' AND a."providerMid" IS NOT NULL AND length(a."providerMid") BETWEEN 1 AND 512
      AND a."claimRevision"=p."claimRevision" AND a."finishedAt" IS NOT NULL AND a."finishedAt"<=b."receivedAt"
      AND q."order"<b."order" AND q."agentRevisionId"=p."agentRevisionId" AND q."tombstonedAt" IS NULL
      AND q."conversationId"=${fence.nativeId} AND q."originalConversationId"=${fence.nativeId}
      AND q."endpointScopeId"=${fence.endpoint.endpointScopeId} AND q."originVersion"=1 AND q."originCiphertext" IS NOT NULL
      AND b."conversationId"=${fence.nativeId} AND b."originalConversationId"=${fence.nativeId}
      AND b."endpointScopeId"=${fence.endpoint.endpointScopeId} AND b."tombstonedAt" IS NULL
      AND b."intakeAgentRevisionId"=p."agentRevisionId"
      AND NOT EXISTS(SELECT 1 FROM "CustomerOutboxPart" other WHERE other."ticketEventKey"=q."eventKey" AND other."id"<>p."id")
      AND NOT EXISTS(SELECT 1 FROM "CustomerPropertyIngressTicket" intervening
        WHERE intervening."conversationId"=${fence.nativeId} AND intervening."endpointScopeId"=${fence.endpoint.endpointScopeId}
          AND intervening."order">q."order" AND intervening."order"<b."order"
          AND intervening."originVersion"=1 AND intervening."originCiphertext" IS NOT NULL)
    LIMIT 2`;
  if (rows.length !== 1) return false;
  try {
    const row = rows[0], plain = decryptSecret(row.payloadEncrypted);
    if (createHash("sha256").update(plain).digest("hex") !== row.payloadHash) return false;
    const stored = customerAgentStoredTextPayloadSchema.parse(JSON.parse(plain)), question = stored.publicData?.nameQuestion;
    if (!question || stored.publicData?.agentRevisionId !== row.agentRevisionId ||
        !stored.text.endsWith(customerAgentNameQuestionText(question.language))) return false;
    const old = customerDeliveryFenceSchema.parse(row.fenceJson), origin = decryptCustomerFinalOrigin(row.originCiphertext);
    const original = origin.input.acceptedFence;
    return !!original && origin.eventKey === row.questionEventKey && origin.order === row.questionOrder.toString() &&
      origin.scopeKey === ticket.scopeKey && origin.originalConversationId === fence.nativeId &&
      origin.input.provenance === "meta_signature" && origin.input.assurance === "protected_namespace" &&
      isDeepStrictEqual(origin.input.verifierCredential, current.verifierCredential) &&
      sameController(original, old) && sameController(old, fence) &&
      BigInt(original.stateRevision) <= BigInt(old.stateRevision) && BigInt(original.intentRevision) <= BigInt(old.intentRevision) &&
      BigInt(old.stateRevision) < BigInt(fence.stateRevision) && BigInt(old.intentRevision) <= BigInt(fence.intentRevision);
  } catch { return false; }
}

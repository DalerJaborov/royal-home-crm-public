import { isDeepStrictEqual } from "node:util";
import { prisma } from "../db.js";
import { customerAgentClaimCurrentTx, type CustomerAgentClaim } from "./customerAgentClaim.js";
import { customerPrincipalAuthenticatedInput, revalidateCustomerPrincipal, type CustomerPrincipal } from "./customerPrincipal.js";
import { inspectAuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { decryptCustomerFinalOrigin } from "./customerOriginPayload.js";
import { decryptCustomerIngressEnvelope } from "./customerIngressPayload.js";
import { decodeCustomerAgentMediaObservation } from "./customerAgentMediaObservation.js";
import { customerMemoryFenceMatches } from "./customerAgentVerifiedContext.js";
import type { CustomerAgentMediaPerception } from "../ai/customerAgentMediaPerception.js";

/** A caption can arrive while its photo is still being perceived. Reuse only
 * finite visual labels from that immediately preceding, safely abandoned turn.
 * This is NOT access to private history: no OCR, transcript, contact, original
 * caption, document text, consent, action or assistant output crosses this read.
 * Neither FINAL assurance nor the original observation is rewritten. */
export async function loadCustomerAdjacentVisualObservation(principal: CustomerPrincipal,
  claim: CustomerAgentClaim): Promise<CustomerAgentMediaPerception | null> {
  const frame = customerPrincipalAuthenticatedInput(principal), input = frame && inspectAuthenticatedCustomerInput(frame);
  if (!input || principal.visibility !== "private_dm" || input.provenance !== "meta_signature" ||
      input.assurance !== "public_envelope" || input.issuerSource !== "verified_public_envelope" || !input.verifierCredential ||
      !await customerAgentClaimCurrentTx(prisma, claim) || (await revalidateCustomerPrincipal(principal)).status !== "current") return null;
  const row = await prisma.customerPropertyIngressTicket.findFirst({ where: {
    conversationId: principal.scope.conversationId, originalConversationId: principal.scope.conversationId,
    scopeKey: principal.scope.scopeKey, endpointScopeId: principal.scope.endpointScopeId,
    order: { lt: BigInt(principal.admission.order) }, tombstonedAt: null,
  }, orderBy: { order: "desc" }, include: { _count: { select: { outboxParts: true } } } });
  if (!row || row.processingState !== "HELD" || row.errorCode !== "newer_input_pending" || row._count.outboxParts ||
      row.plannedAt || !row.inputRecordedAt || row.payloadVersion !== 1 || !row.payloadHash || !row.payloadCiphertext ||
      row.originVersion !== 1 || !row.originCiphertext || row.agentRevisionId !== claim.pin.agentRevisionId ||
      row.intakeAgentRevisionId !== row.agentRevisionId || !row.providerOperationId ||
      row.mediaObservationVersion !== 1 || !row.mediaObservationCiphertext || !row.mediaObservedAt ||
      input.issuedAt < row.receivedAt.getTime() || input.issuedAt - row.receivedAt.getTime() > 30_000) return null;
  try {
    const origin = decryptCustomerFinalOrigin(row.originCiphertext), previous = origin.input;
    const envelope = decryptCustomerIngressEnvelope({ version: 1, eventKey: row.eventKey, order: row.order.toString(),
      scopeKey: row.scopeKey, endpointScopeId: row.endpointScopeId!, payloadHash: row.payloadHash }, row.payloadCiphertext);
    if (origin.eventKey !== row.eventKey || origin.order !== row.order.toString() || origin.scopeKey !== row.scopeKey ||
        origin.originalConversationId !== principal.scope.conversationId || origin.payloadHash !== row.payloadHash ||
        previous.assurance !== input.assurance || previous.provenance !== input.provenance || previous.issuerSource !== input.issuerSource ||
        previous.channel !== input.channel || previous.peer !== input.peer || previous.accountExternalId !== input.accountExternalId ||
        previous.issuerAccountId !== principal.scope.accountId || previous.issuerEndpointScopeId !== principal.scope.endpointScopeId ||
        previous.issuedAt !== row.receivedAt.getTime() || !isDeepStrictEqual(previous.verifierCredential, input.verifierCredential) ||
        !isDeepStrictEqual(previous.verifierCredential, envelope.verification.verifierCredential) ||
        !customerMemoryFenceMatches(previous.acceptedFence, principal.authority.fence) ||
        previous.inputText !== envelope.payload.inputText || previous.eventId !== envelope.payload.eventId ||
        previous.channel !== envelope.payload.channel || previous.peer !== envelope.payload.peer ||
        previous.accountExternalId !== envelope.payload.accountExternalId || previous.eventKind !== envelope.payload.eventKind ||
        envelope.verification.accountId !== previous.issuerAccountId || envelope.verification.endpointScopeId !== previous.issuerEndpointScopeId ||
        envelope.verification.assurance !== previous.assurance || envelope.verification.issuedAt !== previous.issuedAt ||
        envelope.verification.issuerSource !== previous.issuerSource || envelope.verification.provenance !== previous.provenance ||
        envelope.verification.scopeRevision !== previous.acceptedFence.scopeRevision ||
        envelope.verification.policyRevision !== previous.acceptedFence.policyRevision ||
        envelope.payload.observations.providerEcho || envelope.payload.observations.referralOnly ||
        envelope.payload.observations.classifier?.bareTemplateEcho !== false ||
        !envelope.payload.media.some(media => media.kind === "image" || media.kind === "video")) return null;
    const media = decodeCustomerAgentMediaObservation(row.mediaObservationCiphertext, { version: 1, eventKey: row.eventKey,
      payloadHash: row.payloadHash, agentRevisionId: row.agentRevisionId, providerOperationId: row.providerOperationId,
      observedAt: row.mediaObservedAt.getTime() });
    if (!["home_interior", "building_exterior", "floor_plan", "listing_card"].includes(media.subject) ||
        !await customerAgentClaimCurrentTx(prisma, claim) || (await revalidateCustomerPrincipal(principal)).status !== "current") return null;
    return { subject: media.subject, visible: media.visible, language: "unknown", transcript: "", readableText: "", speech: "none",
      ...(media.incomplete !== undefined ? { incomplete: media.incomplete } : {}) };
  } catch { return null; }
}

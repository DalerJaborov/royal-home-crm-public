import { z } from "zod";
import type { CustomerAgentAttachmentInput } from "../ai/customerAgentAttachmentInput.js";
import { customerDmAttachmentInput } from "./customerDmAttachmentInput.js";
import type { CustomerNormalizedIngressInput } from "./customerIngressPayload.js";
import { resolveCustomerPropertyTurnContext, type CustomerPropertyTurnContext } from "./customerPropertyTurnContext.js";
import { prisma } from "../db.js";
import { inspectAuthenticatedCustomerInput, recoverCustomerPendingEnvelope,
  inspectRecoveredCustomerPendingEnvelope } from "./customerIngressAuthority.js";
import { recoverAndFinalizeCustomerInboxInput } from "./customerIngressRecovery.js";
import { recordScopedCustomerInput } from "./customerQualifierLedger.js";
import { loadCustomerDmCoreQualifierLane, refreshCustomerQualifierProjection, type ScopedCustomerQualifierLane } from "./customerQualifierContext.js";
import { loadCustomerTransportForConversation } from "./customerConversationScope.js";
import { noteRealInbound } from "./outboundShield.js";

export type PreparedCustomerDmCoreContext =
  | { status: "prepared"; lane: ScopedCustomerQualifierLane; focus: CustomerPropertyTurnContext | null;
      attachmentInput?: CustomerAgentAttachmentInput; attachmentPropertyReference: boolean;
      media: CustomerNormalizedIngressInput["media"] }
  | { status: "already_planned" }
  | { status: "ignored"; reason: string }
  | { status: "held"; reason: string };

/** Join live and recovered intake through the SAME genuine durable FINAL.
 * No synthetic request, authority from JSON, second sequence or paid/model I/O.
 * Compatibility routing belongs before this adapter; a managed HOLD never
 * falls back to the old full turn. Context preparation is not a lease/plan. */
export async function prepareCustomerDmInboxCoreContext(eventKey: unknown): Promise<PreparedCustomerDmCoreContext> {
  const parsed = z.string().regex(/^[a-f0-9]{64}$/).safeParse(eventKey);
  if (!parsed.success) return { status: "held", reason: "invalid_event_key" };
  try {
    const stored = await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey: parsed.data },
      select: { tombstonedAt: true, processingState: true } });
    if (!stored) return { status: "held", reason: "ticket_missing" };
    if (stored.tombstonedAt) return { status: "held", reason: "ticket_tombstoned" };
    if (stored.processingState === "PLANNED") return { status: "already_planned" };
    const recovered = await recoverAndFinalizeCustomerInboxInput(parsed.data);
    if (recovered.status !== "finalized") return recovered;
    const { input, ticket } = recovered;
    const evidence = inspectAuthenticatedCustomerInput(input);
    if (!evidence || !["INSTAGRAM", "FACEBOOK", "WHATSAPP", "WEBSITE"].includes(evidence.channel)) {
      return { status: "held", reason: "unsupported_channel" };
    }
    const pending = await recoverCustomerPendingEnvelope(parsed.data);
    const payload = pending.status === "pending" ? inspectRecoveredCustomerPendingEnvelope(pending.envelope) : null;
    if (!payload || payload.eventKey !== ticket.eventKey || payload.order !== ticket.order ||
        payload.payload.channel !== evidence.channel || payload.payload.peer !== evidence.peer ||
        payload.payload.eventId !== evidence.eventId || payload.payload.inputText !== evidence.inputText ||
        payload.verification.accountId !== ticket.accountId || payload.verification.endpointScopeId !== ticket.endpointScopeId ||
        payload.verification.issuedAt !== evidence.issuedAt) return { status: "held", reason: "payload_binding_unavailable" };
    const canonicalTicket = { ...ticket, evidence: payload.payload.propertyEvidence };
    if (!await recordScopedCustomerInput({ channel: evidence.channel, subscriberId: evidence.peer,
      skipSaveIncoming: false, replyToMessageId: payload.payload.replyToMessageId }, input, canonicalTicket)) {
      return { status: "held", reason: "input_record_unavailable" };
    }
    // CORE bypasses the legacy webhook loop's noteRealInbound. Without this
    // genuine FINAL observation, its replies were classified as initiatives
    // and could be silenced by the global initiative pulse. Never renew age or
    // clear a native/HUMAN pause after the original controller was captured
    // (the shield pause itself is lifted earlier, in the acceptance transaction
    // of customerIngressRecovery, before the fence is captured). Every signed
    // Meta input counts, public_envelope included: its age used to stay unset.
    if (evidence.provenance === "meta_signature") {
      const transport = await loadCustomerTransportForConversation(ticket.conversationId);
      if (!transport || !evidence.acceptedFence || transport.endpointScopeId !== ticket.endpointScopeId || transport.channel !== evidence.channel ||
          transport.accountId !== ticket.accountId || transport.scopeRevision !== evidence.acceptedFence.scopeRevision) {
        return { status: "held", reason: "original_context_changed" };
      }
      await noteRealInbound({ channel: evidence.channel, subscriberId: evidence.peer, transport,
        providerId: evidence.eventId, now: new Date(evidence.issuedAt), preserveNativeOwner: true });
    }
    // Complete this original IN public focus before minting a point-in-time
    // principal: real P03 updates advance canonical semantic stateRevision.
    // The following genuine lane checks still reject newer IN/controller changes.
    const focus = await resolveCustomerPropertyTurnContext({ status: "admitted", ticket: canonicalTicket }, [canonicalTicket]);
    if (focus?.superseded) return { status: "held", reason: "original_context_changed" };
    const lane = await loadCustomerDmCoreQualifierLane({ authenticatedInput: input, ticket: canonicalTicket });
    if (lane.mode === "legacy") return { status: "held", reason: "core_policy_not_active" };
    if (lane.mode !== "scoped") return { status: "held", reason: "original_context_changed" };
    const current = await refreshCustomerQualifierProjection(lane);
    if (current.status !== "current") return { status: "held", reason: "original_context_changed" };
    return { status: "prepared", lane: { ...lane, context: current.context }, focus,
      attachmentInput: customerDmAttachmentInput(payload.payload), media: structuredClone(payload.payload.media),
      attachmentPropertyReference: payload.payload.propertyEvidence.some(item =>
        ["media", "url", "ad", "public_selector", "reply"].includes(item.kind)) };
  } catch {
    return { status: "held", reason: "storage_unavailable" };
  }
}

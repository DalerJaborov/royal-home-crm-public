import { readCustomerDmSubjectExecution, readCustomerDmSourceExecution } from "./customerAgentEnrollment.js";
import { resolveCustomerEndpoint, loadCustomerTransportForConversation, type CustomerTransportReference } from "./customerConversationScope.js";
import { assertCustomerInboxPlannableTx } from "./customerIngressInbox.js";
import type { CustomerPropertyAdmission, CustomerPropertyAdmissionResult, CustomerStateSnapshot } from "@royal-home/shared";
import { prisma } from "../db.js";
import { extractVolunteeredPhone } from "../ai/leadQualifier.js";
import type { ScopedCustomerQualifierContext } from "../ai/customerPromptMemory.js";
import { isPublicAgencyPhone, isRetiredPublicAgencyPhone } from "./publicAgencyContact.js";
import { inspectAuthenticatedCustomerInput, type AuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { loadPublicCustomerPrincipal, revalidateCustomerPrincipal, type CustomerPrincipal } from "./customerPrincipal.js";
import { observeProtectedInquiryPhone } from "./customerActionJournal.js";

export interface ScopedCustomerQualifierLane {
  readonly mode: "scoped";
  readonly principal: CustomerPrincipal;
  readonly authenticatedInput: AuthenticatedCustomerInput;
  readonly ticket: CustomerPropertyAdmission;
  readonly context: ScopedCustomerQualifierContext;
  readonly publicState: CustomerStateSnapshot["publicState"];
}
export type CustomerQualifierLane = { mode: "legacy" } | { mode: "held"; reason: string } | ScopedCustomerQualifierLane;
export interface CustomerQualifierLaneInput {
  channel: string; subscriberId: string; fromStaff?: boolean; accountExternalId?: string; customerTransport?: CustomerTransportReference;
  customerAuthenticatedInput?: AuthenticatedCustomerInput;
  customerPropertyAdmission?: CustomerPropertyAdmissionResult;
}

/** This is orchestration of the existing qualifier, not a model/tool grant.
 * Selecting scoped policy commits to its proof boundary: a missing/expired
 * frame can never turn into permission to fall back to old profile memory. */
export async function loadCustomerQualifierLane(input: CustomerQualifierLaneInput): Promise<CustomerQualifierLane> {
  if (input.fromStaff) return { mode: "legacy" };
  try {
    if (["INSTAGRAM", "FACEBOOK", "WHATSAPP"].includes(input.channel)) {
      const transport = await resolveCustomerEndpoint({ channel: input.channel, subscriberId: input.subscriberId,
        accountExternalId: input.accountExternalId, transport: input.customerTransport });
      const original = await readCustomerDmSubjectExecution(prisma, transport, input.subscriberId);
      if (original?.lane === "LEGACY") return { mode: "legacy" };
      if (original) return { mode: "held", reason: "original_core_owns_turn" };
    }
    const policy = await prisma.customerRuntimePolicy.findUnique({ where: { id: "singleton" },
      select: { contractVersion: true, rolloutMode: true } });
    if (!policy || !["compat", "scoped"].includes(policy.contractVersion) || !["OFF", "SHADOW", "ACTIVE"].includes(policy.rolloutMode)) {
      return { mode: "held", reason: "policy_unavailable" };
    }
    if (policy.contractVersion === "compat" || policy.rolloutMode !== "ACTIVE") return { mode: "legacy" };
    if (["INSTAGRAM", "FACEBOOK", "WHATSAPP"].includes(input.channel)) return { mode: "held", reason: "original_assignment_required" };
    return await constructAcceptedCustomerQualifierLane(input);
  } catch { return { mode: "held", reason: "projection_unavailable" }; }
}

/** Internal genuine P11 context entry. This does not elect a model worker or
 * grant tools/OUT: customerDmAgentTurn still claims the original ticket AFTER
 * this read-only projection, using the unchanged opaque principal/pin CAS.
 * There is no caller-supplied core boolean, transport or account fallback. */
export async function loadCustomerDmCoreQualifierLane(input: {
  authenticatedInput: AuthenticatedCustomerInput; ticket: CustomerPropertyAdmission;
}): Promise<CustomerQualifierLane> {
  try {
    const evidence = inspectAuthenticatedCustomerInput(input.authenticatedInput);
    if (!evidence?.acceptedFence || (evidence.channel !== "INSTAGRAM" && evidence.channel !== "FACEBOOK" && evidence.channel !== "WHATSAPP")) {
      return { mode: "held", reason: "accepted_core_input_required" };
    }
    const ticket = input.ticket, fence = evidence.acceptedFence;
    if (fence.nativeId !== ticket.conversationId || fence.endpoint.endpointScopeId !== ticket.endpointScopeId ||
        fence.endpoint.channel !== evidence.channel || fence.endpoint.peerId !== evidence.peer ||
        fence.endpoint.accountId !== ticket.accountId) return { mode: "held", reason: "original_context_changed" };
    const transport = await loadCustomerTransportForConversation(ticket.conversationId);
    if (!transport || transport.endpointScopeId !== ticket.endpointScopeId || transport.accountId !== ticket.accountId ||
        transport.channel !== evidence.channel || transport.scopeRevision !== fence.scopeRevision) {
      return { mode: "held", reason: "original_transport_changed" };
    }
    const elected = await readCustomerDmSourceExecution(prisma, ticket.eventKey, ticket.scopeKey, {
      surface: "dm", endpoint: { channel: evidence.channel, accountId: transport.accountId,
        endpointScopeId: transport.endpointScopeId, scopeRevision: transport.scopeRevision, transportKey: transport.transportKey }, peer: evidence.peer,
    });
    if (elected?.lane !== "CORE" || !elected.revisionId) return { mode: "held", reason: "original_core_source_required" };
    const lane = await constructAcceptedCustomerQualifierLane({ channel: evidence.channel, subscriberId: evidence.peer,
      customerAuthenticatedInput: input.authenticatedInput, customerPropertyAdmission: { status: "admitted", ticket } });
    if (lane.mode !== "scoped") return lane;
    // Genuine FINAL decrypt + original credential/controller/age + recorded-IN
    // check. Copied ticket/JSON and another event's opaque frame cannot pass.
    const verified = await prisma.$transaction(async tx => {
      const witness = await assertCustomerInboxPlannableTx(tx, lane.principal);
      if (!witness || witness.eventKey !== ticket.eventKey || witness.order !== ticket.order) return false;
      const source = await tx.customerPropertyIngressTicket.findUnique({ where: { eventKey: ticket.eventKey },
        select: { intakeAgentRevisionId: true } });
      return source?.intakeAgentRevisionId === elected.revisionId;
    });
    if (!verified || (await revalidateCustomerPrincipal(lane.principal)).status !== "current") {
      return { mode: "held", reason: "original_context_changed" };
    }
    return lane;
  } catch { return { mode: "held", reason: "projection_unavailable" }; }
}

/** Shared private constructor; only callers above choose a lane. A genuine
 * accepted opaque input and DB-backed public principal remain mandatory. */
async function constructAcceptedCustomerQualifierLane(input: CustomerQualifierLaneInput): Promise<CustomerQualifierLane> {
  try {
    const frame = input.customerAuthenticatedInput;
    const evidence = inspectAuthenticatedCustomerInput(frame);
    const admission = input.customerPropertyAdmission;
    if (!frame || !evidence?.acceptedFence || evidence.channel !== input.channel || evidence.peer !== input.subscriberId || admission?.status !== "admitted") {
      return { mode: "held", reason: "accepted_input_required" };
    }
    const loaded = await loadPublicCustomerPrincipal({ admission: admission.ticket, authenticatedInput: frame,
      visibility: input.channel === "WEBSITE" ? "website_chat" : "private_dm" });
    if (loaded.status !== "public_only") return { mode: "held", reason: "principal_unavailable" };
    const current = await revalidateCustomerPrincipal(loaded.principal);
    if (current.status !== "current" || current.snapshot.state.contractVersion !== "scoped" || current.snapshot.state.rolloutMode !== "ACTIVE") {
      return { mode: "held", reason: "accepted_input_changed" };
    }
    const lane: ScopedCustomerQualifierLane = { mode: "scoped", principal: loaded.principal,
      authenticatedInput: frame, ticket: admission.ticket,
      context: { mode: "scoped_customer", history: [{ role: "user", content: evidence.inputText }],
        draft: { stage: "chatting" }, knownPhoneSource: "none" }, publicState: structuredClone(current.snapshot.state.publicState) };
    const projection = await refreshCustomerQualifierProjection(lane);
    return projection.status === "current" ? { ...lane, context: projection.context } : { mode: "held", reason: projection.reason };
  } catch { return { mode: "held", reason: "projection_unavailable" }; }
}

/** Revalidate the ORIGINAL opaque principal after the phone-reader await. A
 * fresh Client link/history phone is never consulted. Root-approved current
 * strong WA envelope availability is a UX fact, not literal text/private proof,
 * call consent, or a mutation grant; P06 owns that exact validator. */
export async function refreshCustomerQualifierProjection(lane: ScopedCustomerQualifierLane): Promise<
  { status: "current"; context: ScopedCustomerQualifierContext } | { status: "held"; reason: string }
> {
  const before = await revalidateCustomerPrincipal(lane.principal);
  if (before.status !== "current") return { status: "held", reason: "accepted_input_changed" };
  const evidence = inspectAuthenticatedCustomerInput(lane.authenticatedInput);
  if (!evidence) return { status: "held", reason: "accepted_input_expired" };
  const phone = await observeProtectedInquiryPhone(lane.authenticatedInput, lane.ticket);
  if (phone.status !== "current") return { status: "held", reason: phone.reason };
  const after = await revalidateCustomerPrincipal(lane.principal);
  if (after.status !== "current") return { status: "held", reason: "accepted_input_changed" };
  const literalPhone = extractVolunteeredPhone(evidence.inputText);
  const literalDigits = literalPhone?.replace(/\D/g, "");
  const literalKnown = !!literalDigits && !isPublicAgencyPhone(literalDigits) && !isRetiredPublicAgencyPhone(literalDigits);
  const source = literalKnown ? "current_input" : phone.knownPhoneSource;
  return { status: "current", context: { ...lane.context, knownPhoneSource: source } };
}

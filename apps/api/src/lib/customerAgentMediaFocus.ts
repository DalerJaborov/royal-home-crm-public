import { randomUUID } from "node:crypto";
import { customerPropertyFocusSchema, type CustomerPropertyAdmission, type CustomerPropertyEvidence } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { readCustomerSearchSelection } from "./customerSearchSelection.js";
import { loadCustomerAgentMediaObservation } from "./customerAgentMediaObservation.js";
import { customerAgentClaimAcceptsPrincipal, customerAgentClaimCurrentTx, type CustomerAgentClaim } from "./customerAgentClaim.js";
import { loadPublicCustomerPrincipal, revalidateCustomerPrincipal, type CustomerPrincipal } from "./customerPrincipal.js";
import { pinCustomerAgentTurnTx } from "./customerAgentRevision.js";
import { customerPropertyEvidenceFromText, mergeCustomerPropertyEvidence } from "./customerPropertyEvidence.js";
import { resolveCustomerPropertyEvidence } from "./customerPropertyResolver.js";
import { customerPropertyRegistry } from "./customerPropertyRegistry.js";
import { readCustomerPropertyFocus } from "./customerPropertyFocus.js";
import { customerPrincipalAuthenticatedInput } from "./customerPrincipal.js";
import { resolveCustomerPropertyTurnContext, type CustomerPropertyTurnContext } from "./customerPropertyTurnContext.js";

/** Interpret an explicit spoken/printed public object number with the SAME
 * existing resolver/focus. Never infer identity from appearance, phone or OCR
 * prices; never rewrite RAW/FINAL, renew the source or create a new IN. */
export async function enrichCustomerAgentMediaFocus(input: {
  principal: CustomerPrincipal; claim: CustomerAgentClaim; ticket: CustomerPropertyAdmission;
}): Promise<{ status: "unchanged" } | { status: "updated"; principal: CustomerPrincipal; focus: CustomerPropertyTurnContext } |
  { status: "held"; reason: string }> {
  if ((["eventKey", "order", "scopeKey", "conversationId", "channel", "accountId", "endpointScopeId"] as const)
    .some(key => input.ticket[key] !== input.principal.admission[key])) return { status: "held", reason: "media_focus_original_input_required" };
  if (!customerAgentClaimAcceptsPrincipal(input.claim, input.principal) || !await customerAgentClaimCurrentTx(prisma, input.claim)) return { status: "held", reason: "media_focus_claim_changed" };
  const before = await revalidateCustomerPrincipal(input.principal);
  if (before.status !== "current") return { status: "held", reason: "media_focus_context_changed" };
  if (!before.snapshot.state.capabilities.publicRead) return { status: "unchanged" };
  const media = await loadCustomerAgentMediaObservation(input.claim);
  if (!media) return { status: "unchanged" };
  const candidates = customerPropertyEvidenceFromText([media.transcript, media.subject === "listing_card" ? media.readableText : ""].join("\n"));
  if (candidates.some(item => item.kind === "untrusted_reference" && item.reference === "too_many_references")) return { status: "held", reason: "media_reference_overflow" };
  const selectors = candidates.filter(item => item.kind === "public_selector");
  if (!selectors.length) return { status: "unchanged" };
  return enrichFocus(input, selectors, media.speech === "partial");
}

type FocusInput = { principal: CustomerPrincipal; claim: CustomerAgentClaim; ticket: CustomerPropertyAdmission };
/** Selection is derived from the actual ACCEPTED list in this inquiry; the
 * source is checked again under the canonical locks before updating focus. */
export async function enrichCustomerAgentSelectionFocus(input: FocusInput): ReturnType<typeof enrichCustomerAgentMediaFocus> {
  const selected = await readCustomerSearchSelection(input.principal);
  if (selected.status === "none") return { status: "unchanged" };
  return enrichFocus(input, selected.status === "selected" ? [{ kind: "public_selector", origin: "message", reference: `short:${selected.shortId}` }] : [],
    selected.status === "ambiguous", selected.status === "selected" ? selected.assertSourceCurrent : undefined);
}
async function enrichFocus(input: FocusInput, selectors: CustomerPropertyEvidence[], ambiguous: boolean,
  assertSourceCurrent?: (tx: TxClient) => Promise<boolean>): ReturnType<typeof enrichCustomerAgentMediaFocus> {
  if ((["eventKey", "order", "scopeKey", "conversationId", "channel", "accountId", "endpointScopeId"] as const)
    .some(key => input.ticket[key] !== input.principal.admission[key]) || !customerAgentClaimAcceptsPrincipal(input.claim, input.principal)) {
    return { status: "held", reason: "media_focus_original_input_required" };
  }
  const before = await revalidateCustomerPrincipal(input.principal);
  if (before.status !== "current" || !before.snapshot.state.capabilities.publicRead) return { status: "held", reason: "media_focus_context_changed" };
  const evidence = mergeCustomerPropertyEvidence([input.ticket.evidence, selectors]);
  const focus = await readCustomerPropertyFocus(input.ticket);
  if (!focus || BigInt(focus.focus.lastEvidenceOrder) > BigInt(input.ticket.order)) return { status: "held", reason: "media_focus_superseded" };
  const resolution = ambiguous ? { status: "ambiguous" as const, propertyId: null, candidates: [], reason: "conflict" as const, provenance: evidence }
    : await resolveCustomerPropertyEvidence(evidence, input.ticket, customerPropertyRegistry);
  const next = customerPropertyFocusSchema.parse({ version: 1, scopeKey: input.ticket.scopeKey, generation: randomUUID(),
    lastEvidenceOrder: input.ticket.order, eventKey: input.ticket.eventKey, status: resolution.status,
    propertyId: resolution.propertyId, evidence });
  if ((await revalidateCustomerPrincipal(input.principal)).status !== "current") return { status: "held", reason: "media_focus_context_changed" };
  const changed = await prisma.$transaction(async tx => {
    // Reuse the existing canonical source/native/scope/policy/Inquiry locks and
    // ORIGINAL immutable pin; no second provider operation or controller.
    const pinned = await pinCustomerAgentTurnTx(tx, input.principal);
    if (pinned.status !== "pinned" || pinned.pin.providerOperationId !== input.claim.pin.providerOperationId ||
      pinned.pin.agentRevisionId !== input.claim.pin.agentRevisionId || !await customerAgentClaimCurrentTx(tx, input.claim)) return false;
    if (assertSourceCurrent && !await assertSourceCurrent(tx)) return false;
    const count = await tx.$executeRaw`UPDATE "BotConversation" SET "customerPropertyFocus"=${JSON.stringify(next)}::jsonb,
      "customerPropertyFocusRevision"="customerPropertyFocusRevision"+1 WHERE "id"=${input.ticket.conversationId}
      AND "endpointScopeId"=${input.principal.scope.endpointScopeId} AND "accountId" IS NOT DISTINCT FROM ${input.ticket.accountId}
      AND "customerPropertyFocusRevision"=${focus.revision}`;
    if (count !== 1) return false;
    return true;
  });
  if (!changed) return { status: "held", reason: "media_focus_changed" };
  const frame = customerPrincipalAuthenticatedInput(input.principal);
  const loaded = frame && await loadPublicCustomerPrincipal({ admission: input.ticket, authenticatedInput: frame, visibility: input.principal.visibility });
  if (!loaded || loaded.status !== "public_only" || !customerAgentClaimAcceptsPrincipal(input.claim, loaded.principal) ||
    loaded.principal.authority.fence.stateRevision !== (BigInt(input.principal.authority.fence.stateRevision) + 1n).toString() ||
    loaded.principal.authority.fence.intentRevision !== input.principal.authority.fence.intentRevision ||
    (await revalidateCustomerPrincipal(loaded.principal)).status !== "current") return { status: "held", reason: "media_focus_controller_changed" };
  const context = await resolveCustomerPropertyTurnContext({ status: "admitted", ticket: input.ticket }, [input.ticket]);
  if (!context || context.superseded || context.snapshot.focus.generation !== next.generation || !await customerAgentClaimCurrentTx(prisma, input.claim)) return { status: "held", reason: "media_focus_superseded" };
  return { status: "updated", principal: loaded.principal, focus: context };
}

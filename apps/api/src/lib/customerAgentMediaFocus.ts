import { randomUUID } from "node:crypto";
import { customerPropertyFocusSchema, type CustomerPropertyAdmission, type CustomerPropertyEvidence } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { readCustomerSearchSelection } from "./customerSearchSelection.js";
import { loadCustomerAgentMediaObservation } from "./customerAgentMediaObservation.js";
import { customerAgentClaimAcceptsPrincipal, customerAgentClaimCurrentTx, type CustomerAgentClaim } from "./customerAgentClaim.js";
import { loadPublicCustomerPrincipal, revalidateCustomerPrincipal, type CustomerPrincipal } from "./customerPrincipal.js";
import { pinCustomerAgentTurnTx } from "./customerAgentRevision.js";
import { customerPropertyEvidenceFromText, mergeCustomerPropertyEvidence } from "./customerPropertyEvidence.js";
import { resolveCustomerPropertyEvidence, type CustomerPropertyRegistry } from "./customerPropertyResolver.js";
import { customerPropertyRegistry, customerPropertyRegistryWithOwnSiteRead } from "./customerPropertyRegistry.js";
import { createCustomerOwnSiteIdentityReader, customerOwnSiteListingId, type CustomerOwnSiteReadWait } from "./customerOwnSiteIdentity.js";
import { hasNewerCustomerInboxInput } from "./customerNewerInboxInput.js";
import { readCustomerPropertyFocus } from "./customerPropertyFocus.js";
import { classifyCustomerPropertyFactIntent } from "./customerPropertyFactIntent.js";
import { customerPrincipalAuthenticatedInput } from "./customerPrincipal.js";
import { resolveCustomerPropertyTurnContext, type CustomerPropertyTurnContext } from "./customerPropertyTurnContext.js";
import { inspectAuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { customerBarePropertyAnswer, customerBarePropertyNumber } from "./customerBarePropertyAnswer.js";
import { loadCustomerAgentVerifiedDmContext } from "./customerAgentVerifiedContext.js";

/** Interpret an explicit spoken/printed public object number with the SAME
 * existing resolver/focus. Never infer identity from appearance, phone or OCR
 * prices; never rewrite RAW/FINAL, renew the source or create a new IN. */
export async function enrichCustomerAgentMediaFocus(input: FocusInput): Promise<{ status: "unchanged" } | { status: "updated"; principal: CustomerPrincipal; focus: CustomerPropertyTurnContext } |
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

type LinkReads = { registry: CustomerPropertyRegistry; wait: CustomerOwnSiteReadWait };
type FocusInput = { principal: CustomerPrincipal; claim: CustomerAgentClaim; ticket: CustomerPropertyAdmission; linkReads?: LinkReads };
/** Shared only within this elected turn, so later media/selection enrichment
 * cannot revert the URL identity to the legacy partial mapping. */
export function createCustomerAgentLinkReads(eventKey: string, input: CustomerOwnSiteReadWait): LinkReads {
  const wait: CustomerOwnSiteReadWait = { ...input,
    assertCurrent: async () => await input.assertCurrent() && !await hasNewerCustomerInboxInput(eventKey) };
  return { registry: customerPropertyRegistryWithOwnSiteRead(createCustomerOwnSiteIdentityReader(wait)), wait };
}
/** Site numeric aliases need the public site's actual CRM reference. Do this
 * after original owner election, never during webhook/intake or under DB locks. */
export async function enrichCustomerAgentLinkFocus(input: FocusInput & { linkReads: LinkReads }): ReturnType<typeof enrichCustomerAgentMediaFocus> {
  if (!input.ticket.evidence.some(item => item.kind === "url" && customerOwnSiteListingId(item.reference) !== null)) return { status: "unchanged" };
  return enrichFocus(input, [], false);
}
/** Selection is derived from the actual ACCEPTED list in this inquiry; the
 * source is checked again under the canonical locks before updating focus. */
export async function enrichCustomerAgentSelectionFocus(input: FocusInput): ReturnType<typeof enrichCustomerAgentMediaFocus> {
  const frame = customerPrincipalAuthenticatedInput(input.principal), original = frame && inspectAuthenticatedCustomerInput(frame);
  // A bare fact question ("район", "цена") that names no object anywhere may mean the single card the bot has just shown.
  const factQuestion = !!original && !input.ticket.evidence.length && classifyCustomerPropertyFactIntent(original.inputText) !== null;
  const current = factQuestion ? await readCustomerPropertyFocus(input.ticket) : null;
  const selected = await readCustomerSearchSelection(input.principal, factQuestion ? { factQuestion, focusResolved: current?.focus.status === "resolved" } : {});
  if (selected.status === "none") {
    if (!original || customerBarePropertyNumber(original.inputText) === null) return { status: "unchanged" };
    const history = await loadCustomerAgentVerifiedDmContext({ principal: input.principal, revision: input.claim.pin.revision });
    if (history.status !== "current") return { status: "held", reason: history.reason };
    const shortId = customerBarePropertyAnswer(original.inputText, history.context);
    if (shortId === null) return { status: "unchanged" };
    return enrichFocus(input, [{ kind: "public_selector", origin: "message", reference: `short:${shortId}` }], false);
  }
  return enrichFocus(input, selected.status === "selected" ? [{ kind: "public_selector", origin: "message", reference: `short:${selected.shortId}` }] : [],
    selected.status === "ambiguous", selected.status === "selected" ? selected.assertSourceCurrent : undefined);
}
async function enrichFocus(input: FocusInput, selectors: CustomerPropertyEvidence[], ambiguous: boolean,
  assertSourceCurrent?: (tx: TxClient) => Promise<boolean>): ReturnType<typeof enrichCustomerAgentMediaFocus> {
  const registry = input.linkReads?.registry ?? customerPropertyRegistry, wait = input.linkReads?.wait;
  const alive = () => !wait || !wait.signal.aborted && Date.now() < wait.deadlineAt;
  if ((["eventKey", "order", "scopeKey", "conversationId", "channel", "accountId", "endpointScopeId"] as const)
    .some(key => input.ticket[key] !== input.principal.admission[key]) || !customerAgentClaimAcceptsPrincipal(input.claim, input.principal)) {
    return { status: "held", reason: "media_focus_original_input_required" };
  }
  if (!alive() || wait && !await wait.assertCurrent()) return { status: "held", reason: "link_focus_context_changed" };
  const before = await revalidateCustomerPrincipal(input.principal);
  if (before.status !== "current" || !before.snapshot.state.capabilities.publicRead) return { status: "held", reason: "media_focus_context_changed" };
  const evidence = mergeCustomerPropertyEvidence([input.ticket.evidence, selectors]);
  const focus = await readCustomerPropertyFocus(input.ticket);
  if (!focus || BigInt(focus.focus.lastEvidenceOrder) > BigInt(input.ticket.order)) return { status: "held", reason: "media_focus_superseded" };
  const resolution = ambiguous ? { status: "ambiguous" as const, propertyId: null, candidates: [], reason: "conflict" as const, provenance: evidence }
    : await resolveCustomerPropertyEvidence(evidence, input.ticket, registry);
  const next = customerPropertyFocusSchema.parse({ version: 1, scopeKey: input.ticket.scopeKey, generation: randomUUID(),
    lastEvidenceOrder: input.ticket.order, eventKey: input.ticket.eventKey, status: resolution.status,
    propertyId: resolution.propertyId, evidence });
  if (!alive() || wait && !await wait.assertCurrent() || (await revalidateCustomerPrincipal(input.principal)).status !== "current") return { status: "held", reason: "media_focus_context_changed" };
  const changed = await prisma.$transaction(async tx => {
    // Reuse the existing canonical source/native/scope/policy/Inquiry locks and
    // ORIGINAL immutable pin; no second provider operation or controller.
    const pinned = await pinCustomerAgentTurnTx(tx, input.principal);
    if (!alive() || pinned.status !== "pinned" || pinned.pin.providerOperationId !== input.claim.pin.providerOperationId ||
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

import { randomUUID } from "node:crypto";
import { customerPropertyFocusSchema, type CustomerPropertyAdmission, type CustomerPropertyEvidence } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { readCustomerSearchSelection } from "./customerSearchSelection.js";
import { loadCustomerAgentMediaObservation } from "./customerAgentMediaObservation.js";
import { customerAgentClaimAcceptsPrincipal, customerAgentClaimCurrentTx, type CustomerAgentClaim } from "./customerAgentClaim.js";
import { loadPublicCustomerPrincipal, revalidateCustomerPrincipal, type CustomerPrincipal } from "./customerPrincipal.js";
import { pinCustomerAgentTurnTx } from "./customerAgentRevision.js";
import { customerPropertyEvidenceFromText, mergeCustomerPropertyEvidence } from "./customerPropertyEvidence.js";
import type { CustomerBurst } from "./customerDeferredInput.js";
import { customerCaptionReference, type CustomerOwnBrandMarks } from "./customerCaptionReference.js";
import { customerCaptionReferenceVerified, loadCustomerOwnBrandMarks } from "./customerOwnBrandMarks.js";
import type { CustomerAgentMediaPerception } from "../ai/customerAgentMediaPerception.js";
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
  const spoken = customerPropertyEvidenceFromText(media.transcript);
  if (spoken.some(item => item.kind === "untrusted_reference" && item.reference === "too_many_references")) return { status: "held", reason: "media_reference_overflow" };
  const selectors = mergeCustomerPropertyEvidence([spoken.filter(item => item.kind === "public_selector"),
    (await customerPerceivedCaptionSelectors(media, await loadCustomerOwnBrandMarks())).map(selectorEvidence)]);
  if (!selectors.length) return { status: "unchanged" };
  return enrichFocus(input, selectors, media.speech === "partial");
}

const selectorEvidence = (shortId: number): CustomerPropertyEvidence => ({ kind: "public_selector", origin: "message", reference: `short:${shortId}` });
/** Printed «Объект №N» on a picture (screenshot of our post, listing card): only next to our own mark and only when the
 * fields it prints (rooms, area, district) match that CRM card (lib/customerCaptionReference.ts). */
async function customerPerceivedCaptionSelectors(media: Pick<CustomerAgentMediaPerception, "subject" | "readableText">,
  marks: CustomerOwnBrandMarks): Promise<number[]> {
  const reference = customerCaptionReference(media.readableText, marks, { listingCard: media.subject === "listing_card" });
  return reference && await customerCaptionReferenceVerified(reference) ? [reference.shortId] : [];
}
async function customerSharedCaptionSelectors(captions: readonly string[], marks: CustomerOwnBrandMarks): Promise<number[]> {
  const found = new Set<number>();
  for (const caption of captions) {
    const reference = customerCaptionReference(caption, marks);
    if (reference && await customerCaptionReferenceVerified(reference)) found.add(reference.shortId);
  }
  return [...found];
}

/** One input of the current burst (set-aside inputs + the current one) as the object reference sees it. */
export interface CustomerBurstReference {
  eventKey: string; order: bigint; media: boolean;
  /** The input carried a reference of its own at admission (typed number/link, ad, reply, shared publication id). */
  ownEvidence: boolean;
  /** Verified caption/screenshot object numbers of this input (own mark + CRM card), and spoken ones. */
  selectors: readonly number[];
  /** The numbers came from Meta's caption of a shared post (they travel with that share's own references). */
  fromCaption: boolean;
  evidence: readonly CustomerPropertyEvidence[];
}
/** What each input of the burst points at. Spoken words count like typed ones; printed text needs our mark. */
export async function analyzeCustomerBurstReferences(burst: CustomerBurst, current: { eventKey: string; order: string;
  media: boolean; evidence: readonly CustomerPropertyEvidence[]; captions: readonly string[] }): Promise<CustomerBurstReference[]> {
  const marks = await loadCustomerOwnBrandMarks();
  const out: CustomerBurstReference[] = [];
  for (const input of burst.inputs) {
    const captioned = await customerSharedCaptionSelectors(input.captions, marks);
    const spoken = input.observation ? customerPropertyEvidenceFromText(input.observation.transcript)
      .filter(item => item.kind === "public_selector").map(item => Number(item.reference.replace(/^short:/, ""))) : [];
    const printed = input.observation ? await customerPerceivedCaptionSelectors(input.observation, marks) : [];
    out.push({ eventKey: input.eventKey, order: input.order, media: input.mediaCount > 0, ownEvidence: input.evidence.length > 0,
      selectors: [...new Set([...captioned, ...spoken, ...printed])], fromCaption: captioned.length > 0, evidence: input.evidence });
  }
  const captioned = await customerSharedCaptionSelectors(current.captions, marks);
  out.push({ eventKey: current.eventKey, order: BigInt(current.order), media: current.media, ownEvidence: current.evidence.length > 0,
    selectors: captioned, fromCaption: captioned.length > 0, evidence: current.evidence });
  return out;
}

/** A shared post's own references carry its caption number: the resolver falls back to it when the publication is
 * not in our registry and reports a conflict when they disagree. A CDN-only share (untrusted transport URL) is
 * replaced by the number. Only with exactly one number. */
function withCaption(evidence: readonly CustomerPropertyEvidence[], shortId: number): CustomerPropertyEvidence[] {
  const ref = `short:${shortId}`;
  let attached = false;
  const out = evidence.map((item): CustomerPropertyEvidence => {
    if (item.origin !== "shared_media") return item;
    if (item.kind === "media" || item.kind === "url") { attached = true; return { ...item, secondaryReference: ref }; }
    if (item.kind === "untrusted_reference") { attached = true; return { kind: "public_selector", origin: "shared_media", reference: ref }; }
    return item;
  });
  return attached ? mergeCustomerPropertyEvidence([out]) : mergeCustomerPropertyEvidence([out, [{ kind: "public_selector", origin: "shared_media", reference: ref }]]);
}

/**
 * The object of the current burst from captions and pictures (16–17.11.2026). The current input wins when it names an
 * object in the customer's own words; otherwise its shared post's caption; otherwise the set-aside media just before
 * it (their turns were held for these words before their media focus ran). A reference given AFTER that media keeps
 * priority. Every failure before the focus write leaves the turn to the model ("unchanged"), never silence.
 */
export async function enrichCustomerAgentBurstFocus(input: FocusInput & { references: readonly CustomerBurstReference[] }): ReturnType<typeof enrichCustomerAgentMediaFocus> {
  const current = input.references.at(-1);
  if (!current || current.eventKey !== input.ticket.eventKey) return { status: "unchanged" };
  if (input.ticket.evidence.some(item => item.origin !== "shared_media")) return { status: "unchanged" };
  if (current.selectors.length) {
    if (current.selectors.length > 1) return enrichFocus(input, [], true, undefined, { soft: true });
    return enrichFocus(input, [], false, undefined, { soft: true, evidence: withCaption(input.ticket.evidence, current.selectors[0]) });
  }
  if (input.ticket.evidence.length) return { status: "unchanged" };
  const earlier = input.references.slice(0, -1).filter(item => item.selectors.length);
  if (!earlier.length) return { status: "unchanged" };
  const latestOrder = earlier.reduce((max, item) => item.order > max ? item.order : max, earlier[0].order);
  const focus = await readCustomerPropertyFocus(input.ticket);
  if (focus?.focus.evidence.length && BigInt(focus.focus.lastEvidenceOrder) > latestOrder) return { status: "unchanged" };
  const evidence = mergeCustomerPropertyEvidence(earlier.map(item => item.fromCaption && item.selectors.length === 1 && item.evidence.length
    ? withCaption(item.evidence, item.selectors[0]) : item.selectors.map(selectorEvidence)));
  if (evidence.some(item => item.kind === "untrusted_reference")) return { status: "unchanged" };
  return enrichFocus(input, [], false, undefined, { soft: true, evidence });
}

/**
 * Is the resolved object one THIS burst pointed at (review #225 H2)? The focus must have been set by an input of
 * the burst, and no picture/file of the customer that pointed at nothing may follow the last reference: that
 * picture may show another object. An older focus never answers a fresh question on its own.
 */
export function customerBurstFocusFresh(focus: { status: string; eventKey: string } | null | undefined,
  references: readonly CustomerBurstReference[]): boolean {
  if (!focus || focus.status !== "resolved" || !references.some(item => item.eventKey === focus.eventKey)) return false;
  const pointing = references.filter(item => item.ownEvidence || item.selectors.length);
  const current = references.at(-1);
  const referenceOrder = pointing.length ? pointing.reduce((max, item) => item.order > max ? item.order : max, pointing[0].order)
    : current && focus.eventKey === current.eventKey ? current.order : null;
  if (referenceOrder === null) return false;
  return !references.some(item => item.media && !item.ownEvidence && !item.selectors.length && item.order > referenceOrder);
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
/** `evidence` replaces the merge of the ticket's evidence with `selectors` (a caption attached to its share).
 * `soft`: a failure BEFORE the focus write leaves the turn to the model ("unchanged") instead of holding it (review #225 L1). */
async function enrichFocus(input: FocusInput, selectors: CustomerPropertyEvidence[], ambiguous: boolean,
  assertSourceCurrent?: (tx: TxClient) => Promise<boolean>, options: { evidence?: CustomerPropertyEvidence[]; soft?: boolean } = {}): ReturnType<typeof enrichCustomerAgentMediaFocus> {
  const held = (reason: string) => options.soft ? { status: "unchanged" as const } : { status: "held" as const, reason };
  const registry = input.linkReads?.registry ?? customerPropertyRegistry, wait = input.linkReads?.wait;
  const alive = () => !wait || !wait.signal.aborted && Date.now() < wait.deadlineAt;
  if ((["eventKey", "order", "scopeKey", "conversationId", "channel", "accountId", "endpointScopeId"] as const)
    .some(key => input.ticket[key] !== input.principal.admission[key]) || !customerAgentClaimAcceptsPrincipal(input.claim, input.principal)) {
    return held("media_focus_original_input_required");
  }
  if (!alive() || wait && !await wait.assertCurrent()) return held("link_focus_context_changed");
  const before = await revalidateCustomerPrincipal(input.principal);
  if (before.status !== "current" || !before.snapshot.state.capabilities.publicRead) return held("media_focus_context_changed");
  const evidence = options.evidence ?? mergeCustomerPropertyEvidence([input.ticket.evidence, selectors]);
  const focus = await readCustomerPropertyFocus(input.ticket);
  if (!focus || BigInt(focus.focus.lastEvidenceOrder) > BigInt(input.ticket.order)) return held("media_focus_superseded");
  const resolution = ambiguous ? { status: "ambiguous" as const, propertyId: null, candidates: [], reason: "conflict" as const, provenance: evidence }
    : await resolveCustomerPropertyEvidence(evidence, input.ticket, registry);
  const next = customerPropertyFocusSchema.parse({ version: 1, scopeKey: input.ticket.scopeKey, generation: randomUUID(),
    lastEvidenceOrder: input.ticket.order, eventKey: input.ticket.eventKey, status: resolution.status,
    propertyId: resolution.propertyId, evidence });
  if (!alive() || wait && !await wait.assertCurrent() || (await revalidateCustomerPrincipal(input.principal)).status !== "current") return held("media_focus_context_changed");
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
  if (!changed) return held("media_focus_changed");
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

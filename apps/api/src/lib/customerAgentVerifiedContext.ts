import { isDeepStrictEqual } from "node:util";
import { readCustomerPublicOutreachMemory } from "./customerPublicOutreachMemory.js";
import { readCustomerRecruitmentRecoveryMemory } from "./customerRecruitmentRecoveryMemory.js";
import { customerAgentVerifiedContextSchema, customerAgentRevisionSchema, customerPropertyDeliverySchema, customerPublicStateSchema, customerPropertyFactKindSchema,
  recruitmentResumeSchema, customerRecruitmentPortfolioSchema, type RecruitmentFactKey,
  type CustomerAgentRevision, type CustomerAgentVerifiedContext, type CustomerFence } from "@royal-home/shared";
import { prisma } from "../db.js";
import { isCustomerPrincipal, revalidateCustomerPrincipal, customerPrincipalAuthenticatedInput, type CustomerPrincipal } from "./customerPrincipal.js";
import { inspectAuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { decryptCustomerFinalOrigin } from "./customerOriginPayload.js";
import { decryptCustomerIngressEnvelope } from "./customerIngressPayload.js";
import { decodeCustomerAgentRevision, customerAgentTurnDeadline } from "./customerAgentRevision.js";
import { decodeCustomerOutboxPayload, decodeCustomerOutboxPublicData } from "./customerOutbox.js";
import { customerDeliveryFenceSchema, customerDeliveryReceiptsSchema, customerDeliveryTransportSchema } from "./customerDeliveryContracts.js";
import { customerAgentStoredPublicDataCurrent } from "./customerAgentDeliveryEvidence.js";
import { readCustomerPropertyFacts } from "./customerPropertyFacts.js";
import { phoneSafeText } from "./clientPhone.js";
import { PUBLIC_AGENCY_CONTACT } from "./publicAgencyContact.js";
import { renderCustomerAgentDecision, customerAgentFixedLines, type CustomerAgentEvidence } from "../ai/customerAgentRenderer.js";
import { customerAgentAttachmentQuestion } from "../ai/customerAgentAttachmentInput.js";
import { customerDmAttachmentInput } from "./customerDmAttachmentInput.js";
import { decodeCustomerAgentMediaObservation } from "./customerAgentMediaObservation.js";
import { customerAgentIntake } from "../ai/customerAgentIntake.js";
import { readRecruitmentAnsweredFactTx } from "./recruitmentAnsweredFact.js";
import { readOwnedCustomerIntakeContinuity } from "./customerOwnedIntakeContinuity.js";
import { readApprovedCustomerWordRevisions } from "./customerAgentRevisionAdvance.js";

export interface CustomerAgentMemoryCandidate {
  role: "user" | "assistant"; text: string; observedAt: number; stableKey: string;
}
/** Projection only, never proof or authorization. Historical prose remains
 * untrusted content. Preserve names/ordinary housing intent, not CRM dossiers. */
export function minimizeCustomerAgentMemoryText(text: string): string {
  const minimized = text
    .replace(/https?:\/\/[^\s<>]+/giu, "[ссылка]")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/gu, "[контакт]")
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/giu, "[идентификатор]")
    .replace(/\b[0-9a-f]{64}\b/giu, "[идентификатор]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, "")
    .trim();
  return phoneSafeText(minimized, false);
}
/** Already verified candidates only. This pure projection cannot issue a
 * principal, accept historical consent, select a resource or execute anything. */
export function projectCustomerAgentMemory(candidates: readonly CustomerAgentMemoryCandidate[], maxInputChars: number):
  Array<{ role: "user" | "assistant"; text: string }> {
  const chars = Math.min(6000, Math.floor(maxInputChars / 4)), bytes = Math.min(12000, chars * 4);
  let usedChars = 0, usedBytes = 0;
  const selected: Array<{ role: "user" | "assistant"; text: string }> = [];
  const unique = new Set<string>();
  const ordered = [...candidates].filter(c => Number.isFinite(c.observedAt)).sort((a, b) =>
    b.observedAt - a.observedAt || b.stableKey.localeCompare(a.stableKey));
  for (const c of ordered) {
    if (selected.length === 6) break;
    if (unique.has(c.stableKey)) continue;
    const text = minimizeCustomerAgentMemoryText(c.text), size = Buffer.byteLength(text, "utf8");
    // Omit whole over-bound record, never slice a monetary value/contact mask.
    if (!text || text.length > 1500 || usedChars + text.length > chars || usedBytes + size > bytes) continue;
    unique.add(c.stableKey); selected.push({ role: c.role, text }); usedChars += text.length; usedBytes += size;
  }
  return selected.reverse();
}
/** Epoch relation only, NOT a public read/write grant. Same-IN semantic
 * counters can advance; controller/scope/binding may never be adopted anew. */
export function customerMemoryFenceMatches(old: CustomerFence, current: CustomerFence): boolean {
  return old.inquiryId === current.inquiryId && old.nativeId === current.nativeId &&
    isDeepStrictEqual(old.endpoint, current.endpoint) && old.ownerToken === current.ownerToken &&
    old.ownershipEpoch === current.ownershipEpoch && old.bindingRevision === current.bindingRevision &&
    old.scopeRevision === current.scopeRevision && old.policyRevision === current.policyRevision &&
    BigInt(old.stateRevision) <= BigInt(current.stateRevision) && BigInt(old.intentRevision) <= BigInt(current.intentRevision);
}
const ticketSelect = { eventKey: true, order: true, scopeKey: true, endpointScopeId: true, conversationId: true,
  originalConversationId: true, tombstonedAt: true, payloadVersion: true, payloadCiphertext: true, payloadHash: true,
  receivedAt: true, originVersion: true, originCiphertext: true, originCapturedAt: true, inputRecordedAt: true,
  agentRevisionId: true, intakeAgentRevisionId: true, rolloutAssignmentId: true, providerOperationId: true, providerDeadlineAt: true,
  mediaObservationVersion: true, mediaObservationCiphertext: true, mediaObservedAt: true } as const;
type MemoryTicket = Awaited<ReturnType<typeof readTicket>>;
async function readTicket(eventKey: string) {
  return prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey }, select: ticketSelect });
}
type Current = { principal: CustomerPrincipal; ticket: NonNullable<MemoryTicket>; revision: Readonly<CustomerAgentRevision>;
  input: NonNullable<ReturnType<typeof inspectAuthenticatedCustomerInput>> };
/** Read-only continuity through the actual append-only owner publication chain.
 * It does not renew a historical event, assistant promise, consent or receipt.
 * Both tickets must still belong to the SAME immutable CORE DM assignment. */
async function approvedOwnWordRevisions(current: Current): Promise<ReadonlySet<string>> {
  if (!current.ticket.rolloutAssignmentId) return new Set();
  return readApprovedCustomerWordRevisions(prisma,{assignmentId:current.ticket.rolloutAssignmentId,
    endpointScopeId:current.principal.scope.endpointScopeId,revisionId:current.revision.id,
    receivedAt:current.ticket.receivedAt,policyRevision:current.principal.authority.fence.policyRevision});
}
function historicalText(row: NonNullable<MemoryTicket>, current: Current, ownWordsOnly = false,
  priorRevisions: ReadonlySet<string> = new Set(),
  intakeContinuity?: Awaited<ReturnType<typeof readOwnedCustomerIntakeContinuity>>): string | null {
  try {
    const p = current.principal, f = p.authority.fence;
    const approvedPrior = row.agentRevisionId !== current.revision.id && !!row.agentRevisionId &&
      row.agentRevisionId === row.intakeAgentRevisionId && priorRevisions.has(row.agentRevisionId) &&
      !!row.rolloutAssignmentId && row.rolloutAssignmentId === current.ticket.rolloutAssignmentId;
    if (row.conversationId !== p.scope.conversationId || row.originalConversationId !== p.scope.conversationId ||
        row.endpointScopeId !== p.scope.endpointScopeId || row.scopeKey !== p.scope.scopeKey || row.tombstonedAt ||
        row.order >= current.ticket.order || (row.agentRevisionId !== current.revision.id && !approvedPrior) ||
        row.payloadVersion !== 1 || !row.payloadCiphertext || !row.payloadHash || row.originVersion !== 1 || !row.originCiphertext ||
        !row.originCapturedAt || !row.inputRecordedAt || row.receivedAt > current.ticket.receivedAt || row.inputRecordedAt.getTime() > Date.now() ||
        row.originCapturedAt < row.receivedAt || row.originCapturedAt.getTime() > row.receivedAt.getTime() + 900000) return null;
    // A busy worker may append/process A after B has already arrived. Earlier
    // genuine receive-order/time, not append completion, determines user history.
    // Accepted assistant output still has its separate <=B receive-time fence.
    const envelope = decryptCustomerIngressEnvelope({ version: 1, eventKey: row.eventKey, order: row.order.toString(),
      scopeKey: row.scopeKey, endpointScopeId: row.endpointScopeId, payloadHash: row.payloadHash }, row.payloadCiphertext);
    const origin = decryptCustomerFinalOrigin(row.originCiphertext), i = origin.input;
    const ownIntakeBinding = !!intakeContinuity && i.acceptedFence.bindingRevision === intakeContinuity.bindingRevision &&
      i.acceptedFence.ownershipEpoch === intakeContinuity.ownershipEpoch;
    const wordFence = ownIntakeBinding ? { ...i.acceptedFence, bindingRevision: f.bindingRevision, ownershipEpoch: f.ownershipEpoch } : i.acceptedFence;
    if (origin.eventKey !== row.eventKey || origin.order !== row.order.toString() || origin.scopeKey !== row.scopeKey ||
        origin.originalConversationId !== row.originalConversationId || origin.payloadHash !== row.payloadHash ||
        i.inputText !== envelope.payload.inputText || i.eventId !== envelope.payload.eventId || i.eventKind !== envelope.payload.eventKind ||
        i.accountExternalId !== envelope.payload.accountExternalId || i.channel !== envelope.payload.channel || i.peer !== envelope.payload.peer ||
        i.channel !== p.scope.channel || i.peer !== p.scope.peer || i.assurance !== "protected_namespace" ||
        i.provenance !== "meta_signature" || i.protectedMetaEndpointScopeId !== p.scope.endpointScopeId ||
        i.protectedMetaAccountId !== p.scope.accountId || i.issuerAccountId !== p.scope.accountId ||
        i.issuerEndpointScopeId !== p.scope.endpointScopeId || i.issuedAt !== row.receivedAt.getTime() ||
        i.issuerScopeRevision !== i.acceptedFence.scopeRevision || i.issuerPolicyRevision !== i.acceptedFence.policyRevision ||
        envelope.verification.issuedAt !== i.issuedAt || envelope.verification.assurance !== i.assurance ||
        envelope.verification.accountId !== i.issuerAccountId || envelope.verification.provenance !== i.provenance ||
        envelope.verification.scopeRevision !== i.acceptedFence.scopeRevision ||
        envelope.verification.policyRevision !== i.acceptedFence.policyRevision ||
        !i.verifierCredential || !isDeepStrictEqual(i.verifierCredential, current.input.verifierCredential) ||
        !isDeepStrictEqual(i.verifierCredential, envelope.verification.verifierCredential) ||
        i.issuerSource !== current.input.issuerSource || envelope.verification.issuerSource !== i.issuerSource ||
        !(customerMemoryFenceMatches(wordFence, f) || approvedPrior &&
          BigInt(i.acceptedFence.policyRevision) < BigInt(f.policyRevision) &&
          customerMemoryFenceMatches({ ...wordFence, policyRevision: f.policyRevision }, f))) return null;
    // Audit decryption ONLY. Never recover/brand this old input or renew age.
    // Prior versions contribute literal customer words only. Their model media
    // observations and old assistant output remain excluded from this bridge.
    if (ownWordsOnly || approvedPrior || ownIntakeBinding) return i.inputText.trim();
    const attachment = customerDmAttachmentInput(envelope.payload);
    if (row.mediaObservationVersion === 1 && row.mediaObservationCiphertext && row.mediaObservedAt && row.agentRevisionId && row.providerOperationId) {
      const media = decodeCustomerAgentMediaObservation(row.mediaObservationCiphertext, { version: 1, eventKey: row.eventKey,
        payloadHash: row.payloadHash, agentRevisionId: row.agentRevisionId, providerOperationId: row.providerOperationId,
        observedAt: row.mediaObservedAt.getTime() });
      return [i.inputText.trim(), media.transcript, JSON.stringify({ previouslyObservedCustomerMedia: { subject: media.subject, visible: media.visible, readableText: media.readableText },
        authority: "Historical customer content, no current consent or verified CRM facts" })].filter(Boolean).join("\n");
    }
    return i.inputText.trim() || (attachment ? JSON.stringify({ incomingAttachments: attachment.kinds }) : "");
  } catch { return null; }
}
function safePublicLines(evidence: readonly CustomerAgentEvidence[], revision: Readonly<CustomerAgentRevision>): Set<string> {
  // Fixed server wording (questions, repeat notices, neutral replies) is as safe in history as the templates below;
  // without it a turn made only of such a line vanished, and neither the model nor the repeat check saw it was asked.
  const lines = customerAgentFixedLines();
  for (const language of ["ru", "tg"] as const) {
    // Fixed transport clarifications may enter memory only AFTER the ordinary
    // genuine accepted-OUT checks below, never from a draft/attempt or caption.
    for (const kind of ["image", "audio", "video", "document", "share", "link", "ephemeral", "unknown"] as const) {
      for (const hasProperty of [false, true]) lines.add(customerAgentAttachmentQuestion({ kinds: [kind] }, language, hasProperty));
    }
    const render = (decision: Parameters<typeof renderCustomerAgentDecision>[0]["decision"], values: readonly CustomerAgentEvidence[] = []) => {
      const text = renderCustomerAgentDecision({ decision, evidence: values, language, requestedFacts: [], knownPhoneSource: "none",
        surface: "dm", maxOutputChars: 12000, knowledgeSourceHash: revision.knowledgeSourceHash });
      for (const line of text?.split("\n") ?? []) if (line.trim()) lines.add(line.trim());
    };
    for (const question of ["property", "budget", "location", "rooms", "topic", "role", "clarify_previous"] as const) {
      render({ kind: "clarify", refs: [], social: "none", question });
    }
    for (const social of ["greet", "thank", "acknowledge", "apologize"] as const) render({ kind: "reply", refs: [], social, question: "none" });
    for (const e of evidence) render({ kind: "reply", refs: [e.ref], social: "none", question: "none" }, [e]);
  }
  return lines;
}
export type CustomerAgentMemoryResult = { status: "current"; context: CustomerAgentVerifiedContext } |
  { status: "held"; reason: "original_context_changed" | "revision_mismatch" | "storage_unavailable" | "context_deadline" };
/** Actual scoped storage reader. This is not a public/request-facing projection
 * parser and does not mint actors, recover an old event, or approve a tool. */
export async function loadCustomerAgentVerifiedDmContext(input: { principal: unknown; revision: Readonly<CustomerAgentRevision>;
  wait?: { signal?: AbortSignal; deadlineAt: number } }): Promise<CustomerAgentMemoryResult> {
  if (!isCustomerPrincipal(input.principal)) return { status: "held", reason: "original_context_changed" };
  const principal = input.principal;
  const authenticated = customerPrincipalAuthenticatedInput(principal), currentInput = authenticated && inspectAuthenticatedCustomerInput(authenticated);
  if (!currentInput) return { status: "held", reason: "original_context_changed" };
  const requestedRevision = customerAgentRevisionSchema.safeParse(input.revision);
  if (!requestedRevision.success) return { status: "held", reason: "revision_mismatch" };
  const originalDeadline = customerAgentTurnDeadline(currentInput.issuedAt, requestedRevision.data.limits.deadlineMs);
  const deadlineAt = Math.min(input.wait?.deadlineAt ?? Infinity, originalDeadline);
  const alive = () => !input.wait?.signal?.aborted && Date.now() < deadlineAt;
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  const stopped = new Promise<CustomerAgentMemoryResult>(resolve => {
    abort = () => resolve({ status: "held", reason: "context_deadline" });
    timer = setTimeout(abort, Math.max(0, deadlineAt - Date.now()));
    input.wait?.signal?.addEventListener("abort", abort, { once: true }); if (!alive()) abort();
  });
  const load = async (): Promise<CustomerAgentMemoryResult> => {
    try {
      if (!alive()) return { status: "held", reason: "context_deadline" };
      const before = await revalidateCustomerPrincipal(principal);
      if (before.status !== "current" || !alive()) return { status: "held", reason: "original_context_changed" };
      const ticket = await readTicket(principal.admission.eventKey);
      if (!ticket || ticket.eventKey !== principal.admission.eventKey || ticket.order.toString() !== principal.admission.order ||
          ticket.scopeKey !== principal.scope.scopeKey || ticket.endpointScopeId !== principal.scope.endpointScopeId ||
          ticket.conversationId !== principal.scope.conversationId || ticket.originalConversationId !== ticket.conversationId ||
          ticket.tombstonedAt || !ticket.inputRecordedAt || ticket.originVersion !== 1 || !ticket.originCiphertext ||
          ticket.agentRevisionId !== requestedRevision.data.id || !ticket.providerDeadlineAt ||
          ticket.providerDeadlineAt.getTime() !== originalDeadline || Date.now() >= ticket.providerDeadlineAt.getTime()) {
        return { status: "held", reason: "original_context_changed" };
      }
      const currentOrigin = decryptCustomerFinalOrigin(ticket.originCiphertext);
      if (currentOrigin.eventKey !== ticket.eventKey || currentOrigin.order !== ticket.order.toString() ||
          currentOrigin.scopeKey !== ticket.scopeKey || currentOrigin.originalConversationId !== ticket.conversationId ||
          currentOrigin.input.inputText !== currentInput.inputText || currentOrigin.input.eventId !== currentInput.eventId ||
          currentOrigin.input.issuedAt !== currentInput.issuedAt || ticket.receivedAt.getTime() !== currentInput.issuedAt ||
          !isDeepStrictEqual(currentOrigin.input.verifierCredential, currentInput.verifierCredential) ||
          !customerMemoryFenceMatches(currentOrigin.input.acceptedFence, principal.authority.fence)) {
        return { status: "held", reason: "original_context_changed" };
      }
      const stored = await prisma.customerAgentRevision.findUnique({ where: { id: ticket.agentRevisionId } });
      if (!stored) return { status: "held", reason: "revision_mismatch" };
      const revision = decodeCustomerAgentRevision(stored);
      if (!isDeepStrictEqual(revision, requestedRevision.data)) return { status: "held", reason: "revision_mismatch" };
      const empty = (publicState: unknown): CustomerAgentMemoryResult => ({ status: "current", context: customerAgentVerifiedContextSchema.parse({
        surface: "dm", revisionId: revision.id, turns: [], publicState: customerPublicStateSchema.parse(publicState) }) });
      if (principal.visibility !== "private_dm" || principal.assurance !== "protected_namespace" ||
          currentInput.provenance !== "meta_signature" || !currentInput.verifierCredential) {
        const after = await revalidateCustomerPrincipal(principal);
        return after.status === "current" && alive() ? empty(after.snapshot.state.publicState) : { status: "held", reason: "original_context_changed" };
      }
      const current: Current = { principal, ticket, revision, input: currentInput };
      const where = { conversationId: principal.scope.conversationId, originalConversationId: principal.scope.conversationId,
        scopeKey: principal.scope.scopeKey, endpointScopeId: principal.scope.endpointScopeId, tombstonedAt: null,
        order: { lt: ticket.order }, payloadVersion: 1, originVersion: 1,
        inputRecordedAt: { not: null } };
      if (!alive()) return { status: "held", reason: "context_deadline" };
      const history = await prisma.customerPropertyIngressTicket.findMany({ where, select: ticketSelect, orderBy: { order: "desc" }, take: 50 });
      const priorRevisions = history.some(row => row.agentRevisionId && row.agentRevisionId !== revision.id)
        ? await approvedOwnWordRevisions(current) : new Set<string>();
      const intakeContinuity = principal.knownContact.clientId
        ? await readOwnedCustomerIntakeContinuity(prisma, principal.authority.fence) : null;
      if (!alive()) return { status: "held", reason: "context_deadline" };
      const parts = await prisma.customerOutboxPart.findMany({ where: {
        conversationId: principal.scope.conversationId, originalNativeId: principal.scope.conversationId,
        inquiryId: principal.authority.fence.inquiryId, endpointScopeId: principal.scope.endpointScopeId,
        agentRevisionId: revision.id, sourceKind: "BOT_TURN", mode: "LIVE", status: "ACCEPTED",
        acceptedAt: { not: null, lte: ticket.receivedAt }, projectionRecordedAt: { not: null },
        supersededAt: null, cancelRequestedAt: null, ticket: { is: where },
      }, include: { ticket: { select: ticketSelect }, attempts: { where: { outcome: "ACCEPTED", providerMid: { not: null }, finishedAt: { not: null } },
        orderBy: { attemptNo: "desc" }, take: 1 } }, orderBy: [{ acceptedAt: "desc" }, { ordinal: "desc" }], take: 6 });
      const candidates: CustomerAgentMemoryCandidate[] = await readCustomerPublicOutreachMemory(principal);
      candidates.push(...await readCustomerRecruitmentRecoveryMemory(principal));
      for (const row of history) {
        const text = historicalText(row, current, false, priorRevisions, intakeContinuity);
        if (text !== null) candidates.push({ role: "user", text, observedAt: row.receivedAt.getTime(), stableKey: `in:${row.order.toString().padStart(20, "0")}` });
      }
      for (const part of parts) {
        if (!alive()) return { status: "held", reason: "context_deadline" };
        try {
          if (!part.ticket || historicalText(part.ticket, current) === null || !part.acceptedAt || !part.projectionRecordedAt ||
              part.sourceKey !== part.ticket.eventKey || part.attempts[0]?.endpointScopeId !== principal.scope.endpointScopeId ||
              !part.attempts[0]?.providerMid?.trim() || part.attempts[0].providerMid.length > 512 ||
              part.attempts[0].claimRevision !== part.claimRevision || !part.attempts[0].finishedAt ||
              part.attempts[0].finishedAt > ticket.receivedAt ||
              customerDeliveryReceiptsSchema.parse(part.receiptRefsJson).length > 0) continue;
          const f = customerDeliveryFenceSchema.parse(part.fenceJson), transport = customerDeliveryTransportSchema.parse(part.transportJson);
          if (!customerMemoryFenceMatches(f, principal.authority.fence) || transport.endpointScopeId !== principal.scope.endpointScopeId ||
              transport.accountId !== principal.scope.accountId || transport.channel !== principal.scope.channel ||
              transport.scopeRevision !== principal.authority.fence.scopeRevision || !before.snapshot.transport ||
              transport.transportKey !== before.snapshot.transport.transportKey) continue;
          const payload = decodeCustomerOutboxPayload(part); if (payload.kind !== "text") continue;
          const evidence: CustomerAgentEvidence[] = [{ ref: "e0", value: { kind: "agency_contact", contact: {
            phone: PUBLIC_AGENCY_CONTACT.phone, digits: PUBLIC_AGENCY_CONTACT.digits, channel: "telephone" } } }];
          const sideband = decodeCustomerOutboxPublicData(part);
          if (sideband && await customerAgentStoredPublicDataCurrent(sideband, revision.id)) {
            sideband.observations.forEach(value => evidence.push({ ref: `e${evidence.length}`, value }));
          }
          if (part.p03Json !== null) {
            const parsed = customerPropertyDeliverySchema.safeParse(part.p03Json);
            if (parsed.success && parsed.data.propertyId && parsed.data.factsSignature && parsed.data.inputEventKey === part.ticketEventKey && parsed.data.scopeKey === principal.scope.scopeKey) {
              const facts = await readCustomerPropertyFacts(parsed.data.propertyId, principal.scope.channel);
              if (facts?.signature === parsed.data.factsSignature) for (const kind of customerPropertyFactKindSchema.options) {
                evidence.push({ ref: `e${evidence.length}`, value: { kind: "facts", facts, kinds: [kind] } });
              }
            }
          }
          const allowed = safePublicLines(evidence, revision);
          const text = payload.text.split("\n").map(line => line.trim()).filter(line => allowed.has(line)).join("\n");
          if (text) candidates.push({ role: "assistant", text, observedAt: part.acceptedAt.getTime(), stableKey: `out:${part.id}` });
        } catch { /* Corrupt or non-public historical part is omitted, never a grant. */ }
      }
      const positionKey = before.snapshot.state.publicState.topic === "job" ? before.snapshot.state.publicState.jobPositionKey : undefined;
      // Inside the protected own-inquiry branch only. Expose presence, never
      // résumé text, private HR notes/decision, cross-profile matches or IDs.
      const application = positionKey ? await prisma.jobApplication.findUnique({
        where: { customerInquiryId_customerPositionKey: { customerInquiryId: principal.authority.fence.inquiryId, customerPositionKey: positionKey } },
        select: { recruitmentResume: true, customerPortfolio: true, name: true, phone: true },
      }) : null;
      const resume = recruitmentResumeSchema.safeParse(application?.recruitmentResume);
      const recruitmentKnown = new Set<RecruitmentFactKey>(resume.success ? Object.keys(resume.data.facts) as RecruitmentFactKey[] : []);
      if (application?.name?.trim()) recruitmentKnown.add("name");
      if (application?.phone?.trim()) recruitmentKnown.add("phone");
      const portfolio = customerRecruitmentPortfolioSchema.safeParse(application?.customerPortfolio);
      if (portfolio.success && portfolio.data.length) recruitmentKnown.add("about");
      const native = positionKey ? await prisma.botConversation.findUnique({ where: { id: principal.scope.conversationId }, select: { messages: true } }) : null;
      const recruitmentAnswerTo = native ? await readRecruitmentAnsweredFactTx(prisma, {
        fence: principal.authority.fence, eventKey: ticket.eventKey, order: ticket.order.toString(),
      }, native.messages) : null;
      if (!alive()) return { status: "held", reason: "context_deadline" };
      const after = await revalidateCustomerPrincipal(principal);
      if (!alive() || after.status !== "current" || !isDeepStrictEqual(after.snapshot.state.fence, before.snapshot.state.fence)) {
        return { status: "held", reason: "original_context_changed" };
      }
      return { status: "current", context: customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: revision.id,
        ...(positionKey ? { recruitmentKnown: [...recruitmentKnown] } : {}),
        ...(recruitmentAnswerTo ? { recruitmentAnswerTo } : {}),
        turns: projectCustomerAgentMemory(candidates, revision.limits.maxInputChars),
        intake: customerAgentIntake([...history].reverse().flatMap(row => {
          const text = historicalText(row, current, true, priorRevisions, intakeContinuity);
          return text ? [{ role: "user" as const, text: minimizeCustomerAgentMemoryText(text) }] : [];
        }), minimizeCustomerAgentMemoryText(currentInput.inputText)),
        publicState: customerPublicStateSchema.parse(after.snapshot.state.publicState) }) };
    } catch { return { status: "held", reason: "storage_unavailable" }; }
  };
  try { return await Promise.race([load(), stopped]); }
  finally { clearTimeout(timer); if (abort) input.wait?.signal?.removeEventListener("abort", abort); }
}

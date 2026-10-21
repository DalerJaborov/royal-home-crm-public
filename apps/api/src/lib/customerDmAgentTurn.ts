import { loadCustomerAgentVerifiedDmContext } from "./customerAgentVerifiedContext.js";
import type { CustomerAgentEvidence } from "../ai/customerAgentRenderer.js";
import { runCustomerAgentTurn } from "../ai/customerAgentCore.js";
import { customerAgentToolDefinitions, CUSTOMER_AGENT_PUBLIC_TOOLS } from "../ai/customerAgentToolDefinitions.js";
import { dispatchCustomerTool } from "../ai/customerToolRegistry.js";
import { detectClientLanguage } from "../ai/clientLanguage.js";
import { prisma } from "../db.js";
import { prepareCustomerDmInboxCoreContext } from "./customerDmCoreContext.js";
import { claimCustomerAgentTurnTx, customerAgentClaimCurrentTx, type CustomerAgentClaim } from "./customerAgentClaim.js";
import { openPinnedCustomerAgentRuntime } from "./customerAgentRuntime.js";
import { revalidateCustomerPrincipal } from "./customerPrincipal.js";
import { classifyCustomerPropertyFactIntent } from "./customerPropertyFactIntent.js";
import { readCustomerPropertyFacts } from "./customerPropertyFacts.js";
import { managedCustomerPropertyReply } from "./customerPropertyDelivery.js";
import { PUBLIC_AGENCY_CONTACT } from "./publicAgencyContact.js";
import { createCustomerOutboxPartsTx } from "./customerOutbox.js";
import { createCustomerAgentMutationSession, type CustomerAgentMutationSession } from "./customerAgentMutationSession.js";
import { enrichCustomerAgentMediaFocus, enrichCustomerAgentSelectionFocus } from "./customerAgentMediaFocus.js";
import { issueCustomerHandoverAckTx, planCustomerHandoverAckTx } from "./customerHandoverAck.js";
import { readDmCustomerAgentDataWitness, sealDmCustomerAgentDeliveryEvidence,
  type CustomerAgentDataReadWitness } from "./customerAgentDeliveryEvidence.js";
import { customerAgentPublicReadCurrent } from "./customerAgentPublicReads.js";
import { aiDailyBudgetOf, spendAiTurns } from "./aiDailyBudget.js";
import { loadCustomerDmMediaContent } from "./customerDmMediaContent.js";
import { recordCustomerRecruitmentAttachments } from "./customerRecruitmentAttachments.js";
import { customerAgentMediaReplyLanguage, type CustomerAgentMediaPerception } from "../ai/customerAgentMediaPerception.js";
import { loadCustomerAgentMediaObservation, storeCustomerAgentMediaObservation } from "./customerAgentMediaObservation.js";
import { withBotTurnTrace, traceCustomerManagedBinding, traceCustomerCoreResult, traceCustomerCoreDisposition, traceMediaKinds } from "./botTurnTrace.js";

export type CustomerDmAgentTurnResult = { status: "planned"; partIds: string[] } |
  { status: "unchanged"; reason: string } | { status: "held"; reason: string };

async function releaseHeldClaim(claim: CustomerAgentClaim, reason: string): Promise<void> {
  // Release only OUR original elected owner. This cannot renew the pin, take
  // over another worker or turn a PLANNED/unknown-delivery response into READY.
  await prisma.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "processingState"='HELD',"errorCode"=${reason},
    "leaseOwner"=NULL,"leaseUntil"=NULL WHERE "eventKey"=${claim.eventKey} AND "processingState"='CLAIMED'
    AND "leaseOwner"=${claim.owner} AND "claimRevision"=${BigInt(claim.revision)}`;
}

/** Actual durable worker entry, also safe when the live handler and another
 * worker see the same event. Input recovery/claim precede model I/O; only P12
 * creates delivery jobs. No legacy qualifier, direct sender or fallback loop. */
export async function runCustomerDmAgentTurn(eventKey: string): Promise<CustomerDmAgentTurnResult> {
  if (!/^[a-f0-9]{64}$/.test(eventKey)) return { status: "held", reason: "invalid_event_key" };
  const selected = await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey }, select: { intakeAgentRevisionId: true } });
  if (!selected?.intakeAgentRevisionId) return { status: "held", reason: "intake_revision_missing" };
  const prepared = await prepareCustomerDmInboxCoreContext(eventKey);
  if (prepared.status === "already_planned") return { status: "unchanged", reason: "already_planned" };
  if (prepared.status !== "prepared") return { status: "held", reason: prepared.reason };
  const lane = prepared.lane;
  return withBotTurnTrace({ channel: lane.principal.scope.channel, account: lane.principal.scope.endpointScopeId,
    peer: lane.principal.scope.peer, conversation: lane.principal.scope.conversationId,
    event: lane.principal.admission.eventKey, kind: prepared.attachmentInput ? "media" : "text",
    attachments: prepared.attachmentInput?.kinds.length ?? 0, source: "internal",
    managed: { surface: "dm", phase: "planning" } }, async () => {
    traceMediaKinds((prepared.attachmentInput?.kinds ?? []).filter((kind): kind is "image" | "audio" | "video" | "document" =>
      kind === "image" || kind === "audio" || kind === "video" || kind === "document"));
    const outcome = await (async (): Promise<CustomerDmAgentTurnResult> => {
  let focus = prepared.focus;
  if ((await revalidateCustomerPrincipal(lane.principal)).status !== "current" || focus?.superseded) {
    return { status: "held", reason: "original_context_changed" };
  }
  const elected = await prisma.$transaction(tx => claimCustomerAgentTurnTx(tx, lane.principal));
  if (elected.status === "already_planned") return { status: "unchanged", reason: "already_planned" };
  if (elected.status !== "claimed") return elected;
  const claim = elected.claim;
  traceCustomerManagedBinding({ revisionId: claim.pin.agentRevisionId, operationId: claim.pin.providerOperationId });
  let runtime: Extract<Awaited<ReturnType<typeof openPinnedCustomerAgentRuntime>>, { status: "ready" }>["runtime"] | undefined;
  try {
    let text = lane.context.history[0]?.content ?? "";
    const detected = detectClientLanguage(text);
    let language: "tg" | "ru" = detected === "tg" ? "tg" : "ru";
    let planningPrincipal = lane.principal;
    let activeMutations: CustomerAgentMutationSession | undefined;
    let accumulated: readonly CustomerAgentEvidence[] = [];
    const witnesses: CustomerAgentDataReadWitness[] = [];
    const current = async (wait: { signal: AbortSignal; deadlineAt: number }): Promise<boolean> => {
      const principal = activeMutations?.principal ?? planningPrincipal;
      if ((activeMutations ? !await activeMutations.assertCurrent(wait) : (await revalidateCustomerPrincipal(principal)).status !== "current") ||
        !await customerAgentClaimCurrentTx(prisma, claim)) return false;
      for (const entry of accumulated) {
        const value = entry.value;
        if (value.kind === "facts") {
          const fresh = await readCustomerPropertyFacts(value.facts.propertyId, principal.scope.channel);
          if (!fresh || fresh.signature !== value.facts.signature) return false;
        } else if (value.kind === "company_policy" || value.kind === "property_search" || value.kind === "company_information" || value.kind === "open_vacancies") {
          if (!await customerAgentPublicReadCurrent(principal, value, claim.pin.revision.knowledgeSourceHash)) return false;
        }
      }
      return !wait.signal.aborted && Date.now() < wait.deadlineAt &&
        (activeMutations ? await activeMutations.assertCurrent(wait) : (await revalidateCustomerPrincipal(planningPrincipal)).status === "current") &&
        await customerAgentClaimCurrentTx(prisma, claim);
    };
    const opened = await openPinnedCustomerAgentRuntime({ revision: claim.pin.revision,
      providerOperationId: claim.pin.providerOperationId, originalReceivedAt: claim.pin.receivedAt,
      providerDeadlineAt: claim.pin.providerDeadlineAt, assertCurrent: current });
    if (opened.status !== "ready") {
      await releaseHeldClaim(claim, opened.reason);
      return opened;
    }
    runtime = opened.runtime;
    let remembered = await loadCustomerAgentVerifiedDmContext({ principal: planningPrincipal,
      revision: claim.pin.revision, wait: { signal: runtime.operation.signal, deadlineAt: runtime.operation.deadlineAt } });
    if (remembered.status !== "current") {
      await releaseHeldClaim(claim, remembered.reason);
      return remembered;
    }
    if (!text.trim()) {
      const previousLanguage = [...remembered.context.turns].reverse().filter(turn => turn.role === "user")
        .map(turn => detectClientLanguage(turn.text)).find(value => value === "ru" || value === "tg");
      if (previousLanguage) language = previousLanguage;
    }
    let turnBudgetSpent = false, modelHeldReason: string | undefined;
    const spendTurnBudget = async (wait: { signal: AbortSignal; deadlineAt: number }) => {
      if (turnBudgetSpent) return;
      const budgetRow = await prisma.botConversation.findUnique({ where: { id: lane.ticket.conversationId }, select: {
        id: true, aiBudgetDate: true, aiTurnsToday: true, aiVoiceToday: true, aiPhotoToday: true,
        aiVideoToday: true, aiDocToday: true, aiLimitNoticeAt: true,
      } });
      const budget = budgetRow ? aiDailyBudgetOf({ ...budgetRow, clientId: null }) : null;
      if (!budget || budget.turnsLeft <= 0 || !await current(wait)) {
        modelHeldReason = "customer_turn_budget_or_context";
        throw new Error(modelHeldReason);
      }
      await spendAiTurns(lane.ticket.conversationId, budget.dayKey);
      turnBudgetSpent = true;
    };
    let mediaPerception: CustomerAgentMediaPerception | undefined;
    if (runtime.mediaEnabled && prepared.media.length) {
      const wait = { signal: runtime.operation.signal!, deadlineAt: runtime.operation.deadlineAt };
      mediaPerception = await loadCustomerAgentMediaObservation(claim) ?? undefined;
      if (!mediaPerception) {
        const loaded = await loadCustomerDmMediaContent({ principal: planningPrincipal, media: prepared.media, wait, assertCurrent: current,
          preserveAttachments: remembered.context.publicState.topic === "job" });
        if (loaded.storedAttachments?.length) await recordCustomerRecruitmentAttachments(planningPrincipal, claim, loaded.storedAttachments);
        if (loaded.parts.length) {
          await spendTurnBudget(wait);
          mediaPerception = { ...await runtime.perceiveMedia(loaded.parts, wait), incomplete: loaded.incomplete };
          if (!await current(wait)) throw new Error("Original media context changed");
          await storeCustomerAgentMediaObservation(claim, mediaPerception);
        }
      }
      if (mediaPerception) {
        language = customerAgentMediaReplyLanguage(text, mediaPerception, language);
        // This derived content supplies conversational meaning only. The
        // mutation session above remains bound to the ORIGINAL raw input.
        text = [text, mediaPerception.transcript].filter(value => value.trim()).join("\n");
      }
    }
    let mediaReferenceResolved = false;
    if (mediaPerception) {
      const enriched = await enrichCustomerAgentMediaFocus({ principal: planningPrincipal, claim, ticket: lane.ticket });
      if (enriched.status === "held") {
        await releaseHeldClaim(claim, enriched.reason); return enriched;
      }
      if (enriched.status === "updated") {
        planningPrincipal = enriched.principal; focus = enriched.focus;
        mediaReferenceResolved = focus.snapshot.focus.status === "resolved";
        remembered = await loadCustomerAgentVerifiedDmContext({ principal: planningPrincipal,
          revision: claim.pin.revision, wait: { signal: runtime.operation.signal, deadlineAt: runtime.operation.deadlineAt } });
        if (remembered.status !== "current") { await releaseHeldClaim(claim, remembered.reason); return remembered; }
      }
    }
    const selected = await enrichCustomerAgentSelectionFocus({ principal: planningPrincipal, claim, ticket: lane.ticket });
    if (selected.status === "held") { await releaseHeldClaim(claim, selected.reason); return selected; }
    if (selected.status === "updated") {
      planningPrincipal = selected.principal; focus = selected.focus;
      remembered = await loadCustomerAgentVerifiedDmContext({ principal: planningPrincipal,
        revision: claim.pin.revision, wait: { signal: runtime.operation.signal, deadlineAt: runtime.operation.deadlineAt } });
      if (remembered.status !== "current") { await releaseHeldClaim(claim, remembered.reason); return remembered; }
    }
    const session = await createCustomerAgentMutationSession({ principal: planningPrincipal,
      authenticatedInput: lane.authenticatedInput, ticket: lane.ticket, agentClaim: claim, handoverAckLanguage: language });
    if (session.status !== "ready") { await releaseHeldClaim(claim, session.reason); return { status: "held", reason: session.reason }; }
    const mutations = session.session; activeMutations = mutations;
    const requestedFacts = remembered.context.publicState.topic === "job" ? [] : classifyCustomerPropertyFactIntent(text, { hasPropertyContext: focus?.snapshot.focus.status === "resolved" }) ??
      (!text.trim() && prepared.attachmentInput && (prepared.attachmentPropertyReference || mediaReferenceResolved) && focus?.snapshot.focus.status === "resolved"
        ? ["price" as const, "address" as const] : []);
    const result = await runCustomerAgentTurn({ surface: "dm", language, inputText: text, attachmentInput: prepared.attachmentInput, mediaPerception,
      knownPhoneSource: lane.context.knownPhoneSource, requestedFacts, revision: claim.pin.revision,
      startedAt: claim.pin.receivedAt, operation: runtime.operation,
      tools: customerAgentToolDefinitions([...CUSTOMER_AGENT_PUBLIC_TOOLS, ...mutations.availableToolNames]),
      verifiedContext: remembered.context,
    }, {
      assertCurrent: async (evidence, wait) => { accumulated = evidence; return current(wait); },
      modelTurn: async input => {
        // One bounded customer turn, including its function rounds. Preserve
        // the existing abuse ceiling separately from per-attempt money. A
        // failed pre-model read does not consume a model turn.
        await spendTurnBudget(input.wait);
        return runtime!.modelTurn(input);
      },
      executeAllowedTool: async (call, { wait }) => {
        if (!await current(wait)) return { status: "denied", reason: "original_context_changed" };
        if (call.name === "get_property_facts") {
          const facts = await dispatchCustomerTool(mutations.principal, call, { enabled: true });
          if (facts.status === "observed") return { status: "observed", observation: { kind: "facts", facts: facts.facts, kinds: facts.kinds } };
          if (facts.status === "missing" || facts.status === "ambiguous") return { status: "observed", observation: {
            kind: "property_unresolved", status: facts.status,
          } };
          return { status: facts.status === "unavailable" ? "unavailable" : "denied", reason: "property_read_unavailable" };
        }
        if (call.name === "get_agency_contact") return { status: "observed", observation: {
          kind: "agency_contact", contact: { phone: PUBLIC_AGENCY_CONTACT.phone, digits: PUBLIC_AGENCY_CONTACT.digits, channel: "telephone" },
        } };
        if (call.name === "get_company_policy" || call.name === "search_public_properties" || call.name === "get_company_information" || call.name === "get_open_vacancies") {
          const read = await readDmCustomerAgentDataWitness({ principal: mutations.principal, claim, call });
          if (read.status === "observed") {
            witnesses.push(read.serverWitness);
            return { status: "observed", observation: read.observation };
          }
          return read;
        }
        return mutations.execute(call, wait);
      },
      requestStop: () => runtime!.stop(),
      // The executor owns durable reconciliation. A late notification can
      // neither re-enter the model nor enqueue a second customer response.
      observeLateToolResult: () => {},
    });
    traceCustomerCoreResult(result);
    // A committed handover deliberately invalidates the ordinary BOT context.
    // Only the captured pre-effect source and its actual committed receipt can
    // plan this fixed ACK. No model round, general HOLD exception or new actor.
    if (mutations.state === "handover_committed") {
      const source = mutations.handoverAckSource;
      const receipt = mutations.committedReceipts.find(value => value.kind === "handover");
      const ackLive = () => {
        if (!runtime || runtime.operation.signal?.aborted || runtime.operation.stopped || Date.now() >= claim.deadlineAt) return false;
        try { runtime.operation.check(); return true; } catch { return false; }
      };
      const partId = source && receipt && ackLive() ? await prisma.$transaction(async tx => {
        if (!ackLive()) return null;
        const ack = await issueCustomerHandoverAckTx(tx, source, receipt);
        return ack && ackLive() ? planCustomerHandoverAckTx(tx, ack, runtime!.operation.signal) : null;
      }) : null;
      if (partId) return { status: "planned", partIds: [partId] };
      await releaseHeldClaim(claim, "handover_committed_ack_unavailable");
      return { status: "held", reason: "handover_committed_ack_unavailable" };
    }
    if (result.status !== "ready" || !result.text.trim() || result.decision.kind === "escalate") {
      const reason = result.status === "held" ? modelHeldReason ?? result.reason : "staff_or_supported_reply_required";
      await releaseHeldClaim(claim, reason);
      return { status: "held", reason };
    }
    const principal = mutations.principal;
    const sealed = await sealDmCustomerAgentDeliveryEvidence({ principal, claim, serverWitnesses: witnesses, render: {
      decision: result.decision, evidence: result.evidence, language, requestedFacts,
      knownPhoneSource: lane.context.knownPhoneSource, text: result.text, verifiedContext: remembered.context, inputText: text,
      attachmentInput: prepared.attachmentInput,
      mediaPerception,
    } });
    if (sealed.status !== "sealed") {
      await releaseHeldClaim(claim, sealed.reason);
      return { status: "held", reason: sealed.reason };
    }
    const propertyUsed = result.evidence.some(e => e.value.kind === "facts" || e.value.kind === "property_unresolved");
    const property = propertyUsed ? managedCustomerPropertyReply({ id: principal.scope.conversationId,
      channel: principal.scope.channel, subscriberId: principal.scope.peer, accountId: principal.scope.accountId,
      endpointScopeId: principal.scope.endpointScopeId }, focus, result.text, { status: "admitted", ticket: lane.ticket }).delivery : undefined;
    const partIds = await prisma.$transaction(tx => createCustomerOutboxPartsTx(tx, { principal, agentClaim: claim,
      parts: [{ payload: { kind: "text", text: sealed.text }, property, receipts: mutations.receipts,
        ...(sealed.witness ? { publicDataWitness: sealed.witness } : {}) }], receiptAuthorities: mutations.receiptAuthorities }));
    return { status: "planned", partIds };
  } catch {
    await releaseHeldClaim(claim, "customer_core_unavailable");
    return { status: "held", reason: "customer_core_unavailable" };
  } finally {
    // Settlement and budget errors stay visible to the job runner. Never
    // change unknown usage into a success or issue a new operation here.
    await runtime?.close();
  }
    })();
    traceCustomerCoreDisposition(outcome.status, "reason" in outcome ? outcome.reason : undefined);
    return outcome;
  });
}

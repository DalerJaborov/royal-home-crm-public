import { loadCustomerAgentVerifiedDmContext } from "./customerAgentVerifiedContext.js";
import { hasNewerCustomerInboxInput, NEWER_INPUT_PENDING } from "./customerNewerInboxInput.js";
import { loadDeferredCustomerInput } from "./customerDeferredInput.js";
import type { CustomerAgentEvidence } from "../ai/customerAgentRenderer.js";
import { runCustomerAgentTurn, safeCauseCode } from "../ai/customerAgentCore.js";
import { customerAgentSayMode } from "./customerAgentFeaturePolicy.js";
import { recordCustomerAgentSay } from "./customerAgentSayStats.js";
import { customerAgentToolDefinitions, CUSTOMER_AGENT_PUBLIC_TOOLS } from "../ai/customerAgentToolDefinitions.js";
import { dispatchCustomerTool } from "../ai/customerToolRegistry.js";
import { customerAffirmationFollowUp, customerBareAffirmation, customerCheaperRequested, customerCheaperSearchCall } from "../ai/customerAgentFollowUp.js";
import { resolveCustomerDmLanguage } from "../ai/customerDmLanguage.js";
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
import type { CustomerDeliveryPayload } from "./customerDeliveryContracts.js";
import { createCustomerAgentMutationSession, type CustomerAgentMutationSession } from "./customerAgentMutationSession.js";
import { enrichCustomerAgentMediaFocus, enrichCustomerAgentSelectionFocus, enrichCustomerAgentLinkFocus, createCustomerAgentLinkReads } from "./customerAgentMediaFocus.js";
import { issueCustomerHandoverAckTx, planCustomerHandoverAckTx } from "./customerHandoverAck.js";
import { readDmCustomerAgentDataWitness, sealDmCustomerAgentDeliveryEvidence,
  type CustomerAgentDataReadWitness } from "./customerAgentDeliveryEvidence.js";
import { customerAgentPublicReadCurrent } from "./customerAgentPublicReads.js";
import { aiDailyBudgetOf, spendAiTurns } from "./aiDailyBudget.js";
import { loadCustomerDmMediaContent } from "./customerDmMediaContent.js";
import { recordCustomerRecruitmentAttachments } from "./customerRecruitmentAttachments.js";
import { customerAgentMediaReplyLanguage, type CustomerAgentMediaPerception } from "../ai/customerAgentMediaPerception.js";
import { loadCustomerAgentMediaObservation, storeCustomerAgentMediaObservation } from "./customerAgentMediaObservation.js";
import { loadCustomerAdjacentVisualObservation } from "./customerAdjacentVisualObservation.js";
import { withBotTurnTrace, traceCustomerManagedBinding, traceCustomerCoreResult, traceCustomerCoreDisposition, traceMediaKinds } from "./botTurnTrace.js";
import { customerPropertyUnresolvedReason } from "./customerPropertyUnresolvedReason.js";
import { customerAgentMarkForeignShare } from "../ai/customerAgentAttachmentInput.js";
import { loadCustomerAgentFeaturePolicy } from "./customerAgentFeaturePolicy.js";
import { customerPropertyMediaEndpointSchema, customerPropertyMediaExecutionMode, explicitCustomerPropertyPhotoRequest, prepareCustomerPropertyMedia } from "./customerPropertyMedia.js";
import { reconcileCustomerShowcaseReply } from "./customerShowcaseReceipt.js";
import { createHash } from "node:crypto";
import { inspectAuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { customerVoiceReplyPreference, prepareCustomerVoiceReply, type CustomerVoiceTrigger } from "./customerVoiceReply.js";
import { prepareCustomerApprovedFile, CUSTOMER_BUYER_GUIDE_CURRENT, customerApprovedFileFollowPromptIssuedBy,
  customerBuyerGuideRelevant, type CustomerApprovedFileAuthority, type CustomerApprovedFilePlan } from "./customerApprovedFiles.js";
import { customerVoiceAssetsConfigured, issueCustomerApprovedFilePayload, prepareCustomerVoiceAsset } from "./customerDeliveryMedia.js";
import { customerDeliveryMediaEndpointSchema } from "./customerDeliveryContracts.js";
import { customerAgentMediaExecutionMode } from "./customerDeliveryMedia.js";
import { fetchInstagramProfile, loadCredentials } from "../messengers/meta.js";
import { bindCustomerMetaSendCredentials } from "./customerMetaTransport.js";

export type CustomerDmAgentTurnResult = { status: "planned"; partIds: string[] } |
  { status: "unchanged"; reason: string } | { status: "held"; reason: string };

/** Only the authenticated current own input and its original normalized media
 * can select mirrored audio. An explicit current text-only preference wins. */
export function customerVoiceTriggerForCurrentInput(input: { inputText: string; eventId: string; eventKind: string },
  media: readonly { kind: string; assetRef?: string }[]): CustomerVoiceTrigger | null {
  const preference = customerVoiceReplyPreference(input.inputText);
  if (preference === "text") return null;
  if (preference === "voice") return { kind: "explicit_request", messageId: input.eventId };
  const originalAudio = input.eventKind === "message" ? media.find(item => item.kind === "audio" && item.assetRef) : undefined;
  return originalAudio?.assetRef ? { kind: "inbound_voice", messageId: input.eventId, attachmentId: originalAudio.assetRef } : null;
}

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
    // Safe diagnostic code of the failure (trace only; never part of the returned shape or customer text).
    let heldCause: string | undefined;
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
    let language: "tg" | "ru" = resolveCustomerDmLanguage(text);
    let planningPrincipal = lane.principal;
    let activeMutations: CustomerAgentMutationSession | undefined;
    let accumulated: readonly CustomerAgentEvidence[] = [];
    const witnesses: CustomerAgentDataReadWitness[] = [];
    let mediaPrepared = false;
    const current = async (wait: { signal: AbortSignal; deadlineAt: number }): Promise<boolean> => {
      if (mediaPrepared && await hasNewerCustomerInboxInput(claim.eventKey)) return false;
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
    const linkWait = { signal: runtime.operation.signal!, deadlineAt: runtime.operation.deadlineAt };
    const linkReads = createCustomerAgentLinkReads(claim.eventKey, { ...linkWait, assertCurrent: () => current(linkWait) });
    const linked = await enrichCustomerAgentLinkFocus({ principal: planningPrincipal, claim, ticket: lane.ticket,
      linkReads });
    if (linked.status === "held") { await releaseHeldClaim(claim, linked.reason); return linked; }
    if (linked.status === "updated") { planningPrincipal = linked.principal; focus = linked.focus; }
    let remembered = await loadCustomerAgentVerifiedDmContext({ principal: planningPrincipal,
      revision: claim.pin.revision, wait: { signal: runtime.operation.signal, deadlineAt: runtime.operation.deadlineAt } });
    if (remembered.status !== "current") {
      await releaseHeldClaim(claim, remembered.reason);
      return remembered;
    }
    // Earlier inputs put aside as `newer_input_pending` are part of what the
    // customer asks NOW (chronological, before the current words). Their raw
    // inputs are not re-accepted: this is conversational meaning only, like the
    // media transcript below.
    const carried = await loadDeferredCustomerInput(planningPrincipal);
    const fullInput = () => carried ? [carried, text].filter(part => part.trim()).join("\n") : text;
    // Short answers, names, bare links and greetings carry no decisive language evidence. Keep this
    // customer's last decisive USER turn (never the bot's prose or another inquiry's language); a full
    // sentence in another language, or an explicit request, switches the dialogue. The deferred block
    // is part of the current words, so the whole block decides.
    language = resolveCustomerDmLanguage(fullInput(), remembered.context.turns.filter(turn => turn.role === "user").map(turn => turn.text),
      remembered.context.publicState.language);
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
    let mediaPerception: CustomerAgentMediaPerception | undefined, ownPublicationFound = false;
    if (runtime.mediaEnabled && prepared.media.length) {
      const wait = { signal: runtime.operation.signal!, deadlineAt: runtime.operation.deadlineAt };
      mediaPerception = await loadCustomerAgentMediaObservation(claim) ?? undefined;
      if (!mediaPerception) {
        const loaded = await loadCustomerDmMediaContent({ principal: planningPrincipal, media: prepared.media, wait, assertCurrent: current,
          preserveAttachments: remembered.context.publicState.topic === "job" });
        ownPublicationFound = loaded.publicationFound === true;
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
    if (runtime.mediaEnabled && !prepared.media.length && !mediaPerception) {
      mediaPerception = await loadCustomerAdjacentVisualObservation(planningPrincipal, claim) ?? undefined;
    }
    // Finish/stash the already paid real perception so the next caption can
    // understand its preceding reel. Then abandon the older answer if a newer
    // signed message is already queued, rather than send two unrelated turns.
    mediaPrepared = true;
    if (await hasNewerCustomerInboxInput(claim.eventKey)) {
      await releaseHeldClaim(claim, NEWER_INPUT_PENDING); return { status: "held", reason: NEWER_INPUT_PENDING };
    }
    let mediaReferenceResolved = false;
    if (mediaPerception) {
      const enriched = await enrichCustomerAgentMediaFocus({ principal: planningPrincipal, claim, ticket: lane.ticket, linkReads });
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
    const selected = await enrichCustomerAgentSelectionFocus({ principal: planningPrincipal, claim, ticket: lane.ticket, linkReads });
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
    const requestedFacts = remembered.context.publicState.topic === "job" ? [] : classifyCustomerPropertyFactIntent(fullInput(), { hasPropertyContext: focus?.snapshot.focus.status === "resolved" }) ??
      (!text.trim() && prepared.attachmentInput && (prepared.attachmentPropertyReference || mediaReferenceResolved) && focus?.snapshot.focus.status === "resolved"
        ? ["price" as const, "address" as const] : []);
    // Short-word reads (customer words only): "дорого / дешевле есть?" about the object in focus reads the cheaper
    // catalogue entries before the model answers; a bare "да" after the bot's own clarifying question is re-asked
    // by the server. Neither applies to a job inquiry, media, a fact question or a fresh attachment.
    const plainTurn = remembered.context.publicState.topic !== "job" && !requestedFacts.length && !prepared.attachmentInput && !mediaPerception;
    const resolvedFocusId = focus?.snapshot.focus.status === "resolved" ? focus.snapshot.focus.propertyId : null;
    const previousTurn = remembered.context.turns.at(-1);
    const followUp = plainTurn && !carried && customerBareAffirmation(text)
      ? customerAffirmationFollowUp(previousTurn?.role === "assistant" ? previousTurn.text : undefined, !!resolvedFocusId) ?? undefined : undefined;
    const cheaperCall = plainTurn && !followUp && resolvedFocusId && customerCheaperRequested(fullInput())
      ? customerCheaperSearchCall(await readCustomerPropertyFacts(resolvedFocusId, planningPrincipal.scope.channel)) : null;
    // Buyer-guide availability is a server hint only. It is deliberately not
    // exposed on unrelated job/seller turns, and no model marker can mint a
    // file send without the exact current campaign witness below.
    const authenticatedInput = inspectAuthenticatedCustomerInput(lane.authenticatedInput);
    const ownInputText = authenticatedInput?.inputText ?? "";
    let buyerRelevant = customerBuyerGuideRelevant({ topic: remembered.context.publicState.topic, currentOwnText: ownInputText });
    const mediaExecution = customerAgentMediaExecutionMode();
    let approvedFileState: "available" | "needs_follow" | "awaiting_follow" | "unavailable" | "already_sent" | "pending_delivery" = "unavailable";
    let approvedFilePlan: CustomerApprovedFilePlan | undefined;
    let approvedFileAuthority: CustomerApprovedFileAuthority | undefined;
    let mediaEndpoint: ReturnType<typeof customerDeliveryMediaEndpointSchema.parse> | undefined;
    if (mediaExecution === "LIVE" && authenticatedInput && planningPrincipal.scope.channel !== "WEBSITE") {
      const currentPrincipal = await revalidateCustomerPrincipal(planningPrincipal);
      const capturedTransport = currentPrincipal.status === "current" ? currentPrincipal.snapshot.transport : undefined;
      // Project only the exact transport fields required by the media sender.
      // The source is the revalidated server snapshot; the peer is the same
      // captured scope peer, never a caller/model-selected destination.
      const endpoint = capturedTransport && customerDeliveryMediaEndpointSchema.safeParse({
        channel: capturedTransport.channel, endpointScopeId: capturedTransport.endpointScopeId,
        accountId: capturedTransport.accountId, peerId: planningPrincipal.scope.peer,
        transportKey: capturedTransport.transportKey, scopeRevision: capturedTransport.scopeRevision,
      });
      if (endpoint?.success) {
        mediaEndpoint = endpoint.data;
        const conversation = await prisma.botConversation.findUnique({ where: { id: planningPrincipal.scope.conversationId },
          select: { guideSentAt: true, guideAwaitFollowAt: true } });
        const reserved = await prisma.$queryRaw<{ filePending: boolean; fileAccepted: boolean; followPending: boolean }[]>`SELECT
          EXISTS(SELECT 1 FROM "CustomerOutboxPart" WHERE "originalNativeId"=${planningPrincipal.scope.conversationId}
            AND "mode"='LIVE' AND "approvedAssetPurpose"='buyer_guide' AND "status" IN ('READY','IN_FLIGHT','ACCEPTED','UNKNOWN')) AS "filePending",
          EXISTS(SELECT 1 FROM "CustomerOutboxPart" p WHERE p."originalNativeId"=${planningPrincipal.scope.conversationId}
            AND p."mode"='LIVE' AND p."approvedAssetPurpose"='buyer_guide' AND p."status"='ACCEPTED'
            AND EXISTS(SELECT 1 FROM "CustomerDeliveryAttempt" a WHERE a."partId"=p."id" AND a."outcome"='ACCEPTED'
              AND a."providerMid" IS NOT NULL)) AS "fileAccepted",
          EXISTS(SELECT 1 FROM "CustomerOutboxPart" WHERE "originalNativeId"=${planningPrincipal.scope.conversationId}
            AND "mode"='LIVE' AND "approvedAssetPurpose"='buyer_guide_follow' AND
            ("status" IN ('READY','IN_FLIGHT','UNKNOWN') OR ("status"='ACCEPTED' AND "projectionRecordedAt" IS NULL))) AS "followPending"`;
        const acceptedOwnGuide = !!conversation?.guideSentAt && reserved[0]?.fileAccepted === true;
        buyerRelevant = customerBuyerGuideRelevant({ topic: remembered.context.publicState.topic, currentOwnText: ownInputText,
          awaitingFollowSince: conversation?.guideAwaitFollowAt, hasAcceptedGuide: acceptedOwnGuide });
        if (buyerRelevant) {
        approvedFileAuthority = { endpointScopeId: endpoint.data.endpointScopeId, accountId: endpoint.data.accountId,
          transportKey: endpoint.data.transportKey, scopeRevision: endpoint.data.scopeRevision, peer: endpoint.data.peerId,
          agentRevisionId: claim.pin.agentRevisionId, eventKey: claim.eventKey, scopeKey: lane.ticket.scopeKey, turnKey: claim.eventKey };
        const filePending = !!reserved[0]?.filePending;
        const followPending = !!reserved[0]?.followPending;
        const awaitingSince = conversation?.guideAwaitFollowAt ?? null;
        const awaiting = followPending || !!awaitingSince && Date.now() - awaitingSince.getTime() < 7 * 24 * 60 * 60 * 1000;
        const requested = buyerRelevant;
        let followerState: boolean | undefined;
        if (endpoint.data.channel === "INSTAGRAM") {
          try {
            const loaded = await loadCredentials();
            const bound = await bindCustomerMetaSendCredentials(loaded, "INSTAGRAM", endpoint.data.peerId, undefined, capturedTransport!);
            const profile = await fetchInstagramProfile(endpoint.data.peerId, bound.token);
            followerState = typeof profile.isUserFollowBusiness === "boolean" ? profile.isUserFollowBusiness : undefined;
          } catch { followerState = undefined; }
        }
        if (await current(linkWait)) {
          approvedFilePlan = await prepareCustomerApprovedFile({ assetRef: CUSTOMER_BUYER_GUIDE_CURRENT,
            channel: endpoint.data.channel, authority: approvedFileAuthority,
            eligibility: { canSendGuide: true, requested,
              // An UNKNOWN follow prompt reserves that prompt only. A fresh
              // confirmed follower request may still receive the first file.
              alreadySent: !!conversation?.guideSentAt || filePending, awaitingFollowSince: awaitingSince,
              followerState, now: new Date() },
            stillCurrent: async () => current(linkWait) }, undefined);
          if (acceptedOwnGuide) approvedFileState = "already_sent";
          else if (filePending) approvedFileState = "pending_delivery";
          else if (approvedFilePlan.status === "prepared") approvedFileState = "available";
          else if (approvedFilePlan.reason === "follow_required" && approvedFilePlan.needsFollow) approvedFileState = awaiting ? "awaiting_follow" : "needs_follow";
          else if (approvedFilePlan.reason === "awaiting_follow" || awaiting) approvedFileState = "awaiting_follow";
        }
        }
      }
    }
    // Somebody else's publication: shared as an attachment, nothing of ours pointed at, and the lookup in our own catalog FINISHED
    // with "no such object" for the current event (a transient failure is not "foreign"). Server fact; the model never sets it.
    const currentFocus = focus?.snapshot.focus;
    // Found in OUR account (the lookup returned the publication) but no object is linked: our own, not foreign.
    const unlinked = prepared.foreignShareCandidate && !!currentFocus && currentFocus.eventKey === lane.ticket.eventKey && currentFocus.status === "missing" &&
      customerPropertyUnresolvedReason(currentFocus.evidence, currentFocus.status, currentFocus.lookupAttempts) === "not_found";
    const attachmentInput = customerAgentMarkForeignShare(prepared.attachmentInput,
      unlinked && ownPublicationFound ? "own_share_unlinked" : unlinked && !mediaPerception ? "foreign_share" : false);
    const result = await runCustomerAgentTurn({ surface: "dm", language, inputText: fullInput(), attachmentInput, mediaPerception,
      knownPhoneSource: lane.context.knownPhoneSource, requestedFacts, revision: claim.pin.revision,
      approvedFileState, ...(followUp ? { followUp } : {}), ...(cheaperCall ? { preReads: [cheaperCall] } : {}),
      startedAt: claim.pin.receivedAt, operation: runtime.operation,
      tools: customerAgentToolDefinitions([...CUSTOMER_AGENT_PUBLIC_TOOLS, ...mutations.availableToolNames]),
      verifiedContext: remembered.context, sayMode: customerAgentSayMode(),
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
          if (facts.status === "missing" || facts.status === "ambiguous") {
            const reason = customerPropertyUnresolvedReason(focus?.snapshot.focus.evidence, facts.status, focus?.snapshot.focus.lookupAttempts);
            return { status: "observed", observation: { kind: "property_unresolved", status: facts.status, ...(reason ? { reason } : {}) } };
          }
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
    if (result.status === "ready") recordCustomerAgentSay(result.say);
    if (result.status === "held") heldCause = result.cause;
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
      knownPhoneSource: lane.context.knownPhoneSource, text: result.text, verifiedContext: remembered.context, inputText: fullInput(),
      attachmentInput, approvedFileState,
      mediaPerception,
    } });
    if (sealed.status !== "sealed") {
      await releaseHeldClaim(claim, sealed.reason);
      return { status: "held", reason: sealed.reason };
    }
    const mediaMode = customerPropertyMediaExecutionMode();
    const photoRequested = mediaMode !== "OFF" && explicitCustomerPropertyPhotoRequest(text);
    let imageParts: { payload: CustomerDeliveryPayload }[] = [];
    if (photoRequested) {
      // This checked legacy acknowledgement matcher is used as a detector only:
      // the managed adapter never rewrites immutable renderer text. If the model
      // claims photos already went out before a provider MID, hold the turn for
      // review rather than make a false statement.
      const claimCheck = reconcileCustomerShowcaseReply({ reply: sealed.text },
        { deliveryStatus: "not_sent", attachments: [], linkMid: null, websiteCard: null }, language);
      if (claimCheck.changed) {
        await releaseHeldClaim(claim, "photo_ack_requires_delivery_review");
        return { status: "held", reason: "photo_ack_requires_delivery_review" };
      }
      const currentFocus = focus?.snapshot.focus;
      const focusedProperty = currentFocus?.status === "resolved" && currentFocus.propertyId &&
        currentFocus.eventKey === lane.ticket.eventKey && currentFocus.scopeKey === lane.ticket.scopeKey ? currentFocus : null;
      const policy = await loadCustomerAgentFeaturePolicy();
      if (focusedProperty && policy.photos && policy.photosPerOffer > 0 &&
          ["INSTAGRAM", "FACEBOOK", "WHATSAPP"].includes(mutations.principal.scope.channel)) {
        const currentPrincipal = await revalidateCustomerPrincipal(mutations.principal);
        const capturedTransport = currentPrincipal.status === "current" ? currentPrincipal.snapshot.transport : undefined;
        if (capturedTransport) {
          const endpoint = customerPropertyMediaEndpointSchema.safeParse({ ...capturedTransport, peerId: mutations.principal.scope.peer });
          if (endpoint.success) {
            const preparedMedia = await prepareCustomerPropertyMedia({ propertyId: focusedProperty.propertyId!,
              endpoint: endpoint.data, capability: { photos: policy.photos, photosPerOffer: policy.photosPerOffer },
              agentRevisionId: claim.pin.agentRevisionId, eventKey: lane.ticket.eventKey, scopeKey: lane.ticket.scopeKey,
              focusGeneration: focusedProperty.generation });
            if (preparedMedia.status === "ready" && mediaMode === "LIVE") {
              imageParts = preparedMedia.images.map(image => ({ payload: image.payload }));
            }
          }
        }
      }
    }
    const mediaParts: { payload: CustomerDeliveryPayload; approvedAssetPurpose?: "buyer_guide" }[] = [...imageParts];
    let textApprovedAssetPurpose: "buyer_guide_follow" | undefined;
    let approvedFileIssue: unknown;
    const requestedBuyerGuide = result.decision.kind === "reply" && result.decision.attachment === "buyer_guide";
    if (requestedBuyerGuide && approvedFileState === "available" && approvedFilePlan?.status === "prepared" &&
        approvedFileAuthority && mediaEndpoint && await current(linkWait)) {
      const issued = issueCustomerApprovedFilePayload({ plan: approvedFilePlan, authority: approvedFileAuthority, endpoint: mediaEndpoint });
      if (issued) mediaParts.push({ payload: issued.payload, approvedAssetPurpose: "buyer_guide" });
    } else if (requestedBuyerGuide && approvedFileState === "needs_follow" && approvedFileAuthority &&
        customerApprovedFileFollowPromptIssuedBy(approvedFilePlan, approvedFileAuthority)) {
      textApprovedAssetPurpose = "buyer_guide_follow";
      approvedFileIssue = approvedFilePlan;
    }
    // Voice synthesis consumes only the exact final sealed text, only in LIVE,
    // and only for the authenticated current audio input or explicit request.
    // Failure leaves the ordinary text part intact.
    let voicePart: { payload: CustomerDeliveryPayload } | undefined;
    if (mediaExecution === "LIVE" && customerVoiceAssetsConfigured() && authenticatedInput && mediaEndpoint && runtime &&
        ["INSTAGRAM", "FACEBOOK", "WHATSAPP"].includes(mediaEndpoint.channel)) {
      const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { botCanSendVoiceReplies: true } });
      const voiceTrigger = customerVoiceTriggerForCurrentInput(authenticatedInput, prepared.media);
      if (settings?.botCanSendVoiceReplies === true && voiceTrigger && await current(linkWait)) {
        const sealedTextSha256 = createHash("sha256").update(sealed.text).digest("hex");
        const authority = { voiceReplies: true, voiceTrigger, channel: mediaEndpoint.channel,
          endpointScopeId: mediaEndpoint.endpointScopeId, accountId: mediaEndpoint.accountId,
          transportKey: mediaEndpoint.transportKey, scopeRevision: mediaEndpoint.scopeRevision,
          peer: mediaEndpoint.peerId, agentRevisionId: claim.pin.agentRevisionId,
          eventKey: claim.eventKey, scopeKey: lane.ticket.scopeKey, turnKey: claim.eventKey };
        const voicePreparationDeadlineAtMs = runtime.operation.deadlineAt - 5_000;
        const preparedVoice = await prepareCustomerVoiceReply({ sealedText: sealed.text, sealedTextSha256, authority,
          deadlineAtMs: runtime.operation.deadlineAt, preparationDeadlineAtMs: voicePreparationDeadlineAtMs,
          stillCurrent: async () => await current(linkWait) &&
            (await prisma.settings.findUnique({ where: { id: "singleton" }, select: { botCanSendVoiceReplies: true } }))?.botCanSendVoiceReplies === true });
        if (preparedVoice.status === "prepared" && await current(linkWait)) {
          const preparedAsset = await prepareCustomerVoiceAsset({ prepared: preparedVoice, authority,
            expectedSealedTextSha256: sealedTextSha256, expectedDeadlineAtMs: runtime.operation.deadlineAt,
            preparationDeadlineAtMs: voicePreparationDeadlineAtMs,
            stillCurrent: async () => await current(linkWait) &&
              (await prisma.settings.findUnique({ where: { id: "singleton" }, select: { botCanSendVoiceReplies: true } }))?.botCanSendVoiceReplies === true,
            endpoint: mediaEndpoint });
          if (preparedAsset && await current(linkWait)) voicePart = { payload: preparedAsset.payload };
        }
      }
    }
    const propertyUsed = result.evidence.some(e => e.value.kind === "facts" || e.value.kind === "property_unresolved");
    const property = propertyUsed ? managedCustomerPropertyReply({ id: principal.scope.conversationId,
      channel: principal.scope.channel, subscriberId: principal.scope.peer, accountId: principal.scope.accountId,
      endpointScopeId: principal.scope.endpointScopeId }, focus, result.text, { status: "admitted", ticket: lane.ticket }).delivery : undefined;
    const textPart = { payload: { kind: "text" as const, text: sealed.text }, property, receipts: mutations.receipts,
      ...(textApprovedAssetPurpose ? { approvedAssetPurpose: textApprovedAssetPurpose, approvedFileIssue } : {}),
      ...(sealed.witness ? { publicDataWitness: sealed.witness } : {}) };
    const sidecars = [...mediaParts, ...(voicePart ? [voicePart] : [])];
    let partIds: string[];
    try {
      partIds = await prisma.$transaction(tx => createCustomerOutboxPartsTx(tx, { principal, agentClaim: claim,
        parts: [textPart, ...sidecars], receiptAuthorities: mutations.receiptAuthorities }));
    } catch (error) {
      // The media attachment is optional to the already sealed text response.
      // If its witness/reservation becomes stale during the planning TX, retry
      // the same idempotent text plan alone. An intentional buyer-guide follow
      // instruction is part of textPart and remains guarded with its marker.
      if (!sidecars.length) throw error;
      partIds = await prisma.$transaction(tx => createCustomerOutboxPartsTx(tx, { principal, agentClaim: claim,
        parts: [textPart], receiptAuthorities: mutations.receiptAuthorities }));
    }
    return { status: "planned", partIds };
  } catch (error) {
    heldCause = safeCauseCode(error);
    await releaseHeldClaim(claim, "customer_core_unavailable");
    return { status: "held", reason: "customer_core_unavailable" };
  } finally {
    // Settlement and budget errors stay visible to the job runner. Never
    // change unknown usage into a success or issue a new operation here.
    await runtime?.close();
  }
    })();
    traceCustomerCoreDisposition(outcome.status, "reason" in outcome ? outcome.reason : undefined, heldCause);
    return outcome;
  });
}

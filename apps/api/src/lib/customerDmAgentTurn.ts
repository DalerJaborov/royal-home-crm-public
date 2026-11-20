import { loadCustomerAgentVerifiedDmContext } from "./customerAgentVerifiedContext.js";
import { hasNewerCustomerInboxInput, NEWER_INPUT_PENDING } from "./customerNewerInboxInput.js";
import { loadCustomerBurst } from "./customerDeferredInput.js";
import type { CustomerAgentEvidence } from "../ai/customerAgentRenderer.js";
import { runCustomerAgentTurn, safeCauseCode } from "../ai/customerAgentCore.js";
import { customerAgentSayMode, customerAgentAnswerMode } from "./customerAgentFeaturePolicy.js";
import { readCustomerAgentBrand } from "./customerAgentBrandRead.js";
import { recordCustomerAgentSay, recordCustomerAgentAnswer } from "./customerAgentSayStats.js";
import { recordCustomerAgentAnswerSample } from "./customerAgentAnswerSamples.js";
import { customerAgentToolDefinitions, CUSTOMER_AGENT_PUBLIC_TOOLS } from "../ai/customerAgentToolDefinitions.js";
import { dispatchCustomerTool } from "../ai/customerToolRegistry.js";
import { customerSearchContinuation, customerSearchIntent, customerSearchIntentWithKnownNeeds, customerSearchPreRead } from "../ai/customerAgentSearchIntent.js";
import { resolveSearchPlace } from "./searchPlace.js";
import { customerPreReadWithoutShown } from "./customerSearchHistory.js";
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
import { enrichCustomerAgentMediaFocus, enrichCustomerAgentSelectionFocus, enrichCustomerAgentLinkFocus, createCustomerAgentLinkReads,
  enrichCustomerAgentBurstFocus, safeAnalyzeCustomerBurstReferences, customerBurstFocusFresh } from "./customerAgentMediaFocus.js";
import { customerPropertyVideoPlan, readCustomerPropertyVideoAnswer } from "./customerPropertyVideoAnswer.js";
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
import { customerSpamMuteGate, customerSpamTurn, SPAM_MUTED_NO_REPLY } from "../ai/customerSpamMute.js";
import { clearCustomerSpamMute, readCustomerSpamMute, recordCustomerSpamTurn } from "./customerSpamMuteStore.js";
import { logSystemError } from "./systemError.js";
import { notifyEscalatedCustomerTurn } from "./customerHeldMessage.js";
import { customerReplyCallsStaff } from "../ai/customerAgentStaffFollowUp.js";
import { loadBotAnswersItself } from "./botAnswersItself.js";
import { selfAnswerLine, selfAnswerLines, selfCallbackRequested } from "../ai/botSelfAnswerText.js";
import { enqueueRecruitmentCandidateAlertTx } from "./customerRecruitmentAlert.js";
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
import { loadLeadOnlyConfig } from "./leadOnlySettings.js";
import { assertOperatorStateCurrentTx, enqueueCustomerLeadOnlyIntakeTx, LEAD_ONLY_OPERATOR_SILENT, OperatorStateStaleError, planCustomerLeadOnlyTurn,
  type CustomerLeadOnlyTurnPlan } from "./customerLeadOnlyCore.js";
import { leadOnlyAppliesTo, leadOnlyEscalateLine } from "../ai/leadOnlyMode.js";
import { selfAnswerLeadIntake } from "./selfAnswerLead.js";
import { z } from "zod";
import { customerDeliveryTransportSchema } from "./customerDeliveryContracts.js";
import { coreReplyRepeatBlocked } from "./outboundShield.js";
import { customerHeldForChangedContext, customerSafetyCandidateLines, customerSafetyLine,
  customerSafetyLineAllowed, customerSafetyLineFits, customerSafetyMemory } from "./customerNoSilence.js";
import { clientTalksBusiness } from "../messengers/sharedMedia.js";
import { saveOperatorStateIsolatedTx, saveOperatorStateTx } from "../ai/operator/state.js";
import type { OperatorStaffReason } from "../ai/operator/types.js";

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
  // Блокировка Meta (368 и родня) ход НЕ останавливает — как в main (#273): оператор оформляет заявку по номеру, ответ
  // планируется, а выпустить его не даёт дверь отправки (lib/metaSendBlock.ts), она же передаёт переписку человеку.
  // Ранний выход здесь (#283 до 20.11) оставлял клиента без заявки и без человека (HANDOFF #283, блокер ревью 19.11).
  return withBotTurnTrace({ channel: lane.principal.scope.channel, account: lane.principal.scope.endpointScopeId,
    peer: lane.principal.scope.peer, conversation: lane.principal.scope.conversationId,
    event: lane.principal.admission.eventKey, kind: prepared.attachmentInput ? "media" : "text",
    attachments: prepared.attachmentInput?.kinds.length ?? 0, source: "internal",
    managed: { surface: "dm", phase: "planning" } }, async () => {
    traceMediaKinds((prepared.attachmentInput?.kinds ?? []).filter((kind): kind is "image" | "audio" | "video" | "document" =>
      kind === "image" || kind === "audio" || kind === "video" || kind === "document"));
    // Safe diagnostic code of the failure (trace only; never part of the returned shape or customer text).
    let heldCause: string | undefined;
    // A vacancy chat (the recruiter's path): the lead-only quiet rule of the staff-signal door does not apply to it.
    let jobTopicTurn = false;
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
    // The customer's own typed words of this message, before any media transcript is appended (review #225 H1).
    const ownText = text;
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
    jobTopicTurn = remembered.context.publicState.topic === "job";
    // Earlier inputs put aside as `newer_input_pending` are part of what the
    // customer asks NOW (chronological, before the current words). Their raw
    // inputs are not re-accepted: this is conversational meaning only, like the
    // media transcript below.
    // The set-aside inputs of this burst, read once: their words for the model, their media/captions for the object.
    const burst = await loadCustomerBurst(planningPrincipal);
    const carried = burst.carried;
    const fullInput = () => carried ? [carried, text].filter(part => part.trim()).join("\n") : text;
    // A dialogue marked "spammer" (two like-exchange / foreign-reel turns within a week): the input is already stored for the
    // operator; no media download, no perception, no model, no reply. Real interest in the customer's own words lifts the mark.
    const spamGate = customerSpamMuteGate(await readCustomerSpamMute(lane.ticket.conversationId), { inputText: fullInput(), now: new Date() });
    if (spamGate === "muted") { await releaseHeldClaim(claim, SPAM_MUTED_NO_REPLY); return { status: "held", reason: SPAM_MUTED_NO_REPLY }; }
    if (spamGate === "released") await clearCustomerSpamMute(lane.ticket.conversationId);
    // Short answers, names, bare links and greetings carry no decisive language evidence. Keep this
    // customer's last decisive USER turn (never the bot's prose or another inquiry's language); a full
    // sentence in another language, or an explicit request, switches the dialogue. The deferred block
    // is part of the current words, so the whole block decides.
    // The stored language is never written for DM (audit 16.11.2026), so the wider history decides after the six-turn window.
    const storedLanguage = remembered.context.publicState.language;
    language = resolveCustomerDmLanguage(fullInput(), remembered.context.turns.filter(turn => turn.role === "user").map(turn => turn.text),
      storedLanguage === "ru" || storedLanguage === "tg" ? storedLanguage : remembered.context.dialogueLanguage);
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
    // The object of THIS burst from captions and pictures (16–17.11.2026): the caption «Объект №N» of a shared post, or
    // the number on the customer's own pictures set aside for these words. Only next to our own mark and only when the
    // fields it prints match the CRM card (lib/customerCaptionReference.ts). A failure before the write leaves it to the model:
    // null here = the marks/cards could not be read — no burst focus and no server video answer, the turn goes the usual way.
    const burstReferences = await safeAnalyzeCustomerBurstReferences(burst, { eventKey: lane.ticket.eventKey, order: lane.ticket.order,
      media: prepared.media.length > 0 && !mediaReferenceResolved, evidence: lane.ticket.evidence, captions: prepared.captions });
    if (!mediaReferenceResolved && burstReferences) {
      const fromBurst = await enrichCustomerAgentBurstFocus({ principal: planningPrincipal, claim, ticket: lane.ticket, linkReads, references: burstReferences });
      if (fromBurst.status === "held") { await releaseHeldClaim(claim, fromBurst.reason); return fromBurst; }
      if (fromBurst.status === "updated") {
        planningPrincipal = fromBurst.principal; focus = fromBurst.focus;
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
    // Режим «только заявки»: ВЕСЬ ход ведёт оператор приёма заявок (ai/operator, lib/customerLeadOnlyCore.ts, этап 1.2 от
    // 19.11.2026) — один хозяин разговора. Свободная модель ядра в режиме не вызывается никогда, сбой понимания — запасные
    // правила оператора. Режим действует в каналах BOT_LEAD_ONLY_CHANNELS (по умолчанию WhatsApp, Instagram, Facebook).
    const leadOnlyConfig = await loadLeadOnlyConfig();
    const leadOnly = { ...leadOnlyConfig, enabled: leadOnlyConfig.enabled && leadOnlyAppliesTo(planningPrincipal.scope.channel) };
    const leadOnlyFocusId = focus?.snapshot.focus.status === "resolved" ? focus.snapshot.focus.propertyId ?? null : null;
    // Объект определён именно этим сообщением, а не остался в фокусе с прошлых ходов (ревью: «залипший» объект).
    const leadOnlyFocusFresh = !!leadOnlyFocusId && focus?.snapshot.focus.eventKey === lane.ticket.eventKey;
    const planLeadOnly = async (plan: CustomerLeadOnlyTurnPlan): Promise<CustomerDmAgentTurnResult> => {
      let stateError: unknown = null;
      const now = new Date();
      const partIds = await prisma.$transaction(async tx => {
        // Параллельный ход того же разговора успел записать память, пока этот ждал модель (Р14): решение устарело.
        await assertOperatorStateCurrentTx(tx, lane.ticket.conversationId, plan.baseUpdatedAt);
        const ids = plan.text ? await createCustomerOutboxPartsTx(tx, { principal: mutations.principal, agentClaim: claim,
          parts: [{ payload: { kind: "text" as const, text: plan.text } }] }) : [];
        for (const intake of plan.intakes) await enqueueCustomerLeadOnlyIntakeTx(tx, intake);
        // Память оператора — в той же транзакции, что и ответ, но за точкой сохранения: сбой памяти ответ не откатывает.
        stateError = await saveOperatorStateIsolatedTx(tx, lane.ticket.conversationId, plan.operator.state, now);
        return ids;
      });
      if (stateError) {
        void logSystemError("ai", `Оператор приёма заявок (ядро): память разговора не записана (диалог ${lane.ticket.conversationId}): ` +
          `${stateError instanceof Error ? stateError.message : String(stateError)}`.slice(0, 500), { dedupKey: "lead-only-operator-state-write" });
      }
      // Сотрудника зовём только при грубости и жалобе (до заявки людей не беспокоим, решение владельца 13.11): дверь «клиент ждёт».
      // «Бот отвечает сам» решение оператора не отменяет: он один хозяин разговора (SPEC, случаи 22 и 26; сведение #283 с #311).
      if (plan.signal) void signalStaffFollowUp(lane.ticket.conversationId, claim.pin.receivedAt, jobTopicTurn, false, true, plan.signal.reason);
      if (!plan.text) {
        // Оператор решил молчать (ок после заявки, третий вопрос о роли, повтор вложения): намеренная тишина, не сбой.
        await releaseHeldClaim(claim, LEAD_ONLY_OPERATOR_SILENT);
        return { status: "held", reason: LEAD_ONLY_OPERATOR_SILENT };
      }
      return { status: "planned", partIds };
    };
    // The safety door (lib/customerNoSilence.ts): one hand-off line instead of silence, never a repeat the shield would
    // cut, and the person learns through alertClientWaiting(follow_up). Null when it cannot be planned (claim lost,
    // principal changed, every candidate line would be a repeat): the caller keeps the old held path.
    /** The bot's own last line asked the customer something: a bare «Да» is then an answer (re-review #205, Н-3). */
    const lastBotAsked = () => /[?？]/u.test(remembered.context.turns.filter(turn => turn.role === "assistant").at(-1)?.text ?? "");
    /** «Бот отвечает сам»: страховочная дверь оформила заявку этим ходом — карточка будет, людей отдельно не зовём. */
    let safetyLineMadeLead = false;
    /**
     * «Бот отвечает сам», номер известен: заявка агенту (lib/selfAnswerLead.ts) и утверждённая строка «Передаю ваш вопрос
     * агенту, он свяжется с вами» (ai/leadOnlyMode.ts::leadOnlyEscalateLine, тексты #283 от 18.11) — в ОДНОЙ транзакции:
     * ответ без заявки или заявка без ответа не остаются. null — номера нет или строка была бы повтором.
     */
    const planSelfAnswerLead = async (modelFailed: boolean, assistantTexts: readonly string[]): Promise<CustomerDmAgentTurnResult | null> => {
      const intake = await selfAnswerLeadIntake({ channel: planningPrincipal.scope.channel, peer: planningPrincipal.scope.peer,
        conversationId: lane.ticket.conversationId, eventKey: claim.eventKey, inputText: fullInput(), turns: remembered.context.turns, modelFailed });
      if (!intake) return null;
      const line = leadOnlyEscalateLine(language, true, assistantTexts);
      if ((await customerReplyRepeatBlocked(mutations.principal, [line])).has(line) || !await current(linkWait)) return null;
      const partIds = await prisma.$transaction(async tx => {
        const ids = await createCustomerOutboxPartsTx(tx, { principal: mutations.principal, agentClaim: claim,
          parts: [{ payload: { kind: "text" as const, text: line } }] });
        await enqueueCustomerLeadOnlyIntakeTx(tx, intake);
        return ids;
      });
      safetyLineMadeLead = true;
      return { status: "planned", partIds };
    };
    const planSafetyLine = async (why: string): Promise<CustomerDmAgentTurnResult | null> => {
      try {
        // Lead-only mode: no «the agent will tell» and no staff signal before a lead (owner 13.11.2026). The mode's own
        // hand-off answers instead: a phone ask (Instagram/Facebook), a lead (WhatsApp number) or a short line on a card.
        // A vacancy chat gets null here and keeps the ordinary line below (the recruiter path is unchanged).
        // The model failed on the question (not its own escalate, not a repeat): WhatsApp with a known number gets one lead per
        // conversation with the note «бот не справился с вопросом» (owner 17.11.2026).
        const assistantTexts = remembered.context.turns.filter(turn => turn.role === "assistant").map(turn => turn.text);
        const blocked = await customerReplyRepeatBlocked(mutations.principal, [...customerSafetyCandidateLines(), ...selfAnswerLines()]);
        const memory = customerSafetyMemory(assistantTexts, l => blocked.has(l));
        // «Бот отвечает сам» (18.11.2026, lib/botAnswersItself.ts): без карточки человека не зовут — фраза «это скажет агент»
        // стала бы обещанием, которое некому выполнить. Выход из тупика — один шаг к номеру (номер есть — телефон офиса).
        let selfAnswer = !jobTopicTurn && await loadBotAnswersItself() && !(await customerConversationHasCard(lane.ticket.conversationId));
        const callback = selfAnswer && selfCallbackRequested(fullInput());
        if (selfAnswer) {
          /**
           * Номер известен (WhatsApp, номер в словах клиента) — это заявка агенту (решение владельца 13.11: лид = номер), в том
           * числе на «позвоните мне завтра» (ревью #283: бот отвечал «позвоните нам сами», и заявка терялась). Дверь —
           * lib/selfAnswerLead.ts: задание приёма ядра в одной транзакции с ответом, время звонка в пометке карточки. Номера
           * нет — фраза ниже (просьба номера), людей не зовём.
           */
          const lead = await planSelfAnswerLead(why !== "staff_or_supported_reply_required" && why !== "repeat_shield" && why !== SELF_ANSWER_CALLS_STAFF,
            assistantTexts);
          if (lead) return lead;
          // Номер известен, а заявку оформить нельзя (повтор строки, разговор сменился): «оставьте номер» было бы
          // нелепо — прежний путь, человек узнаёт (staffSignalAllowed пропускает сигнал с известным номером).
          if (lane.context.knownPhoneSource !== "none" || planningPrincipal.scope.channel === "WHATSAPP") selfAnswer = false;
        }
        // Телефон офиса — только своему бренду: аккаунту Арвана номер Royal Home не называем (ревью 1b, №10).
        const line = selfAnswer ? selfAnswerLine(language, { phoneAsked: memory.phoneAsked, callback,
          brandName: await (await import("../messengers/accounts.js")).accountBrandName(planningPrincipal.scope.accountId) })
          : customerSafetyLine(language, lane.context.knownPhoneSource, memory);
        if (blocked.has(line) || !await current(linkWait)) return null;
        const partIds = await prisma.$transaction(tx => createCustomerOutboxPartsTx(tx, { principal: mutations.principal, agentClaim: claim,
          parts: [{ payload: { kind: "text" as const, text: line } }] }));
        // The model's own escalate keeps its push with the customer's words (caller); every other line is one follow_up.
        if (why !== "staff_or_supported_reply_required") void signalStaffFollowUp(lane.ticket.conversationId, claim.pin.receivedAt, jobTopicTurn,
          lane.context.knownPhoneSource !== "none");
        // «Бот отвечает сам» (ревью #283, (д)): человека не звали — журнал не пишет «ответственному — сигнал».
        void logSystemError("ai", selfAnswer
          ? `Бот не смог ответить по существу (${why}) — «бот отвечает сам»: клиенту ушла просьба номера, людей не звали`
          : `Бот не смог ответить по существу (${why}) — клиенту ушла короткая фраза «это скажет агент», ответственному — сигнал`,
          { dedupKey: `customer-safety-line:${selfAnswer ? "self:" : ""}${why}`, quietPult: true });
        return { status: "planned", partIds };
      } catch (error) {
        heldCause = safeCauseCode(error);
        return null;
      }
    };
    if (leadOnly.enabled) {
      // Вложения хода — то, что ядро уже знает: расшифровка голосового (mediaPerception.transcript уже в `text`), наш пост
      // (объект определён этим сообщением или публикация найдена), чужой пост (предварительная метка ядра), фото и видео.
      const kinds = prepared.attachmentInput?.kinds ?? [];
      const ownPost = ownPublicationFound || (leadOnlyFocusFresh && kinds.length > 0);
      const operatorTurn = () => planCustomerLeadOnlyTurn({ config: leadOnly, channel: planningPrincipal.scope.channel, peer: planningPrincipal.scope.peer,
        conversationId: lane.ticket.conversationId, eventKey: claim.eventKey, inputText: fullInput(), focusPropertyId: leadOnlyFocusId,
        turns: remembered.context.turns, attachments: {
          voice: kinds.includes("audio") ? (mediaPerception?.transcript?.trim() ? "transcribed" : "failed") : "none",
          ownPost, foreignPost: !ownPost && (prepared.foreignShareCandidate === true || kinds.includes("foreign_share")),
          media: kinds.some(kind => kind === "image" || kind === "video") } });
      let operatorDone: CustomerDmAgentTurnResult | null = null, handedToRecruiter = false;
      // Р14: решение на устаревшей памяти не пишется — ход решается заново от свежей памяти (одна повторная попытка).
      for (let attempt = 0; attempt < 2 && !operatorDone && !handedToRecruiter; attempt++) {
        const plan = await operatorTurn();
        if (!plan) break;
        if (plan.handoff === "recruiter") {
          // Вакансия (ревью 19.11, Р6): ход ведёт прежний путь рекрутёра ниже; оператор помнит роль «вакансия».
          await saveOperatorStateTx(prisma, lane.ticket.conversationId, plan.operator.state).catch(error =>
            console.error("[lead-operator] память перед путём рекрутёра", error instanceof Error ? error.message : error));
          handedToRecruiter = true;
          break;
        }
        try { operatorDone = await planLeadOnly(plan); }
        catch (error) { if (!(error instanceof OperatorStateStaleError) || attempt === 1) throw error; }
      }
      if (operatorDone) return operatorDone;
      if (!handedToRecruiter) {
        // Режим включён, а оператор не построил ход (не бывает: дверь отвечает null только при выключенном режиме) — тишина
        // с причиной, но НЕ свободная модель ядра.
        await releaseHeldClaim(claim, "lead_only_operator_unavailable");
        return { status: "held", reason: "lead_only_operator_unavailable" };
      }
    }
    // «Видео этой квартиры есть?» (lib/customerPropertyVideoAnswer.ts): decided from the customer's OWN words of this burst
    // only, about an object THIS burst pointed at (never an older focus), answered from the CRM — the published reel or
    // the card's clip, else an honest «the agent will send it» that also reaches the agent through the one follow-up door.
    // A fact question in the same words (price, address…) is answered in the same reply; anything else goes to the model.
    const videoPlan = customerPropertyVideoPlan([...burst.inputs.map(input => input.ownText), ownText].filter(part => part.trim()).join("\n"));
    const videoFocus = focus?.snapshot.focus;
    if (!leadOnly.enabled && videoPlan && burstReferences && videoFocus?.status === "resolved" && videoFocus.propertyId &&
        remembered.context.publicState.topic !== "job" && customerBurstFocusFresh(videoFocus, burstReferences)) {
      const video = await readCustomerPropertyVideoAnswer(videoFocus.propertyId, videoPlan.tajik ? "tg" : language, planningPrincipal.scope.channel, videoPlan.facts);
      if (video && await current(linkWait)) {
        const property = managedCustomerPropertyReply({ id: planningPrincipal.scope.conversationId, channel: planningPrincipal.scope.channel,
          subscriberId: planningPrincipal.scope.peer, accountId: planningPrincipal.scope.accountId, endpointScopeId: planningPrincipal.scope.endpointScopeId },
          focus, video.text, { status: "admitted", ticket: lane.ticket }).delivery;
        const partIds = await prisma.$transaction(tx => createCustomerOutboxPartsTx(tx, { principal: mutations.principal, agentClaim: claim,
          parts: [{ payload: { kind: "text" as const, text: video.text }, property }] }));
        if (video.agentPromised) {
          // «Агент пришлёт» is true only if someone learns about it; a signal that did not go out is visible in the journal.
          // «Бот отвечает сам» это обещание не глушит (ревью #283, блокер 2 / видео): без сигнала оно было бы неправдой.
          void signalStaffFollowUp(lane.ticket.conversationId, claim.pin.receivedAt, jobTopicTurn,
            lane.context.knownPhoneSource !== "none", true).then(outcome => {
            if (outcome === "skipped") void logSystemError("ai", "Бот пообещал клиенту видео от агента, но новый сигнал агенту не ушёл (уже был или некому). Откройте переписку.",
              { dedupKey: `customer-video-promise-skipped:${lane.ticket.conversationId}`, quietPult: true });
          });
        }
        return { status: "planned", partIds };
      }
    }
    // WhatsApp с рубильником «номер WhatsApp»: номер отправителя и есть номер для звонка (владелец 12–13.11), ядро номер
    // не спрашивает: шаблон вопроса «оставьте номер» гасится так же, как при уже известном номере (второе ревью 13.11, №6).
    // Анкета кандидата на вакансию — прежняя: там номер нужен рекрутеру.
    const leadOnlyWhatsappNumber = leadOnly.enabled && leadOnly.useWhatsappNumber && planningPrincipal.scope.channel === "WHATSAPP" &&
      remembered.context.publicState.topic !== "job";
    const knownPhoneSource = leadOnlyWhatsappNumber && lane.context.knownPhoneSource === "none" ? "scoped_contact" as const : lane.context.knownPhoneSource;
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
    const cheaperCall = plainTurn && !followUp && resolvedFocusId && !leadOnly.enabled && customerCheaperRequested(fullInput())
      ? customerCheaperSearchCall(await readCustomerPropertyFacts(resolvedFocusId, planningPrincipal.scope.channel)) : null;
    // «Ищу двушку в Сино», «есть ли двушки»: the model did not start the search on its own (live 30-31.10), so the server reads the
    // bounded catalogue first and the model answers from the result. Only without an object in focus and with the tool's own required args.
    let searchCall: ReturnType<typeof customerSearchPreRead> = null;
    if (plainTurn && !followUp && !cheaperCall && !resolvedFocusId && !leadOnly.enabled) {
      // What the buyer named on earlier turns (budget, rooms, district) rides into the search: the same record the intake does not ask again.
      const knownNeeds = remembered.context.intake?.role === "buyer" ? remembered.context.intake.buyerNeeds : undefined;
      const intent = customerSearchIntentWithKnownNeeds(
        customerSearchIntent(fullInput(), language) ?? customerSearchContinuation(fullInput(), remembered.context.turns), knownNeeds);
      if (intent) {
        let placeDistrict: string | undefined;
        if (!intent.districtName && intent.placeText) {
          const place = await resolveSearchPlace(intent.placeText).catch(() => null);
          placeDistrict = place && !place.suburban ? place.districtName ?? place.placeDistrictName ?? undefined : undefined;
        }
        searchCall = customerSearchPreRead(intent, placeDistrict);
      }
    }
    const preReadCall = await customerPreReadWithoutShown(cheaperCall ?? searchCall, planningPrincipal);
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
    if (mediaExecution === "LIVE" && authenticatedInput && planningPrincipal.scope.channel !== "WEBSITE" && !leadOnly.enabled) {
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
      unlinked && ownPublicationFound && !mediaPerception ? "own_share_unlinked" : unlinked && !mediaPerception ? "foreign_share" : false);
    // Live words may be switched on for one channel first (CUSTOMER_AGENT_ANSWER_LIVE_CHANNELS); the trace records the mode of this turn.
    const answerMode = customerAgentAnswerMode(process.env, planningPrincipal.scope.channel);
    const brand = await readCustomerAgentBrand(planningPrincipal.scope.accountId);
    const result = await runCustomerAgentTurn({ surface: "dm", language, inputText: fullInput(), attachmentInput, mediaPerception,
      ...(brand ? { brand } : {}),
      knownPhoneSource, requestedFacts, revision: claim.pin.revision,
      approvedFileState, ...(followUp ? { followUp } : {}), ...(preReadCall ? { preReads: [preReadCall] } : {}),
      startedAt: claim.pin.receivedAt, operation: runtime.operation,
      // В режиме «только заявки» подборки нет вовсе: инструмент не предлагается модели (первый слой запрета).
      tools: customerAgentToolDefinitions([...CUSTOMER_AGENT_PUBLIC_TOOLS.filter(name => !leadOnly.enabled || name !== "search_public_properties"),
        ...mutations.availableToolNames]),
      verifiedContext: remembered.context, sayMode: customerAgentSayMode(), answerMode,
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
    traceCustomerCoreResult({ ...result, answerMode });
    if (result.status === "ready") { recordCustomerAgentSay(result.say); recordCustomerAgentAnswer(result.answer); }
    // The model's words beside the template, 72 h, for the owner to read before live (17.11.2026). Detached: never awaited,
    // a failed write goes to the error journal inside and the turn goes on.
    if (result.status === "ready" && result.answerSample && result.answer && result.answer.status !== "absent") {
      void recordCustomerAgentAnswerSample({ channel: planningPrincipal.scope.channel, conversationId: lane.ticket.conversationId,
        eventKey: claim.eventKey, answerMode, status: result.answer.status, reason: result.answer.status === "dropped" ? result.answer.reason : null,
        customerText: fullInput(), modelText: result.answerSample.modelText, templateText: result.answerSample.templateText }).catch(() => {});
    }
    // Count a spam turn (a foreign reel / like-exchange words with nothing asked) toward the mute. Never allowed to break the turn.
    if ((result.status === "ready" || result.status === "held" && result.reason === "foreign_share_no_reply") &&
        customerSpamTurn({ inputText: fullInput(), attachmentInput })) {
      await recordCustomerSpamTurn(lane.ticket.conversationId, { eventKey: claim.eventKey }).catch(error =>
        logSystemError("ai", `customer spam mute not recorded: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500), { dedupKey: "customer-spam-mute-write" }));
    }
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
    // Режим «только заявки»: «передать сотруднику» — это ответ клиенту и заявка, а не молчание. В WhatsApp ответ, который
    // состоял из одной просьбы номера (её погасил номер WhatsApp), — то же самое: модель хотела передать клиента агенту.
    // Только когда ответ опустел ИМЕННО из-за погашенной просьбы номера, как в старом пути (пятое ревью 13.11, №4): любой
    // другой пустой ответ остаётся обычным held, а не заявкой. Модель всё же позвала убранное действие (передача, звонок,
    // вопрос собственнику, показ) — тоже ответ режима, а не молчание (пятое ревью 13.11, №1).
    // Режим «только заявки» сюда не доходит (ход ведёт оператор выше), поэтому ответа режима «вместо модели» здесь больше нет.
    if (result.status !== "ready" || !result.text.trim() || result.decision.kind === "escalate") {
      const reason = result.status === "held" ? modelHeldReason ?? result.reason : "staff_or_supported_reply_required";
      // The customer wrote again while this turn ran: the NEWER input answers and carries these words (the same door as
      // `newer_input_pending` above; if that newer turn ends unanswered, resumeDeferredCustomerInbox re-arms). 16.11.2026.
      if (customerHeldForChangedContext(reason, result.status === "held" ? result.cause : undefined) &&
          await hasNewerCustomerInboxInput(claim.eventKey)) {
        await releaseHeldClaim(claim, NEWER_INPUT_PENDING);
        return { status: "held", reason: NEWER_INPUT_PENDING };
      }
      // Never silence (16.11.2026): nothing was written and the claim is still ours — one short verified line, and the
      // responsible person is told through the one door (follow_up). Planning failing keeps the old path below.
      if (customerSafetyLineAllowed(reason) && customerSafetyLineFits(reason, fullInput(), clientTalksBusiness, lastBotAsked()) &&
          mutations.committedReceipts.length === 0 && !(result.status === "held" && result.unknownToolCalls.length)) {
        const planned = await planSafetyLine(reason);
        if (planned) {
          // «Передать сотруднику»: the person still gets the customer's own words (review #205, С-3), as before this change.
          if (result.status === "ready" && result.decision.kind === "escalate") {
            await notifyEscalatedCustomerTurn({ conversationId: lane.ticket.conversationId, channel: lane.principal.scope.channel,
              text: fullInput(), jobTopic: remembered.context.publicState.topic === "job", answered: true,
              phoneKnown: lane.context.knownPhoneSource !== "none" && !safetyLineMadeLead });
          }
          return planned;
        }
      }
      await releaseHeldClaim(claim, reason);
      // The model handed the turn to staff and the customer gets no reply: a
      // person must learn about it (14.11.2026 — before, nobody was told).
      if (result.status === "ready" && result.decision.kind === "escalate") {
        await notifyEscalatedCustomerTurn({ conversationId: lane.ticket.conversationId, channel: lane.principal.scope.channel,
          text: fullInput(), jobTopic: remembered.context.publicState.topic === "job" });
      }
      return { status: "held", reason };
    }
    const principal = mutations.principal;
    const sealed = await sealDmCustomerAgentDeliveryEvidence({ principal, claim, serverWitnesses: witnesses, render: {
      decision: result.decision, evidence: result.evidence, language, requestedFacts,
      knownPhoneSource, text: result.text, verifiedContext: remembered.context, inputText: fullInput(),
      attachmentInput, approvedFileState,
      mediaPerception,
    } });
    if (sealed.status !== "sealed") {
      await releaseHeldClaim(claim, sealed.reason);
      return { status: "held", reason: sealed.reason };
    }
    // Второй слой запрета: ссылка или подборка всё же оказалась в ответе — вместо него короткий ответ «передаю агенту».
    // The same for «это скажет агент» / «агент позвонит» (live words or template): before a lead it is a promise nobody
    // keeps and a staff signal the owner forbade; the mode's hand-off asks for the phone or makes the lead instead.
    // A reply that carries a committed receipt is never replaced (its confirmation must reach the customer).
    // The repeat shield would cut this reply at send time (the same threshold as the transport): the customer would get
    // NOTHING (ФАКТ 11–15.11: 15 cut, 4 ended in silence). Say the hand-off line instead — only when the reply carries no
    // receipt or property delivery that a plain line must not replace (then the old behaviour stays). 16.11.2026.
    if (mutations.receipts.length === 0 && !result.evidence.some(e => ["receipt", "facts", "property_unresolved"].includes(e.value.kind)) &&
        // the same "does this input want an answer" filter as the held path (re-review #205, Н-2): no line on a bare «спасибо»
        customerSafetyLineFits("repeat_shield", fullInput(), clientTalksBusiness, lastBotAsked()) &&
        (await customerReplyRepeatBlocked(mutations.principal, [sealed.text])).has(sealed.text)) {
      const planned = await planSafetyLine("repeat_shield");
      if (planned) return planned;
    }
    /**
     * «БОТ ОТВЕЧАЕТ САМ» (ревью #283, блокер 2): ответ зовёт агента («это подскажет агент», «он позвонит», «передам
     * руководству» — ai/customerAgentStaffFollowUp.ts), а карточки нет и человека при ВКЛ не зовут — обещание повисло бы.
     * Без подтверждения действия и без фактов объекта ответ заменяется: номер известен — заявка агенту и «Передаю ваш
     * вопрос агенту…», номера нет — просьба номера (planSafetyLine). Ответ с фактами или подтверждением не заменяется —
     * тогда его обещание доходит до человека сигналом (staffRequired ниже).
     */
    const callsStaff = customerReplyCallsStaff(sealed.text);
    let staffRequired = false;
    if (callsStaff && !jobTopicTurn && await loadBotAnswersItself() && !(await customerConversationHasCard(lane.ticket.conversationId))) {
      if (mutations.receipts.length === 0 && !result.evidence.some(e => ["receipt", "facts", "property_unresolved"].includes(e.value.kind))) {
        const planned = await planSafetyLine(SELF_ANSWER_CALLS_STAFF);
        if (planned) return planned;
      }
      staffRequired = true;
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
      const policy = await loadCustomerAgentFeaturePolicy(mutations.principal.scope.channel);
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
    // «Передал ваш номер Нозе» is said only together with the vacancy owners' signal, in the same transaction (review #206 В3).
    const recruitmentAlert = (tx: Parameters<typeof enqueueRecruitmentCandidateAlertTx>[0]) => enqueueRecruitmentCandidateAlertTx(tx, {
      replyText: sealed.text, customerText: fullInput(), conversationId: principal.scope.conversationId,
      channel: principal.scope.channel, eventKey: claim.eventKey, peer: principal.scope.peer });
    try {
      partIds = await prisma.$transaction(async tx => {
        const ids = await createCustomerOutboxPartsTx(tx, { principal, agentClaim: claim,
          parts: [textPart, ...sidecars], receiptAuthorities: mutations.receiptAuthorities });
        await recruitmentAlert(tx);
        return ids;
      });
    } catch (error) {
      // The media attachment is optional to the already sealed text response.
      // If its witness/reservation becomes stale during the planning TX, retry
      // the same idempotent text plan alone. An intentional buyer-guide follow
      // instruction is part of textPart and remains guarded with its marker.
      if (!sidecars.length) throw error;
      partIds = await prisma.$transaction(async tx => {
        const ids = await createCustomerOutboxPartsTx(tx, { principal, agentClaim: claim,
          parts: [textPart], receiptAuthorities: mutations.receiptAuthorities });
        await recruitmentAlert(tx);
        return ids;
      });
    }
    // «Это скажет агент» / «агент позвонит» is only true if the responsible person learns about it now (15.11.2026): the one
    // door alertClientWaiting (assigned agent, else management), keyed by THIS customer message, not a 6 h window.
    // The reply is already planned; the signal never blocks it. The condition is the same pure check of the same sealed text
    // as `callsStaff` above, written as in main on purpose: tests/customer-bot-8-chats-15-11.test.ts pins this exact door call.
    if (customerReplyCallsStaff(sealed.text)) void signalStaffFollowUp(lane.ticket.conversationId, claim.pin.receivedAt, jobTopicTurn,
      lane.context.knownPhoneSource !== "none", staffRequired);
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
    // 14.11: BotTurnTrace did not keep the cause of 10 of 10 `turn_unavailable` turns (prod), so nobody could say WHY the bot dropped a turn.
    // Closed codes only (safeCauseCode), one journal line per reason+cause pair, never customer text.
    if (outcome.status === "held" && "reason" in outcome && heldCause && ["turn_unavailable", "customer_core_unavailable", "turn_deadline", "round_limit", "tool_limit"].includes(outcome.reason)) {
      void logSystemError("ai", `Ход бота клиента остановлен: ${outcome.reason} (${heldCause})`, { dedupKey: `customer-core-held:${outcome.reason}:${heldCause}`, quietPult: true });
    }
    // «Передать сотруднику» без оформленной передачи — клиенту тишина (аудит 14.11.2026, №4).
    // Сотруднику — сразу сигнал через одну дверь; остальные причины молчания ловит
    // сторож молчания через 30 минут. Ход не ждёт и из-за сигнала не падает.
    if (outcome.status === "held") {
      const reason = outcome.reason;
      void import("./clientWaitingAlert.js")
        .then(({ STAFF_NEEDED_NOW_REASONS, alertClientWaiting }) =>
          STAFF_NEEDED_NOW_REASONS.has(reason) ? alertClientWaiting({ conversationId: lane.ticket.conversationId, trigger: "escalate", jobTopic: jobTopicTurn }) : undefined)
        .catch(error => console.error("[client-waiting]", error instanceof Error ? error.message : "UnknownError"));
    }
    return outcome;
  });
}

/** Which of these texts the repeat shield would cut if the core sent them now as a reply to this customer — the same
 * key and threshold as the transport (messengers/meta.ts → admitOutbound with answersInbound). Read-only; a failure
 * blocks nothing (the shield must never become the reason for silence). Exported for the class test. */
export async function customerReplyRepeatBlocked(principal: CustomerAgentMutationSession["principal"], texts: readonly string[]): Promise<Set<string>> {
  try {
    const live = await revalidateCustomerPrincipal(principal);
    if (live.status !== "current") return new Set();
    const parsed = customerDeliveryTransportSchema.extend({ subscriberId: z.string() }).strict().safeParse(live.snapshot.transport);
    if (!parsed.success) return new Set();
    const { subscriberId: _peer, ...transport } = parsed.data;
    return new Set(await coreReplyRepeatBlocked(principal.scope.channel, principal.scope.peer, [...texts], transport));
  } catch {
    return new Set();
  }
}

/** Причина страховочной строки: ответ модели звал человека («агент подскажет / позвонит»), а бот отвечает сам (ревью #283, Б2). */
const SELF_ANSWER_CALLS_STAFF = "self_answer_calls_staff";

/** The chat already has a client card (a lead exists). A read failure counts as «has a card»: the old path (signal) is safer. */
async function customerConversationHasCard(conversationId: string | null | undefined): Promise<boolean> {
  if (!conversationId) return false;
  try {
    return !!(await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { clientId: true } }))?.clientId;
  } catch {
    return true;
  }
}

/** The follow-up signal of a reply that promised an agent (15.11.2026). Exported for the class test; never throws. */
export async function signalStaffFollowUp(conversationId: string, customerMessageAtMs: number, jobTopic = false,
  /** Номер клиента известен: при «бот отвечает сам» сигнал всё равно идёт (lib/botAnswersItself.ts, phoneKnown). */
  phoneKnown = false,
  /** Человека звать при любом положении «бот отвечает сам» (оператор: грубость, жалоба; обещание агента, оставшееся в ответе). */
  staffRequired = false,
  /** Оператор приёма заявок зовёт человека по жалобе или грубости: сигнал идёт и до заявки (lib/clientWaitingAlert.ts). */
  staffReason?: OperatorStaffReason): Promise<"agent" | "director" | "already" | "skipped"> {
  try {
    const { alertClientWaiting } = await import("./clientWaitingAlert.js");
    const outcome = await alertClientWaiting({ conversationId, trigger: "follow_up", since: new Date(customerMessageAtMs), jobTopic,
      ...(phoneKnown ? { phoneKnown: true } : {}), ...(staffRequired ? { staffRequired: true } : {}), ...(staffReason ? { staffReason } : {}) });
    // Meta keeps its four outcomes (review 0e463b02 N5 is the channel door's); «бот отвечает сам» (`self`) — никого не звали.
    return outcome === "excluded" || outcome === "self" ? "skipped" : outcome;
  } catch (error) {
    console.error("[client-waiting]", error instanceof Error ? error.message : "UnknownError");
    return "skipped";
  }
}

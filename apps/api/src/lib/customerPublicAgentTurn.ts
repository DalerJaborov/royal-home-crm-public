import { readCustomerPublicSourceExecution } from "./customerAgentEnrollment.js";
import { customerPublicModerationPlan } from "./customerPublicModerationPolicy.js";
import { finishUnsentPublicAgentFailure } from "./customerPublicAgentFailure.js";
// Common core public adapter: source-specific authority stays in this closure.
// No direct sender or legacy funnel dependency.
import { isDeepStrictEqual } from 'node:util';
import { prisma } from '../db.js';
import { loadPeerAiBudget, spendAiTurns } from './aiDailyBudget.js';
import { runCustomerAgentTurn, type CustomerAgentAwaitContext } from '../ai/customerAgentCore.js';
import type { CustomerAgentEvidence } from '../ai/customerAgentRenderer.js';
import { customerAgentToolDefinitions, CUSTOMER_AGENT_PUBLIC_TOOLS } from '../ai/customerAgentToolDefinitions.js';
import { customerPublicLanguage } from '../ai/customerAgentConversationPolicy.js';
import { classifyCustomerPropertyFactIntent } from './customerPropertyFactIntent.js';
import { loadPublicCommentPrincipal, inspectPublicCommentPrincipal, revalidatePublicCommentPrincipal,
  readPublicCommentFacts, type PublicCommentPrincipal } from './publicCommentSourceIssuer.js';
import { readPublicSourceRow, publicCommentOrigin, lockPublicCommentSourceTx } from './customerPublicCommentStore.js';
import { publicCommentHasAutomaticAttempt, type PublicCommentReadWitness } from './customerPublicDelivery.js';
import { decodeCustomerAgentRevision } from './customerAgentRevision.js';
import { openPinnedCustomerAgentRuntime } from './customerAgentRuntime.js';
import { PUBLIC_AGENCY_CONTACT } from './publicAgencyContact.js';
import { customerAgentPublicDataCurrent } from './customerAgentPublicReads.js';
import { readPublicCustomerAgentDataWitness, sealPublicCustomerAgentDeliveryEvidence,
  type CustomerAgentDataReadWitness, type CustomerAgentDeliveryWitness } from './customerAgentDeliveryEvidence.js';
import type { PublicSourceRef } from '@royal-home/shared';
import { withBotTurnTrace, traceCustomerManagedBinding, traceCustomerCoreResult, traceCustomerCoreDisposition } from './botTurnTrace.js';
import { readCustomerPublicationCatalog } from './customerPublicationCatalog.js';
import { loadCustomerPublicThreadContext } from './customerPublicThreadContext.js';
import { readCustomerPublicPublicationSource } from './customerPublicPublicationSource.js';

export type CustomerPublicAgentDraft =
  | { status: 'moderate'; principal: PublicCommentPrincipal }
  | { status: 'readyDraft'; principal: PublicCommentPrincipal; text: string; agentRevisionId: string;
      factsReadWitness?: PublicCommentReadWitness; publicDataWitness?: CustomerAgentDeliveryWitness }
  | { status: 'skip'; reason: 'no_reply_needed' | 'duplicate' | 'unsupported'; principal: PublicCommentPrincipal }
  | { status: 'moderation_proposal'; action: 'hide' | 'delete'; reason: 'spam' | 'abuse'; principal: PublicCommentPrincipal }
  | { status: 'held'; reason: string; principal?: PublicCommentPrincipal };

/** Existing queue worker must already have won its actual WORKING CAS.
 * Produces a draft only: no Graph, DM, staff action, moderation or source finish.
 * A model JSON object never supplies a principal, resource or pin. */
export async function prepareCustomerPublicAgentDraft(ref: PublicSourceRef): Promise<CustomerPublicAgentDraft> {
  const loaded = await loadPublicCommentPrincipal(ref);
  if (loaded.status !== 'current') return loaded;
  const principal = loaded.value;
  const original = inspectPublicCommentPrincipal(principal);
  if (!original || original.status !== 'WORKING') return { status: 'held', reason: 'source_not_claimed' };
  if (original.settings.rolloutMode !== 'ACTIVE') return { status: 'held', reason: 'public_core_not_active' };
  // Issuers can recognize YT/TG; present managed sender is not bound yet.
  if (!['INSTAGRAM', 'FACEBOOK'].includes(original.target.channel)) {
    return { status: 'held', reason: 'managed_public_transport_unbound' };
  }
  return withBotTurnTrace({ channel: original.target.channel, account: original.currentInstallation!.id,
    peer: original.target.commentId, conversation: original.source.id,
    event: `${original.source.table}:${original.source.id}:${original.sourceRevision}`, source: 'internal', kind: 'text',
    managed: { surface: 'public_comment', phase: 'planning' } }, async () => {
    const outcome = await (async (): Promise<CustomerPublicAgentDraft> => {
  let runtime: Extract<Awaited<ReturnType<typeof openPinnedCustomerAgentRuntime>>, { status: 'ready' }>['runtime'] | undefined;
  try {
    const source = await readPublicSourceRow(principal.source);
    if (!source) return { status: 'held', reason: 'source_missing' };
    const origin = publicCommentOrigin(source);
    if (source.sourceRevision !== principal.sourceRevision || !isDeepStrictEqual(origin.proof, original.proof) ||
        !isDeepStrictEqual(origin.target, original.target)) return { status: 'held', reason: 'original_origin_changed' };
    const stored = await prisma.customerAgentRevision.findUnique({ where: { id: origin.agentPin.agentRevisionId } });
    if (!stored) return { status: 'held', reason: 'original_revision_missing' };
    const revision = decodeCustomerAgentRevision(stored);
    // Deterministic old policy takes precedence over model prose. The effect
    // executor separately verifies current compiled artifacts and its own claim.
    if (customerPublicModerationPlan(original.text)) return { status: 'moderate', principal };
    traceCustomerManagedBinding({ revisionId: revision.id, operationId: origin.agentPin.providerOperationId });
    // Explicit presentation preference fixed by this Meta adapter, never model routing.
    const linkPreference = 'social' as const;
    let accumulated: readonly CustomerAgentEvidence[] = [];
    const dataWitnesses: CustomerAgentDataReadWitness[] = [];
    let peerTurnSpent = false;
    const current = async (wait: CustomerAgentAwaitContext): Promise<boolean> => {
      if (wait.signal.aborted || Date.now() >= Math.min(wait.deadlineAt, origin.agentPin.providerDeadlineAt)) return false;
      if ((await revalidatePublicCommentPrincipal(principal)).status !== 'current') return false;
      if (await publicCommentHasAutomaticAttempt(principal.source)) return false;
      for (const entry of accumulated) {
        if (entry.value.kind === 'facts') {
          const fresh = await readPublicCommentFacts(principal);
          if (fresh.status !== 'current' || !fresh.value || fresh.value.propertyId !== entry.value.facts.propertyId ||
              fresh.value.signature !== entry.value.facts.signature) return false;
        } else if (entry.value.kind === 'company_policy' || entry.value.kind === 'property_search' || entry.value.kind === 'publication_properties' || entry.value.kind === 'company_information') {
          if (!await customerAgentPublicDataCurrent(entry.value, { linkPreference,
              knowledgeSourceHash: revision.knowledgeSourceHash })) return false;
        }
      }
      return !wait.signal.aborted && Date.now() < Math.min(wait.deadlineAt, origin.agentPin.providerDeadlineAt) &&
        (await revalidatePublicCommentPrincipal(principal)).status === 'current';
    };
    const opened = await openPinnedCustomerAgentRuntime({ revision,
      providerOperationId: origin.agentPin.providerOperationId, originalReceivedAt: origin.originalReceivedAt,
      providerDeadlineAt: origin.agentPin.providerDeadlineAt, assertCurrent: current });
    if (opened.status !== 'ready') return opened;
    runtime = opened.runtime;
    const language = customerPublicLanguage(original.text);
    let catalog = original.target.channel === 'INSTAGRAM' || original.target.channel === 'FACEBOOK'
      ? await readCustomerPublicationCatalog({ channel: original.target.channel, resourceId: original.target.accountExternalId,
        publicationId: original.target.publicationId }) : null;
    // Purpose hint for an optional read only; it cannot choose a property,
    // rewrite the reply, infer consent or authorize any business mutation.
    if (!catalog && (classifyCustomerPropertyFactIntent(original.text, { hasPropertyContext: true }) ||
        /квартир|объект|вариант|варият|подроб|муфассал|цен|нарх|дешев|арзон|адрес|шаҳр|шахр|хона/iu.test(original.text))) {
      const publication = await readCustomerPublicPublicationSource(principal, { deadlineAt: origin.agentPin.providerDeadlineAt,
        signal: runtime.operation.signal });
      if (publication) catalog = await readCustomerPublicationCatalog(publication);
    }
    const verifiedContext = await loadCustomerPublicThreadContext(principal, revision);
    const requestedFacts = classifyCustomerPropertyFactIntent(original.text, { hasPropertyContext: !!catalog }) ?? [];
    const result = await runCustomerAgentTurn({ surface: 'public_comment', language, inputText: original.text,
      knownPhoneSource: 'none', requestedFacts, revision, startedAt: origin.originalReceivedAt,
      operation: runtime.operation, tools: customerAgentToolDefinitions(CUSTOMER_AGENT_PUBLIC_TOOLS),
      verifiedContext,
      ...(catalog ? { publicationCardCount: catalog.ids.length } : {}),
    }, {
      assertCurrent: async (evidence, wait) => { accumulated = evidence; return current(wait); },
      modelTurn: async input => {
        if (!peerTurnSpent) {
          // One legacy peer spend per bounded CUSTOMER turn, not per internal
          // tool round/provider retry. P13 separately budgets every paid attempt.
          if (!await current(input.wait)) throw new Error('Original public context changed');
          const peer = await loadPeerAiBudget(`${original.target.channel}_COMMENTS`, source.authorId, null);
          const freshSource = await readPublicSourceRow(principal.source);
          if (peer.budget.turnsLeft <= 0 || !freshSource || freshSource.authorId !== source.authorId ||
              freshSource.sourceRevision !== original.sourceRevision || !await current(input.wait)) {
            throw new Error('Public peer budget or original source unavailable');
          }
          await spendAiTurns(peer.row.id, peer.budget.dayKey, 1, 'peer');
          peerTurnSpent = true;
          if (!await current(input.wait)) throw new Error('Original public context changed');
        }
        return runtime!.modelTurn(input);
      },
      executeAllowedTool: async (call, { wait }) => {
        if (!await current(wait)) return { status: 'denied', reason: 'original_source_changed' };
        if (call.name === 'get_property_facts') {
          const publication = await readPublicCustomerAgentDataWitness({ principal, call, linkPreference });
          if (!await current(wait)) return { status: 'denied', reason: 'original_source_changed' };
          if (publication.status === 'observed') {
            dataWitnesses.push(publication.serverWitness);
            return { status: 'observed', observation: publication.observation };
          }
          // A failed permalink/catalog combination must not silently discard
          // that conflicting evidence and adopt a different bare-ID mapping.
          if (publication.status === 'unavailable' && publication.reason === 'publication_unresolved')
            return { status: 'observed', observation: { kind: 'property_unresolved', status: 'missing' } };
          return publication;
        }
        if (call.name === 'get_agency_contact') return { status: 'observed', observation: {
          kind: 'agency_contact', contact: { phone: PUBLIC_AGENCY_CONTACT.phone,
            digits: PUBLIC_AGENCY_CONTACT.digits, channel: 'telephone' } } };
        if (call.name === 'get_company_policy' || call.name === 'search_public_properties' || call.name === 'get_company_information') {
          const read = await readPublicCustomerAgentDataWitness({ principal, call, linkPreference });
          if (!await current(wait)) return { status: 'denied', reason: 'original_source_changed' };
          if (read.status === 'observed') {
            dataWitnesses.push(read.serverWitness);
            return { status: 'observed', observation: read.observation };
          }
          return read;
        }
        return { status: 'denied', reason: 'public_tool_denied' };
      },
      requestStop: () => runtime!.stop(),
      observeLateToolResult: () => {}, // Read-only tools: cannot replay or mutate anything.
    });
    traceCustomerCoreResult(result);
    if (result.status !== 'ready') return { status: 'held', reason: result.reason };
    if (result.decision.kind === 'skip') return { status: 'skip', reason: result.decision.reason, principal };
    if (result.decision.kind === 'escalate') return { status: 'held', reason: 'staff_review_required', principal };
    if (result.decision.kind === 'moderation_proposal') return {
      status: 'moderation_proposal', action: result.decision.action, reason: result.decision.reason, principal };
    if (result.decision.kind === 'propose') return { status: 'held', reason: 'public_proposal_not_supported' };
    const sealed = await sealPublicCustomerAgentDeliveryEvidence({ principal, linkPreference,
      render: { decision: result.decision, evidence: result.evidence, text: result.text, language,
        requestedFacts, knownPhoneSource: 'none', inputText: original.text, verifiedContext }, serverWitnesses: dataWitnesses });
    if (sealed.status !== 'sealed') return sealed;
    const selected = new Set(result.decision.refs);
    // Mirror renderer mandatory facts: the model cannot omit the freshness witness by omitting refs.
    const factEntries = result.evidence.filter(entry => entry.value.kind === 'facts' &&
      (requestedFacts.length > 0 || selected.has(entry.ref)));
    // Existing public facts reader has one exact publication target; never choose an arbitrary model UUID.
    const fact = factEntries[0]?.value;
    if (factEntries.some(entry => entry.value.kind !== 'facts' || fact?.kind !== 'facts' ||
        entry.value.facts.signature !== fact.facts.signature || entry.value.facts.propertyId !== fact.facts.propertyId)) {
      return { status: 'held', reason: 'public_facts_target_conflict' };
    }
    if (!sealed.text.trim()) return { status: 'held', reason: 'empty_public_draft' };
    return { status: 'readyDraft', principal, text: sealed.text, agentRevisionId: revision.id,
      ...(fact?.kind === 'facts' ? { factsReadWitness: { facts: fact.facts } } : {}),
      ...(sealed.witness ? { publicDataWitness: sealed.witness } : {}) };
  } catch {
    return { status: 'held', reason: 'public_core_unavailable' };
  } finally {
    // Original operation accounting only. No new origin, ordinal, grant or source status.
    if (runtime) { try { await runtime.close(); } catch { return { status: 'held', reason: 'provider_settlement_unavailable' }; } }
  }
    })();
    if (outcome.status === 'held') {
      traceCustomerCoreDisposition('held', outcome.reason);
      await finishUnsentPublicAgentFailure(ref, outcome.reason);
    }
    else if (outcome.status === 'skip') traceCustomerCoreDisposition('unchanged');
    return outcome; // A ready draft has not been planned or delivered.
  });
}

/** Fresh row/policy gate only. A retained managed origin never falls back to
 * legacy just because the current rollout was switched OFF. No new issuer. */
export async function publicAgentCommentLane(id: string): Promise<'legacy' | 'managed'> {
  const original = await readCustomerPublicSourceExecution(prisma, { table: 'meta', id });
  return original.lane === 'LEGACY' ? 'legacy' : 'managed'; // HELD cannot fall through.
}

/** Read/proposal outcome only. No Graph moderation. Existing source lock order
 * and genuine principal remain mandatory; stale source cannot be closed. */
export async function finishPublicAgentDecision(principal: PublicCommentPrincipal, decision:
  | { kind: 'skip'; reason: 'no_reply_needed' | 'duplicate' | 'unsupported' }
  | { kind: 'review'; reason: 'staff_review_required' | 'moderation_hide_spam' | 'moderation_hide_abuse' |
      'moderation_delete_spam' | 'moderation_delete_abuse' }): Promise<boolean> {
  const original = inspectPublicCommentPrincipal(principal);
  const notes = new Set(['no_reply_needed', 'duplicate', 'unsupported', 'staff_review_required',
    'moderation_hide_spam', 'moderation_hide_abuse', 'moderation_delete_spam', 'moderation_delete_abuse']);
  if (!original || original.source.table !== 'meta' || !notes.has(decision.reason) ||
      (await revalidatePublicCommentPrincipal(principal)).status !== 'current') return false;
  return prisma.$transaction(async tx => {
    const current = await lockPublicCommentSourceTx(tx, original.source);
    if (!current || current.status !== 'WORKING' || current.settings.rolloutMode !== 'ACTIVE' ||
        current.sourceRevision !== original.sourceRevision || current.text !== original.text ||
        !isDeepStrictEqual(current.target, original.target) || !isDeepStrictEqual(current.proof, original.proof) ||
        !isDeepStrictEqual(current.currentInstallation, original.currentInstallation) ||
        !isDeepStrictEqual(current.settings, original.settings)) return false;
    const [prior] = await tx.$queryRaw<Array<{ exists: boolean }>>`SELECT EXISTS(SELECT 1 FROM "CustomerOutboxPart"
      WHERE "sourceKind" IN ('PUBLIC_COMMENT_REPLY','STAFF_PUBLIC_COMMENT_REPLY')
      AND "sourceKey"=${`meta:${original.source.id}`}) AS exists`;
    if (prior?.exists) return false;
    const status = decision.kind === 'skip' ? 'SKIPPED' : 'ESCALATED';
    const count = await tx.$executeRaw`UPDATE "InstagramComment" SET "status"=${status},
      "note"=${`managed_core:${decision.reason}`},"updatedAt"=now()
      WHERE "id"=${original.source.id} AND "publicSourceRevision"=${BigInt(original.sourceRevision)}
      AND "status"='WORKING'`;
    return count === 1;
  });
}

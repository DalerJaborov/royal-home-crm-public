import { captureCustomerHandoverAckSourceTx, type CustomerHandoverAckSource } from "./customerHandoverAck.js";
import type { CustomerAgentClaim } from "./customerAgentClaim.js";
import { isDeepStrictEqual } from "node:util";
import { customerMutationCommandSchema, customerPropertyAdmissionSchema, type CustomerMutationCommand,
  type CustomerMutationReceipt, type CustomerPropertyAdmission } from "@royal-home/shared";
import { prisma } from "../db.js";
import type { CustomerAgentAwaitContext, CustomerAgentToolResult } from "../ai/customerAgentCore.js";
import { isCustomerPrincipal, customerPrincipalAuthenticatedInput, revalidateCustomerPrincipal, type CustomerPrincipal } from "./customerPrincipal.js";
import { inspectAuthenticatedCustomerInput, recoverAuthenticatedCustomerInput, type AuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { customerActionCapability, issueCustomerWriteAuthority, inspectCustomerWriteAuthority, type CustomerWriteAuthority } from "./customerState.js";
import { openAuthenticatedCustomerMutationIntent } from "./customerMutationIntent.js";
import { openAuthenticatedCustomerContactIntent } from "./customerContactIntent.js";
import { customerMutationDigest, customerMutationKind } from "./customerActionCommand.js";
import { executeCustomerAction, loadCustomerActionReceipt, reconcileCustomerAction } from "./customerActionJournal.js";
import { continueCustomerAgentAfterLocalAuthority } from "./customerAgentContinuation.js";
import { loadCustomerAgentFeaturePolicy } from "./customerAgentFeaturePolicy.js";

type SessionState = "current" | "held" | "unknown" | "handover_committed";
type WriteName = CustomerMutationCommand["name"];
const kinds = { save_contact: "contact", request_callback: "callback", request_handover: "handover", book_showing: "book_showing",
  reschedule_showing: "reschedule_showing", cancel_showing: "cancel_showing", ask_owner: "owner_question", save_job_application: "job_application" } as const;
export interface CustomerAgentMutationSession {
  readonly principal: CustomerPrincipal;
  readonly state: SessionState;
  readonly availableToolNames: readonly WriteName[];
  /** ONLY currently applicable customer ACK evidence, never arbitrary historical commits. */
  readonly receipts: readonly CustomerMutationReceipt[];
  readonly receiptAuthorities: readonly CustomerWriteAuthority[];
  /** Server-only audit/late-result records; no output permission, no IDs in model context. */
  readonly committedReceipts: readonly CustomerMutationReceipt[];
  /** Server-only pre-effect source; NOT a principal, write or receipt grant. */
  readonly handoverAckSource: CustomerHandoverAckSource | null;
  execute(command: unknown, wait: CustomerAgentAwaitContext): Promise<CustomerAgentToolResult>;
  assertCurrent(wait: CustomerAgentAwaitContext): Promise<boolean>;
}
function live(wait: CustomerAgentAwaitContext): boolean { return !wait.signal.aborted && Date.now() < wait.deadlineAt; }
function sameTicket(ticket: CustomerPropertyAdmission, principal: CustomerPrincipal): boolean {
  const a = principal.admission;
  return ticket.eventKey === a.eventKey && ticket.order === a.order && ticket.scopeKey === a.scopeKey && ticket.conversationId === a.conversationId &&
    ticket.channel === a.channel && ticket.accountId === a.accountId && ticket.endpointScopeId === a.endpointScopeId;
}
/** Root owns model/operation/turn claim/public reads/OUT. This adapter owns only
 * current genuine FINAL → intent → existing P06 journal → receipt continuation.
 * Session construction accepts no permission boolean or alternate principal factory. */
export async function createCustomerAgentMutationSession(raw: {
  principal: CustomerPrincipal; authenticatedInput: AuthenticatedCustomerInput; ticket: CustomerPropertyAdmission;
  agentClaim?: CustomerAgentClaim; handoverAckLanguage?: "ru" | "tg";
}): Promise<{ status: "ready"; session: CustomerAgentMutationSession } | { status: "held"; reason: string }> {
  try {
  const parsed = customerPropertyAdmissionSchema.safeParse(raw.ticket);
  if (!isCustomerPrincipal(raw.principal) || customerPrincipalAuthenticatedInput(raw.principal) !== raw.authenticatedInput ||
      !parsed.success || !sameTicket(parsed.data, raw.principal)) return { status: "held", reason: "genuine_original_input_required" };
  const original = raw.principal, ticket = structuredClone(parsed.data), initial = await revalidateCustomerPrincipal(original);
  if (initial.status !== "current") return { status: "held", reason: "original_context_changed" };
  const evidence = inspectAuthenticatedCustomerInput(raw.authenticatedInput);
  const recovered = await recoverAuthenticatedCustomerInput(ticket.eventKey);
  const recorded = await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey: ticket.eventKey }, select: { inputRecordedAt: true, processingState: true } });
  const durableEvidence = recovered.status === "recovered" ? inspectAuthenticatedCustomerInput(recovered.input) : null;
  if (recovered.status !== "recovered" || !sameTicket(recovered.ticket, original) || !recorded?.inputRecordedAt ||
      !["RECEIVED", "CLAIMED", "HELD"].includes(recorded.processingState ?? "") || !evidence || !durableEvidence ||
      evidence.issuedAt !== durableEvidence.issuedAt || evidence.inputText !== durableEvidence.inputText ||
      evidence.eventId !== durableEvidence.eventId || evidence.eventKind !== durableEvidence.eventKind) {
    return { status: "held", reason: "recorded_original_final_required" };
  }
  const strong = evidence?.provenance === "meta_signature" && evidence.assurance === "protected_namespace" &&
    evidence.protectedMetaEndpointScopeId === original.scope.endpointScopeId && evidence.protectedMetaAccountId === original.scope.accountId;
  // Website/PublicEnvelope may still use the core's PUBLIC reads. No write is
  // executed when the current receipt issuer cannot later authorize its ACK.
  const features = await loadCustomerAgentFeaturePolicy();
  const available = strong ? (Object.keys(kinds) as WriteName[]).filter(name =>
    customerActionCapability(initial.snapshot.state, kinds[name]) && (name !== "book_showing" || features.showings) &&
    (name !== "save_job_application" || features.vacancies && initial.snapshot.state.publicState.topic === "job" && !!initial.snapshot.state.publicState.jobPositionKey) &&
    !(name === "request_callback" && initial.snapshot.state.publicState.topic === "job")) : [];
  let principal = original, state: SessionState = "current", busy = false;
  let ackSource: CustomerHandoverAckSource | null = null;
  let applicable: CustomerMutationReceipt[] = [], authorities: CustomerWriteAuthority[] = [];
  const committed = new Map<string, CustomerMutationReceipt>(), seen = new Map<string, CustomerAgentToolResult>();
  function stop(next: SessionState): void { state = next; applicable = []; authorities = []; }
  function frame() { return customerPrincipalAuthenticatedInput(principal); }
  async function continueOver(authority: CustomerWriteAuthority): Promise<boolean> {
    const next = await continueCustomerAgentAfterLocalAuthority(original, authority);
    if (next.status !== "current" || !sameTicket(ticket, next.principal)) return false;
    principal = next.principal; return true;
  }
  async function receiptGrant(receipt: CustomerMutationReceipt): Promise<CustomerWriteAuthority | null> {
    const input = frame(); if (!input || receipt.kind === "new_lead") return null;
    const authority = await issueCustomerWriteAuthority(input, ticket, receipt.kind, prisma, "receipt");
    const grant = authority && inspectCustomerWriteAuthority(authority);
    if (!authority || !grant || grant.generation !== receipt.generation || grant.fence.inquiryId !== receipt.inquiryId) return null;
    const checked = await loadCustomerActionReceipt(authority, receipt.actionId);
    return checked.status === "already_committed" && isDeepStrictEqual(checked.receipt, receipt) ? authority : null;
  }
  async function assertCurrent(wait: CustomerAgentAwaitContext): Promise<boolean> {
    if (state !== "current") return false;
    if (!live(wait) || (await revalidateCustomerPrincipal(principal)).status !== "current") { stop("held"); return false; }
    const nextReceipts: CustomerMutationReceipt[] = [], nextAuthorities: CustomerWriteAuthority[] = [];
    for (const receipt of committed.values()) {
      const authority = await receiptGrant(receipt);
      if (!authority || !live(wait)) { stop("held"); return false; }
      nextReceipts.push(receipt); nextAuthorities.push(authority);
    }
    if (!live(wait) || (await revalidateCustomerPrincipal(principal)).status !== "current") { stop("held"); return false; }
    applicable = nextReceipts; authorities = nextAuthorities; return true;
  }
  /** Read by the captured per-kind key, never a model actionID/Client lookup.
   * Finding a committed row is still not a customer receipt grant. */
  async function recover(authority: CustomerWriteAuthority): Promise<CustomerMutationReceipt | null> {
    const grant = inspectCustomerWriteAuthority(authority); if (!grant) return null;
    const [row] = await prisma.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "CustomerAction" WHERE "inquiryId"=${grant.fence.inquiryId}
      AND "kind"=${grant.kind} AND "generation"=${BigInt(grant.generation)} AND "status"='COMMITTED'`;
    if (!row) return null;
    const result = await reconcileCustomerAction(row.id);
    if (result.status !== "committed" || !result.current || !result.resourceActive || result.receipt.kind !== grant.kind ||
        result.receipt.inquiryId !== grant.fence.inquiryId || result.receipt.generation !== grant.generation) return null;
    return result.receipt;
  }
  async function acknowledge(receipt: CustomerMutationReceipt, authority: CustomerWriteAuthority, wait: CustomerAgentAwaitContext): Promise<CustomerAgentToolResult> {
    committed.set(receipt.actionId, structuredClone(receipt));
    if (receipt.kind === "handover") {
      // Actual P08 commit puts owner in HOLD with a NEW epoch/token. Existing
      // continuation/receipt issuers deliberately reject it; never revive BOT.
      stop("handover_committed"); return { status: "denied", reason: "handover_committed_ack_purpose_unavailable" };
    }
    if (!live(wait) || !await continueOver(authority)) {
      stop("held"); return { status: "denied", reason: "committed_receipt_not_acknowledgeable" };
    }
    const freshReceiptAuthority = await receiptGrant(receipt);
    if (!freshReceiptAuthority || !await continueOver(freshReceiptAuthority) || !await assertCurrent(wait)) {
      stop("held"); return { status: "denied", reason: "committed_receipt_not_acknowledgeable" };
    }
    return { status: "observed", observation: { kind: "receipt", outcome: receipt.outcome } };
  }
  const session: CustomerAgentMutationSession = Object.freeze({
    get principal() { return principal; }, get state() { return state; },
    get availableToolNames() { return state === "current" ? Object.freeze([...available]) : Object.freeze([] as WriteName[]); },
    get receipts() { return structuredClone(applicable); }, get receiptAuthorities() { return [...authorities]; },
    get committedReceipts() { return structuredClone([...committed.values()]); },
    get handoverAckSource() { return state === "handover_committed" ? ackSource : null; }, assertCurrent,
    async execute(rawCommand: unknown, wait: CustomerAgentAwaitContext): Promise<CustomerAgentToolResult> {
      if (state === "unknown") return { status: "unknown", reason: "prior_commit_unconfirmed_no_replay" };
      if (state !== "current" || busy) return { status: "denied", reason: "mutation_session_not_current" };
      const parsedCommand = customerMutationCommandSchema.safeParse(rawCommand);
      if (!parsedCommand.success || !available.includes(parsedCommand.data.name)) return { status: "denied", reason: "unsupported_mutation" };
      busy = true;
      const command = parsedCommand.data, digest = customerMutationDigest(command), kind = customerMutationKind(command);
      try {
        if (!await assertCurrent(wait)) { stop("held"); return { status: "denied", reason: "original_context_changed" }; }
        if (command.name === "book_showing" && !(await loadCustomerAgentFeaturePolicy()).showings) return { status: "denied", reason: "showings_disabled" };
        const cached = seen.get(digest); if (cached) return structuredClone(cached);
        const input = frame(); if (!input) { stop("held"); return { status: "denied", reason: "original_frame_missing" }; }
        // Callback slot/consent was recorded by acceptAuthenticatedCustomerAdmission;
        // never re-run consent classification here to renew a generation/proof.
        const opened = kind === "callback" ? "opened" : kind === "contact"
          ? await openAuthenticatedCustomerContactIntent(input, ticket, command)
          : await openAuthenticatedCustomerMutationIntent(input, ticket, command);
        if (opened !== "opened") return { status: opened === "unavailable" ? "unavailable" : "denied", reason: "current_input_not_authorizing_command" };
        let authority = await issueCustomerWriteAuthority(input, ticket, kind);
        if (!authority) {
          // Same-event recovery may see an already committed slot. It can only
          // read its exact receipt; never create another generation or execute.
          authority = await issueCustomerWriteAuthority(input, ticket, kind, prisma, "receipt");
          if (!authority) return { status: "denied", reason: "write_authority_unavailable" };
          const existing = await recover(authority);
          if (existing) return await acknowledge(existing, authority, wait);
          stop("unknown"); return { status: "unknown", reason: "receipt_unconfirmed" };
        }
        if (!live(wait) || !await continueOver(authority) || !await assertCurrent(wait)) {
          stop("held"); return { status: "denied", reason: "intent_continuation_changed" };
        }
        // Kernel checks its own exact fence again under locks. Abort is not
        // rollback; a committed late result is retained below and never retried.
        const ackClaim = raw.agentClaim, ackLanguage = raw.handoverAckLanguage, ackAuthority = authority;
        if (kind === "handover" && ackClaim && ackLanguage) {
          try {
            ackSource = await prisma.$transaction(tx => captureCustomerHandoverAckSourceTx(tx, {
              principal, authority: ackAuthority, claim: ackClaim, language: ackLanguage,
            }));
          } catch {
            // Optional read-only ACK preparation must not suppress the legitimate
            // kernel action. No raw DB error, message, target or credential here.
            ackSource = null;
            try { console.warn("customer_handover_ack_capture_unavailable"); } catch { /* diagnostic is best effort */ }
          }
          // Capture may await beyond the original Core lifetime. Do not START a
          // new effect after abort/deadline or adopt a changed controller. The
          // second live check also covers cancellation during assertCurrent await.
          if (!live(wait) || !await assertCurrent(wait) || !live(wait)) {
            stop("held"); return { status: "denied", reason: "original_context_changed_before_execution" };
          }
        }
        const result = await executeCustomerAction(authority, command);
        if (result.status === "created" || result.status === "already_committed") {
          const answer = await acknowledge(result.receipt, authority, wait); seen.set(digest, answer); return answer;
        }
        if (result.status === "unknown") {
          const known = await recover(authority);
          if (known) { const answer = await acknowledge(known, authority, wait); seen.set(digest, answer); return answer; }
          stop("unknown"); return { status: "unknown", reason: "commit_unconfirmed_no_replay" };
        }
        if (result.status === "needs_input") return { status: "denied", reason: "phone_required" };
        if (result.status === "stale") stop("held");
        return { status: result.status === "unavailable" ? "unavailable" : "denied", reason: result.status === "needs_review" ? "human_review_required" : "mutation_not_permitted" };
      } catch {
        // Any error after entering execution may have lost a commit ACK. Do
        // not blindly execute again, fabricate a receipt or discard the journal.
        stop("unknown"); return { status: "unknown", reason: "mutation_result_unconfirmed_no_replay" };
      } finally { busy = false; }
    },
  });
  return { status: "ready", session };
  } catch { return { status: "held", reason: "mutation_session_unavailable" }; }
}

import { randomUUID } from "node:crypto";
import {
  customerActionIntentsSchema, customerClaimedContactSchema, customerMutationCommandSchema,
  customerMutationReceiptSchema, type CustomerMutationCommand, type CustomerMutationReceipt,
  type CustomerMutationResult, type CustomerFence, type CustomerPropertyAdmission, type CustomerActionKind,
} from "@royal-home/shared";
import { Prisma } from "../generated/prisma/client.js";
import { prisma, type TxClient } from "../db.js";
import { extractAllPhones, normalizeDigits } from "../ai/leadQualifier.js";
import { customerCallbackConsentDecision, isCustomerCallbackAffirmative } from "./customerCallbackConsent.js";
import { acceptedCallbackQuestionCurrentTx } from "./customerAcceptedCallbackQuestion.js";
import { stripUntrusted } from "../ai/untrustedContent.js";
import { isPublicAgencyPhone, isRetiredPublicAgencyPhone } from "./publicAgencyContact.js";
import { customerPropertyEventKey, customerPropertyScopeKey } from "./customerPropertyScope.js";
import { authenticatedInputMatchesFence, inspectAuthenticatedCustomerInput, type AuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { assertCustomerFence, inspectCustomerWriteAuthority, loadCustomerStateSnapshot,
  transitionCustomerState, loadAcceptedCustomerState, customerActionCapability, type CustomerStateDb, type CustomerWriteAuthority } from "./customerState.js";
import { customerMutationKind, customerMutationDigest } from "./customerActionCommand.js";
import { prelockCustomerActionResource, applyCustomerActionResource, observeManagedCustomerResource } from "./customerActionEffects.js";
import { finalizeManagedHandoverHoldTx } from "./customerCallbackLifecycle.js";
import { currentInputAuthorizesCustomerCommand } from "./customerMutationIntent.js";

type ActionRow = { id: string; kind: CustomerActionKind | "new_lead"; generation: bigint; status: string;
  resourceType: string | null; resourceId: string | null; receiptVersion: number | null;
  publicRef: string | null; resourceRevision: bigint | null;
  committedAt: Date | null; supersededAt: Date | null; evidenceRefs: unknown };
type InquiryRow = { actionIntents: unknown; claimedContact: unknown; lastAcceptedEventKey: string | null;
  lastAcceptedOrder: bigint | null };

function receiptOf(row: ActionRow, inquiryId: string): CustomerMutationReceipt | null {
  const outcomes = { contact: "contact_saved", callback: "callback_requested", new_lead: "new_lead_created",
    handover: "handover_requested", book_showing: "showing_booked", reschedule_showing: "showing_rescheduled",
    cancel_showing: "showing_cancelled", owner_question: "owner_question_recorded" } as const;
  const result = customerMutationReceiptSchema.safeParse({ version: row.receiptVersion, actionId: row.id, inquiryId,
    kind: row.kind, generation: row.generation.toString(), outcome: outcomes[row.kind],
    ...(row.receiptVersion === 2 ? { publicRef: row.publicRef, resourceRevision: row.resourceRevision?.toString() } : {}),
    resourceType: row.resourceType, resourceId: row.resourceId, committedAt: row.committedAt?.toISOString() });
  return row.status === "COMMITTED" && !row.supersededAt && result.success ? result.data : null;
}

export type CustomerActionReconciliation =
  | { status: "committed"; receipt: CustomerMutationReceipt; current: boolean; resourceActive: boolean }
  | { status: "unknown"; reason: "journal_or_resource_unconfirmed" };

/** Trusted server/job-only recovery read. It is not a customer tool or receipt
 * authorization and never recreates/mutates a resource, even after a lost ACK. */
export async function reconcileCustomerAction(actionId: string): Promise<CustomerActionReconciliation> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actionId)) return { status: "unknown", reason: "journal_or_resource_unconfirmed" };
  try {
    const rows = await prisma.$queryRaw<(ActionRow & { inquiryId: string; closedAt: Date | null; actionIntents: unknown })[]>`
      SELECT a."id",a."inquiryId",a."kind",a."generation",a."status",a."resourceType",a."resourceId",a."receiptVersion",
        a."committedAt",a."supersededAt",a."evidenceRefs",a."publicRef",a."resourceRevision",i."closedAt",i."actionIntents"
      FROM "CustomerAction" a JOIN "CustomerInquiry" i ON i."id"=a."inquiryId" WHERE a."id"=${actionId}`;
    const row = rows[0];
    if (!row || row.status !== "COMMITTED") return { status: "unknown", reason: "journal_or_resource_unconfirmed" };
    // Superseded historical receipts remain immutable facts for reconciliation,
    // although they cannot acknowledge a newer/cancelled customer intent.
    const receipt = receiptOf({ ...row, supersededAt: null }, row.inquiryId);
    const intents = customerActionIntentsSchema.safeParse(row.actionIntents);
    const slot = intents.success ? intents.data[row.kind === "new_lead" ? "contact" : row.kind] : null;
    if (!receipt || !slot) return { status: "unknown", reason: "journal_or_resource_unconfirmed" };
    let resourceActive = row.closedAt === null;
    if (row.kind === "callback" || row.kind === "handover") {
      const resource = await prisma.callbackRequest.findUnique({ where: { id: receipt.resourceId }, select: { customerActionId: true, doneAt: true } });
      if (resource?.customerActionId !== row.id) return { status: "unknown", reason: "journal_or_resource_unconfirmed" };
      resourceActive = resource.doneAt === null;
    } else if (row.kind === "new_lead") {
      const resource = await prisma.client.findUnique({ where: { id: receipt.resourceId }, select: { id: true, deletedAt: true } });
      if (!resource) return { status: "unknown", reason: "journal_or_resource_unconfirmed" };
      resourceActive = resource.deletedAt === null;
    } else if (row.kind !== "contact") {
      const observation = await prisma.$transaction(tx => observeManagedCustomerResource(tx, receipt));
      if (observation === "missing") return { status: "unknown", reason: "journal_or_resource_unconfirmed" };
      resourceActive = observation === "active";
    }
    return { status: "committed", receipt, resourceActive,
      current: !row.closedAt && !row.supersededAt && slot.generation === row.generation.toString() && slot.status === "committed" };
  } catch { return { status: "unknown", reason: "journal_or_resource_unconfirmed" }; }
}
function sameOwnerBinding(left: CustomerFence, right: CustomerFence): boolean {
  return left.inquiryId === right.inquiryId && left.nativeId === right.nativeId && left.ownerToken === right.ownerToken &&
    left.ownershipEpoch === right.ownershipEpoch && left.bindingRevision === right.bindingRevision &&
    left.scopeRevision === right.scopeRevision && left.policyRevision === right.policyRevision &&
    JSON.stringify(left.endpoint) === JSON.stringify(right.endpoint);
}
function ownText(input: string): string { return stripUntrusted(input, ["document", "video", "crm_note"]).trim(); }
function normalizedPhone(value: string): string { return normalizeDigits(value.replace(/\D/g, "")); }
function contactPhoneAllowed(phone: string): boolean {
  const digits = phone.replace(/\D/g, "");
  return !isPublicAgencyPhone(digits) && !isRetiredPublicAgencyPhone(digits);
}
type ProtectedPhoneFrame = Pick<NonNullable<ReturnType<typeof inspectCustomerWriteAuthority>>,
  "fence" | "provenance" | "protectedMetaEndpointScopeId" | "protectedMetaAccountId">;
function protectedMetaEndpoint(grant: ProtectedPhoneFrame): boolean {
  // A signature accepted by ANY legacy configured app is insufficient. This
  // optional field is minted only by P07's exact target-account validator.
  return grant.provenance === "meta_signature" &&
    grant.protectedMetaEndpointScopeId === grant.fence.endpoint.endpointScopeId &&
    grant.protectedMetaAccountId === grant.fence.endpoint.accountId;
}
type ProtectedPhoneCandidate = { phone: string; source: "current_input" | "scoped_contact" };
async function protectedPhoneCandidate(db: CustomerStateDb, inquiry: InquiryRow, grant: ProtectedPhoneFrame,
  statedPhones: string[]): Promise<ProtectedPhoneCandidate | null> {
  if (statedPhones.length > 0) return statedPhones.length === 1 && contactPhoneAllowed(statedPhones[0])
    ? { phone: statedPhones[0], source: "current_input" } : null;
  // A signed Meta account/peer is an actual protected transport namespace.
  // Website application authentication proves the app, not a caller's chosen sid.
  if (!protectedMetaEndpoint(grant) || !["INSTAGRAM", "FACEBOOK", "WHATSAPP"].includes(grant.fence.endpoint.channel)) return null;
  const matchedAccountId = grant.protectedMetaAccountId;
  const contact = customerClaimedContactSchema.safeParse(inquiry.claimedContact);
  const intents = customerActionIntentsSchema.safeParse(inquiry.actionIntents);
  const contactIntent = intents.success ? intents.data.contact : null;
  const proof = contact.success ? contact.data.phoneEvidence : null;
  if (contact.success && contact.data.phone && proof && contactIntent?.status === "committed" &&
      contactIntent.generation === proof.contactRevision && contact.data.contactRevision === proof.contactRevision &&
      proof.provenance === "meta_signature" && proof.matchedAccountId === matchedAccountId && proof.scopeRevision === grant.fence.scopeRevision &&
      proof.nativeId === grant.fence.nativeId && JSON.stringify(proof.endpoint) === JSON.stringify(grant.fence.endpoint)) {
    const scopeKey = customerPropertyScopeKey(proof.endpoint.channel, proof.endpoint.peerId, proof.endpoint.accountId, proof.endpoint.endpointScopeId);
    const [evidence] = await db.$queryRaw<{ valid: boolean }[]>`SELECT EXISTS(SELECT 1 FROM "CustomerPropertyIngressTicket" t
      JOIN "CustomerAction" a ON a."inquiryId"=${grant.fence.inquiryId} AND a."kind"='contact'
        AND a."generation"=${BigInt(proof.contactRevision)} AND a."status"='COMMITTED'
        AND a."bindingRevision"=${BigInt(grant.fence.bindingRevision)}
        AND a."receiptVersion"=1 AND a."committedAt" IS NOT NULL
        AND a."supersededAt" IS NULL AND a."evidenceRefs" ? ${proof.eventKey}
        AND a."resourceType"='CustomerInquiry' AND a."resourceId"=${grant.fence.inquiryId}
      WHERE t."eventKey"=${proof.eventKey} AND t."order"=${BigInt(proof.order)}
        AND t."conversationId"=${proof.nativeId} AND t."scopeKey"=${scopeKey}
        AND t."endpointScopeId"=${grant.fence.endpoint.endpointScopeId}) AS valid`;
    if (evidence?.valid && contactPhoneAllowed(contact.data.phone)) return { phone: contact.data.phone, source: "scoped_contact" };
  }
  if (grant.fence.endpoint.channel === "WHATSAPP" && /^\d{7,15}$/.test(grant.fence.endpoint.peerId)) {
    const phone = normalizedPhone(grant.fence.endpoint.peerId);
    return contactPhoneAllowed(phone) ? { phone, source: "current_input" } : null;
  }
  return null;
}
async function callbackPhone(tx: TxClient, inquiry: InquiryRow, grant: ProtectedPhoneFrame,
  statedPhones: string[]): Promise<string | null> {
  return (await protectedPhoneCandidate(tx, inquiry, grant, statedPhones))?.phone ?? null;
}

export type ProtectedInquiryPhoneObservation =
  // current_input includes an exact strongly authenticated current WA envelope
  // whose sender is an allowed callback target; it is not private identity.
  | { status: "current"; knownPhoneSource: "none" | "current_input" | "scoped_contact" }
  | { status: "held"; reason: "input_or_ticket_unverified" | "accepted_frame_changed" | "state_or_namespace_changed" | "observation_unavailable" };

/** Server-only prompt availability, not a phone/private-identity projection or
 * write grant. current_input includes the genuinely verified current WA event
 * envelope (same target validation as callbackPhone), never a raw peer string.
 * The caller must revalidate its original principal after awaiting
 * this observation. Website/public-envelope literal current text is handled by
 * the caller separately; these namespaces cannot discover stored contact. */
export async function observeProtectedInquiryPhone(input: AuthenticatedCustomerInput, ticket: CustomerPropertyAdmission,
  db: CustomerStateDb = prisma): Promise<ProtectedInquiryPhoneObservation> {
  const evidence = inspectAuthenticatedCustomerInput(input);
  if (!evidence || evidence.channel !== ticket.channel) return { status: "held", reason: "input_or_ticket_unverified" };
  try {
    const current = await loadAcceptedCustomerState(ticket, db);
    if (!current || !authenticatedInputMatchesFence(input, current.fence)) return { status: "held", reason: "accepted_frame_changed" };
    const fence = current.fence;
    const scopeKey = customerPropertyScopeKey(evidence.channel, evidence.peer, fence.endpoint.accountId, fence.endpoint.endpointScopeId);
    const eventKey = customerPropertyEventKey(scopeKey, evidence.eventKind, evidence.eventId);
    if (evidence.peer !== fence.endpoint.peerId || ticket.scopeKey !== scopeKey || ticket.eventKey !== eventKey ||
        ticket.endpointScopeId !== fence.endpoint.endpointScopeId || ticket.accountId !== fence.endpoint.accountId) {
      return { status: "held", reason: "input_or_ticket_unverified" };
    }
    const rows = await db.$queryRaw<InquiryRow[]>`SELECT i."actionIntents",i."claimedContact",i."lastAcceptedEventKey",i."lastAcceptedOrder"
      FROM "CustomerInquiry" i JOIN "CustomerPropertyIngressTicket" t ON t."eventKey"=${eventKey}
      AND t."conversationId"=i."conversationId" AND t."order"=${BigInt(ticket.order)} AND t."scopeKey"=${scopeKey}
      AND t."endpointScopeId"=i."endpointScopeId" WHERE i."id"=${fence.inquiryId} AND i."closedAt" IS NULL`;
    const inquiry = rows[0];
    if (rows.length !== 1 || !inquiry || inquiry.lastAcceptedEventKey !== eventKey || inquiry.lastAcceptedOrder?.toString() !== ticket.order) {
      return { status: "held", reason: "accepted_frame_changed" };
    }
    const frame: ProtectedPhoneFrame = { fence, provenance: evidence.provenance,
      protectedMetaEndpointScopeId: evidence.protectedMetaEndpointScopeId, protectedMetaAccountId: evidence.protectedMetaAccountId };
    const protectedInput = evidence.assurance === "protected_namespace" && protectedMetaEndpoint(frame) &&
      evidence.issuerScopeRevision === fence.scopeRevision && evidence.issuerPolicyRevision === fence.policyRevision;
    const candidate = protectedInput ? await protectedPhoneCandidate(db, inquiry, frame, extractAllPhones(ownText(evidence.inputText))) : null;
    // No adoption of a newer state after a contact/journal/namespace await.
    const checked = await assertCustomerFence(db, fence, "public_read");
    if (checked.status !== "current" || !authenticatedInputMatchesFence(input, checked.snapshot.fence)) {
      return { status: "held", reason: "state_or_namespace_changed" };
    }
    return { status: "current", knownPhoneSource: candidate?.source ?? "none" };
  } catch {
    return { status: "held", reason: "observation_unavailable" };
  }
}

/** Required local queue persistence is part of the same resource/receipt tx.
 * This intentionally does not use the legacy best-effort enqueue facade. */
async function readAction(tx: TxClient, inquiryId: string, kind: string, generation: string): Promise<ActionRow | null> {
  const rows = await tx.$queryRaw<ActionRow[]>`SELECT "id","kind","generation","status","resourceType","resourceId",
    "receiptVersion","committedAt","supersededAt","evidenceRefs","publicRef","resourceRevision" FROM "CustomerAction"
    WHERE "inquiryId"=${inquiryId} AND "kind"=${kind} AND "generation"=${BigInt(generation)} FOR UPDATE`;
  return rows[0] ?? null;
}
async function observeCustomerReceiptResource(tx: TxClient, receipt: CustomerMutationReceipt): Promise<"active" | "inactive" | "missing"> {
  if (receipt.kind === "contact") return receipt.resourceId === receipt.inquiryId ? "active" : "missing";
  if (receipt.kind !== "callback") return observeManagedCustomerResource(tx, receipt);
  const rows = await tx.$queryRaw<{ doneAt: Date | null }[]>`SELECT "doneAt" FROM "CallbackRequest"
    WHERE "id"=${receipt.resourceId} AND "customerActionId"=${receipt.actionId} FOR SHARE`;
  return !rows[0] ? "missing" : rows[0].doneAt === null ? "active" : "inactive";
}

/** Only authenticated current-IN authority can reach this local-only executor.
 * No provider call, LLM, ARI, profile link or foreign Client resume occurs under locks. */
export async function executeCustomerAction(authority: CustomerWriteAuthority, rawCommand: CustomerMutationCommand): Promise<CustomerMutationResult> {
  const grant = inspectCustomerWriteAuthority(authority);
  const parsed = customerMutationCommandSchema.safeParse(rawCommand);
  if (!grant || !parsed.success || customerMutationKind(parsed.data) !== grant.kind) {
    return { status: "denied", reason: "write_authority_or_command" };
  }
  const command = parsed.data;
  if (grant.kind !== "contact" && grant.kind !== "callback" &&
      (!grant.commandDigest || grant.commandDigest !== customerMutationDigest(command) ||
       !currentInputAuthorizesCustomerCommand(grant.currentInputText, command))) return { status: "denied", reason: "approved_command_changed" };
  if (grant.purpose !== "execute") return { status: "denied", reason: "receipt_authority_cannot_mutate" };
  if (!["INSTAGRAM", "FACEBOOK", "WHATSAPP", "WEBSITE"].includes(grant.fence.endpoint.channel)) {
    return { status: "denied", reason: "transport_not_supported" };
  }
  if (grant.fence.endpoint.channel !== "WEBSITE" && !protectedMetaEndpoint(grant)) return { status: "denied", reason: "target_endpoint_not_verified" };
  const input = ownText(grant.currentInputText);
  const statedPhones = extractAllPhones(input);
  const phones = statedPhones.filter(contactPhoneAllowed);
  if (command.name === "save_contact" && ((command.args.phone && !phones.includes(normalizedPhone(command.args.phone))) ||
      (command.args.name && !input.normalize("NFKC").toLocaleLowerCase().includes(command.args.name.normalize("NFKC").toLocaleLowerCase())))) {
    return { status: "denied", reason: "slot_not_in_current_input" };
  }
  const callbackDecision = command.name === "request_callback" ? customerCallbackConsentDecision(input) : null;
  const questionAffirmative = command.name === "request_callback" && callbackDecision === "none" &&
    isCustomerCallbackAffirmative(input) && !!grant.callbackConsent?.acceptedQuestion;
  if (command.name === "request_callback" && callbackDecision !== "requested" && callbackDecision !== "continue_phone" && !questionAffirmative) {
    return { status: "denied", reason: "callback_not_requested" };
  }
  if (command.name === "request_callback" && callbackDecision === "continue_phone" && !protectedMetaEndpoint(grant)) {
    return { status: "denied", reason: "protected_callback_continuation_required" };
  }
  try {
    return await prisma.$transaction(async (tx): Promise<CustomerMutationResult> => {
      // Showing kernels share Client→native→scope→policy→Inquiry lock order
      // with the bridge. Preliminary origin reads never authorize a mutation.
      const prelock = await prelockCustomerActionResource(tx, grant, command);
      if (!prelock) return { status: "denied", reason: "owned_resource_required" };
      // Execution never adopts a newer canonical fence. Receipt recovery has
      // a separate authority purpose, including after our own earlier commit.
      const current = await loadCustomerStateSnapshot({ inquiryId: grant.fence.inquiryId }, tx);
      if (!current || !sameOwnerBinding(current.fence, grant.fence)) return { status: "stale", reason: "owner_or_binding_changed" };
      if (command.name === "request_callback" && current.publicState.topic === "job") return { status: "denied", reason: "job_application_route" };
      const fence = await assertCustomerFence(tx, grant.fence, "local_write");
      if (fence.status !== "current") return { status: fence.status, reason: fence.reason };
      const [inquiry] = await tx.$queryRaw<InquiryRow[]>`SELECT "actionIntents","claimedContact","lastAcceptedEventKey","lastAcceptedOrder"
        FROM "CustomerInquiry" WHERE "id"=${grant.fence.inquiryId} FOR UPDATE`;
      if (!inquiry) return { status: "denied", reason: "inquiry_missing" };
      const intents = customerActionIntentsSchema.safeParse(inquiry.actionIntents);
      const intent = intents.success ? intents.data[grant.kind] : null;
      if (!intent || intent.generation !== grant.generation || intent.status !== "open" || !intent.evidenceRefs.includes(grant.eventKey)) {
        return { status: "stale", reason: "intent_changed" };
      }
      if (inquiry.lastAcceptedEventKey !== grant.eventKey || inquiry.lastAcceptedOrder?.toString() !== grant.order ||
          !customerActionCapability(fence.snapshot, grant.kind) ||
          (grant.commandDigest !== undefined && intent.commandDigest !== grant.commandDigest)) {
        return { status: "stale", reason: "input_or_capability_changed" };
      }
      if (command.name === "request_callback") {
        const consent = grant.callbackConsent;
        const persisted = intents.success ? intents.data.callback?.consent : null;
        if (!consent || !persisted || JSON.stringify(consent) !== JSON.stringify(persisted) ||
            consent.nativeId !== grant.fence.nativeId || consent.endpointScopeId !== grant.fence.endpoint.endpointScopeId ||
            consent.accountId !== grant.fence.endpoint.accountId || consent.ownershipEpoch !== grant.fence.ownershipEpoch ||
            consent.bindingRevision !== grant.fence.bindingRevision || consent.scopeRevision !== grant.fence.scopeRevision ||
            consent.policyRevision !== grant.fence.policyRevision || consent.ownerToken !== grant.fence.ownerToken ||
            !intent.evidenceRefs.includes(consent.originalEventKey) ||
            (grant.fence.endpoint.channel === "WEBSITE" && (consent.originalEventKey !== grant.eventKey || consent.originalOrder !== grant.order))) {
          return { status: "stale", reason: "callback_consent_changed" };
        }
        if (consent.acceptedQuestion && !await acceptedCallbackQuestionCurrentTx(tx, grant.fence, consent,
          { eventKey: grant.eventKey, order: grant.order })) return { status: "stale", reason: "accepted_callback_question_changed" };
        const scopeKey = customerPropertyScopeKey(grant.fence.endpoint.channel, grant.fence.endpoint.peerId,
          grant.fence.endpoint.accountId, grant.fence.endpoint.endpointScopeId);
        const [originalConsent] = await tx.$queryRaw<{ valid: boolean }[]>`SELECT EXISTS(SELECT 1 FROM "CustomerPropertyIngressTicket"
          WHERE "eventKey"=${consent.originalEventKey} AND "order"=${BigInt(consent.originalOrder)}
            AND "conversationId"=${consent.nativeId} AND "scopeKey"=${scopeKey}
            AND "endpointScopeId"=${consent.endpointScopeId}) AS valid`;
        if (!originalConsent?.valid) return { status: "denied", reason: "callback_consent_not_admitted" };
      }
      const prior = await readAction(tx, grant.fence.inquiryId, grant.kind, grant.generation);
      if (prior) {
        // Never disclose/recover a receipt through an execute grant, even if
        // inconsistent legacy storage left the committed kind slot open.
        return prior.status === "COMMITTED" ? { status: "denied", reason: "committed_action_requires_receipt_authority" }
          : { status: "unknown", reason: "commit_unconfirmed" };
      }
      // Missing dial target is an incomplete request, not a committed callback.
      // Preserve the open consent generation without creating an action or job.
      const dialPhone = command.name === "request_callback" ? await callbackPhone(tx, inquiry, grant, statedPhones) : null;
      if (command.name === "request_callback" && !dialPhone) return { status: "needs_input", reason: "phone_required" };
      const actionId = randomUUID(); const now = new Date();
      await tx.$executeRaw(Prisma.sql`INSERT INTO "CustomerAction" ("id","inquiryId","kind","generation","status",
        "stateRevision","intentRevision","ownershipEpoch","bindingRevision","scopeRevision","policyRevision","evidenceRefs","updatedAt")
        VALUES (${actionId},${grant.fence.inquiryId},${grant.kind},${BigInt(grant.generation)},'EXECUTING',
          ${BigInt(grant.fence.stateRevision)},${BigInt(grant.fence.intentRevision)},${BigInt(grant.fence.ownershipEpoch)},
          ${BigInt(grant.fence.bindingRevision)},${BigInt(grant.fence.scopeRevision)},${BigInt(grant.fence.policyRevision)},
          ${JSON.stringify(intent.evidenceRefs)}::jsonb,${now})`);
      let resourceId = grant.fence.inquiryId;
      let resourceType: CustomerMutationReceipt["resourceType"] = "CustomerInquiry";
      let resourceRevision: string | undefined;
      if (command.name === "save_contact") {
        const priorContact = customerClaimedContactSchema.safeParse(inquiry.claimedContact);
        const contact = customerClaimedContactSchema.parse({ version: 1, provenance: "customer_stated",
          ...(priorContact.success ? { name: priorContact.data.name, phone: priorContact.data.phone, extraPhones: priorContact.data.extraPhones,
            phoneEvidence: priorContact.data.phoneEvidence } : {}),
          ...command.args, ...(command.args.phone ? { phone: normalizedPhone(command.args.phone) } : {}),
          ...(command.args.phone && grant.fence.nativeId ? { phoneEvidence: { endpoint: grant.fence.endpoint, nativeId: grant.fence.nativeId,
            eventKey: grant.eventKey, order: grant.order, contactRevision: grant.generation, provenance: grant.provenance,
            matchedAccountId: protectedMetaEndpoint(grant) ? grant.protectedMetaAccountId : null, scopeRevision: grant.fence.scopeRevision } } : {}),
          contactRevision: grant.generation,
          evidenceRefs: [...new Set([...(priorContact.success ? priorContact.data.evidenceRefs : []), ...intent.evidenceRefs])],
          submittedAt: now.toISOString() });
        await tx.$executeRaw(Prisma.sql`UPDATE "CustomerInquiry" SET "claimedContact"=${JSON.stringify(contact)}::jsonb WHERE "id"=${resourceId}`);
      } else {
        const effect = await applyCustomerActionResource(tx, grant, command, actionId, now, prelock, dialPhone);
        resourceId = effect.resourceId; resourceType = effect.resourceType; resourceRevision = effect.resourceRevision;
      }
      const snapshot = await loadCustomerStateSnapshot({ inquiryId: grant.fence.inquiryId }, tx);
      if (!snapshot) throw new Error("Customer mutation lost its native binding");
      const committedIntent = await transitionCustomerState(tx, snapshot.fence, { type: "intent_committed", kind: grant.kind, generation: grant.generation });
      if (committedIntent.status !== "applied" && committedIntent.status !== "same_event") throw new Error("Customer intent changed during local mutation");
      if (grant.kind === "handover") await finalizeManagedHandoverHoldTx(tx, { requestId: resourceId, expectedFence: committedIntent.snapshot.fence });
      await tx.$executeRaw`UPDATE "CustomerAction" SET "supersededAt"=${now} WHERE "inquiryId"=${grant.fence.inquiryId}
        AND "kind"=${grant.kind} AND "generation"<${BigInt(grant.generation)} AND "status"='COMMITTED' AND "supersededAt" IS NULL`;
      const receiptVersion = grant.kind === "contact" || grant.kind === "callback" ? 1 : 2;
      const publicRef = receiptVersion === 2 ? randomUUID() : null;
      await tx.$executeRaw`UPDATE "CustomerAction" SET "status"='COMMITTED',"resourceType"=${resourceType},"resourceId"=${resourceId},
        "receiptVersion"=${receiptVersion},"publicRef"=${publicRef},"resourceRevision"=${receiptVersion === 2 && resourceRevision ? BigInt(resourceRevision) : null},
        "committedAt"=${now},"updatedAt"=${now} WHERE "id"=${actionId}`;
      const saved = await readAction(tx, grant.fence.inquiryId, grant.kind, grant.generation);
      const receipt = saved && receiptOf(saved, grant.fence.inquiryId);
      if (!receipt) throw new Error("Customer mutation receipt was not persisted");
      if (grant.kind === "contact" && fence.snapshot.capabilities.newLeadBridge) {
        const row = await tx.customerInquiry.findUnique({ where: { id: grant.fence.inquiryId }, select: { claimedContact: true } });
        const contact = customerClaimedContactSchema.safeParse(row?.claimedContact);
        const [source] = await tx.$queryRaw<{ managed: boolean }[]>`SELECT EXISTS(
          SELECT 1 FROM "CustomerPropertyIngressTicket" t JOIN "CustomerAgentRolloutAssignment" a ON a."id"=t."rolloutAssignmentId"
          WHERE t."eventKey"=${grant.eventKey} AND t."agentRevisionId" IS NOT NULL AND a."lane"='CORE' AND a."surface"='dm'
            AND a."endpointScopeId"=${grant.fence.endpoint.endpointScopeId}
        ) AS managed`;
        if (source?.managed && contact.success && contact.data.name && contact.data.phone) await tx.backgroundJob.create({ data: {
          type: "customer-contact-intake", payload: { version: 1, actionId }, maxAttempts: 24,
          dedupeKey: `customer-contact-intake:${actionId}`,
        } });
      }
      return { status: "created", receipt };
    }, { maxWait: 3_000, timeout: 5_000 });
  } catch {
    // A dropped commit acknowledgement cannot be distinguished from rollback
    // here. Never overwrite a possible COMMITTED entry with UNKNOWN, or blind retry an external effect.
    return { status: "unknown", reason: "commit_unconfirmed" };
  }
}

/** Read/reconcile a known receipt with a fresh owner/binding/per-kind fence.
 * It never delegates to the legacy mutation path on unknown/missing results. */
export async function loadCustomerActionReceipt(authority: CustomerWriteAuthority, actionId: string): Promise<CustomerMutationResult> {
  const grant = inspectCustomerWriteAuthority(authority);
  if (!grant || grant.purpose !== "receipt" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actionId)) {
    return { status: "denied", reason: "write_authority_or_reference" };
  }
  if (!protectedMetaEndpoint(grant)) return { status: "denied", reason: "protected_receipt_endpoint_required" };
  try {
    return await prisma.$transaction(async (tx): Promise<CustomerMutationResult> => {
      const current = await loadCustomerStateSnapshot({ inquiryId: grant.fence.inquiryId }, tx);
      if (!current || !sameOwnerBinding(current.fence, grant.fence)) return { status: "stale", reason: "owner_or_binding_changed" };
      // This previously minted receipt grant also cannot adopt a newer IN.
      const fence = await assertCustomerFence(tx, grant.fence, "local_write");
      if (fence.status !== "current") return { status: fence.status, reason: fence.reason };
      const [inquiry] = await tx.$queryRaw<InquiryRow[]>`SELECT "actionIntents","claimedContact","lastAcceptedEventKey","lastAcceptedOrder"
        FROM "CustomerInquiry" WHERE "id"=${grant.fence.inquiryId} FOR UPDATE`;
      const intents = inquiry && customerActionIntentsSchema.safeParse(inquiry.actionIntents);
      const intent = intents?.success ? intents.data[grant.kind] : null;
      if (!intent || intent.status !== "committed" || intent.generation !== grant.generation || !intent.evidenceRefs.includes(grant.eventKey)) {
        return { status: "stale", reason: "intent_changed" };
      }
      if (inquiry.lastAcceptedEventKey !== grant.eventKey || inquiry.lastAcceptedOrder?.toString() !== grant.order) {
        return { status: "stale", reason: "input_changed" };
      }
      const row = await readAction(tx, grant.fence.inquiryId, grant.kind, grant.generation);
      const receipt = row?.id === actionId ? receiptOf(row, grant.fence.inquiryId) : null;
      if (!receipt) return { status: "unknown", reason: "commit_unconfirmed" };
      const resource = await observeCustomerReceiptResource(tx, receipt);
      if (resource === "missing") return { status: "unknown", reason: "commit_unconfirmed" };
      return resource === "inactive" ? { status: "needs_review", reason: "callback_no_longer_pending" } : { status: "already_committed", receipt };
    }, { maxWait: 3_000, timeout: 5_000 });
  } catch { return { status: "unknown", reason: "commit_unconfirmed" }; }
}

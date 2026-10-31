import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { customerActionIntentsSchema, customerClaimedContactSchema, customerMutationReceiptSchema,
  type CustomerMutationResult, type ClientSource } from "@royal-home/shared";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { createNewCustomerChannelLeadTx } from "../services/leads/intake.js";
import { customerIntakeContextSchema, type CustomerIntakeContext } from "./customerIntakeContext.js";
import { inspectCustomerWriteAuthority, loadCustomerStateSnapshot, loadAcceptedCustomerState, assertCustomerFence, type CustomerWriteAuthority, type CustomerWriteEvidence } from "./customerState.js";
import { isPublicAgencyPhone, isRetiredPublicAgencyPhone } from "./publicAgencyContact.js";
import { normalizeDigits } from "./shared/phoneText.js";
import { stripUntrusted } from "../ai/untrustedContent.js";
import { lockCustomerNative } from "./customerNativeLock.js";
import { recoverAuthenticatedCustomerInput, inspectAuthenticatedCustomerInput, authenticatedInputMatchesFence } from "./customerIngressAuthority.js";
import { decryptCustomerFinalOrigin } from "./customerOriginPayload.js";
import { customerAgentIntake } from "../ai/customerAgentIntake.js";
import { deriveOwnBuyerPreferences } from "./customerBuyerPreferences.js";
import { phoneSafeText } from "./clientPhone.js";
import { isWithinWorkingHours } from "./workingHours.js";

/** Internal, default-OFF bridge after an actual contact action. It cannot resume
 * a found Client or grant private phone ownership; no model descriptor exposes it. */
export async function executeNewOnlyCustomerLeadBridge(authority: CustomerWriteAuthority, rawContext: CustomerIntakeContext): Promise<CustomerMutationResult> {
  const grant = inspectCustomerWriteAuthority(authority); const parsed = customerIntakeContextSchema.safeParse(rawContext);
  if (!grant || grant.kind !== "contact" || !parsed.success || grant.purpose !== "execute") return { status: "denied", reason: "bridge_authority_or_context" };
  return executeBridge({ ...grant, contactEventKey: grant.eventKey }, parsed.data);
}

/** Durable follow-through AFTER the current turn finishes. Creating/linking the
 * new Client changes bindingRevision, so doing it inside the model turn would
 * revoke that turn's legitimate response. This observer never issues OUT or
 * revives an old turn: it needs the current signed IN and committed contact.
 * UNKNOWN send remains UNKNOWN, but cannot cause loss of a legitimate CRM lead. */
export async function createCustomerLeadAfterContactAction(actionId: string): Promise<CustomerMutationResult> {
  try {
    const source = await prisma.customerAction.findUnique({ where: { id: actionId } });
    if (!source || source.kind !== "contact" || source.status !== "COMMITTED" || source.supersededAt || !source.committedAt) {
      return { status: "denied", reason: "committed_contact_action_required" };
    }
    const inquiry = await prisma.customerInquiry.findUnique({ where: { id: source.inquiryId }, select: { lastAcceptedEventKey: true } });
    if (!inquiry?.lastAcceptedEventKey) return { status: "stale", reason: "current_input_missing" };
    const recovered = await recoverAuthenticatedCustomerInput(inquiry.lastAcceptedEventKey);
    if (recovered.status !== "recovered") return { status: "stale", reason: "original_input_unavailable" };
    const current = inspectAuthenticatedCustomerInput(recovered.input);
    const snapshot = await loadAcceptedCustomerState(recovered.ticket);
    if (!current || !snapshot || !snapshot.capabilities.newLeadBridge || snapshot.publicState.topic === "job" ||
        current.provenance !== "meta_signature" || current.assurance !== "protected_namespace" ||
        !current.verifierCredential || !authenticatedInputMatchesFence(recovered.input, snapshot.fence) ||
        snapshot.fence.inquiryId !== source.inquiryId || source.generation.toString() === "0" ||
        source.ownershipEpoch.toString() !== snapshot.fence.ownershipEpoch || source.bindingRevision.toString() !== snapshot.fence.bindingRevision ||
        source.scopeRevision.toString() !== snapshot.fence.scopeRevision) {
      return { status: "stale", reason: "current_intake_context_required" };
    }
    const ticket = await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey: recovered.ticket.eventKey },
      select: { processingState: true, leaseOwner: true, leaseUntil: true } });
    if (!ticket || !["PLANNED", "HELD", "FAILED"].includes(ticket.processingState ?? "") || ticket.leaseOwner || ticket.leaseUntil ||
        await prisma.customerOutboxPart.count({ where: { ticketEventKey: recovered.ticket.eventKey, OR: [
          { status: { in: ["READY", "IN_FLIGHT"] } }, { status: "ACCEPTED", projectionRecordedAt: null },
        ] } })) return { status: "unavailable", reason: "turn_not_settled" };
    const row = await prisma.customerInquiry.findUnique({ where: { id: snapshot.fence.inquiryId },
      select: { claimedContact: true, actionIntents: true } });
    const contact = customerClaimedContactSchema.safeParse(row?.claimedContact), intents = customerActionIntentsSchema.safeParse(row?.actionIntents);
    const intent = intents.success ? intents.data.contact : null;
    if (!contact.success || !contact.data.name || !contact.data.phone || !intent || intent.status !== "committed" ||
        contact.data.contactRevision !== intent.generation || intent.generation !== source.generation.toString()) return { status: "denied", reason: "complete_committed_contact_required" };
    const saved = await prisma.customerAction.findFirst({ where: { inquiryId: snapshot.fence.inquiryId, kind: "contact",
      generation: BigInt(intent.generation), status: "COMMITTED", resourceId: snapshot.fence.inquiryId,
      ownershipEpoch: BigInt(snapshot.fence.ownershipEpoch), bindingRevision: BigInt(snapshot.fence.bindingRevision),
      scopeRevision: BigInt(snapshot.fence.scopeRevision) }, select: { evidenceRefs: true } });
    const refs = Array.isArray(saved?.evidenceRefs) ? saved.evidenceRefs : [];
    const contactEventKey = intent.evidenceRefs.find(ref => refs.includes(ref));
    if (!contactEventKey) return { status: "denied", reason: "owned_contact_receipt_required" };
    const history = await prisma.customerPropertyIngressTicket.findMany({ where: {
      conversationId: recovered.ticket.conversationId, originalConversationId: recovered.ticket.conversationId,
      scopeKey: recovered.ticket.scopeKey, endpointScopeId: recovered.ticket.endpointScopeId,
      order: { lte: BigInt(recovered.ticket.order) }, tombstonedAt: null, originVersion: 1, inputRecordedAt: { not: null },
    }, select: { eventKey: true, order: true, payloadHash: true, originCiphertext: true }, orderBy: { order: "desc" }, take: 30 });
    const own: string[] = [];
    for (const item of history.reverse()) {
      try {
        if (!item.originCiphertext) continue;
        const original = decryptCustomerFinalOrigin(item.originCiphertext), f = original.input.acceptedFence;
        if (!f || original.eventKey !== item.eventKey || original.order !== item.order.toString() || original.payloadHash !== item.payloadHash ||
            original.scopeKey !== recovered.ticket.scopeKey || original.originalConversationId !== recovered.ticket.conversationId ||
            !isDeepStrictEqual(original.input.verifierCredential, current.verifierCredential) ||
            f.inquiryId !== snapshot.fence.inquiryId || f.ownerToken !== snapshot.fence.ownerToken ||
            f.ownershipEpoch !== snapshot.fence.ownershipEpoch || f.bindingRevision !== snapshot.fence.bindingRevision ||
            f.scopeRevision !== snapshot.fence.scopeRevision || f.policyRevision !== snapshot.fence.policyRevision ||
            !isDeepStrictEqual(f.endpoint, snapshot.fence.endpoint)) continue;
        const text = phoneSafeText(stripUntrusted(original.input.inputText, ["document", "video", "crm_note"]).trim(), false);
        if (text && text.length <= 1500) own.push(text);
      } catch { /* Invalid historical content is omitted, never made authoritative. */ }
    }
    const intake = customerAgentIntake(own.map(text => ({ role: "user" as const, text })));
    if (intake.role === "unknown" && own.some(text => /(?:ваканси|резюме|ҷойи\s+кор|ищу\s+работу)/iu.test(text))) {
      return { status: "denied", reason: "recruitment_intake_separate" };
    }
    let requirementsNotes = "";
    for (const text of [...own].reverse()) {
      if (requirementsNotes.length + text.length + 1 <= 4000) requirementsNotes = text + (requirementsNotes ? "\n" + requirementsNotes : "");
    }
    const baseContext: CustomerIntakeContext = { version: 1,
      kind: intake.role === "buyer" ? "BUYER" : intake.role === "seller" ? "SELLER" : "OTHER",
      deferAssignment: !(await isWithinWorkingHours()) };
    const context: CustomerIntakeContext = { ...(intake.role === "buyer" ? deriveOwnBuyerPreferences(own) : {}), ...baseContext };
    return executeBridge({ fence: snapshot.fence, generation: intent.generation, eventKey: recovered.ticket.eventKey,
      order: recovered.ticket.order, currentInputText: current.inputText, provenance: current.provenance,
      protectedMetaEndpointScopeId: current.protectedMetaEndpointScopeId, protectedMetaAccountId: current.protectedMetaAccountId,
      contactEventKey, completedContactActionId: source.id, requirementsNotes }, context); // Existing CRM distribution hours; no chat-owner handover.
  } catch { return { status: "unavailable", reason: "intake_read_unavailable" }; }
}

type BridgePlan = Pick<CustomerWriteEvidence, "fence" | "generation" | "eventKey" | "order" | "currentInputText" | "provenance" |
  "protectedMetaEndpointScopeId" | "protectedMetaAccountId"> & { contactEventKey: string; completedContactActionId?: string; requirementsNotes?: string };

/** Private plan is issued only by the actual write-authority adapter above or
 * the committed-contact observer above; it is never a model tool/JSON permission. */
async function executeBridge(grant: BridgePlan, context: CustomerIntakeContext): Promise<CustomerMutationResult> {
  if (!["INSTAGRAM", "FACEBOOK", "WHATSAPP", "WEBSITE"].includes(grant.fence.endpoint.channel)) return { status: "denied", reason: "transport_not_supported" };
  if (grant.fence.endpoint.channel !== "WEBSITE" && (grant.provenance !== "meta_signature" ||
      grant.protectedMetaEndpointScopeId !== grant.fence.endpoint.endpointScopeId ||
      grant.protectedMetaAccountId !== grant.fence.endpoint.accountId)) return { status: "denied", reason: "target_endpoint_not_verified" };
  let effectEntered = false;
  try {
    return await prisma.$transaction(async (tx): Promise<CustomerMutationResult> => {
      // Legacy Client UPDATE triggers lock Inquiry afterward. Take the broadest
      // required local write fence first, then native → Inquiry, never invert it.
      await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '500ms'`);
      await tx.$executeRaw(Prisma.sql`LOCK TABLE "Client" IN SHARE ROW EXCLUSIVE MODE`);
      if (!grant.fence.nativeId || !await lockCustomerNative(tx, { kind: "bot", id: grant.fence.nativeId })) {
        return { status: "stale", reason: "native_missing" };
      }
      const snapshot = await loadCustomerStateSnapshot({ inquiryId: grant.fence.inquiryId }, tx);
      if (!snapshot || snapshot.fence.nativeId !== grant.fence.nativeId || snapshot.fence.ownerToken !== grant.fence.ownerToken ||
          snapshot.fence.ownershipEpoch !== grant.fence.ownershipEpoch || snapshot.fence.bindingRevision !== grant.fence.bindingRevision ||
          snapshot.fence.scopeRevision !== grant.fence.scopeRevision || snapshot.fence.policyRevision !== grant.fence.policyRevision ||
          snapshot.fence.intentRevision !== grant.fence.intentRevision || !snapshot.capabilities.newLeadBridge) return { status: "stale", reason: "bridge_disabled_or_changed" };
      const checked = await assertCustomerFence(tx, snapshot.fence, "local_write");
      if (checked.status !== "current") return { status: checked.status, reason: checked.reason };
      const [inquiry] = await tx.$queryRaw<{ claimedContact: unknown; actionIntents: unknown; lastAcceptedEventKey: string | null; lastAcceptedOrder: bigint | null }[]>`
        SELECT "claimedContact","actionIntents","lastAcceptedEventKey","lastAcceptedOrder" FROM "CustomerInquiry" WHERE "id"=${grant.fence.inquiryId} FOR UPDATE`;
      const contact = customerClaimedContactSchema.safeParse(inquiry?.claimedContact);
      const intents = customerActionIntentsSchema.safeParse(inquiry?.actionIntents); const intent = intents.success ? intents.data.contact : null;
      if (!contact.success || !contact.data.name || !contact.data.phone || contact.data.contactRevision !== grant.generation ||
          !intent || intent.generation !== grant.generation || intent.status !== "committed" || !intent.evidenceRefs.includes(grant.contactEventKey)) return { status: "stale", reason: "contact_not_current" };
      if (inquiry.lastAcceptedEventKey !== grant.eventKey || inquiry.lastAcceptedOrder?.toString() !== grant.order) {
        return grant.completedContactActionId ? { status: "unavailable", reason: "turn_not_settled" } : { status: "stale", reason: "contact_not_current" };
      }
      const [savedContact] = await tx.$queryRaw<{ present: boolean }[]>`SELECT EXISTS(SELECT 1 FROM "CustomerAction" WHERE "inquiryId"=${grant.fence.inquiryId}
        AND "kind"='contact' AND "generation"=${BigInt(grant.generation)} AND "status"='COMMITTED' AND "resourceId"=${grant.fence.inquiryId}
        AND "evidenceRefs" @> ${JSON.stringify([grant.contactEventKey])}::jsonb) AS present`;
      if (!savedContact?.present) return { status: "denied", reason: "contact_receipt_missing" };
      if (grant.completedContactActionId) {
        const [proof] = await tx.$queryRaw<{ present: boolean }[]>`SELECT EXISTS(
          SELECT 1 FROM "CustomerPropertyIngressTicket" q JOIN "CustomerAction" a ON a."id"=${grant.completedContactActionId}
          WHERE q."eventKey"=${grant.eventKey} AND q."order"=${BigInt(grant.order)} AND q."conversationId"=${grant.fence.nativeId}
            AND q."tombstonedAt" IS NULL AND q."inputRecordedAt" IS NOT NULL AND q."originVersion"=1
            AND q."agentRevisionId" IS NOT NULL AND EXISTS(SELECT 1 FROM "CustomerAgentRolloutAssignment" r
              WHERE r."id"=q."rolloutAssignmentId" AND r."lane"='CORE' AND r."surface"='dm' AND r."endpointScopeId"=q."endpointScopeId")
            AND q."processingState" IN ('PLANNED','HELD','FAILED') AND q."leaseOwner" IS NULL AND q."leaseUntil" IS NULL
            AND a."inquiryId"=${grant.fence.inquiryId} AND a."kind"='contact' AND a."status"='COMMITTED'
            AND a."generation"=${BigInt(grant.generation)} AND a."supersededAt" IS NULL
            AND NOT EXISTS(SELECT 1 FROM "CustomerOutboxPart" p WHERE p."ticketEventKey"=q."eventKey"
              AND (p."status" IN ('READY','IN_FLIGHT') OR (p."status"='ACCEPTED' AND p."projectionRecordedAt" IS NULL)))
        ) AS present`;
        if (!proof?.present) return { status: "unavailable", reason: "turn_not_settled" };
      }
      const [existing] = await tx.$queryRaw<{ id: string; resourceId: string | null; committedAt: Date | null; status: string }[]>`
        SELECT "id","resourceId","committedAt","status" FROM "CustomerAction" WHERE "inquiryId"=${grant.fence.inquiryId}
          AND "kind"='new_lead' AND "generation"=${BigInt(grant.generation)} FOR UPDATE`;
      if (existing) {
        const receipt = customerMutationReceiptSchema.safeParse({ version: 1, actionId: existing.id, inquiryId: grant.fence.inquiryId,
          kind: "new_lead", generation: grant.generation, outcome: "new_lead_created", resourceType: "Client", resourceId: existing.resourceId,
          committedAt: existing.committedAt?.toISOString() });
        return existing.status === "COMMITTED" && receipt.success ? { status: "already_committed", receipt: receipt.data } : { status: "unknown", reason: "commit_unconfirmed" };
      }
      const [native] = await tx.$queryRaw<{ clientId: string | null }[]>`SELECT "clientId" FROM "BotConversation" WHERE "id"=${grant.fence.nativeId}
        AND "endpointScopeId"=${grant.fence.endpoint.endpointScopeId} AND "subscriberId"=${grant.fence.endpoint.peerId}
        AND "accountId" IS NOT DISTINCT FROM ${grant.fence.endpoint.accountId} FOR UPDATE`;
      if (!native || native.clientId) return { status: "needs_review", reason: "native_already_linked" };
      const phones = [contact.data.phone, ...contact.data.extraPhones];
      if (phones.some(phone => isPublicAgencyPhone(phone.replace(/\D/g, "")) || isRetiredPublicAgencyPhone(phone.replace(/\D/g, "")))) return { status: "denied", reason: "agency_phone" };
      const actionId = randomUUID(); const now = new Date();
      effectEntered = true; // before the first domain write; never retry an uncertain commit below
      await tx.$executeRaw(Prisma.sql`INSERT INTO "CustomerAction" ("id","inquiryId","kind","generation","status","stateRevision","intentRevision","ownershipEpoch","bindingRevision",
        "scopeRevision","policyRevision","evidenceRefs","policyResult","updatedAt") VALUES (${actionId},${grant.fence.inquiryId},'new_lead',${BigInt(grant.generation)},'EXECUTING',
        ${BigInt(snapshot.fence.stateRevision)},${BigInt(snapshot.fence.intentRevision)},${BigInt(snapshot.fence.ownershipEpoch)},${BigInt(snapshot.fence.bindingRevision)},
        ${BigInt(snapshot.fence.scopeRevision)},${BigInt(snapshot.fence.policyRevision)},${JSON.stringify(intent.evidenceRefs)}::jsonb,
        ${JSON.stringify({ intakeContext: context })}::jsonb,${now})`);
      const created = await createNewCustomerChannelLeadTx(tx, { ...context,
        fullName: contact.data.name, phone: contact.data.phone, extraPhones: contact.data.extraPhones,
        requirementsNotes: stripUntrusted(grant.requirementsNotes ?? grant.currentInputText, ["document", "video", "crm_note"]).trim().slice(0, 4000),
        source: grant.fence.endpoint.channel as ClientSource, channel: grant.fence.endpoint.channel,
        recipientId: grant.fence.endpoint.peerId, endpointScopeId: grant.fence.endpoint.endpointScopeId,
        ...(grant.fence.endpoint.channel === "WHATSAPP" && /^\d{7,15}$/.test(grant.fence.endpoint.peerId)
          ? { whatsappPhone: normalizeDigits(grant.fence.endpoint.peerId) } : {}),
        ...(context.requestedAgentId ? { requestedAgentNote: "Клиент назвал конкретного сотрудника" } : {}),
      }, actionId);
      if (created.status !== "created") {
        await tx.$executeRaw`UPDATE "CustomerAction" SET "status"='FAILED',"failureCode"=${created.reason} WHERE "id"=${actionId}`;
        return created;
      }
      const linked = await tx.botConversation.updateMany({ where: { id: grant.fence.nativeId!, endpointScopeId: grant.fence.endpoint.endpointScopeId,
        subscriberId: grant.fence.endpoint.peerId, accountId: grant.fence.endpoint.accountId, clientId: null }, data: { clientId: created.clientId } });
      if (linked.count !== 1) throw new Error("Customer new-only binding changed during commit");
      await tx.backgroundJob.create({ data: { type: "customer-intake-policy", payload: { version: 1, actionId }, maxAttempts: 5, dedupeKey: `customer-intake-policy:${actionId}` } });
      await tx.$executeRaw`UPDATE "CustomerAction" SET "status"='COMMITTED',"resourceType"='Client',"resourceId"=${created.clientId},"receiptVersion"=1,
        "committedAt"=${now},"updatedAt"=${now} WHERE "id"=${actionId}`;
      return { status: "created", receipt: customerMutationReceiptSchema.parse({ version: 1, actionId, inquiryId: grant.fence.inquiryId, kind: "new_lead", generation: grant.generation,
        outcome: "new_lead_created", resourceType: "Client", resourceId: created.clientId, committedAt: now.toISOString() }) };
    }, { maxWait: 3_000, timeout: 5_000 });
  } catch {
    return grant.completedContactActionId && !effectEntered ? { status: "unavailable", reason: "intake_read_unavailable" }
      : { status: "unknown", reason: "commit_unconfirmed" };
  }
}

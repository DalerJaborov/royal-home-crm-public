import { randomUUID } from "node:crypto";
import { customerActionIntentsSchema, customerClaimedContactSchema, customerMutationReceiptSchema,
  type CustomerMutationResult, type ClientSource } from "@royal-home/shared";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { createNewCustomerChannelLeadTx } from "../services/leads/intake.js";
import { customerIntakeContextSchema, type CustomerIntakeContext } from "./customerIntakeContext.js";
import { inspectCustomerWriteAuthority, loadCustomerStateSnapshot, assertCustomerFence, type CustomerWriteAuthority } from "./customerState.js";
import { isPublicAgencyPhone, isRetiredPublicAgencyPhone } from "./publicAgencyContact.js";
import { normalizeDigits } from "../ai/leadQualifier.js";
import { stripUntrusted } from "../ai/untrustedContent.js";
import { lockCustomerNative } from "./customerNativeLock.js";

/** Internal, default-OFF bridge after an actual contact action. It cannot resume
 * a found Client or grant private phone ownership; no model descriptor exposes it. */
export async function executeNewOnlyCustomerLeadBridge(authority: CustomerWriteAuthority, rawContext: CustomerIntakeContext): Promise<CustomerMutationResult> {
  const grant = inspectCustomerWriteAuthority(authority); const parsed = customerIntakeContextSchema.safeParse(rawContext);
  if (!grant || grant.kind !== "contact" || !parsed.success || grant.purpose !== "execute") return { status: "denied", reason: "bridge_authority_or_context" };
  if (!["INSTAGRAM", "FACEBOOK", "WHATSAPP", "WEBSITE"].includes(grant.fence.endpoint.channel)) return { status: "denied", reason: "transport_not_supported" };
  if (grant.fence.endpoint.channel !== "WEBSITE" && (grant.provenance !== "meta_signature" ||
      grant.protectedMetaEndpointScopeId !== grant.fence.endpoint.endpointScopeId ||
      grant.protectedMetaAccountId !== grant.fence.endpoint.accountId)) return { status: "denied", reason: "target_endpoint_not_verified" };
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
          !intent || intent.generation !== grant.generation || intent.status !== "committed" || !intent.evidenceRefs.includes(grant.eventKey) ||
          inquiry.lastAcceptedEventKey !== grant.eventKey || inquiry.lastAcceptedOrder?.toString() !== grant.order) return { status: "stale", reason: "contact_not_current" };
      const [savedContact] = await tx.$queryRaw<{ present: boolean }[]>`SELECT EXISTS(SELECT 1 FROM "CustomerAction" WHERE "inquiryId"=${grant.fence.inquiryId}
        AND "kind"='contact' AND "generation"=${BigInt(grant.generation)} AND "status"='COMMITTED' AND "resourceId"=${grant.fence.inquiryId}) AS present`;
      if (!savedContact?.present) return { status: "denied", reason: "contact_receipt_missing" };
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
      const context = parsed.data; const actionId = randomUUID(); const now = new Date();
      await tx.$executeRaw(Prisma.sql`INSERT INTO "CustomerAction" ("id","inquiryId","kind","generation","status","stateRevision","intentRevision","ownershipEpoch","bindingRevision",
        "scopeRevision","policyRevision","evidenceRefs","policyResult","updatedAt") VALUES (${actionId},${grant.fence.inquiryId},'new_lead',${BigInt(grant.generation)},'EXECUTING',
        ${BigInt(snapshot.fence.stateRevision)},${BigInt(snapshot.fence.intentRevision)},${BigInt(snapshot.fence.ownershipEpoch)},${BigInt(snapshot.fence.bindingRevision)},
        ${BigInt(snapshot.fence.scopeRevision)},${BigInt(snapshot.fence.policyRevision)},${JSON.stringify(intent.evidenceRefs)}::jsonb,
        ${JSON.stringify({ intakeContext: context })}::jsonb,${now})`);
      const created = await createNewCustomerChannelLeadTx(tx, { ...context,
        fullName: contact.data.name, phone: contact.data.phone, extraPhones: contact.data.extraPhones,
        requirementsNotes: stripUntrusted(grant.currentInputText, ["document", "video", "crm_note"]).trim().slice(0, 4000),
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
  } catch { return { status: "unknown", reason: "commit_unconfirmed" }; }
}

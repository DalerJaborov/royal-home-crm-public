import { customerClaimedContactSchema, customerRecruitmentPortfolioSchema, type CustomerRecruitmentPortfolio } from "@royal-home/shared";
import { Prisma } from "../generated/prisma/client.js";
import type { TxClient } from "../db.js";
import { loadCustomerStateSnapshot, inspectCustomerWriteAuthority } from "./customerState.js";
import { decryptCustomerIngressEnvelope } from "./customerIngressPayload.js";
import { readVerifiedCustomerFinalOrigin } from "./customerIngressAuthority.js";
import { privateFilePath } from "./privateFiles.js";

type Grant = NonNullable<ReturnType<typeof inspectCustomerWriteAuthority>>;
const portfolioSchema = customerRecruitmentPortfolioSchema;
const item = portfolioSchema.element;
type Portfolio = CustomerRecruitmentPortfolio;

/** Called inside the canonical journal transaction before inserting an action.
 * Shared locks retain the actual switch/opening until the effect commits. */
export async function customerRecruitmentIntakePermittedTx(tx: TxClient, grant: Grant): Promise<boolean> {
  const state = await loadCustomerStateSnapshot({ inquiryId: grant.fence.inquiryId }, tx);
  if (state?.publicState.topic !== "job" || !state.publicState.jobPositionKey) return false;
  const [enabled] = await tx.$queryRaw<Array<{ enabled: boolean }>>`SELECT "botCanHandleVacancies" AS enabled FROM "Settings" WHERE "id"='singleton' FOR SHARE`;
  const [opening] = await tx.$queryRaw<Array<{ isOpen: boolean }>>`SELECT "isOpen" FROM "RecruitmentPosition" WHERE "key"=${state.publicState.jobPositionKey} FOR SHARE`;
  return !!enabled?.enabled && !!opening?.isOpen;
}

/** Existing journal calls this only after genuine FINAL authority, canonical
 * owner locks and a current per-kind intent. No model-provided URL, position,
 * identity, private HR read, interview decision or phone-profile match exists. */
export async function persistCustomerRecruitmentApplicationTx(tx: TxClient, grant: Grant) {
  const state = await loadCustomerStateSnapshot({ inquiryId: grant.fence.inquiryId }, tx);
  const positionKey = state?.publicState.jobPositionKey;
  if (!state || state.publicState.topic !== "job" || !positionKey || !grant.fence.nativeId ||
      !["INSTAGRAM", "FACEBOOK", "WHATSAPP"].includes(grant.fence.endpoint.channel) ||
      !state.capabilities.contactWrite || state.ownerMode !== "BOT") throw Error("Current own job inquiry required");
  const [enabled] = await tx.$queryRaw<Array<{ enabled: boolean }>>`SELECT "botCanHandleVacancies" AS enabled FROM "Settings" WHERE "id"='singleton' FOR SHARE`;
  const [opening] = await tx.$queryRaw<Array<{ isOpen: boolean }>>`SELECT "isOpen" FROM "RecruitmentPosition" WHERE "key"=${positionKey} FOR SHARE`;
  if (!enabled?.enabled || !opening?.isOpen) throw Error("Recruitment closed");
  const origin = await readVerifiedCustomerFinalOrigin(tx, grant.eventKey);
  const row = await tx.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: grant.eventKey }, select: {
    order: true, scopeKey: true, endpointScopeId: true, payloadHash: true, payloadCiphertext: true, inputRecordedAt: true,
  } });
  if (!origin || !row.inputRecordedAt || !row.endpointScopeId || !row.payloadHash || !row.payloadCiphertext ||
      origin.input.inputText !== grant.currentInputText || origin.originalConversationId !== grant.fence.nativeId ||
      row.order.toString() !== grant.order || row.endpointScopeId !== grant.fence.endpoint.endpointScopeId) throw Error("Original recruitment source required");
  const envelope = decryptCustomerIngressEnvelope({ version: 1, eventKey: grant.eventKey, order: row.order.toString(),
    scopeKey: row.scopeKey, endpointScopeId: row.endpointScopeId, payloadHash: row.payloadHash }, row.payloadCiphertext);
  const incoming: Portfolio = [];
  for (const raw of grant.currentInputText.match(/https:\/\/[^\s<>"«»]+/gu) ?? []) {
    const parsed = item.safeParse({ kind: "link", url: raw.replace(/[),.;!?]+$/gu, ""), sourceEventKey: grant.eventKey });
    if (parsed.success) incoming.push(parsed.data);
  }
  for (const media of envelope.payload.media) {
    if (!media.url || !["share", "link"].includes(media.kind)) continue;
    const parsed = item.safeParse({ kind: "link",
      url: media.url, sourceEventKey: grant.eventKey });
    if (parsed.success) incoming.push(parsed.data);
  }
  const native = await tx.botConversation.findUniqueOrThrow({ where: { id: grant.fence.nativeId }, select: { messages: true } });
  for (const message of Array.isArray(native.messages) ? native.messages : []) {
    if (!message || typeof message !== "object" || Array.isArray(message) || message.role !== "user" ||
        !message.customerPropertyAdmission || typeof message.customerPropertyAdmission !== "object" || Array.isArray(message.customerPropertyAdmission) ||
        message.customerPropertyAdmission.eventKey !== grant.eventKey || !Array.isArray(message.attachments)) continue;
    for (const attachment of message.attachments) {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) continue;
      const parsed = item.safeParse({ ...attachment, sourceEventKey: grant.eventKey });
      if (parsed.success && "file" in parsed.data && privateFilePath(parsed.data.file)) incoming.push(parsed.data);
    }
  }
  const existing = await tx.jobApplication.findUnique({ where: { customerInquiryId_customerPositionKey: { customerInquiryId: grant.fence.inquiryId, customerPositionKey: positionKey } } });
  const previous = existing?.customerPortfolio == null ? [] : portfolioSchema.parse(existing.customerPortfolio);
  const portfolio = [...previous];
  for (const entry of incoming) if (!portfolio.some(p => "url" in p && "url" in entry ? p.url === entry.url : "file" in p && "file" in entry && p.file === entry.file)) portfolio.push(entry);
  if (portfolio.length > 24) throw Error("Recruitment portfolio limit reached");
  const ownText = grant.currentInputText.trim();
  const rawText = [existing?.rawText, ownText].filter(Boolean).join("\n");
  if (!ownText && !incoming.length || rawText.length > 32000) throw Error("Recruitment material unavailable");
  const contactRow = await tx.customerInquiry.findUniqueOrThrow({ where: { id: grant.fence.inquiryId }, select: { claimedContact: true } });
  const contact = customerClaimedContactSchema.safeParse(contactRow.claimedContact);
  const patch = { rawText, customerPortfolio: portfolio as Prisma.InputJsonValue,
    ...(contact.success && contact.data.name ? { name: contact.data.name } : {}),
    ...(contact.success && contact.data.phone ? { phone: contact.data.phone } : {}) };
  const saved = existing ? await tx.jobApplication.update({ where: { id: existing.id }, data: { ...patch, customerApplicationRevision: { increment: 1 } } }) :
    await tx.jobApplication.create({ data: { ...patch, channel: grant.fence.endpoint.channel, conversationId: null,
      contactName: envelope.payload.displayName ?? null, customerInquiryId: grant.fence.inquiryId,
      customerPositionKey: positionKey, customerApplicationRevision: 1n } });
  // No eligibility/priority/HR overrides are computed or changed. A missing
  // phone does not prevent collection; no Client or callback is created.
  return { resourceId: saved.id, resourceType: "JobApplication" as const, resourceRevision: saved.customerApplicationRevision!.toString() };
}

import { randomUUID } from "node:crypto";
import { customerPropertyBatchSchema, type CustomerPropertyAdmission, type CustomerPropertyAdmissionResult, type CustomerPropertyEvidence, type CustomerPropertyFacts } from "@royal-home/shared";
import type { ChatMessage } from "../ai/shared.js";
import { prisma } from "../db.js";
import { findScopedBotConversation, type CustomerTransportReference } from "./customerConversationScope.js";
import { admitCustomerPropertyInput, customerPropertyInputAlreadyManaged, verifyCustomerPropertyAdmission, type CustomerPropertyAdmissionInput } from "./customerPropertyAdmission.js";
import { customerPropertyContextEnabled } from "./customerPropertyContextFlag.js";
import { customerPropertyEvidenceFromText, mergeCustomerPropertyEvidence } from "./customerPropertyEvidence.js";
import { completeCustomerPropertyFocus, persistCustomerPropertyBatchEvidence, readCustomerPropertyFocus, type CustomerPropertyFocusSnapshot } from "./customerPropertyFocus.js";
import { customerPropertyRegistry } from "./customerPropertyRegistry.js";
import { resolveCustomerPropertyEvidence } from "./customerPropertyResolver.js";
import { readCustomerPropertyFacts } from "./customerPropertyFacts.js";
import { customerPropertyTurnTerminal } from "./customerPropertyHistory.js";
import { boundedCustomerPropertyBatch } from "./customerPropertyHistory.js";
import { traceCustomerPropertyResolution } from "./botTurnTrace.js";

interface Input {
  channel: string; subscriberId: string; text: string; accountExternalId?: string;
  messageId?: string; skipSaveIncoming?: boolean;
  customerPropertyAdmission?: CustomerPropertyAdmissionResult;
  customerPropertyBatch?: CustomerPropertyAdmissionResult[];
  customerPropertyEventKind?: CustomerPropertyAdmissionInput["eventKind"];
  customerTransport?: CustomerTransportReference;
}
/** Existing fences stay effective when the rollout switch is OFF. */
export async function customerPropertyTurnAlreadyManaged(input: Input): Promise<boolean> {
  if (!input.skipSaveIncoming) return !!input.messageId && customerPropertyInputAlreadyManaged({ channel: input.channel,
    peer: input.subscriberId, accountExternalId: input.accountExternalId, eventId: input.messageId,
    eventKind: input.customerPropertyEventKind ?? "direct", transport: input.customerTransport });
  const scoped = await findScopedBotConversation({ ...input, transport: input.customerTransport });
  const row = scoped ? await prisma.botConversation.findUnique({ where: { id: scoped.id }, select: { id: true, messages: true } }) : null;
  const history = Array.isArray(row?.messages) ? row.messages as unknown as ChatMessage[] : [];
  if (customerPropertyTurnTerminal(history)) return true;
  const last = [...history].reverse().find((message) => message?.role === "user");
  const parsed = customerPropertyBatchSchema.safeParse(last?.customerPropertyBatch ?? (last?.customerPropertyAdmission ? [{ status: "admitted", ticket: last.customerPropertyAdmission }] : []));
  const tickets = parsed.success ? parsed.data.flatMap((result) => result.status === "admitted" && result.ticket.conversationId === row?.id ? [result.ticket] : []) : [];
  if (!tickets.length) return false;
  const stored = await prisma.customerPropertyIngressTicket.findMany({ where: { eventKey: { in: tickets.map((ticket) => ticket.eventKey) }, conversationId: row!.id }, select: { managedOutputRecordedAt: true } });
  return stored.length === tickets.length && stored.every((ticket) => !!ticket.managedOutputRecordedAt);
}
interface Prepared { admission?: CustomerPropertyAdmissionResult; batch: CustomerPropertyAdmissionResult[] }
function prepared(admission: CustomerPropertyAdmissionResult | undefined, batch?: CustomerPropertyAdmissionResult[]): Prepared {
  return { admission, batch: boundedCustomerPropertyBatch(batch ?? (admission ? [admission] : [])) };
}
export async function prepareCustomerPropertyAdmission(input: Input): Promise<Prepared> {
  if (!["WHATSAPP", "INSTAGRAM", "FACEBOOK", "WEBSITE"].includes(input.channel)) return prepared(undefined);
  const propertyEnabled = customerPropertyContextEnabled();
  if (input.customerPropertyAdmission) {
    // Legacy no-MID widgets continue without fabricated durable authority. A
    // genuine foundation ticket, however, survives property OFF in history.
    if (!propertyEnabled && input.customerPropertyAdmission.status === "denied" && input.customerPropertyAdmission.reason === "missing_identity") return prepared(undefined);
    const admission = input.customerPropertyAdmission.status === "admitted" ? await verifyCustomerPropertyAdmission(input.customerPropertyAdmission.ticket) : input.customerPropertyAdmission;
    return prepared(admission, input.customerPropertyBatch);
  }
  if (input.skipSaveIncoming) {
    const scoped = await findScopedBotConversation({ ...input, transport: input.customerTransport });
    const row = scoped ? await prisma.botConversation.findUnique({ where: { id: scoped.id }, select: { messages: true } }) : null;
    const history = Array.isArray(row?.messages) ? row.messages as unknown as ChatMessage[] : [];
    if (customerPropertyTurnTerminal(history)) return prepared({ status: "denied", reason: "retry_ticket_missing" });
    const last = [...history].reverse().find((message) => message.role === "user");
    if (last?.customerPropertyAdmissionDenied) return prepared(last.customerPropertyAdmissionDenied, last.customerPropertyBatch);
    const ticket = last?.customerPropertyAdmission;
    if (!ticket) return prepared(undefined); // legacy pre-P03 retries retain their path
    const parsedBatch = customerPropertyBatchSchema.safeParse(last?.customerPropertyBatch ?? [{ status: "admitted", ticket }]);
    if (!parsedBatch.success) return prepared({ status: "denied", reason: "invalid_input" });
    const checked = await Promise.all(parsedBatch.data.map((result) => result.status === "admitted" ? verifyCustomerPropertyAdmission(result.ticket) : result));
    const restored = checked.filter((result) => result.status !== "denied" || result.reason !== "already_managed");
    if (!restored.length) return prepared({ status: "denied", reason: "already_managed" });
    const denial = restored.find((result) => result.status === "denied");
    const fresh = restored.flatMap((result) => result.status === "admitted" ? [result.ticket] : []);
    const latest = fresh.length ? fresh.reduce((a, b) => BigInt(a.order) > BigInt(b.order) ? a : b) : null;
    return prepared(denial ?? (latest ? { status: "admitted", ticket: latest } : await verifyCustomerPropertyAdmission(ticket)), restored);
  }
  if (!propertyEnabled) return prepared(undefined);
  // Only trusted direct internal calls reach this fallback. Ingress explicitly
  // supplies a denied result if provider identity is absent; it never lands here.
  return prepared(await admitCustomerPropertyInput({ channel: input.channel, peer: input.subscriberId,
    accountExternalId: input.accountExternalId, transport: input.customerTransport, eventKind: "direct", eventId: input.messageId ?? randomUUID(),
    evidence: customerPropertyEvidenceFromText(input.text) }));
}

export interface CustomerPropertyTurnContext {
  ticket: CustomerPropertyAdmission;
  snapshot: CustomerPropertyFocusSnapshot;
  facts: CustomerPropertyFacts | null;
  superseded: boolean;
}
/** Resolve the persisted owner evidence, never adopt newer B for old input A. */
export async function resolveCustomerPropertyTurnContext(
  admission: CustomerPropertyAdmissionResult | undefined,
  batchTickets: readonly CustomerPropertyAdmission[],
): Promise<CustomerPropertyTurnContext | null> {
  if (admission?.status !== "admitted") return null;
  const ticket = admission.ticket;
  let snapshot = await readCustomerPropertyFocus(ticket);
  if (!snapshot) return null;
  if (BigInt(ticket.order) < BigInt(snapshot.focus.lastEvidenceOrder)) {
    traceCustomerPropertyResolution({ status: snapshot.focus.status, propertyId: snapshot.focus.propertyId, provenanceKinds: snapshot.focus.evidence.map((item) => item.kind) }, true);
    return { ticket, snapshot, facts: null, superseded: true };
  }
  if (snapshot.focus.status === "pending") {
    // The prompt winner can be a later plain question. Use the immutable
    // admission of the focus owner; never reallocate the old event's order.
    const ownerRow = await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey: snapshot.focus.eventKey }, select: { eventKey: true, order: true, scopeKey: true, conversationId: true } });
    if (!ownerRow?.conversationId || ownerRow.scopeKey !== ticket.scopeKey || ownerRow.conversationId !== ticket.conversationId || ownerRow.order.toString() !== snapshot.focus.lastEvidenceOrder) return null;
    const owner: CustomerPropertyAdmission = { ...ticket, ...ownerRow, conversationId: ownerRow.conversationId, order: ownerRow.order.toString(), evidence: snapshot.focus.evidence };
    const recorded = await prisma.customerPropertyIngressTicket.findMany({ where: { eventKey: { in: batchTickets.map((item) => item.eventKey) }, managedOutputRecordedAt: { not: null } }, select: { eventKey: true } });
    const consumed = new Set(recorded.map((item) => item.eventKey));
    const grouped: CustomerPropertyEvidence[] = mergeCustomerPropertyEvidence([snapshot.focus.evidence,
      ...batchTickets.filter((item) => !consumed.has(item.eventKey) && item.scopeKey === ticket.scopeKey && item.conversationId === ticket.conversationId &&
        BigInt(item.order) <= BigInt(snapshot!.focus.lastEvidenceOrder)).map((item) => item.evidence)]);
    const persisted = await persistCustomerPropertyBatchEvidence(owner, snapshot, grouped);
    if (!persisted) return null;
    const resolution = await resolveCustomerPropertyEvidence(persisted.focus.evidence, owner, customerPropertyRegistry);
    if (!await completeCustomerPropertyFocus(owner, persisted, resolution)) return null;
    traceCustomerPropertyResolution({ status: resolution.status, propertyId: resolution.propertyId, provenanceKinds: resolution.provenance.map((item) => item.kind), candidateCount: resolution.candidates.length });
    snapshot = await readCustomerPropertyFocus(ticket);
    if (!snapshot || snapshot.focus.generation !== persisted.focus.generation || snapshot.revision !== persisted.revision) return null;
  }
  traceCustomerPropertyResolution({ status: snapshot.focus.status, propertyId: snapshot.focus.propertyId, provenanceKinds: snapshot.focus.evidence.map((item) => item.kind) });
  return { ticket, snapshot, superseded: false,
    facts: snapshot.focus.status === "resolved" && snapshot.focus.propertyId
      ? await readCustomerPropertyFacts(snapshot.focus.propertyId, ticket.channel) : null };
}

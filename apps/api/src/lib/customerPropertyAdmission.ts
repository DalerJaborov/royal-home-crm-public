import { inspectCustomerDmRouting, type CustomerDmRoutingWitness } from "./customerAgentRoutingReference.js";
import {
  customerPropertyAdmissionSchema,
  customerPropertyEvidenceSchema,
  type CustomerPropertyAdmission,
  type CustomerPropertyAdmissionResult,
  type CustomerPropertyEvidence,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { customerPropertyEventKey, customerPropertyScopeKey } from "./customerPropertyScope.js";
import { reserveCustomerPropertyFocus } from "./customerPropertyFocus.js";
import { CustomerScopeDenied, ensureCustomerEndpoint, ensureScopedBotConversation, resolveCustomerEndpoint, type CustomerTransportReference } from "./customerConversationScope.js";
import { acceptAuthenticatedCustomerAdmission } from "./customerState.js";
import type { AuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { customerIngressPayloadHash } from "./customerIngressPayload.js";
export { customerPropertyScopeKey } from "./customerPropertyScope.js";

const CHANNELS = new Set(["WHATSAPP", "INSTAGRAM", "FACEBOOK", "WEBSITE"]);
type Denial = Extract<CustomerPropertyAdmissionResult, { status: "denied" }>["reason"];
class AdmissionDenied extends Error {
  constructor(readonly reason: Denial) { super("Customer property admission denied"); }
}

export interface CustomerPropertyAdmissionInput {
  channel: string;
  peer: string;
  customerRoutingWitness?: CustomerDmRoutingWitness;
  accountExternalId?: string;
  /** Trusted internal callers only; webhook bodies never supply this field. */
  accountId?: string | null;
  transport?: CustomerTransportReference;
  eventKind: "message" | "postback" | "website_message" | "direct";
  /** Stable provider/client MID, or a trusted fresh direct-operation UUID. */
  eventId?: string;
  evidence: CustomerPropertyEvidence[];
  /** Runtime-branded normalized current IN, never a webhook JSON field. */
  authenticatedInput?: AuthenticatedCustomerInput;
  /** Meta allocates immutable order before classification, but its focus/state
   * is reserved only after that frame is confirmed to be customer input. */
  deferFocusUntilClassification?: boolean;
}

/**
 * First work after authenticated normalization, before names/media/ad enrichment.
 * The sequence is allocated at the beginning of the short DB transaction.
 * No provider calls, contacts, scenarios, interest writes or claim-state changes.
 */
export async function admitCustomerPropertyInput(input: CustomerPropertyAdmissionInput): Promise<CustomerPropertyAdmissionResult> {
  if (!CHANNELS.has(input.channel) || !input.peer || input.peer.length > 512 || input.evidence.length > 16 ||
      !input.evidence.every((item) => customerPropertyEvidenceSchema.safeParse(item).success)) {
    return { status: "denied", reason: "invalid_input" };
  }
  if (!input.eventId || input.eventId.length > 512) return { status: "denied", reason: "missing_identity" };
  try {
    const admitted = await prisma.$transaction(async (tx) => {
      // Nontransactional sequence gaps are fine; only committed tickets are admissions.
      const [allocated] = await tx.$queryRaw<{ order: bigint }[]>`
        SELECT nextval('"CustomerPropertyIngressTicket_order_seq"') AS "order"`;
      if (!allocated) throw new AdmissionDenied("storage_unavailable");

      // A durable inbox tombstone must be checked BEFORE any native upsert.
      // A repeated provider event can never recreate a deleted conversation.
      const endpoint = await ensureCustomerEndpoint(tx, { channel: input.channel, subscriberId: input.peer,
        accountId: input.accountId, accountExternalId: input.accountExternalId, transport: input.transport });
      const accountId = endpoint.accountId;
      const endpointScopeId = endpoint.endpointScopeId;
      const scopeKey = customerPropertyScopeKey(input.channel, input.peer, accountId, endpointScopeId);
      const key = customerPropertyEventKey(scopeKey, input.eventKind, input.eventId!);
      const routing = inspectCustomerDmRouting(input.customerRoutingWitness);
      if (input.customerRoutingWitness && (!routing || routing.execution.lane !== "LEGACY" || routing.eventKey !== key ||
        routing.scopeKey !== scopeKey || routing.transport.endpointScopeId !== endpointScopeId ||
        routing.transport.scopeRevision !== endpoint.scopeRevision || routing.input.peer !== input.peer)) throw new AdmissionDenied("account_mismatch");
      const assignmentId = routing?.execution.lane === "LEGACY" ? routing.execution.assignment?.id ?? null : null;
      const [prior] = await tx.$queryRaw<Array<{ conversationId: string | null; originalConversationId: string | null;
        tombstonedAt: Date | null; order: bigint; routingProvenance: string | null; routingSourceHash: string | null;
        routingScopeRevision: bigint | null; rolloutAssignmentId: string | null; originalUnexpired: boolean;
        payloadVersion: number | null; intakeAgentRevisionId: string | null }>>`SELECT "conversationId","originalConversationId",
          "tombstonedAt","order","routingProvenance","routingSourceHash","routingScopeRevision","rolloutAssignmentId",
          "payloadVersion","intakeAgentRevisionId",
          (clock_timestamp() >= "receivedAt" AND clock_timestamp() <= "receivedAt" + interval '15 minutes') AS "originalUnexpired"
          FROM "CustomerPropertyIngressTicket" WHERE "eventKey"=${key}`;
      if (prior?.tombstonedAt || (prior?.originalConversationId && !prior.conversationId)) throw new AdmissionDenied("retry_ticket_missing");
      if (prior?.routingProvenance === "NATIVE_HISTORY") throw new AdmissionDenied("retry_ticket_missing");
      // CORE RAW keeps its existing authenticated admission/consumer path; this
      // extra first-binding gate belongs only to the new LEGACY metadata rows.
      const originalLegacy = prior?.routingProvenance === "META_ENVELOPE" &&
        prior.payloadVersion === null && prior.intakeAgentRevisionId === null;
      if (originalLegacy && (!routing || !routing.input.eventId ||
        prior.routingSourceHash !== customerIngressPayloadHash(routing.input) || prior.rolloutAssignmentId !== assignmentId ||
        prior.routingScopeRevision?.toString() !== endpoint.scopeRevision || !prior.originalUnexpired)) throw new AdmissionDenied("retry_ticket_missing");
      const conversation = await ensureScopedBotConversation(tx, { channel: input.channel, subscriberId: input.peer, transport: endpoint });
      await tx.$executeRaw`
        INSERT INTO "CustomerPropertyIngressTicket" ("eventKey", "order", "scopeKey", "conversationId", "originalConversationId", "endpointScopeId", "rolloutAssignmentId")
        VALUES (${key}, ${allocated.order}, ${scopeKey}, ${conversation.id}, ${conversation.id}, ${endpointScopeId}, ${assignmentId}) ON CONFLICT ("eventKey") DO NOTHING`;
      const firstBinding = await tx.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "conversationId"=${conversation.id},"originalConversationId"=${conversation.id}
        WHERE "eventKey"=${key} AND "conversationId" IS NULL AND "originalConversationId" IS NULL AND "tombstonedAt" IS NULL
          AND ("routingProvenance" IS DISTINCT FROM 'META_ENVELOPE' OR "payloadVersion" IS NOT NULL OR "intakeAgentRevisionId" IS NOT NULL OR
            (clock_timestamp() >= "receivedAt" AND clock_timestamp() <= "receivedAt" + interval '15 minutes'))`;
      const stored = await tx.customerPropertyIngressTicket.findUnique({
        where: { eventKey: key }, select: { eventKey: true, order: true, scopeKey: true, conversationId: true, endpointScopeId: true, managedOutputRecordedAt: true },
      });
      if (!stored) throw new AdmissionDenied("storage_unavailable");
      if (stored.managedOutputRecordedAt) throw new AdmissionDenied("already_managed");
      if (stored.conversationId !== conversation.id || stored.scopeKey !== scopeKey || stored.endpointScopeId !== endpointScopeId) throw new AdmissionDenied("account_mismatch");
      const admission = customerPropertyAdmissionSchema.parse({
        eventKey: stored.eventKey, scopeKey: stored.scopeKey, conversationId: stored.conversationId, order: stored.order.toString(), accountId,
        channel: input.channel, endpointScopeId, evidence: input.evidence,
      });
      // New explicit evidence invalidates the previous object before enrichment.
      // Equal/older tickets cannot reserve a new generation, including retries.
      if (!input.deferFocusUntilClassification) await reserveCustomerPropertyFocus(tx, admission);
      // Early P03 tickets preserve ordering, not customer input authority. Meta
      // classification runs later; only a FINAL-IN runtime brand may affect the
      // canonical state (the WEBSITE text adapter already classified its input).
      if (input.authenticatedInput) await acceptAuthenticatedCustomerAdmission(input.authenticatedInput, admission, tx);
      // The durable compare-and-set, not an in-memory first-request token, owns
      // first binding. A genuine identical retry can recover a crash before
      // native admission, within the ORIGINAL 15-minute intake window. Same or
      // different request witnesses racing here get exactly one fresh binding.
      // Native upsert precedes the source UPDATE, matching native deletion and
      // the native-history guard's lock order. Exactly one UPDATE can bind it.
      const firstOriginalAdmission = originalLegacy && firstBinding === 1;
      return { ticket: admission, fresh: stored.order === allocated.order || firstOriginalAdmission };
    }, { maxWait: 5000, timeout: 10000 });
    return { status: "admitted", ...admitted };
  } catch (error) {
    return { status: "denied", reason: error instanceof AdmissionDenied ? error.reason : error instanceof CustomerScopeDenied
      ? (error.reason === "account_unknown" ? "account_unknown" : "account_mismatch") : "storage_unavailable" };
  }
}

/** Lookup only: an old retry can neither allocate an order nor recreate a thread. */
export async function verifyCustomerPropertyAdmission(ticket: CustomerPropertyAdmission): Promise<CustomerPropertyAdmissionResult> {
  const parsed = customerPropertyAdmissionSchema.safeParse(ticket);
  if (!parsed.success) return { status: "denied", reason: "invalid_input" };
  try {
    const stored = await prisma.customerPropertyIngressTicket.findUnique({
      where: { eventKey: ticket.eventKey },
      select: { order: true, scopeKey: true, conversationId: true, originalConversationId: true, tombstonedAt: true, endpointScopeId: true, managedOutputRecordedAt: true,
        conversation: { select: { channel: true, subscriberId: true, accountId: true, endpointScopeId: true } } },
    });
    if (!stored?.conversationId || !stored.conversation || stored.tombstonedAt ||
        (stored.originalConversationId && stored.originalConversationId !== stored.conversationId) || stored.order.toString() !== ticket.order || stored.conversationId !== ticket.conversationId) {
      return { status: "denied", reason: "retry_ticket_missing" };
    }
    if ((ticket.accountId === null && ticket.channel !== "WEBSITE" && !ticket.endpointScopeId) ||
        (ticket.endpointScopeId && (ticket.endpointScopeId !== stored.endpointScopeId || ticket.endpointScopeId !== stored.conversation.endpointScopeId)) ||
        stored.scopeKey !== ticket.scopeKey || stored.conversation.channel !== ticket.channel ||
        stored.conversation.accountId !== ticket.accountId ||
        customerPropertyScopeKey(ticket.channel, stored.conversation.subscriberId, ticket.accountId, ticket.endpointScopeId) !== ticket.scopeKey) {
      return { status: "denied", reason: "account_mismatch" };
    }
    if (stored.managedOutputRecordedAt) return { status: "denied", reason: "already_managed" };
    return { status: "admitted", ticket: parsed.data };
  } catch {
    return { status: "denied", reason: "storage_unavailable" };
  }
}

/** Rollback-safe feature OFF: lookup previously fenced stable events only.
 * Never allocates a sequence, ticket, conversation or focus. */
export async function customerPropertyInputAlreadyManaged(input: Omit<CustomerPropertyAdmissionInput, "evidence">): Promise<boolean> {
  if (!input.eventId || !CHANNELS.has(input.channel)) return false;
  try {
    const endpoint = await resolveCustomerEndpoint({ channel: input.channel, subscriberId: input.peer,
      accountId: input.accountId, accountExternalId: input.accountExternalId, transport: input.transport });
    const scope = customerPropertyScopeKey(input.channel, input.peer, endpoint.accountId, endpoint.endpointScopeId);
    const stored = await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey: customerPropertyEventKey(scope, input.eventKind, input.eventId) },
      select: { scopeKey: true, endpointScopeId: true, managedOutputRecordedAt: true } });
    return !!stored?.managedOutputRecordedAt && stored.scopeKey === scope &&
      (!stored.endpointScopeId || stored.endpointScopeId === endpoint.endpointScopeId);
  } catch (error) { if (error instanceof CustomerScopeDenied) return false; throw error; }
}

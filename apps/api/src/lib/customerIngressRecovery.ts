import { customerPropertyAdmissionSchema, type CustomerPropertyAdmission } from "@royal-home/shared";
import { prisma } from "../db.js";
import { classifyRecoveredCustomerPendingInput, inspectRecoveredCustomerPendingEnvelope,
  recoverAuthenticatedCustomerInput, recoverCustomerPendingEnvelope, revalidateRecoveredCustomerPendingInputTx,
  type AuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { resolveCustomerEndpoint, ensureScopedBotConversation, CustomerScopeDenied } from "./customerConversationScope.js";
import { acceptAuthenticatedCustomerAdmission, lockCustomerStateSnapshot } from "./customerState.js";
import { reserveCustomerPropertyFocus } from "./customerPropertyFocus.js";
import { customerPropertyContextEnabled } from "./customerPropertyContextFlag.js";

export type RecoveredFinalCustomerInboxInput =
  | { status: "finalized"; input: AuthenticatedCustomerInput; ticket: CustomerPropertyAdmission }
  | { status: "ignored"; reason: string }
  | { status: "held"; reason: string };
class RecoveryHeld extends Error { constructor(readonly reason: string) { super("Customer input recovery held"); } }
type RecoveryRow = { eventKey: string; order: bigint; scopeKey: string; endpointScopeId: string | null;
  conversationId: string | null; originalConversationId: string | null; tombstonedAt: Date | null;
  originCiphertext: string | null; payloadHash: string | null; processingState: string | null; managedOutputRecordedAt: Date | null };

/** P11's actual pending→FINAL adapter, not the planner/controller. Same original
 * event/order/age/assurance, original credential epoch, no request forgery or new
 * sequence. It performs no model/action/OUT/input-history append or PLANNED.
 * Root consumer/lease and paid loop remain separate. */
export async function recoverAndFinalizeCustomerInboxInput(eventKey: unknown): Promise<RecoveredFinalCustomerInboxInput> {
  if (typeof eventKey !== "string" || !/^[a-f0-9]{64}$/.test(eventKey)) return { status: "held", reason: "invalid_event_key" };
  try {
    const rows = await prisma.$queryRaw<RecoveryRow[]>`SELECT * FROM "CustomerPropertyIngressTicket" WHERE "eventKey"=${eventKey}`;
    const original = rows.length === 1 ? rows[0] : null;
    if (!original || original.tombstonedAt || original.originalConversationId && !original.conversationId) return { status: "held", reason: "ticket_missing_or_tombstoned" };
    if (original.processingState === "PLANNED" || original.managedOutputRecordedAt) return { status: "held", reason: "already_planned" };
    if (original.originCiphertext) {
      const prior = await recoverAuthenticatedCustomerInput(eventKey);
      return prior.status === "recovered" ? { status: "finalized", input: prior.input, ticket: prior.ticket }
        : { status: "held", reason: "original_final_stale" };
    }
    const recovered = await recoverCustomerPendingEnvelope(eventKey);
    if (recovered.status !== "pending") return recovered;
    const pending = inspectRecoveredCustomerPendingEnvelope(recovered.envelope);
    if (!pending || pending.payload.channel === "WEBSITE") return { status: "held", reason: "recovery_adapter_unsupported" };
    const classified = await classifyRecoveredCustomerPendingInput(recovered.envelope);
    if (classified.status !== "classified") return classified;
    return await prisma.$transaction(async tx => {
      // Read without Ticket lock first. Canonical native→scope→policy→Inquiry
      // locks precede the Ticket lock, exactly as current live acceptance.
      const endpoint = await resolveCustomerEndpoint({ channel: pending.payload.channel, subscriberId: pending.payload.peer,
        accountExternalId: pending.payload.accountExternalId }, tx);
      if (endpoint.endpointScopeId !== pending.verification.endpointScopeId || endpoint.accountId !== pending.verification.accountId ||
          endpoint.scopeRevision !== pending.verification.scopeRevision) throw new RecoveryHeld("original_endpoint_changed");
      const native = await ensureScopedBotConversation(tx, { channel: pending.payload.channel, subscriberId: pending.payload.peer, transport: endpoint });
      const state = await lockCustomerStateSnapshot(tx, { conversationId: native.id });
      if (!state || state.closedAt || state.fence.endpoint.endpointScopeId !== endpoint.endpointScopeId) throw new RecoveryHeld("native_state_unavailable");
      const [locked] = await tx.$queryRaw<RecoveryRow[]>`SELECT * FROM "CustomerPropertyIngressTicket" WHERE "eventKey"=${eventKey} FOR UPDATE`;
      if (!locked || locked.tombstonedAt || locked.order.toString() !== pending.order || locked.scopeKey !== original.scopeKey ||
          locked.endpointScopeId !== endpoint.endpointScopeId || locked.payloadHash !== original.payloadHash ||
          locked.originalConversationId && locked.originalConversationId !== native.id || locked.conversationId && locked.conversationId !== native.id ||
          locked.processingState === "PLANNED" || locked.managedOutputRecordedAt) throw new RecoveryHeld("ticket_binding_changed");
      // Another genuine live/worker path may have committed FINAL while the
      // profile GET ran. Never overwrite it or replay accepted state/focus.
      if (locked.originCiphertext) {
        const final = await recoverAuthenticatedCustomerInput(eventKey, tx);
        if (final.status !== "recovered") throw new RecoveryHeld("original_final_stale");
        return { status: "finalized" as const, input: final.input, ticket: final.ticket };
      }
      if (!await revalidateRecoveredCustomerPendingInputTx(tx, classified.input)) throw new RecoveryHeld("classification_or_epoch_changed");
      if (!locked.conversationId && !locked.originalConversationId) {
        const changed = await tx.$executeRaw`UPDATE "CustomerPropertyIngressTicket"
          SET "conversationId"=${native.id},"originalConversationId"=${native.id}
          WHERE "eventKey"=${eventKey} AND "order"=${BigInt(pending.order)} AND "tombstonedAt" IS NULL
            AND "conversationId" IS NULL AND "originalConversationId" IS NULL`;
        if (changed !== 1) throw new RecoveryHeld("first_native_binding_failed");
      }
      const ticket = customerPropertyAdmissionSchema.parse({ eventKey, order: pending.order, scopeKey: locked.scopeKey,
        conversationId: native.id, endpointScopeId: endpoint.endpointScopeId, accountId: endpoint.accountId,
        channel: pending.payload.channel, evidence: pending.payload.propertyEvidence });
      if (customerPropertyContextEnabled()) await reserveCustomerPropertyFocus(tx, ticket);
      if (!await acceptAuthenticatedCustomerAdmission(classified.input, ticket, tx)) throw new RecoveryHeld("canonical_acceptance_denied");
      return { status: "finalized" as const, input: classified.input, ticket };
    }, { maxWait: 5000, timeout: 10000 });
  } catch (error) {
    return { status: "held", reason: error instanceof RecoveryHeld ? error.reason : error instanceof CustomerScopeDenied
      ? "original_endpoint_changed" : "recovery_unavailable" };
  }
}

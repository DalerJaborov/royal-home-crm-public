import { isDeepStrictEqual } from "node:util";
import { publicCommentDeliveryFenceSchema, publicReplyReceiptSchema } from "@royal-home/shared";
import { prisma } from "../db.js";
import { customerManagedTraceEnabled, withBotTurnTrace, traceCustomerManagedDelivery, type TraceStart } from "./botTurnTrace.js";
import { customerDeliveryControllerFence } from "./customerDeliveryContracts.js";
import type { CustomerDispatchResult } from "./customerDeliveryDispatcher.js";
import { readCustomerOutboxPart } from "./customerOutbox.js";
import { inspectPublicCommentPrincipal, type PublicCommentPrincipal } from "./publicCommentSourceIssuer.js";
import { publicCommentOrigin, readPublicSourceRow } from "./customerPublicCommentStore.js";
import { PublicReplyHeldError } from "../messengers/publicCommentReply.js";

let warned = false;
function omitted(): void {
  if (warned) return;
  warned = true;
  try { console.warn("[bot-trace] managed delivery correlation omitted"); } catch { /* diagnostic cannot suppress business work */ }
}
async function publicStart(principal: PublicCommentPrincipal): Promise<TraceStart | null> {
  const original = inspectPublicCommentPrincipal(principal);
  if (!original?.currentInstallation || !["INSTAGRAM", "FACEBOOK"].includes(original.target.channel)) return null;
  const source = await readPublicSourceRow(original.source);
  if (!source || source.sourceRevision !== original.sourceRevision) return null;
  const origin = publicCommentOrigin(source);
  if (!isDeepStrictEqual(origin.target, original.target) || !isDeepStrictEqual(origin.proof, original.proof)) return null;
  return { channel: original.target.channel, account: original.currentInstallation.id,
    peer: original.target.commentId, conversation: original.source.id,
    event: `${original.source.table}:${original.source.id}:${original.sourceRevision}`, source: "internal", kind: "text",
    managed: { surface: "public_comment", phase: "delivery", revisionId: origin.agentPin.agentRevisionId,
      operationId: origin.agentPin.providerOperationId } };
}

/** Diagnostic setup is separate from business execution. A read failure may
 * omit correlation; NEVER catch/repeat an actual send for the sake of trace. */
export async function withCustomerPublicDeliveryTrace(principal: PublicCommentPrincipal, send: () => Promise<string>): Promise<string> {
  if (!customerManagedTraceEnabled()) return send();
  let start: TraceStart | null = null;
  try { start = await publicStart(principal); } catch { omitted(); }
  if (!start) return send();
  return withBotTurnTrace(start, async () => {
    try {
      const mid = await send();
      traceCustomerManagedDelivery({ status: "accepted" }); // Actual durable MID, not a model assertion.
      return mid;
    } catch (error) {
      // A real typed observation may survive local projection/persistence failure.
      // Its finite outcome is diagnostic; never repeat POST or log its raw reason/MID.
      const receipt = error instanceof PublicReplyHeldError ? publicReplyReceiptSchema.safeParse(error.receipt) : null;
      if (receipt?.success) traceCustomerManagedDelivery({
        status: receipt.data.outcome === "accepted" ? "accepted" : receipt.data.outcome === "refused" ? "not_sent" : "unknown",
        projectionPending: receipt.data.outcome === "accepted",
      });
      throw error;
    }
  });
}

/** Actual dispatcher invocation, including reconciliation-only public jobs.
 * Immutable source metadata is not a principal, renewed deadline or send grant. */
export async function withCustomerOutboxDeliveryTrace(partId: string, dispatch: () => Promise<CustomerDispatchResult>): Promise<CustomerDispatchResult> {
  if (!customerManagedTraceEnabled()) return dispatch();
  let start: TraceStart | null = null;
  try {
    const row = await readCustomerOutboxPart(partId);
    if (row?.sourceKind === "PUBLIC_COMMENT_REPLY") {
      const f = publicCommentDeliveryFenceSchema.parse(row.fenceJson);
      if (f.installation.id === row.endpointScopeId && f.source.id === row.originalNativeId &&
          f.sourceRevision === row.publicSourceRevision?.toString()) {
        start = { channel: row.channel, account: row.endpointScopeId, peer: f.target.commentId, conversation: row.originalNativeId,
          event: `${f.source.table}:${f.source.id}:${f.sourceRevision}`, source: "internal", kind: "text",
          managed: { surface: "public_comment", phase: "delivery", ...(row.agentRevisionId ? { revisionId: row.agentRevisionId } : {}) } };
        // Source may already be edited/deleted: omit original operation rather than inventing it.
        const source = await readPublicSourceRow(f.source);
        if (source?.sourceRevision === f.sourceRevision) {
          const origin = publicCommentOrigin(source);
          if (origin.agentPin.agentRevisionId === row.agentRevisionId && isDeepStrictEqual(origin.target, f.target)) {
            start.managed!.operationId = origin.agentPin.providerOperationId;
          }
        }
      }
    } else if (row && ["BOT_TURN", "HANDOVER_ACK"].includes(row.sourceKind) && row.ticketEventKey && row.agentRevisionId) {
      const f = customerDeliveryControllerFence(row);
      const ticket = await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey: row.ticketEventKey }, select: {
        agentRevisionId: true, providerOperationId: true, originalConversationId: true, endpointScopeId: true,
      } });
      if (ticket?.agentRevisionId === row.agentRevisionId && ticket.providerOperationId &&
          ticket.originalConversationId === row.originalNativeId && ticket.endpointScopeId === row.endpointScopeId &&
          f.nativeId === row.originalNativeId && f.endpoint.endpointScopeId === row.endpointScopeId && f.endpoint.channel === row.channel) {
        start = { channel: row.channel, account: row.endpointScopeId, peer: f.endpoint.peerId, conversation: row.originalNativeId,
          event: row.ticketEventKey, source: "internal", kind: "text", managed: { surface: "dm", phase: "delivery",
            revisionId: ticket.agentRevisionId, operationId: ticket.providerOperationId } };
      }
    }
  } catch { start = null; omitted(); }
  if (!start) return dispatch();
  return withBotTurnTrace(start, async () => {
    const result = await dispatch();
    traceCustomerManagedDelivery(result);
    return result;
  });
}

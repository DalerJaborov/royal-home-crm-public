import { prisma } from "../db.js";
import { customerDeliveryFenceSchema, customerDeliveryTransportSchema } from "./customerDeliveryContracts.js";
import { decodeCustomerOutboxPayload } from "./customerOutboxCodec.js";
import { IN_FLIGHT_ECHO_WINDOW_MS } from "../messengers/inFlightEcho.js";

/** Core projects OUT only after acceptance, so legacy assistant-tail matching
 * has no entry during a real POST. Use that exact durable attempt instead.
 * No receipt is invented, UNKNOWN is not retried and a human pause is not undone. */
export async function isOwnCustomerOutboxEcho(input: {
  conversationId: string; accountId: string | null; channel: string; peer: string; text: string; messageId?: string;
}): Promise<boolean> {
  try {
    const native = await prisma.botConversation.findUnique({ where: { id: input.conversationId },
      select: { channel: true, accountId: true, endpointScopeId: true, subscriberId: true } });
    if (!native?.endpointScopeId || native.accountId !== input.accountId || native.channel !== input.channel || native.subscriberId !== input.peer) return false;
    const since = new Date(Date.now() - IN_FLIGHT_ECHO_WINDOW_MS);
    const parts = await prisma.customerOutboxPart.findMany({ where: {
      conversationId: input.conversationId, originalNativeId: input.conversationId, endpointScopeId: native.endpointScopeId,
      sourceKind: "BOT_TURN", mode: "LIVE", agentRevisionId: { not: null },
      OR: [{ status: "IN_FLIGHT", attempts: { some: { outcome: "IN_FLIGHT", startedAt: { gte: since } } } },
        ...(input.messageId ? [{ status: "ACCEPTED", attempts: { some: { outcome: "ACCEPTED", providerMid: input.messageId } } }] : [])],
    }, include: { attempts: { orderBy: { attemptNo: "desc" }, take: 1 } }, orderBy: { createdAt: "desc" }, take: 8 });
    for (const part of parts) {
      const fence = customerDeliveryFenceSchema.parse(part.fenceJson), transport = customerDeliveryTransportSchema.parse(part.transportJson), a = part.attempts[0];
      if (!a || a.claimRevision !== part.claimRevision || a.endpointScopeId !== native.endpointScopeId ||
          fence.nativeId !== input.conversationId || fence.endpoint.endpointScopeId !== native.endpointScopeId ||
          fence.endpoint.accountId !== input.accountId || fence.endpoint.channel !== input.channel || fence.endpoint.peerId !== input.peer ||
          transport.endpointScopeId !== native.endpointScopeId || transport.accountId !== input.accountId || transport.channel !== input.channel) continue;
      if (part.status === "ACCEPTED" && a.outcome === "ACCEPTED" && input.messageId && a.providerMid === input.messageId && a.finishedAt) return true;
      const payload = decodeCustomerOutboxPayload(part), text = input.text.replace(/\s+/gu, " ").trim();
      if (payload.kind === "text" && text && part.status === "IN_FLIGHT" && a.outcome === "IN_FLIGHT" &&
          a.startedAt >= since && part.leaseUntil && part.leaseUntil.getTime() > Date.now() &&
          payload.text.replace(/\s+/gu, " ").trim() === text) return true;
    }
  } catch { /* Missing proof preserves the existing manual-echo handling. */ }
  return false;
}

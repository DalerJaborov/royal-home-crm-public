import { z } from "zod";
import { prisma, type TxClient } from "../db.js";
import { customerDeliveryFenceSchema, customerDeliveryTransportSchema } from "./customerDeliveryContracts.js";
import { decodeCustomerOutboxPayload } from "./customerOutboxCodec.js";
import { IN_FLIGHT_ECHO_WINDOW_MS } from "../messengers/inFlightEcho.js";
import { decryptSecret } from "../crypto.js";
import { recruitmentRecoveryHash } from "../ai/recruitmentRecoveryReply.js";

// Recovery persists the scoped endpoint returned by the installed-account
// loader, including its peer. Ordinary P12 parts use the narrower transport.
// Keep both strict: no unknown keys or implicit peer stripping.
const recoveryTransportSchema = customerDeliveryTransportSchema.extend({ subscriberId: z.string().min(1).max(512) }).strict();

/** Core projects OUT only after acceptance, so legacy assistant-tail matching
 * has no entry during a real POST. Use that exact durable attempt instead.
 * No receipt is invented, UNKNOWN is not retried and a human pause is not undone. */
export async function isOwnCustomerOutboxEcho(input: {
  conversationId: string; accountId: string | null; channel: string; peer: string; text: string; messageId?: string;
}, database: Pick<TxClient, "botConversation" | "customerOutboxPart" | "recruitmentRecovery"> = prisma): Promise<boolean> {
  try {
    const native = await database.botConversation.findUnique({ where: { id: input.conversationId },
      select: { channel: true, accountId: true, endpointScopeId: true, subscriberId: true } });
    if (!native?.endpointScopeId || native.accountId !== input.accountId || native.channel !== input.channel || native.subscriberId !== input.peer) return false;
    const now = Date.now(), since = new Date(now - IN_FLIGHT_ECHO_WINDOW_MS);
    const parts = await database.customerOutboxPart.findMany({ where: {
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
    // Owner-reviewed corrections use a distinct durable delivery purpose. They
    // also project only AFTER Graph accepts, so an early echo has no native
    // assistant message or remembered MID yet. Read the existing attempt; do
    // not write a speculative message, receipt, retry or ownership grant.
    const recoveries = await database.recruitmentRecovery.findMany({ where: {
      conversationId: input.conversationId, originalConversationId: input.conversationId, endpointScopeId: native.endpointScopeId,
      OR: [{ status: "IN_FLIGHT", attemptAt: { gte: since, lte: new Date(now) } },
        ...(input.messageId ? [{ status: "ACCEPTED", providerMid: input.messageId }] : [])],
    }, orderBy: { createdAt: "desc" }, take: 2 });
    for (const recovery of recoveries) {
      const fence = customerDeliveryFenceSchema.parse(recovery.fenceJson), transport = recoveryTransportSchema.parse(recovery.transportJson);
      if (recovery.conversationId !== input.conversationId || recovery.originalConversationId !== input.conversationId ||
          recovery.endpointScopeId !== native.endpointScopeId || fence.nativeId !== input.conversationId ||
          fence.endpoint.endpointScopeId !== native.endpointScopeId || fence.endpoint.accountId !== input.accountId ||
          fence.endpoint.channel !== input.channel || fence.endpoint.peerId !== input.peer ||
          transport.endpointScopeId !== native.endpointScopeId || transport.accountId !== input.accountId ||
          transport.channel !== input.channel || transport.subscriberId !== input.peer || transport.scopeRevision !== fence.scopeRevision) continue;
      if (recovery.status === "ACCEPTED" && recovery.finishedAt && input.messageId && recovery.providerMid === input.messageId) return true;
      if (recovery.status !== "IN_FLIGHT" || !recovery.attemptAt || recovery.attemptAt < since || recovery.attemptAt.getTime() > now) continue;
      const text = input.text.replace(/\s+/gu, " ").trim(), payload = decryptSecret(recovery.payloadEncrypted);
      if (text && recruitmentRecoveryHash({ text: payload }) === recovery.payloadHash && payload.replace(/\s+/gu, " ").trim() === text) return true;
    }
  } catch { /* Missing proof preserves the existing manual-echo handling. */ }
  return false;
}

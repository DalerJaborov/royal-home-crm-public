import type { TxClient } from "../db.js";
import type { ChatMessage } from "../ai/shared.js";
import { sendImage, sendMessage } from "../messengers/meta.js";
import { appendConversationMessagesInTransaction } from "../messengers/appendMessages.js";
import { CustomerDeliveryHeldError } from "./customerDeliveryTransport.js";
import { customerDeliveryControllerFence, customerDeliveryTransportSchema, customerDeliveryP03Schema,
  type CustomerDeliveryPayload, type CustomerOutboxRow } from "./customerDeliveryContracts.js";

/** Current managed adapter is text-only. Media must arrive from a server asset
 * validator/capability observer, not merely a schema-valid URL. Managed property
 * photos require the separately verified asset witness enforced by the dispatcher. */
export function supportsCustomerDeliveryPayload(row: CustomerOutboxRow, payload: CustomerDeliveryPayload): boolean {
  return payload.kind === "text" && ["INSTAGRAM", "FACEBOOK", "WHATSAPP", "WEBSITE"].includes(row.channel) ||
    payload.kind === "image" && ["INSTAGRAM", "FACEBOOK", "WHATSAPP"].includes(row.channel) &&
    payload.url === payload.mediaWitness.publicUrl && payload.mediaWitness.endpoint.channel === row.channel;
}
export async function sendCustomerDeliveryPayload(row: CustomerOutboxRow, payload: CustomerDeliveryPayload): Promise<string | null> {
  if (!supportsCustomerDeliveryPayload(row, payload) || payload.kind !== "text" && payload.kind !== "image") throw new CustomerDeliveryHeldError("unsupported_payload_adapter");
  const transport = customerDeliveryTransportSchema.parse(row.transportJson), fence = customerDeliveryControllerFence(row);
  if (transport.channel === "WEBSITE") throw new CustomerDeliveryHeldError("website_requires_atomic_publication");
  if (payload.kind === "image") return sendImage(transport.channel, fence.endpoint.peerId, payload.url, undefined, transport);
  // A managed part bound to its genuine inbound ticket answers THAT input: the
  // shield must not reclassify a queued/retried reply as an initiative by clock.
  return sendMessage(transport.channel, fence.endpoint.peerId, payload.text, undefined,
    { origin: "bot", transport, answersInbound: !!row.ticketEventKey && (row.sourceKind === "BOT_TURN" || row.sourceKind === "HANDOVER_ACK") });
}

/** Called under the original native/canonical lock. A durable projection marker
 * prevents re-append even when last40 no longer contains this part. */
export async function projectCustomerDeliveryPartTx(tx: TxClient, row: CustomerOutboxRow,
  payload: CustomerDeliveryPayload, mid: string | null): Promise<boolean> {
  if (row.projectionRecordedAt) return true;
  if (!row.conversationId || row.conversationId !== row.originalNativeId || payload.kind !== "text" && payload.kind !== "image") return false;
  const [current] = await tx.$queryRaw<{ messages: unknown }[]>`SELECT "messages" FROM "BotConversation" WHERE "id"=${row.originalNativeId} FOR UPDATE`;
  if (!current) return false;
  const history = Array.isArray(current.messages) ? current.messages as ChatMessage[] : [];
  const times = history.flatMap(message => [message?.at, message?.customerPropertyDelivery?.publishedAt])
    .filter((at): at is string => typeof at === "string").map(Date.parse).filter(Number.isFinite);
  const at = new Date(Math.max(Date.now(), ...times.map(time => time + 1))).toISOString();
  const property = row.p03Json === null ? null : customerDeliveryP03Schema.parse(row.p03Json);
  const message: ChatMessage & { customerOutboxPartId: string; customerPropertyMedia?: Record<string, string | number> } = payload.kind === "image" ? {
    role: "assistant", by: { kind: "bot" }, content: "", at, customerOutboxPartId: row.id,
    ...(mid ? { mid } : {}), customerPropertyReference: { scopeKey: payload.mediaWitness.scopeKey, propertyId: payload.mediaWitness.propertyId },
    attachments: [{ kind: "image", url: payload.mediaWitness.assetPath, mime: "image/jpeg", ...(mid ? { mid } : {}) }],
    customerPropertyMedia: { partId: row.id, propertyId: payload.mediaWitness.propertyId, shortId: payload.mediaWitness.shortId,
      sourceSha256: payload.mediaWitness.sourceSha256, assetSha256: payload.mediaWitness.assetSha256,
      witnessFingerprint: payload.mediaWitness.fingerprint, focusGeneration: payload.mediaWitness.focusGeneration,
      agentRevisionId: payload.mediaWitness.agentRevisionId, acceptedAt: at },
  } : {
    role: "assistant", by: { kind: "bot" }, content: payload.text, at, customerOutboxPartId: row.id,
    ...(mid ? { mid } : {}),
    ...(property ? { customerPropertyDelivery: { ...property, partId: row.id, status: "accepted", publishedAt: at },
      ...(property.propertyId ? { customerPropertyReference: { scopeKey: property.scopeKey, propertyId: property.propertyId } } : {}) } : {}),
  };
  // If projection once existed but its marker was not written by an older
  // binary, exact part ID can be healed. Never infer this from assistant tail.
  const exists = history.some(item => item !== null && typeof item === "object" && Reflect.get(item, "customerOutboxPartId") === row.id);
  if (!exists && (await appendConversationMessagesInTransaction(tx, row.originalNativeId, [message])).affectedRows !== 1) {
    throw new Error("Delivery projection unavailable");
  }
  const changed = await tx.$executeRaw`UPDATE "CustomerOutboxPart" SET "projectionRecordedAt"=now(),"updatedAt"=now()
    WHERE "id"=${row.id} AND "projectionRecordedAt" IS NULL`;
  if (changed !== 1) throw new Error("Delivery projection marker unavailable");
  return true;
}

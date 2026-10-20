import { createHash, randomUUID } from "node:crypto";
import type { CustomerPropertyAdmissionResult, CustomerPropertyDelivery, ManagedCustomerPropertyReply } from "@royal-home/shared";
import { Prisma } from "../generated/prisma/client.js";
import { prisma, type TxClient } from "../db.js";
import type { ChatMessage } from "../ai/shared.js";
import { customerPropertyFocusSchema } from "@royal-home/shared";
import { customerPropertyScopeKey } from "./customerPropertyScope.js";
import { readCustomerPropertyFacts } from "./customerPropertyFacts.js";
import { CustomerPropertyHeldError, withCustomerPropertyTransport } from "./customerPropertyTransport.js";
import { isOutboundBlockedError } from "./outboundShield.js";
import { traceStamp, traceOutcome, traceWebsiteMessagesPersisted } from "./botTurnTrace.js";
import type { CustomerPropertyTurnContext } from "./customerPropertyTurnContext.js";
import { MAX_STORED_MESSAGES } from "../messengers/appendMessages.js";
import { publishMessageNew } from "./livePublish.js";

interface Binding { id: string; channel: ManagedCustomerPropertyReply["channel"]; subscriberId: string; accountId: string | null;
  endpointScopeId?: string; accountExternalId?: string }
export function managedCustomerPropertyReply(binding: Binding, context: CustomerPropertyTurnContext | null, text: string, admission?: CustomerPropertyAdmissionResult): ManagedCustomerPropertyReply {
  const partId = randomUUID();
  const endpointScopeId = binding.endpointScopeId ?? context?.ticket.endpointScopeId ?? (admission?.status === "admitted" ? admission.ticket.endpointScopeId : undefined);
  const scopeKey = customerPropertyScopeKey(binding.channel, binding.subscriberId, binding.accountId, endpointScopeId);
  return { conversationId: binding.id, channel: binding.channel, peer: binding.subscriberId, accountId: binding.accountId, text,
    endpointScopeId, accountExternalId: binding.accountExternalId,
    delivery: { version: 1, partId, scopeKey,
      inputEventKey: admission?.status === "admitted" ? admission.ticket.eventKey : context?.ticket.eventKey ?? createHash("sha256").update(`unadmitted-part:${partId}`).digest("hex"),
      generation: context?.snapshot.focus.generation ?? randomUUID(), focusRevision: context?.snapshot.revision ?? 0,
      propertyId: context?.facts?.propertyId ?? null, factsSignature: context?.facts?.signature ?? null, status: "pending" } };
}
export function managedCustomerPropertyMessage(part: ManagedCustomerPropertyReply): ChatMessage {
  return { role: "assistant", content: part.text, by: { kind: "bot" }, customerPropertyDelivery: part.delivery,
    ...(part.delivery.propertyId ? { customerPropertyReference: { propertyId: part.delivery.propertyId, scopeKey: part.delivery.scopeKey } } : {}) };
}

/** One short transaction for a pending part and every absorbed stable input.
 * No network/typing/model occurs under its conversation row lock. */
export async function persistManagedCustomerPropertyReply(part: ManagedCustomerPropertyReply, batch: readonly CustomerPropertyAdmissionResult[]): Promise<boolean> {
  const tickets = [...new Map(batch.flatMap((result) => result.status === "admitted" ? [[result.ticket.eventKey, result.ticket] as const] : [])).values()];
  const message = { ...managedCustomerPropertyMessage(part), at: new Date().toISOString() };
  const committed = await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ channel: string; subscriberId: string; accountId: string | null; endpointScopeId: string | null }[]>`
      SELECT "channel", "subscriberId", "accountId", "endpointScopeId" FROM "BotConversation" WHERE "id" = ${part.conversationId} FOR UPDATE`;
    if (!row || row.channel !== part.channel || row.subscriberId !== part.peer || row.accountId !== part.accountId ||
        (part.endpointScopeId && part.endpointScopeId !== row.endpointScopeId) ||
        customerPropertyScopeKey(row.channel, row.subscriberId, row.accountId, row.endpointScopeId) !== part.delivery.scopeKey) throw new Error("Managed property binding changed");
    if (tickets.some((ticket) => ticket.conversationId !== part.conversationId || ticket.scopeKey !== part.delivery.scopeKey ||
        ticket.accountId !== part.accountId || ticket.channel !== part.channel ||
        (ticket.endpointScopeId && ticket.endpointScopeId !== part.endpointScopeId))) throw new Error("Managed batch scope mismatch");
    let freshKeys = tickets.map((ticket) => ticket.eventKey);
    if (tickets.length) {
      const stored = await tx.customerPropertyIngressTicket.findMany({ where: { eventKey: { in: tickets.map((ticket) => ticket.eventKey) } },
        select: { eventKey: true, order: true, scopeKey: true, conversationId: true, endpointScopeId: true, managedOutputRecordedAt: true } });
      if (stored.length !== tickets.length || stored.some((item) => item.scopeKey !== part.delivery.scopeKey || item.conversationId !== part.conversationId ||
          (item.endpointScopeId && item.endpointScopeId !== part.endpointScopeId) ||
          item.order.toString() !== tickets.find((ticket) => ticket.eventKey === item.eventKey)?.order)) throw new Error("Managed batch ticket mismatch");
      freshKeys = stored.filter((item) => !item.managedOutputRecordedAt).map((item) => item.eventKey);
      if (!freshKeys.length) return false;
    }
    const changed = await tx.$executeRaw`
      UPDATE "BotConversation" SET "messages" = (
        SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb) FROM (
          SELECT elem, ord FROM jsonb_array_elements("messages" || ${JSON.stringify([message])}::jsonb) WITH ORDINALITY AS t(elem,ord)
          ORDER BY ord DESC LIMIT ${MAX_STORED_MESSAGES}) tail), "updatedAt" = now()
      WHERE "id" = ${part.conversationId} AND "channel" = ${part.channel}
        AND (${part.endpointScopeId ?? null}::text IS NULL OR "endpointScopeId" = ${part.endpointScopeId ?? null})
        AND "subscriberId" = ${part.peer} AND "accountId" IS NOT DISTINCT FROM ${part.accountId}`;
    if (changed !== 1) throw new Error("Managed property append not committed");
    if (freshKeys.length) {
      const marked = await tx.customerPropertyIngressTicket.updateMany({ where: { eventKey: { in: freshKeys },
        scopeKey: part.delivery.scopeKey, conversationId: part.conversationId, managedOutputRecordedAt: null }, data: { managedOutputRecordedAt: new Date() } });
      if (marked.count !== freshKeys.length) throw new Error("Managed output fence not committed");
    }
    return true;
  });
  if (committed) void publishMessageNew("bot", part.conversationId, "OUT");
  return committed;
}

/** A point-in-time check immediately before POST/website publication. No lock
 * survives the query and no atomicity with a third-party POST is claimed. */
export async function customerPropertyReplyFresh(part: ManagedCustomerPropertyReply, db: Pick<TxClient, "botConversation" | "settings" | "property"> = prisma): Promise<boolean> {
  return checkCustomerPropertyReplyFresh(part, db, true);
}
/** Outbox owns its pending/projection ledger separately. Reuse the exact P03
 * binding/focus/live-facts checks without requiring a pre-send history bubble. */
export async function customerPropertyReplyFactsFresh(part: ManagedCustomerPropertyReply, db: Pick<TxClient, "botConversation" | "settings" | "property"> = prisma): Promise<boolean> {
  return checkCustomerPropertyReplyFresh(part, db, false);
}
async function checkCustomerPropertyReplyFresh(part: ManagedCustomerPropertyReply, db: Pick<TxClient, "botConversation" | "settings" | "property">, requirePendingProjection: boolean): Promise<boolean> {
  const row = await db.botConversation.findUnique({ where: { id: part.conversationId },
    select: { channel: true, subscriberId: true, accountId: true, endpointScopeId: true, optedOutAt: true, pausedUntil: true,
      customerPropertyFocus: true, customerPropertyFocusRevision: true, messages: true,
      account: { select: { enabled: true } }, client: { select: { deletedAt: true } } } });
  if (!row || row.channel !== part.channel || row.subscriberId !== part.peer || row.accountId !== part.accountId ||
      (part.endpointScopeId && part.endpointScopeId !== row.endpointScopeId) ||
      (row.accountId === null && row.channel !== "WEBSITE" && !part.endpointScopeId) ||
      customerPropertyScopeKey(row.channel, row.subscriberId, row.accountId, row.endpointScopeId) !== part.delivery.scopeKey ||
      row.optedOutAt || row.client?.deletedAt || row.account?.enabled === false ||
      (row.pausedUntil && row.pausedUntil.getTime() > Date.now())) return false;
  const settings = await db.settings.findUnique({ where: { id: "singleton" }, select: {
    botEnabled: true, botWhatsappEnabled: true, botInstagramEnabled: true, botFacebookEnabled: true, botWebsiteChatEnabled: true,
    metaWaPhoneId: true, metaPageId: true } });
  if (row.accountId === null && part.channel !== "WEBSITE") {
    const currentResource = part.channel === "WHATSAPP" ? settings?.metaWaPhoneId || process.env.META_WA_PHONE_ID
      : part.channel === "FACEBOOK" ? settings?.metaPageId || process.env.META_PAGE_ID : undefined;
    if (!part.accountExternalId || part.accountExternalId !== currentResource) return false;
  }
  const enabled = { WHATSAPP: settings?.botWhatsappEnabled, INSTAGRAM: settings?.botInstagramEnabled,
    FACEBOOK: settings?.botFacebookEnabled, WEBSITE: settings?.botWebsiteChatEnabled }[part.channel];
  if (settings?.botEnabled === false || enabled === false) return false;
  const history = Array.isArray(row.messages) ? row.messages as unknown as ChatMessage[] : [];
  const stored = history.find((message) => message.role === "assistant" && message.by?.kind === "bot" &&
    message.customerPropertyDelivery?.partId === part.delivery.partId);
  if (requirePendingProjection && (!stored || stored.content !== part.text || stored.customerPropertyDelivery?.status !== "pending" ||
      stored.customerPropertyDelivery.scopeKey !== part.delivery.scopeKey)) return false;
  const focus = customerPropertyFocusSchema.safeParse(row.customerPropertyFocus);
  if (part.delivery.focusRevision > 0 && (!focus.success || focus.data.scopeKey !== part.delivery.scopeKey ||
      focus.data.generation !== part.delivery.generation || row.customerPropertyFocusRevision !== part.delivery.focusRevision)) return false;
  if (part.delivery.propertyId) {
    if (!focus.success || focus.data.status !== "resolved" || focus.data.propertyId !== part.delivery.propertyId) return false;
    const facts = await readCustomerPropertyFacts(part.delivery.propertyId, part.channel, db);
    if (!facts || facts.signature !== part.delivery.factsSignature) return false;
  }
  return true;
}

/** Exact part UUID; never stamp/mark the latest unrelated assistant message. */
export async function stampCustomerPropertyDelivery(part: ManagedCustomerPropertyReply, status: Exclude<CustomerPropertyDelivery["status"], "pending">, mid: string | null = null): Promise<boolean> {
  const write = async (db: Pick<TxClient, "$executeRaw">, metadata: CustomerPropertyDelivery): Promise<boolean> => {
    const patch = { customerPropertyDelivery: metadata, ...(mid ? { mid } : {}) };
    const affected = await db.$executeRaw(Prisma.sql`
    UPDATE "BotConversation" c SET "messages" = (
      SELECT jsonb_agg(CASE WHEN elem->'customerPropertyDelivery'->>'partId' = ${part.delivery.partId}
        AND elem->>'role' = 'assistant' AND elem->'by'->>'kind' = 'bot'
        AND elem->'customerPropertyDelivery'->>'status' = 'pending'
        THEN elem || ${JSON.stringify(patch)}::jsonb ELSE elem END ORDER BY ord)
      FROM jsonb_array_elements(c."messages") WITH ORDINALITY AS t(elem,ord))
    WHERE c."id" = ${part.conversationId} AND c."channel" = ${part.channel}
      AND (${part.endpointScopeId ?? null}::text IS NULL OR c."endpointScopeId" = ${part.endpointScopeId ?? null})
      AND c."subscriberId" = ${part.peer} AND c."accountId" IS NOT DISTINCT FROM ${part.accountId}
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(c."messages") elem
        WHERE elem->'customerPropertyDelivery'->>'partId' = ${part.delivery.partId}
          AND elem->'customerPropertyDelivery'->>'scopeKey' = ${part.delivery.scopeKey}
          AND elem->'customerPropertyDelivery'->>'status' = 'pending')`);
    return affected > 0;
  };
  if (part.channel === "WEBSITE" && status === "accepted") {
    return prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ messages: unknown }[]>`
        SELECT "messages" FROM "BotConversation" WHERE "id" = ${part.conversationId}
          AND "channel" = ${part.channel} AND "subscriberId" = ${part.peer}
          AND "accountId" IS NOT DISTINCT FROM ${part.accountId} FOR UPDATE`;
      if (!row || !await customerPropertyReplyFresh(part, tx)) return false;
      const history = Array.isArray(row.messages) ? row.messages as ChatMessage[] : [];
      // Chosen AFTER acquiring the lock, and strictly newer than every existing
      // server cursor. No query/transaction-start timestamp can predate lock wait.
      const seen = history.flatMap((message) => [message?.at, message?.customerPropertyDelivery?.publishedAt])
        .filter((at): at is string => typeof at === "string").map(Date.parse).filter(Number.isFinite);
      const publishedAt = new Date(Math.max(Date.now(), ...seen.map((at) => at + 1))).toISOString();
      return write(tx, { ...part.delivery, status, publishedAt });
    });
  }
  return write(prisma, { ...part.delivery, status });
}

export async function sendManagedCustomerPropertyReply(part: ManagedCustomerPropertyReply, send: () => Promise<string | null>): Promise<"accepted" | "held" | "unknown"> {
  let accepted = false; let mid: string | null = null; let status: "accepted" | "held" | "unknown" = "unknown";
  try {
    if (!await customerPropertyReplyFresh(part)) throw new CustomerPropertyHeldError();
    await withCustomerPropertyTransport({ beforePost: async () => {
      if (!await customerPropertyReplyFresh(part)) throw new CustomerPropertyHeldError();
    }, accepted: (value) => { accepted = true; mid = value; } }, send);
    // A provider returning without its acceptance hook is ambiguous.
    status = accepted ? "accepted" : "unknown";
  } catch (error) {
    status = accepted ? "accepted" : error instanceof CustomerPropertyHeldError || isOutboundBlockedError(error) ||
      (error instanceof Error && /^Graph API HTTP 4\d\d:/.test(error.message)) ? "held" : "unknown";
  }
  // Acceptance is already irrevocably observed; a stamp failure does not turn
  // it into a failed turn or permission to send again. Pending remains terminal.
  try { const stamped = await stampCustomerPropertyDelivery(part, status, mid); if (status === "accepted") traceStamp(mid, stamped); }
  catch { if (status === "accepted") traceStamp(mid, false); }
  if (status === "held") traceOutcome("blocked");
  return status;
}

export async function publishManagedCustomerPropertyReply(part: ManagedCustomerPropertyReply): Promise<"accepted" | "held" | "unknown"> {
  if (part.channel !== "WEBSITE") throw new Error("Managed website publication requires WEBSITE");
  try {
    if (!await customerPropertyReplyFresh(part)) {
      await stampCustomerPropertyDelivery(part, "held"); traceOutcome("blocked"); return "held";
    }
    const committed = await stampCustomerPropertyDelivery(part, "accepted");
    if (!committed) return "unknown";
    traceWebsiteMessagesPersisted(part.conversationId, [{ ...managedCustomerPropertyMessage(part), customerPropertyDelivery: { ...part.delivery, status: "accepted" } }], 1);
    return "accepted";
  } catch {
    try { await stampCustomerPropertyDelivery(part, "unknown"); } catch { /* pending also terminal for replay */ }
    return "unknown";
  }
}

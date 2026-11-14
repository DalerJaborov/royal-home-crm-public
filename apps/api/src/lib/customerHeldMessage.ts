// A customer DM that NO bot will answer still reaches a person (13.11.2026).
//
// Routing can hold a DM for good (see customerRoutingHold.ts): the core owns
// the person but is switched off, an old history row pins the person to the
// core, and so on. Neither bot may answer such a turn, but the message must not
// vanish: before the webhook ACKs Meta, the text is written into the person's
// CRM chat (no model, no reply, idempotent by provider MID); after the ACK the
// responsible agent (or everyone who reads all chats) gets one notification
// with the client's name and a link to the chat, at most once per chat per
// window. Failing to write is transient (the webhook answers 503 and Meta
// retries); a scope denial is permanent and is reported without the text.
import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { appendConversationMessagesInTransaction } from "../messengers/appendMessages.js";
import type { ChatMessage } from "../ai/client.js";
import { clientOwnWords } from "../ai/untrustedContent.js";
import { CustomerScopeDenied, ensureScopedBotConversation, findScopedBotConversation, type CustomerTransportReference } from "./customerConversationScope.js";
import { customerPropertyScopeKey } from "./customerPropertyScope.js";
import type { CustomerNormalizedIngressInput } from "./customerIngressPayload.js";
import { scrubMentionedClientPhonesInText } from "./clientPhoneMasking.js";
import { publishMessageNew } from "./livePublish.js";
import { findAgentsWithPermission } from "./recipients.js";
import { logSystemError } from "./systemError.js";
import { leadOnlyQuietBeforeLead } from "./leadOnlyConfig.js";

export type CustomerHeldMessage = {
  reason: string; channel: string; peer: string; accountExternalId: string | null;
  /** Null when the text could not be placed into a CRM chat. */
  conversationId: string | null; excerpt: string;
  /** Why the text is not in a chat: scope denied, no MID, or the chat was deleted by staff. */
  unrecorded?: "scope_denied" | "no_mid" | "chat_deleted";
};

const NOTIFY_WINDOW_MS = 6 * 60 * 60 * 1000;
const CHANNEL_NAME: Record<string, string> = { INSTAGRAM: "Instagram", FACEBOOK: "Facebook", WHATSAPP: "WhatsApp" };
const REASON_TEXT: Record<string, string> = {
  owned_subject_stopped: "новый бот выключен, а переписка закреплена за ним",
  historical_subject_owned_or_closed: "переписка по старой записи закреплена за новым ботом",
};
const plainReason = (reason: string) => REASON_TEXT[reason] ?? `служебная причина «${reason}»`;
const tagOf = (conversationId: string) => `customer-held-${conversationId}`;

function contentOf(input: CustomerNormalizedIngressInput): string {
  const text = input.inputText.trim();
  if (text) return text;
  const kinds = [...new Set(input.media.map(item => item.kind))];
  return kinds.length ? `[вложение: ${kinds.join(", ")}]` : "[сообщение без текста]";
}

/** Pre-ACK. Throws only on a transient failure (caller answers 503). */
export async function recordHeldCustomerMessage(hold: { reason: string; input: CustomerNormalizedIngressInput;
  transport: CustomerTransportReference }): Promise<CustomerHeldMessage> {
  const { input, transport } = hold;
  const base = { reason: hold.reason, channel: input.channel, peer: input.peer, accountExternalId: input.accountExternalId ?? null };
  const raw = contentOf(input);
  try {
    const recorded = await prisma.$transaction(async tx => {
      // A chat staff deleted is not resurrected by a held message (13.11.2026):
      // its inquiry/ticket keep the tombstone (conversationId set to NULL).
      if (!await findScopedBotConversation({ channel: input.channel, subscriberId: input.peer, transport }, tx)) {
        const scopeKey = customerPropertyScopeKey(input.channel, input.peer, transport.accountId, transport.endpointScopeId);
        const [gone] = await tx.$queryRaw<Array<{ deleted: boolean }>>`SELECT
          EXISTS(SELECT 1 FROM "CustomerInquiry" WHERE "endpointScopeId"=${transport.endpointScopeId} AND "peerId"=${input.peer}
            AND "conversationId" IS NULL) OR
          EXISTS(SELECT 1 FROM "CustomerPropertyIngressTicket" WHERE "endpointScopeId"=${transport.endpointScopeId} AND "scopeKey"=${scopeKey}
            AND "originalConversationId" IS NOT NULL AND "conversationId" IS NULL) AS "deleted"`;
        if (gone?.deleted) return null;
      }
      const native = await ensureScopedBotConversation(tx, { channel: input.channel, subscriberId: input.peer, transport });
      // Row lock: two deliveries of the same MID must not both append.
      const [row] = await tx.$queryRaw<Array<{ clientId: string | null; present: boolean }>>`SELECT "clientId",
        "messages" @> ${JSON.stringify([{ mid: input.eventId }])}::jsonb AS "present"
        FROM "BotConversation" WHERE "id"=${native.id} FOR UPDATE`;
      if (!row) throw new Error("Held customer chat disappeared");
      const content = (await scrubMentionedClientPhonesInText(raw, row.clientId)).text;
      if (!row.present) {
        const message: ChatMessage = { role: "user", content, mid: input.eventId, heldRouting: true,
          ...(input.providerOccurredAt ? { at: new Date(input.providerOccurredAt).toISOString() } : {}) };
        await appendConversationMessagesInTransaction(tx, native.id, [message]);
        // Unread for staff, same guard as the legacy controller: never wake a
        // sleeping debounce winner of the old bot.
        await tx.$executeRaw`UPDATE "BotConversation" SET "lastMessageAt"=now() WHERE "id"=${native.id}
          AND CASE WHEN jsonb_typeof("pendingMessages")='array' THEN jsonb_array_length("pendingMessages") ELSE 0 END = 0`;
      }
      return { conversationId: native.id, fresh: !row.present, content };
    }, { maxWait: 5000, timeout: 10000 });
    if (!recorded) return { ...base, conversationId: null, excerpt: "", unrecorded: "chat_deleted" };
    if (recorded.fresh) void publishMessageNew("bot", recorded.conversationId, "IN");
    return { ...base, conversationId: recorded.conversationId, excerpt: recorded.content.slice(0, 160) };
  } catch (error) {
    if (error instanceof CustomerScopeDenied) return { ...base, conversationId: null, excerpt: "", unrecorded: "scope_denied" };
    throw error;
  }
}

/** Post-ACK, after every message of the batch is durable. Never throws. */
export async function notifyHeldCustomerMessages(holds: readonly CustomerHeldMessage[]): Promise<void> {
  // One journal line per reason (not per person, no live-panel refresh): the
  // people themselves are in their chats and in the staff notification.
  for (const reason of new Set(holds.map(hold => hold.reason))) {
    void logSystemError("meta",
      `Входящие сообщения клиентов не переданы ни одному боту (причина «${reason}»): ${plainReason(reason)}. ` +
        `Текст записан в чат CRM, ответственный получил уведомление; ответить нужно вручную.`,
      { dedupKey: `customer-dm-routing-held:${reason}`, dedupWindowMs: NOTIFY_WINDOW_MS, quietPult: true });
  }
  const seen = new Set<string>();
  for (const hold of holds) {
    try {
      if (!hold.conversationId) {
        // Text could not reach a chat: the journal is the only trace, so name the person.
        const why = hold.unrecorded === "chat_deleted" ? "чат этого человека удалён сотрудником, новый не заводится"
          : `причина «${hold.reason}»`;
        void logSystemError("meta", `Сообщение клиента в ${CHANNEL_NAME[hold.channel] ?? hold.channel} не записано в чат CRM ` +
          `(${why}, собеседник ${hold.peer}). Если нужно, найдите его в приложении и ответьте вручную.`,
          { dedupKey: `customer-dm-routing-held-unrecorded:${hold.reason}`, dedupScope: `${hold.channel}:${hold.peer}`, quietPult: true });
        continue;
      }
      if (seen.has(hold.conversationId)) continue;
      seen.add(hold.conversationId);
      await pushStaffAboutChat({ conversationId: hold.conversationId, channel: hold.channel,
        body: `«${hold.excerpt}». Бот не ответит: ${plainReason(hold.reason)}.` });
    } catch (error) {
      void logSystemError("meta", `Уведомление о непереданном сообщении клиента не отправлено: ${error instanceof Error ? error.message : String(error)}`,
        { dedupKey: "customer-dm-routing-held-notify-failed", quietPult: true });
    }
  }
}

/** One push per chat per window to the responsible agent (or everyone who
 * reads all chats). Shared by a routing hold and a bot escalation, so a person
 * whose chat is both held and escalated is not called twice. */
async function pushStaffAboutChat(input: { conversationId: string; channel: string; body: string }): Promise<"sent" | "skipped"> {
  const tag = tagOf(input.conversationId);
  const recent = await prisma.notification.findFirst({ where: { tag, createdAt: { gte: new Date(Date.now() - NOTIFY_WINDOW_MS) } },
    select: { id: true } });
  if (recent) return "skipped"; // one call per chat per window, the chat itself shows every message
  const chat = await prisma.botConversation.findUnique({ where: { id: input.conversationId },
    select: { name: true, client: { select: { fullName: true, deletedAt: true, assignedAgent: { select: { id: true, isActive: true } } } } } });
  // The client is in the trash: the text is kept in the hidden chat, nobody is called.
  if (!chat || chat.client?.deletedAt) return "skipped";
  const name = chat.client?.fullName?.trim() || chat.name?.trim() || `клиент из ${CHANNEL_NAME[input.channel] ?? input.channel}`;
  // An inactive (dismissed) responsible agent gets no push: fall back to everyone who reads all chats.
  const owner = chat.client?.assignedAgent?.isActive ? chat.client.assignedAgent.id : null;
  const recipients = owner ? [owner] : await findAgentsWithPermission("messages.view");
  if (!recipients.length) return "skipped";
  // Atomic claim per chat and window: two near-simultaneous batches must not
  // both pass the "recent" check above (the feed row is written asynchronously).
  const claimed = await prisma.$executeRaw`INSERT INTO "ProcessedMessage" ("id","channel","messageId","createdAt")
    VALUES (${randomUUID()},'customer-held-notify',${`${input.conversationId}:${Math.floor(Date.now() / NOTIFY_WINDOW_MS)}`},now())
    ON CONFLICT ("channel","messageId") DO NOTHING`;
  if (claimed !== 1) return "skipped";
  await sendPushToAgents(recipients, { kind: "message", title: `Ответьте вручную: ${name}`, body: input.body,
    url: `/messages?open=${input.conversationId}`, tag });
  return "sent";
}

/**
 * THE NEW BOT ESCALATED A DM TURN TO STAFF (14.11.2026). Decision `escalate`
 * sends the customer nothing (lib/customerDmAgentTurn.ts): the ticket is only
 * marked HELD, and until this change nobody was told — the customer asked for a
 * person and waited in silence. Now the responsible agent (or everyone who
 * reads all chats) gets the same once-per-chat-per-window push as a routing
 * hold. The text is already in the CRM chat. Never throws.
 */
export async function notifyEscalatedCustomerTurn(input: { conversationId: string; channel: string; text: string;
  /** Разговор о вакансии: его ведёт рекрутер прежним путём, режим «только заявки» его не глушит. */
  jobTopic?: boolean }): Promise<"sent" | "skipped"> {
  try {
    const chat = await prisma.botConversation.findUnique({ where: { id: input.conversationId }, select: { clientId: true } });
    if (!chat) return "skipped";
    // Режим «только заявки» (решение владельца 13.11.2026): до заявки людей не зовут вовсе — ни ботом, ни общими
    // уведомлениями. Сюда это доходит, только если режим включили посреди хода (иначе ответ даёт сам режим).
    if (!chat.clientId && !input.jobTopic && await leadOnlyQuietBeforeLead(input.channel)) return "skipped";
    const raw = clientOwnWords(input.text ?? "").replace(/\s+/gu, " ").trim() || "[сообщение без текста]";
    const excerpt = (await scrubMentionedClientPhonesInText(raw, chat.clientId)).text.slice(0, 160);
    return await pushStaffAboutChat({ conversationId: input.conversationId, channel: input.channel,
      body: `«${excerpt}». Бот передал разговор человеку: ответьте клиенту сами.` });
  } catch (error) {
    void logSystemError("meta", `Уведомление о переданном боте разговоре не отправлено: ${error instanceof Error ? error.message : String(error)}`,
      { dedupKey: "customer-dm-escalated-notify-failed", quietPult: true });
    return "skipped";
  }
}

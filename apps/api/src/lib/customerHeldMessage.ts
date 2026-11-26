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
import { BARE_MESSAGE_MARKER, NO_TEXT_NOTE, describeForStaff } from "@royal-home/shared";
import { loadBotAnswersItself, staffSignalAllowed } from "./botAnswersItself.js";
import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { sendPushToAgents } from "../push.js";
import { appendConversationMessagesInTransaction } from "../messengers/appendMessages.js";
import type { ChatMessage } from "../ai/client.js";
import { clientOwnWords } from "../ai/untrustedContent.js";
import { CustomerScopeDenied, ensureScopedBotConversation, findScopedBotConversation, type CustomerTransportReference } from "./customerConversationScope.js";
import { customerPropertyScopeKey } from "./customerPropertyScope.js";
import type { CustomerNormalizedIngressInput } from "./customerIngressPayload.js";
import { scrubMentionedClientPhonesInText } from "./clientPhoneMasking.js";
import { publishMessageNew } from "./livePublish.js";
import { insertSettlementPlaceholder, keepIngressMediaInBackground } from "./customerInputMedia.js";
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
  whatsapp_peer_on_other_number: "клиент написал на второй номер WhatsApp, а его переписка уже идёт с другого нашего номера",
};
/** A turn that has a text but no answer: the same words for the staff push. */
const UNANSWERED_REASON_TEXT: Record<string, string> = {
  round_limit: "бот не уложился в отведённые шаги и ответа не подготовил",
  turn_unavailable: "у бота сорвался ход, ответа нет",
  turn_deadline: "бот не успел подготовить ответ вовремя",
  unsupported_decision_evidence: "бот не смог подтвердить ответ данными",
  staff_or_supported_reply_required: "бот решил передать вопрос сотруднику",
  sender_read_unavailable: "не удалось прочитать данные собеседника",
  original_context_changed: "переписка изменилась, пока бот готовил ответ, и ответ не ушёл",
  consume_job_gave_up: "бот не смог обработать сообщение после повторов",
  // lib/customerAgentOrphanClaims.ts: the worker restarted mid-answer (deploy), the answer never went out.
  claim_orphaned_after_deadline: "бот готовил ответ, но сервер перезапустился, и ответ не ушёл",
  // lib/customerAgentChannelOff.ts: the emergency kill switch, the customer heard nothing from the bot.
  customer_channel_off: "бот в этом канале временно выключен, клиенту он не отвечал",
};
const plainReason = (reason: string) => REASON_TEXT[reason] ?? `служебная причина «${reason}»`;
/** customerAgentEnrollment.ts: a WhatsApp customer wrote to our other number while their chat lives on the first one. */
const WHATSAPP_OTHER_NUMBER = "whatsapp_peer_on_other_number";

async function existingWhatsappChat(tx: Pick<import("../db.js").TxClient, "$queryRaw">, peer: string): Promise<{ id: string } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "BotConversation"
    WHERE "channel"='WHATSAPP' AND "subscriberId"=${peer} LIMIT 2`;
  return rows.length === 1 ? rows[0] : null;
}
const tagOf = (conversationId: string) => `customer-held-${conversationId}`;

function contentOf(input: CustomerNormalizedIngressInput): string {
  const text = input.inputText.trim();
  if (text) return text;
  const kinds = [...new Set(input.media.map(item => item.kind))];
  return kinds.length ? `[вложение: ${kinds.join(", ")}]` : BARE_MESSAGE_MARKER;
}

/** Pre-ACK. Throws only on a transient failure (caller answers 503). */
export async function recordHeldCustomerMessage(hold: { reason: string; input: CustomerNormalizedIngressInput;
  transport: CustomerTransportReference }): Promise<CustomerHeldMessage> {
  const { input, transport } = hold;
  const base = { reason: hold.reason, channel: input.channel, peer: input.peer, accountExternalId: input.accountExternalId ?? null };
  const raw = contentOf(input);
  try {
    const recorded = await prisma.$transaction(async tx => {
      // The person already talks to us on our OTHER WhatsApp number (26.11.2026): their one CRM chat is that one. A chat
      // in this number's scope cannot exist next to it (global unique channel+peer), so the text goes where staff already
      // read this person. No chat at all (deleted meanwhile) falls through to the ordinary path below.
      const otherNumberChat = hold.reason === WHATSAPP_OTHER_NUMBER && input.channel === "WHATSAPP"
        ? await existingWhatsappChat(tx, input.peer) : null;
      // A chat staff deleted is not resurrected by a held message (13.11.2026):
      // its inquiry/ticket keep the tombstone (conversationId set to NULL).
      if (!otherNumberChat && !await findScopedBotConversation({ channel: input.channel, subscriberId: input.peer, transport }, tx)) {
        const scopeKey = customerPropertyScopeKey(input.channel, input.peer, transport.accountId, transport.endpointScopeId);
        const [gone] = await tx.$queryRaw<Array<{ deleted: boolean }>>`SELECT
          EXISTS(SELECT 1 FROM "CustomerInquiry" WHERE "endpointScopeId"=${transport.endpointScopeId} AND "peerId"=${input.peer}
            AND "conversationId" IS NULL) OR
          EXISTS(SELECT 1 FROM "CustomerPropertyIngressTicket" WHERE "endpointScopeId"=${transport.endpointScopeId} AND "scopeKey"=${scopeKey}
            AND "originalConversationId" IS NOT NULL AND "conversationId" IS NULL) AS "deleted"`;
        if (gone?.deleted) return null;
      }
      const native = otherNumberChat ?? await ensureScopedBotConversation(tx, { channel: input.channel, subscriberId: input.peer, transport });
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
        // Файл скачивается после коммита: заявка в этой же транзакции (обрыв даст пометку, а не пустоту).
        if (input.media.length) await insertSettlementPlaceholder(tx, { channel: input.channel, peer: input.peer, mid: input.eventId,
          media: input.media, kinds: input.observations.classifier?.mediaKinds });
        // Unread for staff, same guard as the legacy controller: never wake a
        // sleeping debounce winner of the old bot.
        await tx.$executeRaw`UPDATE "BotConversation" SET "lastMessageAt"=now() WHERE "id"=${native.id}
          AND CASE WHEN jsonb_typeof("pendingMessages")='array' THEN jsonb_array_length("pendingMessages") ELSE 0 END = 0`;
      }
      return { conversationId: native.id, fresh: !row.present, content };
    }, { maxWait: 5000, timeout: 10000 });
    if (!recorded) return { ...base, conversationId: null, excerpt: "", unrecorded: "chat_deleted" };
    if (recorded.fresh) {
      void publishMessageNew("bot", recorded.conversationId, "IN");
      // Бот не отвечает, а файл клиента сотруднику нужен больше всего: сохраняем сразу, пока ссылка Meta жива (26.11.2026).
      if (input.media.length) keepIngressMediaInBackground({ channel: input.channel, peer: input.peer, mid: input.eventId,
        ...(input.accountExternalId ? { accountExternalId: input.accountExternalId } : {}),
        media: input.media, kinds: input.observations.classifier?.mediaKinds });
    }
    return { ...base, conversationId: recorded.conversationId, excerpt: recorded.content.slice(0, 160) };
  } catch (error) {
    if (error instanceof CustomerScopeDenied) {
      // No chat to write into, but the person must still see WHAT the customer wrote (review 198-2): the same masking of
      // other clients' numbers as a recorded message; masking failing is no reason to drop the text.
      const excerpt = await scrubMentionedClientPhonesInText(raw, null).then(r => r.text, () => raw);
      return { ...base, conversationId: null, excerpt: excerpt.slice(0, 160), unrecorded: "scope_denied" };
    }
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
        // A chat staff deleted stays deleted (their decision); every other unrecorded message reaches a person (15.11.2026, task 5).
        if (hold.unrecorded !== "chat_deleted") {
          await queueUnrecordedCustomer({ channel: hold.channel, peer: hold.peer, accountExternalId: hold.accountExternalId,
            excerpt: describeForStaff(hold.excerpt), why: `бот не ответит: ${plainReason(hold.reason)}` });
        }
        continue;
      }
      if (seen.has(hold.conversationId)) continue;
      seen.add(hold.conversationId);
      await pushStaffAboutChat({ conversationId: hold.conversationId, channel: hold.channel,
        body: `«${describeForStaff(hold.excerpt)}». Бот не ответит: ${plainReason(hold.reason)}.` });
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
  jobTopic?: boolean;
  /** Клиенту уже ушла безопасная строка (дверь ядра planSafetyLine): при «бот отвечает сам» — ни пуша, ни журнала. */
  answered?: boolean;
  /** Номер клиента известен, а заявку этим ходом не оформили: сигнал идёт при любой настройке (lib/botAnswersItself.ts). */
  phoneKnown?: boolean }): Promise<"sent" | "skipped"> {
  try {
    const chat = await prisma.botConversation.findUnique({ where: { id: input.conversationId }, select: { clientId: true } });
    if (!chat) return "skipped";
    // Режим «только заявки» (решение владельца 13.11.2026): до заявки людей не зовут вовсе — ни ботом, ни общими
    // уведомлениями. Сюда это доходит, только если режим включили посреди хода (иначе ответ даёт сам режим).
    if (!chat.clientId && !input.jobTopic && await leadOnlyQuietBeforeLead(input.channel)) return "skipped";
    // «Бот отвечает сам» (18.11.2026, lib/botAnswersItself.ts): клиенту уже ушла безопасная строка, а карточки (значит, и
    // своего агента) нет — руководство не зовём. Клиент ответа не получил — сбой, сигнал как раньше (ревью 1b, №1).
    const signal = { kind: input.answered ? "answered_handover" as const : "unanswered" as const, hasCard: !!chat.clientId,
      phoneKnown: input.phoneKnown === true };
    if (!input.jobTopic && !staffSignalAllowed({ on: true, ...signal }) && !staffSignalAllowed({ on: await loadBotAnswersItself(), ...signal })) {
      return "skipped";
    }
    const raw = clientOwnWords(input.text ?? "").replace(/\s+/gu, " ").trim() || NO_TEXT_NOTE;
    const excerpt = (await scrubMentionedClientPhonesInText(raw, chat.clientId)).text.slice(0, 160);
    return await pushStaffAboutChat({ conversationId: input.conversationId, channel: input.channel,
      body: `«${excerpt}». Бот передал разговор человеку: ответьте клиенту сами.` });
  } catch (error) {
    void logSystemError("meta", `Уведомление о переданном боте разговоре не отправлено: ${error instanceof Error ? error.message : String(error)}`,
      { dedupKey: "customer-dm-escalated-notify-failed", quietPult: true });
    return "skipped";
  }
}

/** Post-turn guard (13.11.2026): a core turn that ended HELD without an answer for a reason that is NOT an intended silence
 * (customerTurnSilence.ts) reaches a person. The text is already in the CRM chat; this is the push plus one journal line per
 * reason. Never throws. */
export async function notifyUnansweredCustomerTurn(hold: { reason: string; channel: string; peer: string; conversationId: string | null;
  excerpt: string; accountExternalId?: string | null; displayName?: string | null }): Promise<void> {
  const why = UNANSWERED_REASON_TEXT[hold.reason] ?? "бот не смог подготовить ответ"; // staff never see service codes
  void logSystemError("meta", hold.conversationId
    ? `Бот не ответил клиенту (причина «${hold.reason}»): ${why}. Текст в чате CRM, ответственный получил уведомление; ответить нужно вручную.`
    : `Бот не ответил клиенту (причина «${hold.reason}», собеседник ${hold.peer || "неизвестен"}): текст не попал в чат CRM, ` +
      (hold.channel && hold.peer ? `всем, кто читает переписки, уйдёт сводка «Ответьте вручную».`
        : `а кто писал, прочитать не удалось — уведомить некого. Проверьте входящие в приложениях.`),
    { dedupKey: `customer-turn-unanswered:${hold.reason}`, dedupWindowMs: NOTIFY_WINDOW_MS, quietPult: true });
  try {
    if (!hold.conversationId) {
      // No CRM chat to open (15.11.2026, task 5): until now only the journal line above, nobody was told. The person is
      // found by channel, account and (WhatsApp) number; once per person per window, like every "answer by hand" push.
      if (hold.channel && hold.peer) {
        await queueUnrecordedCustomer({ channel: hold.channel, peer: hold.peer, accountExternalId: hold.accountExternalId ?? null,
          excerpt: hold.excerpt, why, displayName: hold.displayName ?? null });
      } else {
        // 198-4: the ticket did not decrypt (historical format) — nobody can be called, so this one is NOT quiet: it reaches
        // the director's «Здоровье системы».
        void logSystemError("meta", `Бот не ответил клиенту (причина «${hold.reason}»), а кто писал, CRM прочитать не смогла — ` +
          `проверьте входящие в приложениях Meta вручную.`, { dedupKey: `customer-turn-unanswered-unreadable:${hold.reason}` });
      }
      return;
    }
    // ONE door for "the customer is waiting" (#174): idempotent per silence episode, critical level, director fallback when
    // nobody is assigned. The sweep of #174 finds the same chats later; the episode mark keeps it from a second push.
    const { alertClientWaiting } = await import("./clientWaitingAlert.js");
    // «Бот решил позвать сотрудника» — только когда модель правда так решила; поломка хода — своими словами (ревью 193-3).
    await alertClientWaiting(hold.reason === "staff_or_supported_reply_required"
      ? { conversationId: hold.conversationId, trigger: "escalate" }
      : { conversationId: hold.conversationId, trigger: "failed", why });
  } catch (error) {
    void logSystemError("meta", `Уведомление о неотвеченном сообщении клиента не отправлено: ${error instanceof Error ? error.message : String(error)}`,
      { dedupKey: "customer-turn-unanswered-notify-failed", quietPult: true });
  }
}

const UNRECORDED_CLAIM = "customer-unrecorded-notify";
const UNRECORDED_PENDING = "customer-unrecorded-pending";
const UNRECORDED_SUMMARY_LIMIT = 50;
const DUSHANBE_TIME = new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Dushanbe", hour: "2-digit", minute: "2-digit" });

type UnrecordedPending = { channel: string; peer: string; accountExternalId: string | null; excerpt: string; why: string;
  displayName: string | null; at: string };

/**
 * A customer message that has NO CRM chat (routing could not record it, or a core ticket without a conversation) still
 * reaches a person (15.11.2026, owner: "никого не пропускать"). It is QUEUED here and sent as ONE summary per tick
 * (runUnrecordedCustomerSummary, review 198-1: a wave of N people must not become N pushes to every staff member).
 * One entry per person per rolling 6 h (review 198-6: no double push across a fixed window border). The queued text is
 * encrypted at rest like the core ticket it came from. Never throws.
 */
export async function queueUnrecordedCustomer(input: { channel: string; peer: string; accountExternalId: string | null;
  excerpt: string; why: string; displayName?: string | null }): Promise<"queued" | "skipped"> {
  const personKey = `${input.channel}:${input.peer}`;
  try {
    // Rolling window: insert, or re-arm only a mark older than the window. 1 row = this call owns the person now.
    const claimed = await prisma.$executeRaw`INSERT INTO "ProcessedMessage" ("id","channel","messageId","createdAt","completedAt")
      VALUES (${randomUUID()},${UNRECORDED_CLAIM},${personKey},now(),now())
      ON CONFLICT ("channel","messageId") DO UPDATE SET "createdAt"=now(),"completedAt"=now()
      WHERE "ProcessedMessage"."createdAt" < now() - make_interval(secs => ${NOTIFY_WINDOW_MS / 1000})`;
    if (claimed !== 1) return "skipped";
    const excerpt = (await scrubMentionedClientPhonesInText(clientOwnWords(input.excerpt).replace(/\s+/gu, " ").trim(), null)).text.slice(0, 160);
    const payload: UnrecordedPending = { channel: input.channel, peer: input.peer, accountExternalId: input.accountExternalId,
      excerpt, why: input.why, displayName: input.displayName ?? null, at: new Date().toISOString() };
    try {
      await prisma.processedMessage.create({ data: { channel: UNRECORDED_PENDING,
        messageId: `${randomUUID()}|${encryptSecret(JSON.stringify(payload))}`, completedAt: new Date() } });
    } catch (error) {
      await prisma.processedMessage.deleteMany({ where: { channel: UNRECORDED_CLAIM, messageId: personKey } }).catch(() => {});
      throw error;
    }
    return "queued";
  } catch (error) {
    void logSystemError("meta", `Сообщение вне чата CRM не поставлено в сводку «Ответьте вручную»: ${error instanceof Error ? error.message : String(error)}`,
      { dedupKey: "customer-unrecorded-queue-failed" });
    return "skipped";
  }
}

export interface UnrecordedSummaryResult { people: number; sent: boolean }

/**
 * Cron tick: everything queued since the last tick — ONE push to everyone who reads all chats (В1 «а»). The person has no
 * CRM chat, so the push says where to look (channel, account, time, WhatsApp number) and — fact, prod 15.11: of 37 such
 * people in 30 days 2 got an answer another way within a day — asks to check whether someone already answered.
 * Rows are taken atomically (DELETE … RETURNING); a failed push puts them back for the next tick.
 */
export async function runUnrecordedCustomerSummary(): Promise<UnrecordedSummaryResult> {
  const recipients = await findAgentsWithPermission("messages.view");
  if (!recipients.length) {
    const waiting = await prisma.processedMessage.count({ where: { channel: UNRECORDED_PENDING } });
    if (waiting) void logSystemError("meta", `Сообщения клиентов (${waiting}) не попали в чат CRM, а сказать некому: нет никого с правом «Сообщения».`,
      { dedupKey: "customer-unrecorded-no-recipients" });
    return { people: 0, sent: false };
  }
  const taken = await prisma.$queryRaw<Array<{ messageId: string; createdAt: Date }>>`DELETE FROM "ProcessedMessage" WHERE "id" IN (
      SELECT "id" FROM "ProcessedMessage" WHERE "channel"=${UNRECORDED_PENDING} ORDER BY "createdAt" ASC LIMIT ${UNRECORDED_SUMMARY_LIMIT}
      FOR UPDATE SKIP LOCKED) RETURNING "messageId","createdAt"`;
  if (!taken.length) return { people: 0, sent: false };
  const people: UnrecordedPending[] = [];
  for (const row of taken) {
    try {
      people.push(JSON.parse(decryptSecret(row.messageId.slice(row.messageId.indexOf("|") + 1))) as UnrecordedPending);
    } catch {
      void logSystemError("meta", "Запись сводки «Ответьте вручную» не расшифровалась и пропущена.", { dedupKey: "customer-unrecorded-unreadable" });
    }
  }
  if (!people.length) return { people: 0, sent: false };
  people.sort((a, b) => a.at.localeCompare(b.at));
  const titles = new Map<string, string>();
  for (const p of people) {
    if (!p.accountExternalId || titles.has(`${p.channel}:${p.accountExternalId}`)) continue;
    const row = await prisma.messengerAccount.findFirst({ where: { channel: p.channel, externalId: p.accountExternalId }, select: { title: true } });
    if (row?.title) titles.set(`${p.channel}:${p.accountExternalId}`, row.title);
  }
  const where = (p: UnrecordedPending) => {
    const account = p.accountExternalId ? titles.get(`${p.channel}:${p.accountExternalId}`) : undefined;
    return `${CHANNEL_NAME[p.channel] ?? p.channel}${account ? ` «${account}»` : ""}`;
  };
  // 198-5: a staff member without the phone permission sees the number masked, so time, account and text are the clues too.
  const who = (p: UnrecordedPending) => p.channel === "WHATSAPP" && /^\d{8,15}$/.test(p.peer) ? `номер +${p.peer}` : p.displayName?.trim() || "клиент";
  const first = people[0]!;
  const line = (p: UnrecordedPending) => `${who(p)}, ${where(p)}, в ${DUSHANBE_TIME.format(new Date(p.at))}: «${describeForStaff(p.excerpt)}»`;
  const places = [...new Set(people.map(where))].join(", ");
  try {
    await sendPushToAgents(recipients, { kind: "message", level: "CRITICAL",
      title: people.length === 1 ? `Ответьте вручную: ${who(first)} (${where(first)})` : `Ответьте вручную: ${people.length} чел. не попали в чат CRM`,
      body: people.length === 1
        ? `${line(first)}. ${first.why[0]?.toUpperCase() ?? ""}${first.why.slice(1)}. Чата в CRM нет — ответьте в приложении ${where(first)}; ` +
          `сначала проверьте, не ответили ли уже.`
        : `Первый: ${line(first)}. Где: ${places}. Чатов в CRM нет — ответьте в приложениях; сначала проверьте, не ответили ли уже.`,
      // One tag: a newer summary replaces the older one in the bell instead of piling up.
      url: "/messages", tag: "customer-unrecorded" });
    return { people: people.length, sent: true };
  } catch (error) {
    // Put the taken rows back: the next tick retries them.
    await prisma.processedMessage.createMany({ data: taken.map(r => ({ channel: UNRECORDED_PENDING, messageId: r.messageId,
      createdAt: r.createdAt, completedAt: new Date() })), skipDuplicates: true }).catch(() => {});
    void logSystemError("meta", `Сводка «Ответьте вручную» по сообщениям вне чата CRM не отправлена, повторим: ${error instanceof Error ? error.message : String(error)}`,
      { dedupKey: "customer-unrecorded-notify-failed" });
    return { people: 0, sent: false };
  }
}

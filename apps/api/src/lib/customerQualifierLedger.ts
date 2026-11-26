import { BARE_ATTACHMENT_MARKER } from "@royal-home/shared";
import { captureConversationPhoneMessages } from "./clientPhoneCapture.js";
import type { CustomerPropertyAdmission } from "@royal-home/shared";
import { prisma } from "../db.js";
import { authenticatedInputMatchesFence, inspectAuthenticatedCustomerInput, type AuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { isCustomerPrincipal } from "./customerPrincipal.js";
import { customerPropertyEventKey, customerPropertyScopeKey } from "./customerPropertyScope.js";
import { lockCustomerNative } from "./customerNativeLock.js";
import { assertCustomerFence, loadCustomerStateSnapshot, lockCustomerStateSnapshot } from "./customerState.js";
import { appendConversationMessagesInTransaction } from "../messengers/appendMessages.js";
import { insertSettlementPlaceholder, keepIngressMediaInBackground, takePendingCustomerMedia, type StoredIngressMedia } from "./customerInputMedia.js";
import { publishMessageNew } from "./livePublish.js";
import { traceWebsiteMessagesPersisted } from "./botTurnTrace.js";
import type { ScopedCustomerQualifierLane } from "./customerQualifierContext.js";
import type { MessengerTurnInput } from "../messengers/turnTypes.js";
import type { ChatMessage } from "../ai/client.js";

/** Staff ledger persistence, not identity or BOT permission. A genuine IN may
 * still be recorded after a human takes ownership; rebinding never adopts it.
 * Marker and append commit together and survive the 40-message history trim. */
export async function recordScopedCustomerInput(input: Pick<MessengerTurnInput, "channel" | "subscriberId" | "skipSaveIncoming" | "replyToMessageId">,
  frame: AuthenticatedCustomerInput | undefined, ticket: CustomerPropertyAdmission,
  /** Файлы входящего (из нормализованного payload): сохраняются для сотрудника ровно один раз — в той транзакции,
   *  что записала реплику. Без этого файл клиента в ядре терялся молча (прод 25–26.11, 8 из 8). */
  incomingMedia?: { accountExternalId?: string; media: readonly StoredIngressMedia[]; kinds?: readonly (string | undefined)[] }): Promise<boolean> {
  const evidence = inspectAuthenticatedCustomerInput(frame), original = evidence?.acceptedFence;
  if (!evidence || !original || evidence.channel !== input.channel || evidence.peer !== input.subscriberId ||
      original.nativeId !== ticket.conversationId || original.endpoint.channel !== ticket.channel ||
      original.endpoint.accountId !== ticket.accountId || ticket.endpointScopeId !== original.endpoint.endpointScopeId ||
      customerPropertyScopeKey(evidence.channel, evidence.peer, ticket.accountId, ticket.endpointScopeId) !== ticket.scopeKey ||
      customerPropertyEventKey(ticket.scopeKey, evidence.eventKind, evidence.eventId) !== ticket.eventKey) return false;
  let appended: ChatMessage[] = [];
  try {
    const saved = await prisma.$transaction(async tx => {
      if (!await lockCustomerNative(tx, { kind: "bot", id: ticket.conversationId })) return false;
      const current = await loadCustomerStateSnapshot({ conversationId: ticket.conversationId }, tx);
      if (!current || current.closedAt || current.fence.nativeId !== original.nativeId ||
          current.fence.bindingRevision !== original.bindingRevision ||
          current.fence.endpoint.endpointScopeId !== original.endpoint.endpointScopeId ||
          current.fence.endpoint.channel !== original.endpoint.channel || current.fence.endpoint.accountId !== original.endpoint.accountId ||
          current.fence.endpoint.peerId !== original.endpoint.peerId || current.fence.endpoint.threadId !== original.endpoint.threadId) return false;
      const [stored] = await tx.$queryRaw<Array<{ inputRecordedAt: Date | null; originalConversationId: string | null; tombstonedAt: Date | null }>>`
        SELECT "inputRecordedAt","originalConversationId","tombstonedAt" FROM "CustomerPropertyIngressTicket" WHERE "eventKey"=${ticket.eventKey}
          AND "order"=${BigInt(ticket.order)} AND "scopeKey"=${ticket.scopeKey} AND "conversationId"=${ticket.conversationId}
          AND "endpointScopeId"=${ticket.endpointScopeId} FOR UPDATE`;
      if (!stored || stored.tombstonedAt || (stored.originalConversationId && stored.originalConversationId !== ticket.conversationId)) return false;
      if (stored.inputRecordedAt) return true;
      if (input.skipSaveIncoming) return false;
      // Файлы клиента, скачанные для сотрудника раньше этой записи (lib/customerInputMedia.ts),
      // ложатся в реплику здесь же, под тем же замком диалога (25.11.2026).
      const pendingMedia = await takePendingCustomerMedia(tx, evidence.channel, evidence.peer, evidence.eventId);
      const msg: ChatMessage = { role: "user", content: evidence.inputText || BARE_ATTACHMENT_MARKER, mid: evidence.eventId,
        at: new Date(evidence.issuedAt).toISOString(),
        customerPropertyAdmission: ticket, ...(input.replyToMessageId ? { replyToMid: input.replyToMessageId } : {}),
        ...(pendingMedia as Partial<ChatMessage> | undefined) };
      const result = await appendConversationMessagesInTransaction(tx, ticket.conversationId, [msg]);
      if (result.affectedRows !== 1) throw new Error("Scoped input append unavailable");
      await tx.$executeRaw`UPDATE "BotConversation" SET "lastMessageAt"=now() WHERE "id"=${ticket.conversationId}`;
      const marked = await tx.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "inputRecordedAt"=now()
        WHERE "eventKey"=${ticket.eventKey} AND "inputRecordedAt" IS NULL`;
      if (marked !== 1) throw new Error("Scoped input marker unavailable");
      appended = result.messages;
      // Файл ещё не скачан: заявка в этой же транзакции, чтобы обрыв до скачивания дал пометку, а не пустоту.
      if (incomingMedia?.media.length && !pendingMedia) await insertSettlementPlaceholder(tx, { channel: evidence.channel, peer: evidence.peer, mid: evidence.eventId, ...incomingMedia });
      return true;
    });
    if (saved && appended.length) {
      void captureConversationPhoneMessages(ticket.conversationId, appended.map(message => ({ ...message, at: new Date(evidence.issuedAt).toISOString() }))).catch(error => console.error("[contact-capture]", error instanceof Error ? error.name : "UnknownError"));
      void publishMessageNew("bot", ticket.conversationId, "IN");
      if (incomingMedia?.media.length) keepIngressMediaInBackground({ channel: evidence.channel, peer: evidence.peer, mid: evidence.eventId, ...incomingMedia });
      // Действия CRM на входящее (пуш агенту, возврат из «Потерянных», автопилот…)
      // — ровно один раз на сообщение: эта ветка проходится только в той
      // транзакции, которая поставила inputRecordedAt. Не зависит от того,
      // ответит ли мозг; ход не ждёт (lib/inboundSideEffects.ts).
      void import("./inboundSideEffects.js")
        .then(({ applyInboundSideEffects }) => applyInboundSideEffects({ source: "core", channel: evidence.channel,
          peer: evidence.peer, conversationId: ticket.conversationId, text: evidence.inputText, eventId: evidence.eventId }))
        .catch(error => console.error("[inbound-effects]", error instanceof Error ? error.name : "UnknownError"));
    }
    return saved;
  } catch (error) {
    console.error("[customer-qualifier] input ledger unavailable:", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}

/** Atomic local OUT ledger fence. This does not prove a later provider POST or
 * implement an outbox; the channel still revalidates its captured transport. */
export async function appendScopedCustomerReply(lane: ScopedCustomerQualifierLane, reply: string, mid?: string): Promise<boolean> {
  if (!reply || !isCustomerPrincipal(lane.principal) || lane.principal.scope.conversationId !== lane.ticket.conversationId ||
      lane.principal.admission.eventKey !== lane.ticket.eventKey || lane.principal.admission.order !== lane.ticket.order ||
      lane.principal.scope.scopeKey !== lane.ticket.scopeKey) return false;
  try {
    let appended: ChatMessage[] = [];
    const saved = await prisma.$transaction(async tx => {
      const original = lane.principal.authority.fence;
      if (!await lockCustomerStateSnapshot(tx, { inquiryId: original.inquiryId }) ||
          !authenticatedInputMatchesFence(lane.authenticatedInput, original) ||
          (await assertCustomerFence(tx, original, "outbound")).status !== "current") return false;
      const msg: ChatMessage = { role: "assistant", content: reply, by: { kind: "bot" }, ...(mid ? { replyToMid: mid } : {}) };
      const result = await appendConversationMessagesInTransaction(tx, lane.ticket.conversationId, [msg]);
      if (result.affectedRows !== 1) throw new Error("Scoped reply append unavailable");
      appended = result.messages;
      return true;
    });
    if (saved) {
      traceWebsiteMessagesPersisted(lane.ticket.conversationId, appended, 1);
      void publishMessageNew("bot", lane.ticket.conversationId, "OUT");
    }
    return saved;
  } catch (error) {
    console.error("[customer-qualifier] output ledger unavailable:", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}

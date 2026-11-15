// ONE DOOR: a customer DM turn that ends without an answer (13.11.2026).
//
// Owner's rule: "the bot's silence without a reason is an incident". A core turn
// that ends HELD used to be written into the ticket and nothing else: the person
// waited, the CRM chat only showed their text and nobody was told (prod 13.11:
// a client asked about renovated flats in Instagram, `round_limit`, no answer and
// no signal; a job candidate on WhatsApp waited 11 hours).
//
// Every HELD reason is therefore one of two things:
//  - INTENDED silence (listed below, on purpose): not a customer question, spam,
//    our own account, a question the bot must not repeat, or an input put aside
//    for a newer one (the newer one is answered or, if it ends HELD, reported
//    itself);
//  - everything else, including every FUTURE reason by default: a person gets the
//    text and a push "answer by hand" (customerHeldMessage.ts).
// The list itself lives in customerIntendedSilence.ts (one list for both guards).
// Unclassified reasons need no test to be safe: by default they call a person.
import { prisma } from "../db.js";
import { CUSTOMER_TURN_INTENDED_SILENCE, customerTurnSilenceIsIntended } from "./customerIntendedSilence.js";
import { notifyUnansweredCustomerTurn } from "./customerHeldMessage.js";
import { logSystemError } from "./systemError.js";
import { decryptCustomerIngressPayload, type CustomerNormalizedIngressInput } from "./customerIngressPayload.js";

type TicketPayloadRef = { order: bigint | null; scopeKey: string | null; endpointScopeId: string | null; payloadVersion: number | null;
  payloadCiphertext: string | null; payloadHash: string | null };

/** The ticket's own normalized input (strict AES-GCM binding). Null when it is historical or does not decrypt. */
function ticketInput(eventKey: string, row: TicketPayloadRef): CustomerNormalizedIngressInput | null {
  if (row.payloadVersion !== 1 || !row.payloadCiphertext || !row.payloadHash || !row.endpointScopeId || !row.scopeKey || row.order === null) return null;
  try {
    return decryptCustomerIngressPayload({ version: 1, eventKey, order: row.order.toString(), scopeKey: row.scopeKey,
      endpointScopeId: row.endpointScopeId, payloadHash: row.payloadHash }, row.payloadCiphertext);
  } catch {
    return null;
  }
}

export { CUSTOMER_TURN_INTENDED_SILENCE, customerTurnSilenceIsIntended };

/** Called once a core turn ended HELD for `reason`. Never throws. */
export async function reportUnansweredCustomerTurn(eventKey: string, reason: string, opts: { gaveUp?: boolean } = {}): Promise<void> {
  const gaveUp = opts.gaveUp === true;
  if (customerTurnSilenceIsIntended(reason)) return;
  try {
    const [row] = await prisma.$queryRaw<Array<{ conversationId: string | null; channel: string | null; peer: string | null; excerpt: string | null;
      answered: boolean; chatDeleted: boolean } & TicketPayloadRef>>`
      SELECT t."conversationId", c."channel", c."subscriberId" AS "peer",
        (t."originalConversationId" IS NOT NULL AND t."conversationId" IS NULL) AS "chatDeleted",
        t."order", t."scopeKey", t."endpointScopeId", t."payloadVersion", t."payloadCiphertext", t."payloadHash",
        (SELECT left(CASE WHEN jsonb_typeof(m.elem -> 'content')='string' THEN m.elem ->> 'content' ELSE '' END, 160)
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c."messages")='array' THEN c."messages" ELSE '[]'::jsonb END)
          WITH ORDINALITY AS m(elem, ord) WHERE m.elem ->> 'role'='user' ORDER BY m.ord DESC LIMIT 1) AS "excerpt",
        -- "answered" = nobody needs to be alarmed: an answer exists or is coming, the ticket is not HELD any more or a worker holds it,
        -- or a person already runs this chat (pause, opt-out, property chat agent, the last message is not the customer's).
        -- A responsible agent is NOT "answered" (review 193-2, 15.11): the push goes exactly to that agent.
        (EXISTS (SELECT 1 FROM "CustomerOutboxPart" p WHERE p."ticketEventKey"=t."eventKey") OR EXISTS (SELECT 1 FROM "CustomerPropertyIngressTicket" x
          WHERE x."scopeKey"=t."scopeKey" AND x."endpointScopeId"=t."endpointScopeId" AND x."order">t."order" AND x."processingState" IN ('PLANNED','RECEIVED','CLAIMED'))
          -- after the queue job gave up, a ticket left in RECEIVED/CLAIMED is exactly the failure: only PLANNED means answered
          OR (CASE WHEN ${gaveUp}::boolean THEN t."processingState"='PLANNED'
                ELSE t."processingState" IS DISTINCT FROM 'HELD' OR (t."leaseOwner" IS NOT NULL AND t."leaseUntil" > now()) END)
          OR (c."id" IS NOT NULL AND (
            (c."pausedUntil" IS NOT NULL AND c."pausedUntil" > now()) OR c."optedOutAt" IS NOT NULL OR c."propertyChatAgentId" IS NOT NULL
            OR (c."messages" -> -1 ->> 'role') IS DISTINCT FROM 'user'))) AS "answered"
      FROM "CustomerPropertyIngressTicket" t LEFT JOIN "BotConversation" c ON c."id"=t."conversationId"
      WHERE t."eventKey"=${eventKey} AND t."tombstonedAt" IS NULL`;
    if (!row || row.answered) return; // gone, or the customer already got an answer to this or a newer input
    // A chat staff deleted stays deleted: their decision, the core does not resurrect it (customerIngressProducer.ts).
    if (row.chatDeleted) {
      void logSystemError("meta", `Бот не ответил клиенту (причина «${reason}»): чат этого человека удалён сотрудником — человека не зовём.`,
        { dedupKey: `customer-turn-unanswered-deleted:${reason}`, quietPult: true });
      return;
    }
    if (!row.conversationId) {
      // No CRM chat (15.11.2026, task 5): who and where come from the ticket's own encrypted input, never from a guess.
      const input = ticketInput(eventKey, row);
      await notifyUnansweredCustomerTurn({ reason, channel: input?.channel ?? "", peer: input?.peer ?? "", conversationId: null,
        accountExternalId: input?.accountExternalId ?? null, displayName: input?.displayName ?? null,
        excerpt: input?.inputText.trim().slice(0, 160) || "[сообщение без текста]" });
      return;
    }
    await notifyUnansweredCustomerTurn({ reason, channel: row.channel ?? "", peer: row.peer ?? "", conversationId: row.conversationId,
      excerpt: (row.excerpt ?? "").trim() || "[сообщение без текста]" });
  } catch (error) {
    void logSystemError("meta", `Не удалось сообщить о неотвеченном ходе бота (${reason}): ${error instanceof Error ? error.message : String(error)}`,
      { dedupKey: "customer-turn-unanswered-report-failed", quietPult: true });
  }
}

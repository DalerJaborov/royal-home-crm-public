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
// The guard test customer-turn-silence.test.ts fails when a literal stored as a
// ticket `errorCode` by the turn code is not classified.
import { prisma } from "../db.js";
import { CUSTOMER_NON_INPUT_TICKET_CODES } from "./customerIngressNonInput.js";
import { NEWER_INPUT_PENDING, NEWER_INPUT_RESUMED } from "./customerNewerInboxInput.js";
import { notifyUnansweredCustomerTurn } from "./customerHeldMessage.js";
import { logSystemError } from "./systemError.js";

/** Silence that is the product's decision. Keep every entry justified. */
export const CUSTOMER_TURN_INTENDED_SILENCE: readonly string[] = [
  ...CUSTOMER_NON_INPUT_TICKET_CODES, // echo of our own message, ad-click marker, bare template echo: the customer said nothing
  "own_account", // a message from one of our own accounts
  "spam_muted_no_reply", // spam is muted on purpose (customerSpamTurn)
  "foreign_share_no_reply", // a foreign post forwarded with no question
  "attachment_question_repeat_no_reply", // the same attachment question is never asked twice
  NEWER_INPUT_PENDING, NEWER_INPUT_RESUMED, // put aside for a newer input, which carries its words
  "already_planned", // not a failure: the answer exists
  "staff_sender", "outgoing_mid", // our own staff or our own message coming back: the customer said nothing
  "turn_already_owned", // another worker is running this very turn
];

export function customerTurnSilenceIsIntended(reason: string): boolean {
  return CUSTOMER_TURN_INTENDED_SILENCE.includes(reason);
}

/** Called once a core turn ended HELD for `reason`. Never throws. */
export async function reportUnansweredCustomerTurn(eventKey: string, reason: string, opts: { gaveUp?: boolean } = {}): Promise<void> {
  const gaveUp = opts.gaveUp === true;
  if (customerTurnSilenceIsIntended(reason)) return;
  try {
    const [row] = await prisma.$queryRaw<Array<{ conversationId: string | null; channel: string | null; peer: string | null; excerpt: string | null;
      answered: boolean }>>`
      SELECT t."conversationId", c."channel", c."subscriberId" AS "peer",
        (SELECT left(CASE WHEN jsonb_typeof(m.elem -> 'content')='string' THEN m.elem ->> 'content' ELSE '' END, 160)
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c."messages")='array' THEN c."messages" ELSE '[]'::jsonb END)
          WITH ORDINALITY AS m(elem, ord) WHERE m.elem ->> 'role'='user' ORDER BY m.ord DESC LIMIT 1) AS "excerpt",
        -- "answered" = nobody needs to be alarmed: an answer exists or is coming, the ticket is not HELD any more or a worker holds it,
        -- or a person already runs this chat (pause, opt-out, own agent, the last message is not the customer's).
        (EXISTS (SELECT 1 FROM "CustomerOutboxPart" p WHERE p."ticketEventKey"=t."eventKey") OR EXISTS (SELECT 1 FROM "CustomerPropertyIngressTicket" x
          WHERE x."scopeKey"=t."scopeKey" AND x."endpointScopeId"=t."endpointScopeId" AND x."order">t."order" AND x."processingState" IN ('PLANNED','RECEIVED','CLAIMED'))
          -- after the queue job gave up, a ticket left in RECEIVED/CLAIMED is exactly the failure: only PLANNED means answered
          OR (CASE WHEN ${gaveUp}::boolean THEN t."processingState"='PLANNED'
                ELSE t."processingState" IS DISTINCT FROM 'HELD' OR (t."leaseOwner" IS NOT NULL AND t."leaseUntil" > now()) END)
          OR (c."id" IS NOT NULL AND (
            (c."pausedUntil" IS NOT NULL AND c."pausedUntil" > now()) OR c."optedOutAt" IS NOT NULL OR c."propertyChatAgentId" IS NOT NULL
            OR (c."messages" -> -1 ->> 'role') IS DISTINCT FROM 'user'
            OR EXISTS (SELECT 1 FROM "Client" cl JOIN "Agent" ag ON ag."id"=cl."assignedAgentId"
              WHERE cl."id"=c."clientId" AND ag."isActive" AND cl."status" NOT IN ('LOST','ARCHIVED') AND cl."workStatus" <> 'INACTIVE')))) AS "answered"
      FROM "CustomerPropertyIngressTicket" t LEFT JOIN "BotConversation" c ON c."id"=t."conversationId"
      WHERE t."eventKey"=${eventKey} AND t."tombstonedAt" IS NULL`;
    if (!row || row.answered) return; // gone, or the customer already got an answer to this or a newer input
    await notifyUnansweredCustomerTurn({ reason, channel: row.channel ?? "", peer: row.peer ?? "", conversationId: row.conversationId,
      excerpt: (row.excerpt ?? "").trim() || "[сообщение без текста]" });
  } catch (error) {
    void logSystemError("meta", `Не удалось сообщить о неотвеченном ходе бота (${reason}): ${error instanceof Error ? error.message : String(error)}`,
      { dedupKey: "customer-turn-unanswered-report-failed", quietPult: true });
  }
}

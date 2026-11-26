// ONE LIST of the customer turns the bot leaves unanswered ON PURPOSE (15.11.2026).
//
// Two guards decide "call a person or not": the instant one after a core turn
// (customerTurnSilence.ts) and the 30-minute sweep (clientWaitingAlert.ts). Until
// 15.11 each had its own list and they already disagreed (review 193-4): a reason
// added to one list made the two guards decide differently. Both now read this
// list; the test customer-turn-silence.test.ts fails if a second list appears.
import { CUSTOMER_NON_INPUT_TICKET_CODES } from "./customerIngressNonInput.js";
import { NEWER_INPUT_PENDING, NEWER_INPUT_RESUMED } from "./customerNewerInboxInput.js";

/** Silence that is the product's decision. Keep every entry justified. Every other reason calls a person. */
export const CUSTOMER_TURN_INTENDED_SILENCE: readonly string[] = [
  ...CUSTOMER_NON_INPUT_TICKET_CODES, // echo of our own message, ad-click marker, bare template echo: the customer said nothing
  "own_account", // a message from one of our own accounts
  "spam_muted_no_reply", // spam is muted on purpose (customerSpamTurn)
  "spam_filtered_no_reply", // a spam turn in the lead-only mode: no model, no reply, no signal (owner 20.11.2026)
  "foreign_share_no_reply", // a foreign post forwarded with no question
  "attachment_question_repeat_no_reply", // the same attachment question is never asked twice
  NEWER_INPUT_PENDING, NEWER_INPUT_RESUMED, // put aside for a newer input, which carries its words
  "already_planned", // not a failure: the answer exists
  "staff_sender", "outgoing_mid", // our own staff or our own message coming back: the customer said nothing
  "turn_already_owned", // another worker is running this very turn
  "lead_only_operator_silent", // the lead-only operator decided not to answer (ок after a lead, a third role question, a repeated attachment)
  "ack_only_reaction", // «ок / спасибо / пока» with nothing to answer: a reaction instead of text, decided by code (ai/ackTurnDoor.ts, owner 26.11.2026)
  // NOT here: "lead_only_operator_yields" — the bot stays silent because a staff member leads the chat; the silence watchdog
  // must see it (review #333, round 2), the operator also signals that person at once.
];

export function customerTurnSilenceIsIntended(reason: string): boolean {
  return CUSTOMER_TURN_INTENDED_SILENCE.includes(reason);
}

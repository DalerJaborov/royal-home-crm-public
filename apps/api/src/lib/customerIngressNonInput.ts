// ONE DOOR: which provider frames carry NO customer input (13.11.2026).
//
// Our own outgoing message comes back from Meta as an echo; an ad click can
// arrive as a referral-only marker; a template we sent can come back as a bare
// template echo. None of them is something the customer said, so none of them
// may decide which engine (LEGACY or CORE) owns the conversation.
//
// Incident 12.11.2026 (prod): an echo of our first DM was stored with the
// active CORE revision although the account runs LEGACY. When the person
// answered, the enrollment history check saw "CORE already owns this subject",
// held the turn, and the Meta webhook answered 503 for fifteen minutes until
// Meta dropped the customer's message. Routing, the RAW producer and every
// ownership read take the decision from here, never from a local copy.
import { Prisma } from "../generated/prisma/client.js";
import type { CustomerNormalizedIngressInput } from "./customerIngressPayload.js";

/** Same reason strings the FINAL classifier stores as `errorCode`
 * (customerIngressClassification.ts), so historical rows match too. */
export const CUSTOMER_NON_INPUT_TICKET_CODES = ["provider_echo", "referral_only", "bare_template"] as const;
export type CustomerNonInputTicketCode = (typeof CUSTOMER_NON_INPUT_TICKET_CODES)[number];

export function customerNonInputCode(entry: Pick<CustomerNormalizedIngressInput, "observations">): CustomerNonInputTicketCode | null {
  if (entry.observations.providerEcho) return "provider_echo";
  if (entry.observations.referralOnly) return "referral_only";
  if (entry.observations.classifier?.bareTemplateEcho === true) return "bare_template";
  return null;
}

/** SQL predicate: this ticket row is a real customer input (or not yet known
 * otherwise). Use it in EVERY query that reads tickets as evidence of who owns
 * a subject. Echo rows written before 13.11 keep their CORE revision forever
 * (the column is immutable), so the stored `errorCode` is what excludes them.
 * `alias` is a fixed table alias from the caller's own SQL, never input. */
export function customerTicketIsInputSql(alias?: "t"): Prisma.Sql {
  const column = Prisma.raw(alias ? `${alias}."errorCode"` : `"errorCode"`);
  return Prisma.sql`(${column} IS NULL OR ${column} NOT IN (${Prisma.join([...CUSTOMER_NON_INPUT_TICKET_CODES])}))`;
}

import type { CustomerAgentDecision, CustomerAgentVerifiedContext } from "@royal-home/shared";
import { customerAgentIntake } from "./customerAgentIntake.js";
import { foldCustomerText } from "./customerAgentRole.js";
import { BW, EW } from "./wordBoundary.js";
import { customerAgencyTermsAsked, customerCommissionWordsAsked } from "./customerAgentPolicyAsked.js";

/**
 * Server guard for a DM seller whose model decision answered the wrong subject (30.10.2026 live probes:
 * "у меня дом на продажу" -> "арендой не занимаемся"; "продам двушку 450000" -> only the commission).
 * Pure: reads the customer's own words and the already observed evidence, never invents a fact. A rental refusal is
 * honest only when the customer spoke about renting; the commission is an answer only when the customer asked about it.
 */
export const SELLER_POLICY_MISMATCH_CAUSE = "repair:seller_policy_mismatch";
export const SELLER_COMMISSION_NO_INTAKE_CAUSE = "repair:seller_commission_no_intake";
export const SELLER_TERMS_UNANSWERED_CAUSE = "repair:seller_terms_unanswered";

const RENT_MENTION = new RegExp(`${BW}(?:аренд\\p{L}*|сдам|сдаю|сдаем|сда(?:ть|вать)|сдается|сдаются|сними\\p{L}*|снять|снимать|ичора\\p{L}*|наем\\p{L}*)${EW}`, "u");

// «Какая комиссия?», «Чи шарту шароит доред?»: ONE detector with the renderer's gate (customerAgentPolicyAsked.ts, 17.11.2026).
// Two copies drifted: the seller guard forced the commission for «шарту шароит», and the renderer then dropped it as unasked.
const asksTermsQuestion = customerAgencyTermsAsked;
/** The commission was asked about (the older, wider reading: «комиссия 2% устроит» keeps a commission answer the model chose). */
function asksTerms(text: string): boolean {
  return customerCommissionWordsAsked(text) || asksTermsQuestion(text);
}
/** A seller (this turn or the remembered intake) asks about the agency's terms: the server reads the commission itself. */
export function customerSellerAskedTerms(input: { inputText: string; verifiedContext?: Pick<CustomerAgentVerifiedContext, "intake" | "turns"> }): boolean {
  if (!asksTermsQuestion(input.inputText)) return false;
  const prior = input.verifiedContext?.intake;
  const recent = customerAgentIntake(prior ? [] : input.verifiedContext?.turns ?? [], input.inputText, prior?.role);
  return (recent.role !== "unknown" ? recent.role : prior?.role) === "seller";
}

type Evidence = { ref: string; value: { kind: string; topic?: string } };
export function guardSellerDecision(input: { decision: CustomerAgentDecision; evidence: readonly Evidence[]; surface: string;
  inputText: string; verifiedContext?: Pick<CustomerAgentVerifiedContext, "intake" | "turns"> }): { decision: CustomerAgentDecision; cause: string } | null {
  const d = input.decision;
  if (input.surface !== "dm" || (d.kind !== "reply" && d.kind !== "clarify")) return null;
  // The seller asked for the terms and the commission was read this turn: it is THE answer, whatever the model chose instead
  // (a phone, «амвол ё кор?», «Фаҳмидам.»). The intake continues with the seller question, never a phone demand first.
  const commission = input.evidence.find(e => e.value.kind === "company_policy" && e.value.topic === "commission");
  if (commission && !d.refs.includes(commission.ref) && customerSellerAskedTerms(input)) {
    return { cause: SELLER_TERMS_UNANSWERED_CAUSE, decision: { kind: "reply", refs: [...d.refs, commission.ref], social: d.social, question: "seller_details" } };
  }
  // "clarify_previous" with no bot question before it has nothing to repair: live Gemini 31.10 answered "хонаи фуруши дорам" with it ("Чиро муфассалтар шарҳ диҳам?").
  const nothingToRepair = input.verifiedContext?.turns.at(-1)?.role !== "assistant";
  const topicOnly = !d.refs.length && (d.question === "topic" || d.question === "clarify_previous" && nothingToRepair);
  if (!d.refs.length && !topicOnly) return null;
  const referenced = d.refs.map(ref => input.evidence.find(e => e.ref === ref)?.value);
  if (!topicOnly && referenced.some(value => !value || value.kind !== "company_policy")) return null;
  const prior = input.verifiedContext?.intake;
  const recent = customerAgentIntake(prior ? [] : input.verifiedContext?.turns ?? [], input.inputText, prior?.role);
  const role = recent.role !== "unknown" ? recent.role : prior?.role;
  if (role !== "seller") return null;
  const words = foldCustomerText(input.inputText);
  const rentTopic = referenced.every(value => value?.topic === "rental"), commissionTopic = referenced.every(value => value?.topic === "commission");
  // A bare "what should I explain?" to a seller who just named an object is the same miss (30.10: "хонаи фуруши дорам").
  const mismatch = topicOnly || rentTopic && !RENT_MENTION.test(words) || commissionTopic && !asksTerms(input.inputText);
  if (mismatch) return { cause: SELLER_POLICY_MISMATCH_CAUSE,
    decision: { kind: "clarify", refs: [], social: d.social, question: "seller_details", ...(d.say ? { say: d.say } : {}) } };
  // The seller asked about the commission: keep the verified answer, but do not leave the intake unanswered (question: none).
  if (commissionTopic && d.kind === "reply" && d.question === "none") return { cause: SELLER_COMMISSION_NO_INTAKE_CAUSE, decision: { ...d, question: "seller_details" } };
  return null;
}

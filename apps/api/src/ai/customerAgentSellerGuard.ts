import type { CustomerAgentDecision, CustomerAgentVerifiedContext } from "@royal-home/shared";
import { customerAgentIntake } from "./customerAgentIntake.js";
import { foldCustomerText } from "./customerAgentRole.js";
import { BW, EW } from "./wordBoundary.js";

/**
 * Server guard for a DM seller whose model decision answered the wrong subject (30.10.2026 live probes:
 * "у меня дом на продажу" -> "арендой не занимаемся"; "продам двушку 450000" -> only the commission).
 * Pure: reads the customer's own words and the already observed evidence, never invents a fact. A rental refusal is
 * honest only when the customer spoke about renting; the commission is an answer only when the customer asked about it.
 */
export const SELLER_POLICY_MISMATCH_CAUSE = "repair:seller_policy_mismatch";

const RENT_MENTION = new RegExp(`${BW}(?:аренд\\p{L}*|сдам|сдаю|сдаем|сда(?:ть|вать)|сдается|сдаются|сними\\p{L}*|снять|снимать|ичора\\p{L}*|наем\\p{L}*)${EW}`, "u");
const COMMISSION_ASK = new RegExp(`${BW}(?:комисс\\p{L}*|процент\\p{L}*|фоиз\\p{L}*|чанпул|чанд пул|хаки хизмат|хакки хизмат|кобиш|стоимост\\p{L}*|тариф\\p{L}*|оплат\\p{L}*|берете|берет|возьмете|возьмет|получу|получит\\p{L}*|на руки)${EW}|${BW}сколько (?:стоит|будет стоить|с меня|с продавц\\p{L}*|вы берете|берут|ваш\\p{L}*)${EW}|${BW}какой (?:у вас )?процент${EW}`, "u");

type Evidence = { ref: string; value: { kind: string; topic?: string } };
export function guardSellerDecision(input: { decision: CustomerAgentDecision; evidence: readonly Evidence[]; surface: string;
  inputText: string; verifiedContext?: Pick<CustomerAgentVerifiedContext, "intake" | "turns"> }): CustomerAgentDecision | null {
  const d = input.decision;
  if (input.surface !== "dm" || (d.kind !== "reply" && d.kind !== "clarify")) return null;
  const topicOnly = !d.refs.length && d.question === "topic";
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
  const mismatch = topicOnly || rentTopic && !RENT_MENTION.test(words) || commissionTopic && !COMMISSION_ASK.test(words);
  return mismatch ? { kind: "clarify", refs: [], social: d.social, question: "seller_details", ...(d.say ? { say: d.say } : {}) } : null;
}

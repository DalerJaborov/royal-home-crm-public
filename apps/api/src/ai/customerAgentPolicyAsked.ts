import type { CustomerAgentCompanyPolicyTopic } from "@royal-home/shared";
import { customerLegalAsked, customerRentalAsked } from "./customerAgentLiveWording.js";
import { foldCustomerTextForRole } from "./customerAgentRole.js";
import { clientOwnWords } from "./untrustedContent.js";
import { BW, EW } from "./wordBoundary.js";

/**
 * ONE door: did the customer's OWN words ask about this company term? (17.11.2026, ported from the old PR #173)
 *
 * A company term (commission, installments, bargaining, documents, rental) is printed in a DM only for the customer's
 * own question about it, like the office address. Live cases: an address question got the bargaining rule; a
 * candidate's picture got "no installments"; a seller who only named the object got the rental refusal (30.10).
 * Quoted ads, forwarded documents and assistant prose never count (clientOwnWords). The decision is the server's,
 * never the model's: the model only chooses which terms to read.
 * Legal and rental keep their audited wordings (customerAgentLiveWording.ts); the other topics live here, in the
 * folded alphabet of foldCustomerTextForRole (ҳ→х, ӯ→у, ҷ→ч, қ→к, ғ→г, ӣ→и, ё→е; Latin Tajik is transliterated).
 */
const L = "\\p{L}*";
const asked = (source: string) => new RegExp(`${BW}(?:${source})${EW}`, "u");
const POLICY_ASKED: Partial<Record<CustomerAgentCompanyPolicyTopic, RegExp>> = {
  commission: asked(`комисс${L}|процент${L}|фоиз${L}|чанпул|чанд пул|хак+и хизмат|нархи хизмат${L}|кобиш|стоимост${L}|тариф${L}|оплат${L}|берете|берет|возьмете|возьмет|получу|получит${L}|на руки|бесплатн${L}|бепул${L}|ройгон${L}|платн${L}|ваши услуги|услуги ваш${L}|сколько (?:стоит|стоят|будет стоить|с меня|с продавц${L}|вы берете|берут|ваш${L})|какой (?:у вас )?процент|хизматрасони${L}(?: \\p{L}+)? чанд|за что (?:вы )?(?:берете|платить)`),
  payment: asked(`рассрочк${L}|ипотек${L}|кредит${L}|кисм${L}|насия${L}|банк${L}|частями|по частям`),
  negotiation: asked(`торг${L}|скидк${L}|уступ${L}|дешевле|дорого|тахфиф${L}|арзон${L}|савдо${L}|кам (?:мекун|кун)${L}`),
};

/** `service_scope` has its own rule (serviceScopeLines in the renderer): the work area is answered by where the flat is. */
export function customerPolicyTermAsked(topic: CustomerAgentCompanyPolicyTopic, text: string): boolean {
  if (topic === "service_scope") return true;
  if (topic === "legal") return customerLegalAsked(text);
  if (topic === "rental") return customerRentalAsked(text);
  const pattern = POLICY_ASKED[topic];
  return !!pattern && pattern.test(foldCustomerTextForRole(clientOwnWords(text)));
}

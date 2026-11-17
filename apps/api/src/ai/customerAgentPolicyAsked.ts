import type { CustomerAgentCompanyPolicyTopic } from "@royal-home/shared";
import { customerLegalAsked, customerRentalAsked } from "./customerAgentLiveWording.js";
import { foldCustomerTextForRole } from "./customerAgentRole.js";
import { customerRecruitmentRequested } from "./customerAgentRecruitmentProtocol.js";
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
const ownWords = (text: string) => foldCustomerTextForRole(clientOwnWords(text));

/**
 * The agency's fee named in the customer's words. The seller guard (customerAgentSellerGuard.ts) reads the same detector.
 * «А для покупателя?», «барои харидор чӣ?» is the follow-up to a commission line: without it the gate dropped the answer.
 */
const COMMISSION_ASKED = asked(`комисс${L}|процент${L}|фоиз${L}|чанпул|чанд пул|хак+и хизмат|нархи хизмат${L}|кобиш|стоимост${L}|тариф${L}|оплат${L}|берете|берет|возьмете|возьмет|получу|получит${L}|на руки|бесплатн${L}|бепул${L}|ройгон${L}|платн${L}|ваши услуги|услуги ваш${L}|сколько (?:стоит|стоят|будет стоить|с меня|с продавц${L}|вы берете|берут|ваш${L})|какой (?:у вас )?процент|хизматрасони${L}(?: \\p{L}+)? чанд|за что (?:вы )?(?:берете|платить)|(?:для|с) (?:покупател|продавц)(?:я|а)|барои (?:харидор|фурушанда)`);
/**
 * «Чи шарту шароит доред?», «какие у вас условия?»: the agency's terms ARE the commission (Facebook 16.11.2026 17:44: a seller
 * asked this, the bot demanded a phone and said «Фаҳмидам.» twice, the client left). Never the terms of a mortgage, instalments,
 * a discount, rent or a job.
 */
const TERMS_WORD = asked(`шарт${L}|шароит${L}|услови${L}`);
const NOT_AGENCY_TERMS = asked(`ипотек${L}|кредит${L}|рассроч${L}|насия${L}|карз${L}|кисм${L}|скидк${L}|тахфиф${L}|аренд${L}|ичора${L}|кироя${L}`);
/** A QUESTION, not a description: «все условия есть», «ҳама шароит дорад», «шароиташ хуб» describe the flat (re-review #211, п.7). */
const ASKING_TERMS = asked(`какие|какая|какой|каковы|каков|сколько|чи|чист|чанд|кадом|расскажите|подскажите|скажите|бигуед|узнать|донам|гуна|хел`);
/**
 * «со всеми условиями», «ҳама шароит»: the flat's amenities, never the agency's terms. Not after a question word:
 * «Какие все условия?», «Чи ҳама шартҳо?» ask the agency's terms (fourth review of #211, п.3).
 */
const AMENITIES = new RegExp(`(?<!${BW}(?:какие|каковы|какая|какой|чи|кадом|кадоме)\\s+)${BW}(?:все|всеми|всех|хама|хамаи|бо\\s+хама)\\s+(?:услови\\p{L}*|шароит\\p{L}*|шарт\\p{L}*)`, "u");

/** The customer's own words name the agency's fee («комиссия 2% устроит» counts too: the wider reading). */
export function customerCommissionWordsAsked(text: string): boolean {
  return COMMISSION_ASKED.test(ownWords(text));
}

/** The customer ASKS what the agency takes: a fee word or «какие у вас условия?», as a question. One detector for the renderer and the seller guard. */
export function customerAgencyTermsAsked(text: string): boolean {
  const words = ownWords(text);
  return (COMMISSION_ASKED.test(words) || TERMS_WORD.test(words) && !AMENITIES.test(words)) &&
    (/[?؟]/u.test(clientOwnWords(text)) || ASKING_TERMS.test(words)) && !NOT_AGENCY_TERMS.test(words) && !customerRecruitmentRequested(text);
}

const POLICY_ASKED: Partial<Record<CustomerAgentCompanyPolicyTopic, RegExp>> = {
  payment: asked(`рассрочк${L}|ипотек${L}|кредит${L}|кисм${L}|насия${L}|банк${L}|частями|по частям`),
  negotiation: asked(`торг${L}|скидк${L}|уступ${L}|дешевле|дорого|тахфиф${L}|арзон${L}|савдо${L}|кам (?:мекун|кун)${L}`),
};

/** `service_scope` has its own rule (serviceScopeLines in the renderer): the work area is answered by where the flat is. */
export function customerPolicyTermAsked(topic: CustomerAgentCompanyPolicyTopic, text: string): boolean {
  if (topic === "service_scope") return true;
  if (topic === "legal") return customerLegalAsked(text);
  if (topic === "rental") return customerRentalAsked(text);
  if (topic === "commission") return customerCommissionWordsAsked(text) || customerAgencyTermsAsked(text);
  const pattern = POLICY_ASKED[topic];
  return !!pattern && pattern.test(ownWords(text));
}

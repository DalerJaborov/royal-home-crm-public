import type { CustomerAgentCompanyPolicyTopic } from "@royal-home/shared";
import { customerLegalAsked, customerRentalAsked, customerRentalAskedRecently } from "./customerAgentLiveWording.js";
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
/**
 * The whole message is the terms word: «Условия.», «шартҳо», «шарту шароит» (review of #269: messengers write the question
 * this way, and before the gate the commission was printed). One or two such words and nothing else; inside a longer
 * phrase without a question («мне условия не важны») it stays a description.
 */
// A polite word around it is still the question (rest of the #269 review, 18.11.2026): «Условия, пожалуйста», «Условия пожалуйста»,
// «Пожалуйста, условия», «Шартҳо, илтимос» (the fold drops the comma).
const POLITE = "(?:пожалуйста|пожалуста|плиз|пж|please|илтимос|лутфан|бемалол|скажите|подскажите|бигуед)";
const TERM = "(?:шарт\\p{L}*|шароит\\p{L}*|услови\\p{L}*)";
const BARE_TERMS = new RegExp(`^(?:${POLITE} )?${TERM}(?: ${TERM})?(?: ${POLITE})?$`, "u");
/** «Az 2% kam nameshava?», «2% меньше можно?»: a percent with a «less» word is about OUR fee, never the owner's price (audit 17.11). */
const PERCENT_BARGAIN = new RegExp(`\\d\\s*%[^\\n]{0,40}${BW}(?:кам\\p{L}*|меньше|ниже|скидк\\p{L}*|сниз\\p{L}*|тахфиф\\p{L}*|арзон\\p{L}*)${EW}|` +
  `${BW}(?:кам\\p{L}*|меньше|скидк\\p{L}*|тахфиф\\p{L}*)${EW}[^\\n]{0,20}\\d\\s*%`, "u");
const AMENITIES = new RegExp(`(?<!${BW}(?:какие|каковы|какая|какой|чи|кадом|кадоме)\\s+)${BW}(?:все|всеми|всех|хама|хамаи|бо\\s+хама)\\s+(?:услови\\p{L}*|шароит\\p{L}*|шарт\\p{L}*)`, "u");

/** The customer's own words name the agency's fee («комиссия 2% устроит» counts too: the wider reading). */
export function customerCommissionWordsAsked(text: string): boolean {
  const words = ownWords(text);
  return COMMISSION_ASKED.test(words) || PERCENT_BARGAIN.test(words);
}

/** The customer ASKS what the agency takes: a fee word or «какие у вас условия?», as a question. One detector for the renderer and the seller guard. */
export function customerAgencyTermsAsked(text: string): boolean {
  const own = clientOwnWords(text), words = foldCustomerTextForRole(own);
  if (NOT_AGENCY_TERMS.test(words) || customerRecruitmentRequested(text)) return false;
  if (BARE_TERMS.test(words)) return true;
  const isQuestion = (raw: string, folded: string) => /[?؟]/u.test(raw) || ASKING_TERMS.test(folded);
  if (COMMISSION_ASKED.test(words) && isQuestion(own, words)) return true;
  // «Условия» asks only inside its own clause: «мне условия не важны, сколько комнат?» is a question about rooms.
  return (own.match(/[^,.;!?؟\n]+[,.;!?؟\n]*/gu) ?? []).some(clause => {
    const folded = foldCustomerTextForRole(clause);
    return TERMS_WORD.test(folded) && !AMENITIES.test(folded) && isQuestion(clause, folded);
  });
}

const POLICY_ASKED: Partial<Record<CustomerAgentCompanyPolicyTopic, RegExp>> = {
  payment: asked(`рассрочк${L}|ипотек${L}|кредит${L}|кисм${L}|насия${L}|банк${L}|частями|по частям`),
  negotiation: asked(`торг${L}|скидк${L}|уступ${L}|дешевле|дорого|тахфиф${L}|арзон${L}|савдо${L}|кам (?:мекун|кун)${L}`),
};

/** The customer's earlier messages in this chat, oldest first (the rental rule looks at the last three, #267). */
export function customerRecentUserTexts(context?: { turns: readonly { role: string; text: string }[] } | null): string[] {
  return (context?.turns ?? []).filter(turn => turn.role === "user").map(turn => turn.text);
}

/**
 * `service_scope` has its own rule (serviceScopeLines in the renderer): the work area is answered by where the flat is.
 * `recentTurns` (the customer's earlier messages) matter only for rental: «хочу снять квартиру», then «Центр», then «Сколько
 * это будет стоить?» still speaks about renting (#267, 17.11.2026). Every other term answers only the current question.
 */
export function customerPolicyTermAsked(topic: CustomerAgentCompanyPolicyTopic, text: string, recentTurns?: readonly string[]): boolean {
  if (topic === "service_scope") return true;
  if (topic === "legal") return customerLegalAsked(text);
  if (topic === "rental") return recentTurns ? customerRentalAskedRecently(text, recentTurns) : customerRentalAsked(text);
  if (topic === "commission") return customerCommissionWordsAsked(text) || customerAgencyTermsAsked(text);
  const pattern = POLICY_ASKED[topic];
  // A percent haggle is about our fee (commission above), never the owner's price.
  if (topic === "negotiation" && PERCENT_BARGAIN.test(ownWords(text))) return false;
  return !!pattern && pattern.test(ownWords(text));
}

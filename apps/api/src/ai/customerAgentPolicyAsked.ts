import type { CustomerAgentCompanyPolicyTopic } from "@royal-home/shared";
import { foldCustomerText } from "./customerAgentRole.js";
import { clientOwnWords } from "./untrustedContent.js";
import { BW, EW } from "./wordBoundary.js";

/**
 * ONE door: did the customer's OWN words ask about this company term? (13.11.2026)
 *
 * A company term (commission, rental, payment, bargaining, documents, cities) is printed in a DM
 * only for the customer's own question about it, like the office address. Live cases: an address
 * question got the bargaining rule; a candidate's picture got "no installments"; a seller who
 * only named the object got the rental refusal (30.10). The renderer and the seller guard both
 * ask here; quoted ads, forwarded documents and assistant prose never count (clientOwnWords).
 * Patterns are in the folded alphabet of foldCustomerText (ҳ→х, ӯ→у, ҷ→ч, қ→к, ғ→г, ӣ→и, ё→е).
 */
const L = "\\p{L}*";
const asked = (source: string) => new RegExp(`${BW}(?:${source})${EW}`, "u");
const POLICY_ASKED: Record<CustomerAgentCompanyPolicyTopic, RegExp> = {
  commission: asked(`комисс${L}|процент${L}|фоиз${L}|чанпул|чанд пул|хак+и хизмат|нархи хизмат${L}|кобиш|стоимост${L}|тариф${L}|оплат${L}|берете|берет|возьмете|возьмет|получу|получит${L}|на руки|бесплатн${L}|бепул${L}|ройгон${L}|платн${L}|ваши услуги|услуги ваш${L}|сколько (?:стоит|стоят|будет стоить|с меня|с продавц${L}|вы берете|берут|ваш${L})|какой (?:у вас )?процент|хизматрасони${L}(?: \\p{L}+)? чанд|за что (?:вы )?(?:берете|платить)`),
  rental: asked(`аренд${L}|сдам|сдаю|сдаем|сда(?:ть|вать)|сдается|сдаются|сдаете|сними${L}|снять|снимать|ичора${L}|ijora|наем${L}|кирой${L}`),
  payment: asked(`рассрочк${L}|ипотек${L}|ipoteka|кредит${L}|кисм${L}|насия${L}|банк${L}|частями|по частям`),
  negotiation: asked(`торг${L}|скидк${L}|уступ${L}|дешевле|дорого|тахфиф${L}|арзон${L}|савдо${L}|кам (?:мекун|кун)${L}`),
  legal: asked(`документ${L}|техпаспорт${L}|снос${L}|хуччат${L}|шартнома${L}|нотариус${L}|мбти|бти|вайрон${L}|красн${L} (?:зон|лини)${L}|юридическ${L}|коробк${L}|котлован${L}|сдач${L} дом${L}`),
  service_scope: asked(`город${L}|шахр${L}|худжанд${L}|хучанд${L}|вахдат${L}|гиссар${L}|хисор${L}|турсунзод${L}|бохтар${L}|кулоб${L}|куляб${L}|чортут${L}|област${L}|вилоят${L}|чем (?:вы )?занимаетесь|где работаете`),
};

export function customerAskedPolicyTopic(topic: CustomerAgentCompanyPolicyTopic, text: string): boolean {
  return POLICY_ASKED[topic].test(foldCustomerText(clientOwnWords(text)));
}

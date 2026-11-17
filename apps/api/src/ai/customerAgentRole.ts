import { BW, EW } from "./wordBoundary.js";

/**
 * One reading of "what does this customer want" for the customer agent: the
 * intake (buyer/seller/unknown) and the topic (buyer/seller/job/rent) used to
 * keep two hand-written regex pairs that drifted apart (23.10.2026 probes:
 * "Продам квартиру", "Мо хонаи фуруши дорем" and "Хочу сдать квартиру" were
 * `unknown`; "Продаются квартиры у вас?" and "Осман мефурӯшад" were `seller`).
 * Pure text in, no state: it proves nothing about identity, consent or listings.
 *
 * Text is folded first (case, ё/е, Tajik ӯ ҳ ҷ ӣ қ ғ -> у х ч и к г, punctuation
 * between words -> space), so every pattern below is written in the folded
 * alphabet. Word edges use BW/EW, never `\w`/`\b` (they are Latin-only in JS).
 */
const FOLDED: Record<string, string> = { "ӯ": "у", "ҳ": "х", "ҷ": "ч", "ӣ": "и", "қ": "к", "ғ": "г", "ё": "е" };
export function foldCustomerText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[ӯҳҷӣқғё]/gu, ch => FOLDED[ch] ?? ch)
    .replace(/[ъʼ’'`]/gu, "").replace(/[.,;:!?…«»"()[\]{}\\/|_*~—–-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

const HOUSING = `(?:хона\\p{L}*|хавли\\p{L}*|квартир\\p{L}*|кувартир\\p{L}*|дом(?:а|у|е|ом)?|двор(?:а|у|е)?|участ\\p{L}*|котлован\\p{L}*|замин\\p{L}*|манзил\\p{L}*|жиль\\p{L}*|недвижим\\p{L}*|офис\\p{L}*|магазин\\p{L}*|имарат\\p{L}*|объект\\p{L}*)`;
const HAVE = `(?:дорам|дорем|доштам|доштем|доштм)`;
const re = (source: string) => new RegExp(source, "gu");

const SELL_ACTIVE = re(`${BW}(?:продам|продаю|продаем|продать|продавать|(?:ме)?фур[уо]ш(?:ам|ем)?|фурухт\\p{L}*)${EW}`);
const SELL_PASSIVE = re(`${BW}(?:продается|продаются)${EW}`);
const OWN_HOUSING = [re(`${BW}${HOUSING}${EW}.{0,25}?${BW}${HAVE}${EW}`), re(`${BW}${HAVE}${EW}.{0,25}?${BW}${HOUSING}${EW}`)];
const HOUSING_WORD = new RegExp(`${BW}${HOUSING}${EW}`, "u");
const SELL_OWN =re(`${BW}хонаи худам${EW}`);
// Tajik "for sale" without a housing noun (folded alphabet: фурӯши/фурушӣ -> фуруши): "фуруши дорам", "барои фуруш", "фурушӣ ҳаст".
const SELL_TG = re(`${BW}фуруши?${EW} ${HAVE}${EW}`);
const FOR_SALE_TG = re(`${BW}барои фуруши?${EW}`);
const LANDLORD_ACTIVE = re(`${BW}(?:сдам|сдаю|сдаем|сдать|сдавать)${EW}`);
const LANDLORD_PASSIVE = re(`${BW}(?:сдается|сдаются)${EW}`);
const LANDLORD_TG = re(`${BW}(?:ба )?ичора (?:медихам|медихем|медам|медем)${EW}`);
const RENT_HINT = new RegExp(`аренд|наем|ичора`, "u");
const BUY_STRONG = [
  re(`${BW}(?:хочу|хотим|планирую|собираюсь|хотел\\p{L}* бы)(?: бы)? (?:купить|приобрести)${EW}`),
  re(`${BW}(?:куплю|покупаю|покупаем|приобрету|мехарам|мехарем|харидорам)${EW}`),
  re(`${BW}харидан мехох\\p{L}*${EW}`),
];
const BUY_WEAK = [
  re(`${BW}ищу (?:квартир\\p{L}*|дом(?:а|у|е)?|участ\\p{L}*|жиль\\p{L}*|хавли\\p{L}*|хона\\p{L}*|котлован\\p{L}*)${EW}`),
  re(`${BW}${HOUSING}${EW}.{0,30}?${BW}(?:мечу|мекоб)\\p{L}*${EW}`), re(`${BW}(?:мечу|мекоб)\\p{L}*${EW}.{0,30}?${BW}${HOUSING}${EW}`),
];
const RENT_TENANT = re(`${BW}(?:аренд\\p{L}*|снять|снимать|сниму|ичора)${EW}`);
// "is it for sale / do you sell" is a buyer's question, not an offer to sell.
const BUYER_ASK = re(`${BW}(?:продается|продаются|продаете) ли${EW}|${BW}что (?:у вас )?продает\\p{L}*${EW}`);
const ON_SALE = re(`${BW}на продажу${EW}`);
const FOR_SALE = re(`${BW}в продаже${EW}`);
const ASKING = new RegExp(`${BW}ли${EW}|${BW}у вас${EW}`, "u");
const NEGATED_BEFORE = new RegExp(`(?:^|\\s)(?:не|ни|намех\\p{L}*)\\s+(?:\\p{L}+\\s+)?$`, "u");

/** True when at least one match is not preceded by "не"/"намехоҳам" (one filler word allowed). */
function plain(norm: string, patterns: RegExp | readonly RegExp[]): boolean {
  for (const pattern of Array.isArray(patterns) ? patterns : [patterns]) {
    for (const match of norm.matchAll(pattern)) {
      if (!NEGATED_BEFORE.test(norm.slice(Math.max(0, match.index - 30), match.index))) return true;
    }
  }
  return false;
}

export type CustomerRoleSignals = { buyStrong: boolean; buyWeak: boolean; sell: boolean; landlord: boolean; rent: boolean };
export function customerRoleSignals(text: string): CustomerRoleSignals {
  const norm = foldCustomerText(text);
  const question = /[?؟]/u.test(text) || ASKING.test(norm);
  const passive = plain(norm, SELL_PASSIVE);
  const buyerAsk = plain(norm, BUYER_ASK) || (passive && question) || (question && plain(norm, FOR_SALE));
  const landlord = plain(norm, LANDLORD_TG) ||
    (plain(norm, LANDLORD_ACTIVE) || (plain(norm, LANDLORD_PASSIVE) && !question)) && (RENT_HINT.test(norm) || HOUSING_WORD.test(norm));
  const sell = plain(norm, SELL_ACTIVE) || (passive && !question && !buyerAsk) || plain(norm, SELL_OWN) || plain(norm, SELL_TG) || (!question && !buyerAsk && plain(norm, FOR_SALE_TG)) || (!question && !buyerAsk && plain(norm, ON_SALE)) || plain(norm, OWN_HOUSING);
  return { buyStrong: buyerAsk || plain(norm, BUY_STRONG), buyWeak: plain(norm, BUY_WEAK), sell, landlord,
    rent: plain(norm, RENT_TENANT) };
}

/** Topic-level reading (job wins over buy/sell; a landlord offers property, so it is a seller). */
export function customerTextRole(text: string, jobRequested: boolean): "job" | "buyer" | "seller" | "rent" | null {
  if (jobRequested) return "job";
  const signals = customerRoleSignals(text);
  if (signals.buyStrong) return "buyer";
  if (signals.sell || signals.landlord) return "seller";
  if (signals.rent) return "rent";
  return signals.buyWeak ? "buyer" : null;
}

/**
 * ЧТО БОТ ГОВОРИТ, КОГДА СКАЗАТЬ ЕМУ НЕЧЕГО НОВОГО, — ОДНА ДВЕРЬ (15.11.2026, 8 живых переписок владельца).
 *
 * Живые случаи Instagram 13–15.11:
 *  - «Рахмат» → «Агар саволи ман дар боло номафҳум буд…» (на «спасибо» так не отвечают);
 *  - «Мо дар шаҳри Кайроккум» → «Бори дигар такрор мекунам: …» (грубо и роботно);
 *  - «2% от 700 000 сколько?» → «Ман инро дар боло навишта будам…» (свысока и без ответа);
 *  - «Мошин ҳам қабул мекунед?» → «Андозаи тахфифро … тасдиқ карда наметавонам» (не по вопросу, человека не позвали).
 * ФАКТ (прод, 08–15.11): 30 таких «повторю/я уже писал выше» в 19 переписках, все — из рендера ядра.
 *
 * Правило владельца (15.11): бот НИКОГДА не пишет «я уже писал выше» и «повторяю ещё раз». Передача агенту — только
 * когда клиент правда спрашивает то, на что у бота нет ответа (ревью #201: не на «фаҳмидам» и не на название города).
 * Звонок обещаем, только когда номер уже есть; без номера номер просим ОДИН раз за разговор (tajik-phrasebook, правило 7).
 * Человек узнаёт об обещании через одну дверь alertClientWaiting (lib/customerDmAgentTurn.ts::signalStaffFollowUp).
 *
 * ТАДЖИКСКИЕ СТРОКИ — ТОЛЬКО ПРОВЕРЕННЫЕ (tajik-phrasebook, live-agent-phrases.md, без пометки «(?)»):
 * «Инро аниқ агенти мо мегӯяд» (стр. 43), «Агенти мо ҳамаи тафсилотро ба шумо мегӯяд» (44), «Агенти мо дар вақти корӣ
 * ба шумо занг мезанад» (46), «Рақами телефонатонро нависед, то агенти мо занг занад» (51), «Бемалол, рақами
 * телефонатонро нависед» (52), «Ташаккур, дархости шумо қабул шуд» (27), «Бале» (84), «Марҳамат», «Саломат бошед!»
 * (правила 5–6). Сумма комиссии по-таджикски — только цифрами и знаками, без слов, которые не проверил носитель.
 *
 * Чистые функции без базы: рендер повторяет их при запечатывании ответа и получает тот же текст.
 */
import { clientOwnWords } from "./untrustedContent.js";
import { priceMentions } from "./priceGuard.js";

type Lang = "ru" | "tg";
type KnownPhone = "none" | "current_input" | "scoped_contact";
type Pair = { ru: string; tg: string };
/** What the conversation already holds: was this exact line said, was the phone already asked for. */
export interface FollowUpMemory { said: (line: string) => boolean; phoneAsked: boolean }

const own = (text: string) => clientOwnWords(text ?? "").normalize("NFKC").toLowerCase().replace(/ё/gu, "е");
const pick = (family: readonly Pair[], language: Lang, said: (line: string) => boolean) =>
  (family.find(pair => !said(pair[language])) ?? family[family.length - 1])[language];

/** No phone and never asked: the hand-off asks for it. */
const STAFF_ASK_PHONE: Pair = { ru: "Это точно подскажет наш агент. Напишите, пожалуйста, ваш номер телефона, чтобы агент вам позвонил.",
  tg: "Инро аниқ агенти мо мегӯяд. Рақами телефонатонро нависед, то агенти мо занг занад." };
/** No phone, already asked once in this chat: the hand-off without a second request. */
const STAFF_NO_ASK: readonly Pair[] = [
  { ru: "Это точно подскажет наш агент.", tg: "Инро аниқ агенти мо мегӯяд." },
  { ru: "Все подробности расскажет наш агент.", tg: "Агенти мо ҳамаи тафсилотро ба шумо мегӯяд." },
];
/** The phone is known: the agent will call (true only because the turn signals the responsible person). */
const STAFF_WITH_PHONE: readonly Pair[] = [
  { ru: "Это точно подскажет наш агент. Он позвонит вам в рабочее время.",
    tg: "Инро аниқ агенти мо мегӯяд. Агенти мо дар вақти корӣ ба шумо занг мезанад." },
  { ru: "Все подробности расскажет наш агент.", tg: "Агенти мо ҳамаи тафсилотро ба шумо мегӯяд." },
];
/** Nothing in the catalog fits: an agent searches by hand. */
const SEARCH_ASK_PHONE: Pair = { ru: "Агент подберёт варианты вручную. Напишите, пожалуйста, ваш номер телефона, чтобы агент вам позвонил.",
  tg: "Рақами телефонатонро нависед, то агенти мо занг занад." };
const SEARCH_NO_ASK: Pair = { ru: "Агент подберёт варианты вручную.", tg: "Агенти мо ҳамаи тафсилотро ба шумо мегӯяд." };
const SEARCH_WITH_PHONE: Pair = { ru: "Агент подберёт варианты вручную и позвонит вам в рабочее время.",
  tg: "Агенти мо дар вақти корӣ ба шумо занг мезанад." };
/** A partnership/B2B offer: management decides. */
const PARTNERSHIP: Pair = { ru: "Спасибо, передам руководству.", tg: "Ташаккур, дархости шумо қабул шуд." };
const PARTNERSHIP_PHONE: Pair = { ru: "Оставьте, пожалуйста, номер телефона для связи.", tg: "Бемалол, рақами телефонатонро нависед." };
/** Answer to a bare "thank you": "Марҳамат" plus one farewell, no "write again if…" tail (phrasebook rule 5). */
const THANKS_REPLIES: readonly Pair[] = [
  { ru: "Пожалуйста! Всего доброго.", tg: "Марҳамат! Саломат бошед!" },
  { ru: "Пожалуйста!", tg: "Марҳамат!" },
];

/** The hand-off to a person for a question the bot cannot answer. */
export function customerStaffFollowUpLine(language: Lang, knownPhone: KnownPhone, memory: FollowUpMemory): string {
  if (knownPhone !== "none") return pick(STAFF_WITH_PHONE, language, memory.said);
  return memory.phoneAsked ? pick(STAFF_NO_ASK, language, memory.said) : STAFF_ASK_PHONE[language];
}
/** After "nothing fits" / "no new options": an agent searches by hand. */
export function customerSearchHandOffLine(language: Lang, knownPhone: KnownPhone, memory: FollowUpMemory): string {
  if (knownPhone !== "none") return SEARCH_WITH_PHONE[language];
  return memory.phoneAsked ? SEARCH_NO_ASK[language] : SEARCH_ASK_PHONE[language];
}
export function customerPartnershipReply(language: Lang, knownPhone: KnownPhone, memory: FollowUpMemory): string[] {
  return knownPhone === "none" && !memory.phoneAsked ? [PARTNERSHIP[language], PARTNERSHIP_PHONE[language]] : [PARTNERSHIP[language]];
}
export function customerThanksReply(language: Lang, said: (line: string) => boolean = () => false): string {
  return pick(THANKS_REPLIES, language, said);
}

/** Lines that hand the customer to a person (the turn must signal the responsible person). */
const STAFF_LINES = new Set([STAFF_ASK_PHONE, ...STAFF_NO_ASK, ...STAFF_WITH_PHONE, SEARCH_ASK_PHONE, SEARCH_NO_ASK, SEARCH_WITH_PHONE, PARTNERSHIP]
  .flatMap(pair => [pair.ru, pair.tg]));
/** Lines that ask for the phone: asked once per conversation. */
const PHONE_ASK_LINES = new Set([STAFF_ASK_PHONE, SEARCH_ASK_PHONE, PARTNERSHIP_PHONE].flatMap(pair => [pair.ru, pair.tg]));
export function customerStaffFollowUpFixedLines(): string[] {
  return [STAFF_ASK_PHONE, ...STAFF_NO_ASK, ...STAFF_WITH_PHONE, SEARCH_ASK_PHONE, SEARCH_NO_ASK, SEARCH_WITH_PHONE,
    PARTNERSHIP, PARTNERSHIP_PHONE, ...THANKS_REPLIES].flatMap(pair => [pair.ru, pair.tg]);
}
export function customerPhoneAskLines(): string[] { return [...PHONE_ASK_LINES]; }
/** The reply told the customer that a person takes over: the turn must actually tell a person (one door). */
export function customerReplyCallsStaff(text: string): boolean {
  return text.split("\n").some(line => STAFF_LINES.has(line.trim()));
}
/** Any earlier bot text that asked for the customer's phone (ours or the model-era wording). */
export const PHONE_ASK_TEXT = /рақами\s+телефон\S*\s+(?:нав|гуз|ф)|рақам(?:атон|тон)\S*\s+нав|номер\S*\s+телефон|оставьте[^.\n]*номер|напишите[^.\n]*номер|кадом\s+рақами\s+телефон/iu;

const THANKS_WORD = /^(?:рахмат|раҳмат|рахмад|рахмаат|ташаккур|ташакур|ташаккури|ташакури|сипос|спасибо|спасиб|спс|пасиб|благодарю|благодарим|мерси|thanks|thank|thx|rahmat|tashakkur|tashakur)$/u;
const THANKS_FILLER = /^(?:калон|зиёд|зиед|бисер|бисёр|большое|огромное|вам|you|very|much|ака|апа|акаҷон|акачон|апаҷон|апачон|брат|бародар|ҷон|чон|хуб|хоп|ок|ok|окей|ладно|хорошо|ясно|понятно|майлаш|саломат|бошед|бошен|бош|шумо|ба|и|ва|за|информацию|маълумот|барои)$/u;
/** The customer's own message is only "thank you" (with "ok", "brother", a farewell): nothing is asked. */
export function customerThanksOnly(text: string): boolean {
  const t = own(text);
  // A digit is a phone, a price or an address: that message is handled, not thanked.
  if (!t.trim() || t.length > 80 || /[?？\d]/u.test(t)) return false;
  const words = t.replace(/[\p{P}\p{S}\p{Emoji_Presentation}]+/gu, " ").split(/\s+/u).filter(Boolean);
  return words.length > 0 && words.some(word => THANKS_WORD.test(word)) && words.every(word => THANKS_WORD.test(word) || THANKS_FILLER.test(word));
}

const sentences = (t: string) => t.split(/[.!?？\n;]+/u).map(part => part.trim()).filter(Boolean);
const VEHICLE = "(?:мошин|машин|автомоб|авто(?![\\p{L}]))\\p{L}*";
const ACCEPT = "(?:қабул|кабул|принима|приним|возьм|бер[её]т|зач[её]т)\\p{L}*";
const NEAR = (a: string, b: string) => new RegExp(`${a}(?:\\s+\\S+){0,3}?\\s+${b}|${b}(?:\\s+\\S+){0,3}?\\s+${a}`, "iu");
const VEHICLE_ACCEPTED = NEAR(VEHICLE, ACCEPT);
const EXCHANGE = /обмен|бартер|мубодил|иваз/u;
const EXCHANGE_OBJECT = new RegExp(`${VEHICLE}|квартир|дом(?![\\p{L}])|дома|хона|ҳавлӣ|хавли|участ|замин`, "iu");
/**
 * "Мошин ҳам қабул мекунед?", "машину в зачёт возьмёте?", "обмен квартиры на дом": a deal term no catalog knows — the agent
 * answers. Narrow on purpose (review #201, С2): the car and "accept/take/offset" in one sentence within four words, an
 * exchange only together with a car or a property. "Есть парковка для машины? Принимаете наличные?" is not barter.
 */
export function customerTradeInQuestion(text: string): boolean {
  return sentences(own(text)).some(part => VEHICLE_ACCEPTED.test(part) || EXCHANGE.test(part) && EXCHANGE_OBJECT.test(part));
}

const PARTNER_WORD = /сотрудничеств|партн[её]рств|коммерческ\S*\s+предложени|ҳамкор[иӣ]|хамкор[иӣ]/u;
const OFFER_WORD = /предлага|предложи|предложени|пешниҳод|пешниход|мы\s+занимаемся|наша\s+(?:компания|студия|команда)|ширкати\s+мо/u;
/** The writer's own sale, purchase or job search: a client, not a partner (review #201, С3). */
const OWN_NEED = /у\s+меня|мо[яюй]\s+(?:квартир|дом|участ)|продайте|продаю|продать|продам|куплю|купить|хонаам|хонаи\s+ман|фур[ӯу]шед|мефур[ӯу]шам|фур[ӯу]шам|фрушам|мехарам|харидан\s+мехоҳам|ищу\s+(?:работ|квартир|дом)|работ\S*\s+агент|кор\s+(?:меҷӯям|мечуям|мекобам|кофта)|ваканси/u;
/** Somebody offers US a partnership/service (design studio, agency, developer): management decides, a person is told. */
export function customerPartnershipOffer(text: string): boolean {
  const t = own(text);
  return PARTNER_WORD.test(t) && OFFER_WORD.test(t) && !OWN_NEED.test(t);
}

const PERCENT_ASK = /%|фоиз|процент|комисс|ҳаққи\s+хизмат|хакки\s+хизмат|хаки\s+хизмат/u;
/** Not the seller's commission: a mortgage, a discount, an annual rate, a down payment (review #201, В1). */
const NOT_COMMISSION = /ипотек|кредит|скидк|тахфиф|годов|солон|дар\s+сол|взнос|аванс|предоплат|насия|қарз|карз|рассроч|қисм/u;
export const CUSTOMER_SELLER_WORDS = /фур[ӯу]ш|фрӯш|фруш|продаю|продать|продам|продаж/u;
const group = (value: number) => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/**
 * "2% от 700 000 — сколько?" from a SELLER: the server counts the company's seller commission (never the model, never the
 * customer's percent, never a mortgage/discount/annual rate). The caller checks that the pinned policy was read this turn
 * and that the customer sells. Tajik: digits and signs only — no unverified words (tajik-phrasebook rule 8).
 */
export function customerCommissionAmountLine(text: string, language: Lang, sellerPercent: number): string | null {
  const t = own(text);
  if (!PERCENT_ASK.test(t) || NOT_COMMISSION.test(t)) return null;
  const amounts = priceMentions(t).filter(hit => hit.value >= 1000);
  if (amounts.length !== 1 || !Number.isFinite(sellerPercent) || sellerPercent <= 0 || sellerPercent > 20) return null;
  const { value, currency } = amounts[0];
  const unit = currency === "USD" ? " USD" : currency === "TJS" ? language === "tg" ? " сомонӣ" : " сомони" : "";
  const fee = `${group(value * sellerPercent / 100)}${unit}`, sum = `${group(value)}${unit}`, p = `${String(sellerPercent).replace(".", ",")}%`;
  return language === "tg" ? `${p} × ${sum} = ${fee}` : `Комиссия продавца ${p}: от ${sum} это ${fee}.`;
}

/**
 * ЧТО БОТ ГОВОРИТ, КОГДА СКАЗАТЬ ЕМУ НЕЧЕГО НОВОГО, — ОДНА ДВЕРЬ (15.11.2026, 8 живых переписок владельца).
 *
 * Живые случаи Instagram 13–15.11:
 *  - «Рахмат» → «Агар саволи ман дар боло номафҳум буд, бо суханони худ нависед…» (на «спасибо» так не отвечают);
 *  - «Мо дар шаҳри Кайроккум» → «Бори дигар такрор мекунам: …» (грубо и роботно);
 *  - «2% от 700 000 сколько?» → «Ман инро дар боло навишта будам…» (свысока и без ответа);
 *  - «Мошин ҳам қабул мекунед?» → «Андозаи тахфифро … тасдиқ карда наметавонам» (не по вопросу, человека не позвали).
 * ФАКТ (прод, 08–15.11): 30 таких «повторю/я уже писал выше» в 19 переписках, все — из рендера ядра.
 *
 * Правило владельца (15.11): бот НИКОГДА не пишет «я уже писал выше» и «повторяю ещё раз».
 * Нечего сказать нового — честно «это скажет агент» и человек узнаёт об этом сразу
 * (lib/customerDmAgentTurn.ts зовёт notifyStaffFollowUpCustomerTurn по `customerReplyCallsStaff`).
 * Тон и слова — скилл tajik-phrasebook (live-agent-phrases.md: «Инро аниқ агенти мо мегӯяд»,
 * «Рақами телефонатонро нависед, то агенти мо занг занад», «Марҳамат», «Саломат бошед!»), только «шумо».
 * Звонок обещаем, только когда номер уже есть; без номера — просим номер.
 *
 * Чистые функции без базы: рендер повторяет их при запечатывании ответа и получает тот же текст.
 */
import { clientOwnWords } from "./untrustedContent.js";
import { priceMentions } from "./priceGuard.js";

type Lang = "ru" | "tg";
type KnownPhone = "none" | "current_input" | "scoped_contact";
type Pair = { ru: string; tg: string };

const own = (text: string) => clientOwnWords(text ?? "").normalize("NFKC").toLowerCase().replace(/ё/gu, "е");

/** Two wordings each: the second is used when the first was already said in this chat (the shield blocks a third verbatim). */
const STAFF_NO_PHONE: readonly Pair[] = [
  { ru: "Это точно подскажет наш агент. Напишите, пожалуйста, ваш номер телефона, чтобы агент вам позвонил.",
    tg: "Инро аниқ агенти мо мегӯяд. Рақами телефонатонро нависед, то агенти мо занг занад." },
  { ru: "Все подробности расскажет наш агент. Оставьте, пожалуйста, номер телефона.",
    tg: "Агенти мо ҳамаи тафсилотро ба шумо мегӯяд. Бемалол, рақами телефонатонро нависед." },
];
const STAFF_WITH_PHONE: readonly Pair[] = [
  { ru: "Это точно подскажет наш агент. Он позвонит вам в рабочее время.",
    tg: "Инро аниқ агенти мо мегӯяд. Агенти мо дар вақти корӣ ба шумо занг мезанад." },
  { ru: "Все подробности расскажет наш агент.", tg: "Агенти мо ҳамаи тафсилотро ба шумо мегӯяд." },
];
/** A partnership/B2B offer: management decides, the bot only passes it on (leadQualifier.ts wording, owner-approved). */
const PARTNERSHIP: Pair = { ru: "Спасибо, передам руководству.", tg: "Раҳмат, ба роҳбарият мерасонам." };
const PARTNERSHIP_PHONE: Pair = { ru: "Оставьте, пожалуйста, номер телефона для связи.", tg: "Бемалол, рақами телефонатонро нависед." };
/** Answer to a bare "thank you": "Марҳамат" plus one farewell, no "write again if…" tail (phrasebook rule 5). */
const THANKS_REPLIES: readonly Pair[] = [
  { ru: "Пожалуйста! Всего доброго.", tg: "Марҳамат! Саломат бошед!" },
  { ru: "Пожалуйста!", tg: "Марҳамат!" },
];

/** The staff hand-off line for this turn: phone known → the agent will call; no phone → ask for it. */
export function customerStaffFollowUpLine(language: Lang, knownPhone: KnownPhone, alreadySaid: (line: string) => boolean = () => false): string {
  const family = knownPhone === "none" ? STAFF_NO_PHONE : STAFF_WITH_PHONE;
  return (family.find(pair => !alreadySaid(pair[language])) ?? family[family.length - 1])[language];
}
export function customerPartnershipReply(language: Lang, knownPhone: KnownPhone): string[] {
  return knownPhone === "none" ? [PARTNERSHIP[language], PARTNERSHIP_PHONE[language]] : [PARTNERSHIP[language]];
}
export function customerThanksReply(language: Lang, alreadySaid: (line: string) => boolean = () => false): string {
  return (THANKS_REPLIES.find(pair => !alreadySaid(pair[language])) ?? THANKS_REPLIES[THANKS_REPLIES.length - 1])[language];
}

const STAFF_LINES = new Set([...STAFF_NO_PHONE, ...STAFF_WITH_PHONE, PARTNERSHIP].flatMap(pair => [pair.ru, pair.tg]));
/** Every fixed line of this module, for the read-only conversation memory allow-list. */
export function customerStaffFollowUpFixedLines(): string[] {
  return [...STAFF_NO_PHONE, ...STAFF_WITH_PHONE, PARTNERSHIP, PARTNERSHIP_PHONE, ...THANKS_REPLIES].flatMap(pair => [pair.ru, pair.tg]);
}
/** The reply told the customer that a person takes over: the turn must actually tell a person (one door). */
export function customerReplyCallsStaff(text: string): boolean {
  return text.split("\n").some(line => STAFF_LINES.has(line.trim()));
}

const THANKS_WORD = /^(?:рахмат|раҳмат|рахмад|рахмаат|ташаккур|ташакур|ташаккури|ташакури|сипос|спасибо|спасиб|спс|пасиб|благодарю|благодарим|мерси|thanks|thank|thx|rahmat|tashakkur|tashakur)$/u;
const THANKS_FILLER = /^(?:калон|зиёд|зиед|бисер|бисёр|большое|огромное|вам|you|very|much|ака|апа|акаҷон|акачон|апаҷон|апачон|брат|бародар|ҷон|чон|хуб|хоп|ок|ok|окей|ладно|хорошо|ясно|понятно|майлаш|саломат|бошед|бошен|бош|шумо|ба|и|ва|за|информацию|маълумот|барои)$/u;
/** The customer's own message is only "thank you" (with "ok", "brother", a farewell): nothing is asked. */
export function customerThanksOnly(text: string): boolean {
  const t = own(text);
  // A digit is a phone, a price or an address: that message is handled, not thanked.
  if (!t.trim() || t.length > 80 || /[?？\d]/u.test(t)) return false;
  const words = t.replace(/[\p{P}\p{S}\p{Emoji_Presentation}\d]+/gu, " ").split(/\s+/u).filter(Boolean);
  return words.length > 0 && words.some(word => THANKS_WORD.test(word)) && words.every(word => THANKS_WORD.test(word) || THANKS_FILLER.test(word));
}

/** "Мошин ҳам қабул мекунед?", "обмен на машину", "бартер": a deal term no catalog knows — the agent answers, never a discount line. */
export function customerTradeInQuestion(text: string): boolean {
  const t = own(text);
  if (/обмен|бартер|мубодил|в\s+зач[её]т/u.test(t)) return true;
  const vehicle = /(?:^|[^\p{L}])(?:мошин|машин|автомоб|авто(?![\p{L}])|мошина)/u.test(t);
  return vehicle && /(?:қабул|кабул|принима|возьм|бер[её]те|иваз|ба\s*[ҷч]ои|бадал|вместо|плюс|доплат|илова)/u.test(t);
}

const PARTNER_WORD = /сотрудничеств|партн[её]рств|коммерческ\S*\s+предложени|ҳамкор[иӣ]|хамкор[иӣ]/u;
const OFFER_WORD = /предлага|предложи|предложени|пешниҳод|пешниход|мы\s+занимаемся|наша\s+(?:компания|студия|команда)|ширкати\s+мо/u;
/** Somebody offers US a partnership/service (design studio, agency, developer): management decides, a person is told. */
export function customerPartnershipOffer(text: string): boolean {
  const t = own(text);
  return PARTNER_WORD.test(t) && OFFER_WORD.test(t);
}

const PERCENT_ASK = /%|фоиз|процент|комисс|ҳаққи\s+хизмат|хакки\s+хизмат|хаки\s+хизмат/u;
const PERCENT_NUMBER = /(\d{1,2}(?:[.,]\d)?)\s*(?:%|фоиз|процент)/u;
const group = (value: number) => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/**
 * "2% от 700 000 сколько будет?" — the server counts, the model never names a figure (15.11.2026, live: «як копча пул меша»).
 * Percent: the company's seller commission when the pinned policy was read this turn, otherwise the customer's own figure
 * (then it is plain arithmetic of the customer's numbers, not our term). No amount or no percent → nothing.
 */
export function customerCommissionAmountLine(text: string, language: Lang, companySellerPercent?: number): string | null {
  const t = own(text);
  if (!PERCENT_ASK.test(t)) return null;
  const amounts = priceMentions(t).filter(hit => hit.value >= 1000);
  if (amounts.length !== 1) return null;
  const named = PERCENT_NUMBER.exec(t);
  const percent = companySellerPercent ?? (named ? Number(named[1].replace(",", ".")) : NaN);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 20) return null;
  const { value, currency } = amounts[0];
  const unit = currency === "USD" ? " USD" : currency === "TJS" ? language === "tg" ? " сомонӣ" : " сомони" : "";
  const fee = `${group(value * percent / 100)}${unit}`, sum = `${group(value)}${unit}`, p = `${String(percent).replace(".", ",")}%`;
  // Wording assembled by analogy (phrasebook (?)): a native speaker checks it before release.
  return language === "tg" ? `Агар хона ба ${sum} фурӯхта шавад, ${p}-и он ${fee} мешавад.`
    : `Если продать за ${sum}, ${p} от этой суммы составит ${fee}.`;
}

import { detectHate } from "../lib/commentHate.js";
import { foldCustomerText } from "./customerAgentRole.js";
import { clientOwnWords } from "./untrustedContent.js";
import { BW, EW, TAIL } from "./wordBoundary.js";

/**
 * Hostile or promotional customer DM: a threat, an insult, or spam (24.10.2026, attack stand).
 * "я вас найду и сожгу ваш офис" matched the agency-office question and got the office address
 * back. Such a message is not a question about the company, so no company/property fact may be
 * rendered for it; a short neutral line is the whole reply.
 *
 * Pure text in, nothing proven out. Written in the folded alphabet of `foldCustomerText`
 * (ё->е, ӣ->и, ӯ->у, ҳ->х, ҷ->ч, қ->к, ғ->г); word edges are BW/EW/TAIL, never `\w`/`\b`.
 * Only phrases with no ordinary business meaning: "подпишитесь на рассылку?" or "дурак" inside a
 * quoted listing are not here, and "лохотрон"/"мошенники" stay a complaint the model answers politely.
 */
const THREAT = new RegExp([
  `${BW}(?:сожг|подожг|поджег|взорв|убь|убей|убив|приконч|зарежу|зарежем|зарезать|перережу|перерезать|придуш|застрел|пристрел|расстрел|покалеч|расправ)${TAIL}`,
  `${BW}найд(?:у|ем|ём)${EW}\\s+(?:вас|тебя|вам)`,
  `${BW}(?:вас|тебя)\\s+найд(?:у|ем)${TAIL}`,
  `${BW}(?:ме|би)куш(?:ам|ем)${EW}`, `${BW}месузон${TAIL}`, `${BW}таркон${TAIL}`, `${BW}бомб${TAIL}`,
  `${BW}(?:kill|burn|bomb)${EW}`,
].join("|"), "iu");
const INSULT = new RegExp([
  `${BW}(?:тупо[йе]|тупая|тупые|тупица|тупиц${TAIL}|дурак${TAIL}|дура${EW}|идиот${TAIL}|кретин${TAIL}|дебил${TAIL}|придурок|придурк${TAIL}|урод(?:ы|а|у)?${EW}|мразь|говнюк${TAIL}|гнид${TAIL})`,
  `${BW}ахмак${TAIL}`, `${BW}бешарм${TAIL}`, `${BW}дуруг${TAIL}`, `${BW}нодон${EW}`,
].join("|"), "iu");
const SPAM = new RegExp([
  `${BW}подпиши(?:сь|тесь)${EW}\\s+на\\s+(?:мо[йяю]|меня|наш)`, `${BW}подписывай(?:ся|тесь)${EW}`, `${BW}взаимн${TAIL}\\s+подписк${TAIL}`,
  `${BW}заработок\\s+без\\s+вложени${TAIL}`, `${BW}пиши(?:те)?\\s+мне\\s+в\\s+(?:директ|лс|личк${TAIL}|телеграм)`,
  `${BW}казино${EW}`, `${BW}ставки\\s+на\\s+спорт`, `${BW}выигрыш${TAIL}\\s+100`,
  `${BW}переходи(?:те)?\\s+и\\s+(?:выигрывай|заработай)`,
].join("|"), "iu");

export type CustomerDmAbuse = "threat" | "insult" | "spam";

/** The hostile or promotional kind of the customer's own words, or null for an ordinary message. */
export function customerDmAbuseKind(text: string): CustomerDmAbuse | null {
  const own = clientOwnWords(text).normalize("NFKC");
  if (!own.trim()) return null;
  const folded = foldCustomerText(own);
  if (THREAT.test(folded)) return "threat";
  if (INSULT.test(folded) || detectHate(own)) return "insult";
  if (SPAM.test(folded)) return "spam";
  return null;
}

const NEUTRAL: Record<CustomerDmAbuse, { ru: string; tg: string }> = {
  threat: { ru: "Я не могу продолжать разговор в таком тоне. Если есть вопрос по недвижимости или работе, напишите, помогу.",
    tg: "Бо чунин лаҳн гуфтугӯро идома дода наметавонам. Агар дар бораи амвол ё кор савол дошта бошед, нависед, кӯмак мекунам." },
  insult: { ru: "Я не могу продолжать разговор в таком тоне. Если есть вопрос по недвижимости или работе, напишите, помогу.",
    tg: "Бо чунин лаҳн гуфтугӯро идома дода наметавонам. Агар дар бораи амвол ё кор савол дошта бошед, нависед, кӯмак мекунам." },
  spam: { ru: "Спасибо за сообщение. Если у вас есть вопрос по недвижимости или работе, напишите, помогу.",
    tg: "Ташаккур барои паём. Агар дар бораи амвол ё кор савол дошта бошед, нависед, кӯмак мекунам." },
};
/** The whole reply to a hostile or promotional DM: no company, property or vacancy fact, no question. */
export function customerDmAbuseReply(kind: CustomerDmAbuse, language: "ru" | "tg"): string { return NEUTRAL[kind][language]; }
/** Every fixed line above, for the read-only memory allow-list. */
export function customerDmAbuseLines(): string[] { return Object.values(NEUTRAL).flatMap(line => [line.ru, line.tg]); }

import { clientLanguageScores, detectClientLanguage as detectRawClientLanguage, isUnreadableLatin, stripNonLanguage, type ClientLanguage } from "./clientLanguage.js";
import { foldCustomerText } from "./customerAgentRole.js";
import { clientOwnWords } from "./untrustedContent.js";
import { BW, EW } from "./wordBoundary.js";

/** Customer-core view of the detector: Latin noise is no evidence of Tajik (the legacy detector guesses "tg"). */
function detectClientLanguage(input: string): ClientLanguage {
  return isUnreadableLatin(input) ? "unknown" : detectRawClientLanguage(input);
}

/** History stores a turn without words as a JSON stand-in (`{"incomingAttachments":[..]}`,
 * `{"previouslyObservedCustomerMedia":..}`). Those are our literals, never the customer's language. */
const PLACEHOLDER_KEYS = /^\{\s*"(?:incomingAttachments|previouslyObservedCustomerMedia)"\s*:/u;
export function isCustomerHistoryPlaceholder(text: string): boolean {
  return PLACEHOLDER_KEYS.test(text.trim());
}
/** The customer's own words of a history turn: placeholder lines removed. */
export function customerHistoryOwnWords(text: string): string {
  return text.split("\n").filter(line => !isCustomerHistoryPlaceholder(line)).join("\n").trim();
}

// "I do not understand Russian" is a request for Tajik (and the mirror for Tajik). Written in the
// folded alphabet of `foldCustomerText` (ӣ->и, ӯ->у, ҳ->х, ...). First person only: "вы не понимаете" is not a request.
const GAP = `(?: \\p{L}+){0,2} `;
const CANT_RU = [
  new RegExp(`${BW}не (?:понимаю|знаю|умею|владею|говорю|читаю)(?: по)? русск\\p{L}*(?: язык\\p{L}*)?${EW}`, "u"),
  new RegExp(`${BW}(?:по )?русск\\p{L}*(?: язык\\p{L}*)? не (?:понимаю|знаю|умею|говорю)${EW}`, "u"),
  new RegExp(`${BW}у?рус\\p{L}*${GAP}(?:намефам|намефахм|намедон|наметавон)\\p{L}*${EW}`, "u"),
  new RegExp(`${BW}(?:намефам|намефахм|намедон|наметавон)\\p{L}*${GAP}(?:бо |ба )?у?рус\\p{L}*${EW}`, "u"),
];
const CANT_TG = [
  new RegExp(`${BW}не (?:понимаю|знаю|умею|владею|говорю|читаю)(?: по)? таджикск\\p{L}*(?: язык\\p{L}*)?${EW}`, "u"),
  new RegExp(`${BW}(?:по )?таджикск\\p{L}*(?: язык\\p{L}*)? не (?:понимаю|знаю|умею|говорю)${EW}`, "u"),
  new RegExp(`${BW}точик\\p{L}*${GAP}(?:намефам|намефахм|намедон|наметавон)\\p{L}*${EW}`, "u"),
];

/** A requested reply language is different from the language of the sentence
 * requesting it. Scope this to customer DM, leaving voice/legacy routing alone. */
export function customerDmLanguagePreference(input: string): "ru" | "tg" | null {
  const own = clientOwnWords(input);
  const text = own.normalize("NFKC").trim().toLowerCase().replace(/[.!?]+$/gu, "").trim();
  const requested = /^(?:ответь(?:те)?|пиши(?:те)?|напиши(?:те)?|говори(?:те)?)(?:,?\s+пожалуйста)?\s+(?:на\s+(русском|таджикском)|по[-\s](русски|таджикски))(?:\s|,|$)/u.exec(text);
  if (requested) return /рус/u.test(requested[1] ?? requested[2]) ? "ru" : "tg";
  if (/^(?:на русском|по[-\s]русски)(?:,?\s+пожалуйста)?$/u.test(text) || /^(?:бо|ба)\s+(?:забони\s+)?рус[ӣи]\s+(?:нависед|гап занед)$/u.test(text)) return "ru";
  if (/^(?:на таджикском|по[-\s]таджикски)(?:,?\s+пожалуйста)?$/u.test(text) ||
      /^то[ҷч]ик[ӣи](?:ш|ша)?\s+(?:мегрифт[ӣи]|гап\s+зан(?:ед)?|навис(?:ед)?)(?:\s|$)/u.test(text)) return "tg";
  const folded = foldCustomerText(own);
  if (CANT_RU.some(pattern => pattern.test(folded))) return "tg";
  if (CANT_TG.some(pattern => pattern.test(folded))) return "ru";
  return null;
}
export function detectCustomerDmLanguage(input: string) {
  return customerDmLanguagePreference(input) ?? detectClientLanguage(input);
}

/** Customer-core spelling hints only; do not change legacy or voice routing.
 * A Russian question quoting one unfamiliar word still wins by its own words. */
export function customerColloquialTajikLanguage(input: string): boolean {
  const own = stripNonLanguage(clientOwnWords(input)).replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, " ");
  if (/по[-\s]русски|на русском/iu.test(own)) return false;
  const words = foldCustomerText(own).split(" ");
  const hints = words.filter(word => /^(?:схемаша|схемаш|планировкаша|партоен|партоед|фурухта|шуд|шуда|кичода|кичо|кучода|кучо|бехтарин|макон)$/u.test(word)).length;
  return hints > clientLanguageScores(own).russian;
}

/** Words that carry no language evidence of their own (greeting, thanks, ok/yes/no), folded alphabet. */
const NEUTRAL_WORDS = new Set(["привет", "здравствуйте", "здравствуй", "добрый", "доброе", "день", "вечер", "утро", "спасибо",
  "благодарю", "ок", "окей", "ok", "okay", "хорошо", "ладно", "да", "нет", "ага", "угу", "понятно", "ясно", "отлично", "супер",
  "салом", "асалом", "ассалом", "ассалому", "алейкум", "алайкум", "ассаломуалейкум", "асаломалейкум", "саломалейкум", "рахмат",
  "ташаккур", "хуб", "майлаш", "бале", "ха", "salom", "rahmat", "tashakkur", "hi", "hello", "yes", "no", "thanks"]);

/** Up to two neutral words, or nothing readable at all (a bare link, @handle, emoji): no reason to switch the dialogue language. */
export function isNeutralShortReply(input: string): boolean {
  const words = foldCustomerText(stripNonLanguage(clientOwnWords(input))).split(" ").filter(word => /\p{L}/u.test(word));
  return words.length <= 2 && words.every(word => NEUTRAL_WORDS.has(word) || /^а[л]+о+$/u.test(word));
}

/** "ru"/"tg" by the larger word count; null on an exact tie. */
function majority(text: string): "ru" | "tg" | null {
  const { tajik, russian } = clientLanguageScores(text);
  return tajik === russian ? null : tajik > russian ? "tg" : "ru";
}

/**
 * One Russian word among three or more unrecognised ones is no proof of Russian (01.11.2026: a Tajik
 * sentence in an unfamiliar spelling with one stray «не» pinned the whole dialogue to Russian).
 * Such a turn neither decides the dialogue language nor overrides an earlier decisive one.
 */
function weakRussian(text: string): boolean {
  const { tajik, russian } = clientLanguageScores(text);
  const words = foldCustomerText(stripNonLanguage(clientOwnWords(text))).split(" ").filter(word => /\p{L}/u.test(word));
  // Only the short words Tajik speech borrows; "Мне нужна двушка в Сино" has one listed word and is plainly Russian.
  return russian === 1 && tajik === 0 && words.length >= 3 && words.some(word => word === "не" || word === "нет" || word === "он");
}

function decisiveLanguage(text: string): "ru" | "tg" | null {
  const preference = customerDmLanguagePreference(text);
  if (preference) return preference;
  if (isNeutralShortReply(text)) return null;
  if (customerColloquialTajikLanguage(text)) return "tg";
  const detected: ClientLanguage = detectClientLanguage(text);
  if (detected === "ru" && weakRussian(text)) return null;
  return detected === "ru" || detected === "tg" ? detected : detected === "mixed" ? majority(text) : null;
}

/**
 * Language of the dialogue for this turn. An explicit request wins; a full sentence in one language wins
 * over history; a short neutral reply ("Спасибо", "Рахмат", a bare link) keeps the language of the last
 * decisive earlier customer turn; a mixed or unreadable turn falls back to history, then to the larger word
 * count, then to Russian. `priorUserTexts` are the customer's earlier turns, oldest first.
 */
export function resolveCustomerDmLanguage(text: string, priorUserTexts: readonly string[] = [],
  storedLanguage?: "ru" | "tg" | "mixed" | "unknown"): "ru" | "tg" {
  text = customerHistoryOwnWords(text);
  const preference = customerDmLanguagePreference(text);
  if (preference) return preference;
  const prior = [...priorUserTexts].reverse().map(customerHistoryOwnWords).filter(Boolean);
  const stored = storedLanguage === "ru" || storedLanguage === "tg" ? storedLanguage : undefined;
  // Window evidence is fresher than the stored value; the stored one keeps the language across a revision
  // change (the window drops older tickets) and in long dialogues.
  const earlier = prior.map(decisiveLanguage).find((value): value is "ru" | "tg" => value !== null) ?? stored
    ?? prior.filter(isNeutralShortReply).map(detectClientLanguage).find((value): value is "ru" | "tg" => value === "ru" || value === "tg");
  if (isNeutralShortReply(text)) return earlier ?? (detectClientLanguage(text) === "tg" ? "tg" : "ru");
  if (customerColloquialTajikLanguage(text)) return "tg";
  const detected = detectClientLanguage(text);
  if (detected === "ru" && weakRussian(text)) return earlier ?? "ru";
  if (detected === "ru" || detected === "tg") return detected;
  return earlier ?? (detected === "mixed" ? majority(text) : null) ?? "ru";
}

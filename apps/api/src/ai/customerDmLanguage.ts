import { clientLanguageScores as baseClientLanguageScores, detectClientLanguage as detectRawClientLanguage, isUnreadableLatin, stripNonLanguage,
  type ClientLanguage, type ClientLanguageExtension } from "./clientLanguage.js";
import { foldCustomerText } from "./customerAgentRole.js";
import { clientOwnWords } from "./untrustedContent.js";
import { BW, EW } from "./wordBoundary.js";
import { adTemplateLanguage, isAdTemplateOpener, SALAAM_WORDS, withoutAdTemplatePhrases } from "./adTemplatePhrase.js";

/**
 * CUSTOMER-CORE WORD LISTS (audit 16.11.2026; review #206 С2: only this path, the legacy bot and the voice keep theirs).
 * Dushanbe colloquial Tajik («медоден», «мечуед», «мекнен», «нависад», «фуруши», «коргар», «кучодай», «гучо», «дорум»,
 * «омадам»): verb stems with «ме-» never occur in Russian (checked against «мебель», «медленно», «медицина», «мега»).
 * Russian function words that Tajik speakers do not mix in («я», «понял», «извините», «увидела»); «по», «работа», «все»
 * are left out on purpose — «Ман по работе омадам», «Работа хаст?», «Все хуб» are Tajik.
 * Words: tajik-phrasebook/references/client-chat-vocabulary.md and the live chats of the audit.
 */
const L = "а-яёҳҷӣӯқғ";
const CORE_TAJIK = new RegExp(`(?<![${L}])(?:ме(?:кун|кн|диҳ|дих|дод|чу|ҷу|хар|фур|фру|фр[уӯ]ш|гир|бин|гу|гӯ|фаҳм|фахм|дон|тон|рас|ой|омад|нав|шин|ғ|рав|зан|п[уӯ]рс|пурс|кашем|кобам|кобем|кобед|шава|шад)[${L}]*` +
  `|на(?:мекун|мекн|медон|мефахм|мефаҳм|мешава|мешад|висад|висен|висед|вистм|вистам)[${L}]*|нависад|навис[еи]н|фур[уӯ]ши|фурши|фрӯши|коргар[${L}]*` +
  `|к[уӯ][чҷ]ода[ий]?|кичо[${L}]*|гучо[${L}]*|ягон[${L}]*|хама[аш]*|ҳама[аш]*|хато|дорум|дорм|дорен|дорем|агар|як|ака[ҷч]он|апа[ҷч]он|чии|чиба|чаро` +
  `|хозир|ҳозир|пагох|пагоҳ|шумоба|шумора|шумо[рн]о|хонаи|хонам|хонаам[${L}]*|хонагӣ|хонага[ий]?|хучра[${L}]*|ҳуҷра[${L}]*|ошена[${L}]*|нархаш|нархи` +
  `|нархат|чанд[та]?|чанде|ҳамин|хамин|хамту|ҳамту|кори|маълумот[${L}]*|маьлумот[${L}]*|маоумот[${L}]*|маъоумот[${L}]*|гирифтен|гирифтед|занг` +
  `|зангзан[${L}]*|рақам[${L}]*|раками[${L}]*|ракам|ракамат[${L}]*|нест|дошта|доштаед|боша|бошен|бдай|бдаст|хастам|хастем|хастед|хастан|сола|солам` +
  `|солаам|омадам|омадем|омадед|омадан)(?![${L}])`, "giu");
const CORE_RUSSIAN = new RegExp(`(?<![${L}])(?:я|мы|вас|нас|вам|нам|так|но|понял|поняла|понятно|извините|хорошо|ладно|рекламу|реклама|увидела|увидел` +
  `|написала|написал|ищете|ищите|ищу|продажам|продажи|городе|город|здесь|там|был|была|было|уже|только|если|чтобы|нужна|нужен|можете|хотела|хотел` +
  `|узнать|подробнее|звонила|звонил|берёт|берет|трубку|никто|ничего|вакансию|вакансии|график|офисный)(?![${L}])`, "giu");
/** Uzbek Latin («Bu haqida yana maʼlumot olsam boʻladimi?») is not Tajik: no language is forced. */
const CORE_UZBEK = /(^|[^a-zʻʼ'])(bu|haqida|yana|olsam|bo[ʻʼ']?ladimi|bo[ʻʼ']?ladi|kerak|qancha|uy|uyni|sotaman|sotib|olaman|ishlaysizmi|ish|batafsil|ko[ʻʼ']?proq)([^a-zʻʼ']|$)/gi;
const CORE_LANGUAGE: ClientLanguageExtension = { tajik: CORE_TAJIK, russian: CORE_RUSSIAN, uzbekLatin: CORE_UZBEK };
const clientLanguageScores = (text: string) => baseClientLanguageScores(text, CORE_LANGUAGE);

/** Customer-core view of the detector: Latin noise is no evidence of Tajik (the legacy detector guesses "tg"). */
function detectClientLanguage(input: string): ClientLanguage {
  return isUnreadableLatin(input) ? "unknown" : detectRawClientLanguage(input, CORE_LANGUAGE);
}
/** The customer core's language detector (DM, media caption, public comment): the core word lists. */
export function detectCustomerCoreLanguage(input: string): ClientLanguage { return detectClientLanguage(input); }

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

// A request for a reply language is read inside ONE sentence, not only as the whole message (audit 17.11.2026:
// «Пожалуйста, пишите по-таджикски», «Можно на таджикском?», «русӣ нависед» were answered in the old language).
// Conservative on purpose: an imperative/request verb (or a bare «на русском») + the language phrase; a negation
// («не пишите»), a choice («по-русски или по-таджикски?») and a plain mention («я знаю русский») are no request.
const W = String.raw`(?<!\p{L})`, E = String.raw`(?!\p{L})`;
const RU_PHRASE = String.raw`(?:на\s+(?<a>русском|таджикском)(?:\s+языке)?|по[-\s](?<b>русски|таджикски))`;
const RU_WRITE = "(?:ответь(?:те)?|отвечайте|пиши(?:те)?|напиши(?:те)?|говори(?:те)?|общайтесь|переходите|переключитесь)";
const RU_ASK = String.raw`(?:можно(?:\s+ли)?|можете|можешь|могли\s+бы|давайте|лучше|а\s+можно|хотелось\s+бы|хочу|прошу)`;
const RU_FILL = "(?:ли|мне|вам|вы|нам|пожалуйста|все|всё|общаться|писать|говорить|отвечать|переписываться|общение|вести)";
const RU_REQUEST = [
  new RegExp(String.raw`${W}(?<neg>не\s+)?${RU_WRITE}(?:[,\s]+\p{L}+){0,2}[,\s]+${RU_PHRASE}${E}`, "u"),
  new RegExp(String.raw`${W}(?<neg>не\s+)?${RU_ASK}(?:[,\s]+${RU_FILL}){0,3}[,\s]+${RU_PHRASE}${E}`, "u"),
  new RegExp(String.raw`^(?:(?:пожалуйста|давайте|лучше|а)[,\s]+)?${RU_PHRASE}(?:,?\s+пожалуйста)?$`, "u"),
];
const TG_LANG = String.raw`(?:(?:бо|ба)\s+)?(?:забони\s+)?(?<l>рус[ӣи]|то[ҷч]ик[ӣи])(?:ш|ша)?`;
const TG_VERB_IMPERATIVE = String.raw`(?:навис(?:ед|ен|[ие]н)|гап\s+зан(?:ед|ен)?|гуфтугу\s+кун(?:ед|ен)|сухан\s+кун(?:ед|ен)|[ҷч]авоб\s+(?:дихед|диҳед|дихен|диҳен))`;
const TG_VERB_QUESTION = String.raw`(?:мегу?[ӯу]ед|мегед|метавонед|мешавад|шавад|мегрифт[ӣи])`;
const tgRequests = (verb: string) => [
  new RegExp(String.raw`${W}${TG_LANG}(?:\s+\p{L}+){0,2}\s+${verb}${E}`, "u"),
  new RegExp(String.raw`${W}${verb}(?:\s+\p{L}+){0,2}\s+${TG_LANG}${E}`, "u"),
];
const TG_REQUEST = tgRequests(`(?:${TG_VERB_IMPERATIVE}|${TG_VERB_QUESTION})`);
const TG_REQUEST_PINNED = tgRequests(TG_VERB_IMPERATIVE);
const LANG_RU_WORD = /(?<!\p{L})(?:русск\p{L}*|рус[ӣи])(?!\p{L})/u;
const LANG_TG_WORD = /(?<!\p{L})(?:таджикск\p{L}*|то[ҷч]ик[ӣи]\p{L}*)(?!\p{L})/u;

/** `pinned`: only an explicit imperative («пишите по-таджикски», «нависед»); a question form («Вы говорите по-таджикски?»,
 * «можно на русском?», «…бо русӣ мешавад?») acts for its own turn only and is never remembered for later turns. */
function languageRequestIn(sentence: string, pinned = false): "ru" | "tg" | null {
  const ru = LANG_RU_WORD.test(sentence), tg = LANG_TG_WORD.test(sentence);
  if (ru === tg) return null; // none, or a choice between both
  for (const [index, pattern] of RU_REQUEST.entries()) {
    if (pinned && index === 1) continue;
    const match = pattern.exec(sentence);
    const groups = match?.groups;
    if (!match || !groups) continue;
    if (groups.neg) return null;
    if (pinned && /(?:^|[\s,])(?:вы|ты)\s+$/u.test(sentence.slice(0, match.index))) return null;
    const lang = groups.a ?? groups.b;
    return lang ? (lang.startsWith("рус") ? "ru" : "tg") : null;
  }
  for (const pattern of pinned ? TG_REQUEST_PINNED : TG_REQUEST) {
    const lang = pattern.exec(sentence)?.groups?.l;
    if (lang) return lang.startsWith("рус") ? "ru" : "tg";
  }
  return null;
}

/** A requested reply language is different from the language of the sentence
 * requesting it. Scope this to customer DM, leaving voice/legacy routing alone. */
function scanLanguageRequest(input: string, pinned: boolean): "ru" | "tg" | null {
  const own = clientOwnWords(input);
  const text = own.normalize("NFKC").trim().toLowerCase();
  for (const part of text.matchAll(/[^.!?;\n]+[.!?;\n]*/gu)) {
    const sentence = part[0].replace(/[.!?;\n]+$/u, "").trim();
    if (!sentence || (pinned && part[0].includes("?"))) continue;
    const found = languageRequestIn(sentence, pinned);
    if (found) return found;
  }
  const folded = foldCustomerText(own);
  if (CANT_RU.some(pattern => pattern.test(folded))) return "tg";
  if (CANT_TG.some(pattern => pattern.test(folded))) return "ru";
  return null;
}
export function customerDmLanguagePreference(input: string): "ru" | "tg" | null { return scanLanguageRequest(input, false); }
/** The requests that stay in force for later turns: explicit imperatives and «не понимаю…», never question forms. */
export function customerDmPinnedLanguageRequest(input: string): "ru" | "tg" | null { return scanLanguageRequest(input, true); }

export function detectCustomerDmLanguage(input: string) {
  return customerDmLanguagePreference(input) ?? detectClientLanguage(input);
}

/** Customer-core spelling hints only; do not change legacy or voice routing.
 * A Russian question quoting one unfamiliar word still wins by its own words. */
export function customerColloquialTajikLanguage(input: string): boolean {
  const own = stripNonLanguage(clientOwnWords(input)).replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, " ");
  if (/по[-\s]русски|на русском/iu.test(own)) return false;
  const words = foldCustomerText(own).split(" ");
  const hints = words.filter(word => /^(?:схемаша|схемаш|планировкаша|партоен|партоед|фурухта|шуд|шуда|кичода|кичо|кучода|кучо|бехтарин|макон|хами|хамин|хонара|хонаша|хонаро|видеоша|видеоро|дорен|доред|дорин)$/u.test(word)).length;
  return hints > clientLanguageScores(own).russian;
}

/** Words that carry no language evidence of their own (greeting, thanks, ok/yes/no), folded alphabet. */
const NEUTRAL_WORDS = new Set(["привет", "здравствуйте", "здравствуй", "добрый", "доброе", "день", "вечер", "утро", "спасибо",
  "благодарю", "ок", "окей", "ok", "okay", "хорошо", "ладно", "да", "нет", "ага", "угу", "понятно", "ясно", "отлично", "супер",
  ...SALAAM_WORDS, "рахмат",
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

function decisiveLanguage(text: string): "ru" | "tg" | null {
  const preference = customerDmLanguagePreference(text);
  if (preference) return preference;
  if (isNeutralShortReply(text)) return null;
  if (customerColloquialTajikLanguage(text)) return "tg";
  const detected: ClientLanguage = detectClientLanguage(text);
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
  text = customerLanguageWords(text);
  const preference = customerDmLanguagePreference(text);
  if (preference) return preference;
  // The ad button text («Привет! Можно узнать об этом подробнее?») is not the customer's words (audit 16.11.2026:
  // «Салом» after it was answered in Russian). It is never evidence; its own language is the last resort only.
  const prior = [...priorUserTexts].reverse().map(customerHistoryOwnWords).filter(value => value && !isAdTemplateOpener(value));
  // An explicit request of an earlier turn stays in force until the client asks otherwise (nothing is stored for DM:
  // the history is the memory, like the dialogue language below).
  const requestedEarlier = prior.map(customerDmPinnedLanguageRequest).find((value): value is "ru" | "tg" => value !== null);
  if (requestedEarlier) return requestedEarlier;
  const stored = storedLanguage === "ru" || storedLanguage === "tg" ? storedLanguage : undefined;
  // Window evidence is fresher than the stored value; the stored one keeps the language across a revision
  // change (the window drops older tickets) and in long dialogues.
  const earlier = prior.map(decisiveLanguage).find((value): value is "ru" | "tg" => value !== null) ?? stored
    ?? prior.filter(isNeutralShortReply).map(detectClientLanguage).find((value): value is "ru" | "tg" => value === "ru" || value === "tg");
  if (isAdTemplateOpener(text)) return earlier ?? adTemplateLanguage(text);
  if (isNeutralShortReply(text)) return earlier ?? (detectClientLanguage(text) === "tg" ? "tg" : "ru");
  if (customerColloquialTajikLanguage(text)) return "tg";
  const detected = detectClientLanguage(text);
  if (detected === "ru" || detected === "tg") return detected;
  return earlier ?? (detected === "mixed" ? majority(text) : null) ?? "ru";
}

/**
 * Слова клиента для выбора ЯЗЫКА: без готовой фразы рекламы Meta рядом с ними (живая находка 34, 25.11.2026: «Какие услуги вы
 * предлагаете?» и дальше «нарх / хона / сурога» — язык решала русская кнопка). Только шаблон — как есть: его ловит
 * isAdTemplateOpener и язык берётся прежним путём (история, потом язык кнопки).
 */
function customerLanguageWords(raw: string): string {
  const text = customerHistoryOwnWords(raw);
  return withoutAdTemplatePhrases(text) || text;
}

/**
 * ЯЗЫК, ЗА КОТОРЫЙ КОД РУЧАЕТСЯ (20.11.2026, оператор приёма заявок). Детектор выше по умолчанию считает таджикским любой
 * латинский текст без английских слов («Skolko stoit kvartira?» — русский транслит), поэтому перекрывать им ответ модели
 * можно не всегда. Код ручается, только когда у него есть настоящее основание: явная просьба о языке или текст кириллицей
 * с найденными признаками языка — таджикские буквы (ғ ӣ қ ӯ ҳ ҷ) или слова-маркеры для таджикского, слова-маркеры для
 * русского. Латиница, кнопка рекламы, короткое «ок/салом», текст без маркеров — null: решает модель (живой случай 19.11:
 * «телефон номера нависед» модель назвала русским, а у кода тут маркер «нависед»).
 */
export function groundedCustomerDmLanguage(input: string): "ru" | "tg" | null {
  const text = customerLanguageWords(input);
  const preference = customerDmLanguagePreference(text);
  if (preference) return preference;
  if (!text || isAdTemplateOpener(text) || isNeutralShortReply(text)) return null;
  const own = stripNonLanguage(clientOwnWords(text));
  if (!/[а-яёҳҷӣӯқғ]/iu.test(own)) return null;
  const decided = decisiveLanguage(text);
  if (!decided) return null;
  const { tajik, russian } = clientLanguageScores(own);
  if (decided === "tg") return /[ҳҷӣӯқғ]/iu.test(own) || tajik > 0 || customerColloquialTajikLanguage(text) ? "tg" : null;
  return russian > 0 ? "ru" : null;
}

/**
 * Language of the whole dialogue so far (audit 16.11.2026, chats 5a5de705 and 5e961b62): the six-turn memory holds ~3 customer
 * turns, so a dot, a phone number or a pack of photos pushed the Tajik words out and the reply fell back to Russian. This reads
 * the customer's own words of the wider history (the loader passes up to 50 inputs, oldest first) and returns the language of
 * the last decisive one. The ad button text and short neutral words never decide. Null when nothing decided yet.
 */
export function customerDmDialogueLanguage(userTextsOldestFirst: readonly string[]): "ru" | "tg" | null {
  // The latest explicit request («пишите по-таджикски») outlives any later full sentence in the other language.
  for (const raw of [...userTextsOldestFirst].reverse()) {
    const requested = customerDmPinnedLanguageRequest(customerHistoryOwnWords(raw));
    if (requested) return requested;
  }
  for (const raw of [...userTextsOldestFirst].reverse()) {
    const text = customerLanguageWords(raw);
    if (!text || isAdTemplateOpener(text)) continue;
    const decided = decisiveLanguage(text);
    if (decided) return decided;
  }
  return null;
}

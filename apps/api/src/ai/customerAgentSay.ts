import type { CustomerAgentSayDropReason, CustomerAgentSurface, CustomerAgentVerifiedContext } from "@royal-home/shared";
import { clientOwnWords } from "./untrustedContent.js";
import { detectClientLanguage } from "./clientLanguage.js";
import { BW, EW, TAIL } from "./wordBoundary.js";

/**
 * GROUNDED FREE-PHRASE CHANNEL (`say`) — the only model-written words a customer can read (plan 24.10.2026, section 3).
 *
 * The model may add one or two short sentences to the template answer: acknowledge what was said, restate the need, lead
 * softly into the answer. It never carries facts, numbers, contacts, promises or questions: the templates still own all of
 * those. The verdict is ALL OR NOTHING — the text is never cut or repaired (the old filter chain that did so ate answers),
 * a rejected `say` simply disappears and the template reply goes out unchanged.
 *
 * Pure and deterministic: the core validates once, the renderer validates again from the same inputs, and delivery sealing
 * re-renders the identical text. No clock, randomness, database or network may ever enter this file.
 */
export const SAY_MAX_CHARS = 200;
export const SAY_MAX_SENTENCES = 2;
/** v1 ships Russian only; Tajik tone needs a native speaker's review of ~50 samples first (plan section 8). */
export const SAY_ENABLED_LANGUAGES: readonly ("ru" | "tg")[] = ["ru"];
/** The phrase repeats the customer's own message word for word: this many consecutive words. */
const ECHO_WORDS = 5;

/** Example phrases shown to the model. The tests run every one through the validator, so the guidance can never teach a phrase the server would drop. */
export const CUSTOMER_AGENT_SAY_EXAMPLES = {
  ru: ["Понял, вас интересует эта квартира.", "Спасибо, что рассказали о своей ситуации.", "Извините, что вам пришлось ждать ответа."],
  tg: ["Фаҳмидам, шуморо ин объект ҷалб кардааст.", "Ташаккур, ки дар бораи вазъияти худ навиштед.", "Бубахшед, ки шумо интизор шудед."],
} as const;
const sayExample = (text: string) => `{"kind":"reply","refs":[],"social":"none","question":"none","say":"${text}"}`;
/**
 * The rules for the optional `say` field. They travel in the per-turn server context (`serverSurface.sayGuidance`, private messages only), NOT in the
 * system prompt: the system prompt and its hash are one constant for every surface, and a changed prompt hash cannot ride the ordinary «Обновить версию
 * бота» path (lib/customerAgentOwnerPolicy.ts pins every instruction change to a reviewed upgrade pair). This text is hashed with the renderer files instead.
 */
export const CUSTOMER_AGENT_SAY_GUIDANCE = `Единственное исключение из «не добавляй произвольный текст» — необязательное поле say в reply, clarify и propose: одна-две короткие фразы на языке replyLanguage.
Они признают сказанное клиентом, пересказывают его потребность и мягко подводят к ответу. Сервер ставит say после приветствия и перед проверенными фактами и единственным шаблонным вопросом.
Правила say:
- без цифр, сумм, дат, дней недели, сроков, контактов, ссылок и @; без названий мест, которых клиент сам не писал;
- без обещаний и будущих действий («позвоним», «уточню», «проверю», «запишу», «подберу»);
- без вопросов и просьб что-то написать или прислать: вопрос задаёт сервер;
- без слов «я бот», «ИИ», CRM, «инструмент», refs; не повторяй факты и слова клиента подряд;
- не здоровайся в say и не повторяй прежние реплики.
Сервер принимает say целиком или отбрасывает целиком и не правит; сомневаешься в фразе — не пиши say, ответ уйдёт по шаблону.
Примеры на русском:
${CUSTOMER_AGENT_SAY_EXAMPLES.ru.map(sayExample).join("\n")}
Примеры на таджикском:
${CUSTOMER_AGENT_SAY_EXAMPLES.tg.map(sayExample).join("\n")}`;

export type CustomerAgentSayVerdict = { ok: true; text: string } | { ok: false; reason: Exclude<CustomerAgentSayDropReason, "shadow"> };
export interface CustomerAgentSayInput {
  say: unknown;
  language: "ru" | "tg";
  surface: CustomerAgentSurface;
  inputText?: string;
  /** The evidence the decision points at; receipts there are the only thing that unlocks a promise word. */
  selectedEvidence?: readonly { kind: string; outcome?: unknown }[];
  /** Earlier bot turns of this conversation (verified context), newest last. */
  priorAssistantTurns?: readonly string[];
  social?: "none" | "greet" | "thank" | "acknowledge" | "apologize";
  /** Defaults to the v1 set; tests widen it to exercise the Tajik rules. */
  enabledLanguages?: readonly ("ru" | "tg")[];
}

// Tajik-specific letters fold to their Russian base so a spelling variant cannot slip past a lexicon; ъ and ё fold too.
const FOLD: Record<string, string> = { "қ": "к", "ғ": "г", "ҳ": "х", "ҷ": "ч", "ӣ": "и", "ӯ": "у", "ё": "е", "ъ": "" };
const foldSource = (value: string) => value.replace(/[қғҳҷӣӯёъ]/gu, ch => FOLD[ch]);
/** Lower-cased, folded text that every lexicon below is matched against (patterns are folded the same way). */
const fold = (value: string) => foldSource(value.toLowerCase());
const rx = (source: string) => new RegExp(foldSource(source), "iu");
/** Whole-word alternatives (Cyrillic-aware boundaries, never \b/\w). */
const w = (alternatives: string) => rx(`${BW}(?:${alternatives})${EW}`);
const TAJIK_LETTER = /[қғҳҷӣӯҚҒҲҶӢӮ]/u;
const INVISIBLE = /[\p{Cf}\u00AD\u180E\uFE00-\uFE0F]/gu;

/** NFKC folds full-width and compatibility digits to ASCII; invisible and bidi controls would hide a digit or a word. */
export function normalizeSayText(value: string): string {
  return value.normalize("NFKC").replace(INVISIBLE, "").replace(/[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/gu, " ").trim();
}
const NEWLINE = /[\r\n\u0085\u2028\u2029\v\f]/u;

const NUMBER_WORDS = w([
  "ноль", "нуль", "нол[яюе]", "один", "одна", "одно", "одну", "одной", "одного", "одним", "одни", "одних", "дв[аеу]", "двух", "двум", "двумя", "три", "трех", "трем", "тремя",
  `четыр${TAIL}`, `пят(?:ь|и|ью|ый|ая|ое|ого|ой|ом|ер${TAIL})`, `шест(?:ь|и|ью|ой|ая|ое|ого|ом|ер${TAIL})`, "семь", "семи", "семью", `седьм${TAIL}`, `восем${TAIL}`, `девят${TAIL}`, `десят${TAIL}`, `\\p{L}*надцат${TAIL}`,
  `двадцат${TAIL}`, `тридцат${TAIL}`, "сорок", "сорока", `пятьдесят${TAIL}`, `шестьдесят${TAIL}`, `семьдесят${TAIL}`, `восемьдесят${TAIL}`, "девяносто", "сто", "ста", "стам", `сотн${TAIL}`, "сотен",
  "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот", `тысяч${TAIL}`, "тыс", `миллион${TAIL}`, `миллиард${TAIL}`, `полтор${TAIL}`, "пара", "пару", "пары",
  // Tajik cardinals
  "як", "ду", "се", "чор", "панҷ", "шаш", "ҳафт", "ҳашт", "нӯҳ", "даҳ", "бист", "си", "чил", "панҷоҳ", "шаст", "ҳафтод", "ҳаштод", "навад", "сад", "ҳазор",
  // Property parameters read as figures: floors, rooms, areas
  `\\p{L}*комнатн${TAIL}`, `этаж${TAIL}`, `одн?ушк${TAIL}`, `двушк${TAIL}`, `тр[её]шк${TAIL}`, `квадрат${TAIL}`, `метр${TAIL}`, `сотк${TAIL}`, `ошёна${TAIL}`, `ҳуҷра${TAIL}`,
].join("|"));
const CURRENCY = rx(`[$€₽£¥%№]|${BW}(?:сомон${TAIL}|сом|долл?ар${TAIL}|usd|tjs|руб${TAIL}|евро|дирам${TAIL}|процент${TAIL}|фоиз${TAIL}|валют${TAIL})${EW}`);
const MONTHS = w(`январ${TAIL}|феврал${TAIL}|март${TAIL}|апрел${TAIL}|ма[йя]|июн${TAIL}|июл${TAIL}|август${TAIL}|сентябр${TAIL}|октябр${TAIL}|ноябр${TAIL}|декабр${TAIL}`);
const WEEKDAYS = w(`понедельник${TAIL}|вторник${TAIL}|сред(?:а|ы|у|е|ой|ам|ами|ах)|четверг${TAIL}|пятниц${TAIL}|суббот${TAIL}|воскресень${TAIL}|выходн${TAIL}|якшанбе|сешанбе|чоршанбе|панҷшанбе|ҷумъа|шанбе`);
const RELATIVE_TIME = w(`сегодня|завтра|вчера|послезавтра|позавчера|утром|вечером|днем|ночью|через\\s+(?:час|минут|секунд|пару|несколько|день|дн|недел|месяц|год|полчаса)\\p{L}*|в\\s+ближайш${TAIL}|на\\s+(?:этой|следующей|той)\\s+неделе|имрӯз|фардо|дирӯз|пагоҳ${TAIL}|баъдтар|баъд\\s+аз|ба\\s+зудӣ|соат${TAIL}|час|часа|часов|часу|часы|минут${TAIL}|секунд${TAIL}|дней|недел${TAIL}|месяц${TAIL}|год|года|лет`);

const QUESTION_MARK = /[?\uFF1F\u061F\u2047\u2048\u2049]/u;
// A question without the sign, or a request for information: the single template question owns that slot.
const ASKING = w(`как${TAIL}|сколько|где|когда|почему|зачем|куда|откуда|кто|подскажите|скажите|расскажите|уточните|напишите|пришлите|отправьте|назовите|сообщите|ответьте|укажите|выберите|не\\s+подскажете|нависед|фиристед|бигӯед|гӯед|маълум\\s+кунед|хабар\\s+диҳед|кадом|чанд|кай|куҷо|чаро`);

const META = rx(`${BW}(?:ии|ai|api|llm|gpt|gemini|json|markdown|crm|bot|prompt|ref|нейросет${TAIL}|искусственн${TAIL}\\s+интеллект${TAIL}|интеллект${TAIL}|модел${TAIL}|бот(?:а|у|ом|е|ы|ов|ам|ами|ах)?|ассистент${TAIL}|виртуальн${TAIL}|автоответ${TAIL}|робот${TAIL}|систем${TAIL}|инструмент${TAIL}|алгоритм${TAIL}|шаблон${TAIL}|зеҳни\\s+сунъӣ|сунъӣ|нейро${TAIL}|шабакаи\\s+асаб${TAIL})${EW}|[*_\`#{}\\[\\]<>|~\\\\]`);

const CONTACT = rx(`\\p{Script=Latin}|@|https?:|www\\.|${BW}(?:вотсап${TAIL}|ватсап${TAIL}|уотсап${TAIL}|телеграм${TAIL}|инстаграм${TAIL}|инста|фейсбук${TAIL}|мессенджер${TAIL}|директ|директе|директа|директом|сайт${TAIL}|ссылк${TAIL}|пайванд${TAIL}|номер${TAIL}|телефон${TAIL}|контакт${TAIL}|почт(?:а|ы|у|е|ой|овый|овая|овых)|е-?мейл${TAIL}|мобильн${TAIL}|рақам${TAIL}|смс|точк${TAIL}\\s+(?:тж|ру|ком|нет|орг|рф)|тж|ком)${EW}|\\.\\s*(?:тж|ру|ком|рф)${EW}`);

// Gated promise words: a callback or handover receipt unlocks "call"; a saved-contact receipt unlocks "noted".
const CALL_PROMISE = rx(`${BW}(?:(?:по|пере)?звон${TAIL}|свяж${TAIL}|связ${TAIL}|наберем|наберу|наберут|занг\\s+мезан${TAIL}|занг\\s+занем|занг\\s+занад|занг\\s+мекун${TAIL}|тамос\\s+мегир${TAIL})${EW}`);
const SAVE_PROMISE = rx(`${BW}(?:записал${TAIL}|запишу|запишем|занес${TAIL}|внес${TAIL}|сохранил${TAIL}|сохраню|сохраним|зафиксир${TAIL}|зарегистрир${TAIL}|сабт\\s+кард${TAIL}|сабт\\s+мекун${TAIL}|сабт\\s+шуд${TAIL}|нигоҳ\\s+дошт${TAIL})${EW}`);
const ALWAYS_PROMISE = rx(`${BW}(?:вернусь|вернемся|напомню|напомним|дам\\s+знать|дадим\\s+знать|буду\\s+на\\s+связи|будем\\s+на\\s+связи|оформлен${TAIL}|оформим|оформлю|подтвержд${TAIL}|подтверд${TAIL}|забронир${TAIL}|зарезервир${TAIL}|бронир${TAIL}|тасдиқ\\s+шуд${TAIL}|тасдиқ\\s+мекун${TAIL}|уточню|уточним|проверю|проверим|посмотрю|посмотрим|узнаю|узнаем|выясню|выясним|сообщу|сообщим|отправлю|отправим|пришлю|пришлем|подготовлю|подберу|подберем|найду|найдем|организую|договорюсь|передам|передадим|гарантир${TAIL}|обещаю|обещаем|занимусь|разберусь|помогу|поможем|мепурсам|мепурсем|мефиристам|мефиристем|хабар\\s+медиҳам|хабар\\s+медиҳем|санҷида\\s+мебинам|мебинам|меҷӯям|меҷӯем|кафолат\\s+медиҳам)${EW}|${BW}в\\s+ближайш${TAIL}\\s+врем${TAIL}${EW}|${BW}как\\s+можно\\s+скорее${EW}`);

// Claims about availability, price and company policy belong to server facts, never to free words.
const FACT_CLAIM = w([
  `продан${TAIL}`, "свободен", `свободн${TAIL}`, `занят${TAIL}`, `брон${TAIL}`, `скидк${TAIL}`, "торг", `торгу${TAIL}`, `торгов${TAIL}`, `дешев${TAIL}`, `недорог${TAIL}`, `дорог${TAIL}`, `выгодн${TAIL}`, `подешев${TAIL}`,
  "цена", "цены", "цену", "цене", "ценой", `ценов${TAIL}`, `стоимост${TAIL}`, "стоит", "стоят", `оплат${TAIL}`, `платеж${TAIL}`,
  "в\\s+наличии", "имеется", "имеются", `доступн${TAIL}`, `актуальн${TAIL}`, `остал${TAIL}`, `найден${TAIL}`, `нашл${TAIL}`, `нашел${TAIL}`, "нашли", `подходящ${TAIL}`, `подобран${TAIL}`, `подборк${TAIL}`,
  `ипотек${TAIL}`, `рассрочк${TAIL}`, `комисси${TAIL}`, `гаранти${TAIL}`, `юридическ${TAIL}`, `аренд${TAIL}`, `застройщик${TAIL}`, `новостройк${TAIL}`,
  `фурӯхта${TAIL}`, `фурӯхт${TAIL}`, `озод${TAIL}`, `тахфиф${TAIL}`, "савдо", `арзон${TAIL}`, `гарон${TAIL}`, `дастрас${TAIL}`, `мавҷуд${TAIL}`, `ёфт${TAIL}`, `нарх${TAIL}`, `пардохт${TAIL}`, `кироя${TAIL}`, "ҳаққи\\s+хизмат",
].join("|"));

const CLICHE = rx(`${BW}(?:отличн${TAIL}\\s+вопрос${TAIL}|хорош${TAIL}\\s+вопрос${TAIL}|интересн${TAIL}\\s+вопрос${TAIL}|рад\\s+помочь|рада\\s+помочь|с\\s+радостью|буду\\s+рад${TAIL}|понимаю\\s+ваш${TAIL}\\s+(?:беспокойств${TAIL}|чувств${TAIL}|волнени${TAIL}|эмоци${TAIL})|благодарю\\s+за\\s+(?:обращени${TAIL}|вопрос${TAIL})|спасибо\\s+за\\s+(?:обращени${TAIL}|вопрос${TAIL})|чем\\s+могу\\s+(?:быть\\s+)?полезн${TAIL}|чем\\s+могу\\s+помочь|обращайтесь|не\\s+стесняйтесь|безусловно|разумеется|непременно|ваш${TAIL}\\s+мнени${TAIL}\\s+важн${TAIL}|ценим\\s+ваш${TAIL}|всегда\\s+рады|рады\\s+помочь|к\\s+вашим\\s+услугам|саволи\\s+хуб|саволи\\s+ҷолиб|хурсанд\\s+мешавам|хурсандам|бо\\s+камоли\\s+майл|барои\\s+муроҷиат\\s+ташаккур|шуморо\\s+мефаҳмам)${EW}`);

const GREETING = rx(`${BW}(?:здравствуй${TAIL}|привет${TAIL}|добр(?:ый|ое|ого|ым|ая|ой)\\s+(?:день|дня|утро|утра|вечер|вечера|ночи)|доброго\\s+времени|салом${TAIL}|ассалом${TAIL}|хуш\\s+омад${TAIL}|рӯзатон\\s+бахайр|субҳ${TAIL}\\s+бахайр|шоми\\s+хуш|ҳаллоу|алло)${EW}`);

/** Places a customer could talk about; the model may repeat one ONLY if the customer's own words already contain it.
 * The capitalised-word rule in unsupportedPlace is the wide net; this list also catches a lower-cased spelling. */
const KNOWN_PLACE_NAMES = ["душанбе", "худжанд", "бохтар", "куляб", "вахдат", "рудаки", "исмоили", "шохмансур", "фирдавси", "сино", "профсоюз", "борбад", "зарафшон", "овир", "чашмасор", "гулистон",
  "хисор", "варзоб", "таджикистан", "тоджикистан", "точикистон"];
const stem = (word: string) => { const folded = fold(word); return folded.slice(0, Math.max(4, folded.length - 2)); };
const KNOWN_PLACES = KNOWN_PLACE_NAMES.map(name => ({ stem: stem(name), pattern: w(`${name}${TAIL}`) }));
const tokens = (value: string) => value.match(/[\p{L}][\p{L}-]*/gu) ?? [];

function sentenceCount(value: string): number {
  return value.split(/[.!?…]+(?=\s|$)/u).map(part => part.trim()).filter(part => /\p{L}/u.test(part)).length;
}
/** A place name (known, or any capitalised word inside a sentence) that the customer never wrote himself. */
function unsupportedPlace(text: string, ownWords: string): boolean {
  const own = fold(ownWords), folded = fold(text);
  if (KNOWN_PLACES.some(place => place.pattern.test(folded) && !own.includes(place.stem))) return true;
  for (const sentence of text.split(/(?<=[.!?…])\s+/u)) {
    for (const [index, word] of tokens(sentence).entries()) {
      if (index === 0 || word.length < 3) continue;
      const first = word[0];
      if (first === first.toLowerCase() || first !== first.toUpperCase()) continue;
      if (!own.includes(stem(word))) return true;
    }
  }
  return false;
}
function echoes(text: string, ownWords: string): boolean {
  const say = tokens(fold(text)), own = tokens(fold(ownWords));
  if (say.length < ECHO_WORDS || own.length < ECHO_WORDS) return false;
  const windows = new Set<string>();
  for (let i = 0; i + ECHO_WORDS <= own.length; i++) windows.add(own.slice(i, i + ECHO_WORDS).join(" "));
  for (let i = 0; i + ECHO_WORDS <= say.length; i++) if (windows.has(say.slice(i, i + ECHO_WORDS).join(" "))) return true;
  return false;
}
const comparable = (value: string) => tokens(fold(normalizeSayText(value))).join(" ");

/** All-or-nothing verdict. The first failing rule names the reason; the text is never repaired. */
export function validateCustomerAgentSay(input: CustomerAgentSayInput): CustomerAgentSayVerdict {
  const bad = (reason: Exclude<CustomerAgentSayDropReason, "shadow">): CustomerAgentSayVerdict => ({ ok: false, reason });
  if (input.surface !== "dm") return bad("surface_disabled");
  if (!(input.enabledLanguages ?? SAY_ENABLED_LANGUAGES).includes(input.language)) return bad("language_disabled");
  if (typeof input.say !== "string") return bad("length");
  const raw = input.say.normalize("NFKC").replace(INVISIBLE, "");
  if (NEWLINE.test(raw)) return bad("length");
  const text = normalizeSayText(raw);
  if (text.length < 2 || text.length > SAY_MAX_CHARS || sentenceCount(text) > SAY_MAX_SENTENCES) return bad("length");
  const folded = fold(text);
  if (QUESTION_MARK.test(text) || ASKING.test(folded)) return bad("question");
  if (/\p{Nd}/u.test(text) || NUMBER_WORDS.test(folded) || CURRENCY.test(folded) || MONTHS.test(folded) || WEEKDAYS.test(folded) || RELATIVE_TIME.test(folded)) return bad("number_or_date");
  if (META.test(folded)) return bad("meta");
  if (CONTACT.test(folded)) return bad("contact");
  const outcomes = new Set((input.selectedEvidence ?? []).filter(item => item.kind === "receipt").map(item => String(item.outcome)));
  const callUnlocked = outcomes.has("callback_requested") || outcomes.has("handover_requested");
  const saveUnlocked = outcomes.has("contact_saved") || outcomes.has("job_application_saved");
  if (ALWAYS_PROMISE.test(folded) || CALL_PROMISE.test(folded) && !callUnlocked || SAVE_PROMISE.test(folded) && !saveUnlocked) return bad("promise");
  if (FACT_CLAIM.test(folded)) return bad("fact_claim");
  const ownWords = clientOwnWords(input.inputText ?? "");
  if (unsupportedPlace(text, ownWords)) return bad("place");
  if (CLICHE.test(folded)) return bad("cliche");
  const verdict = detectClientLanguage(text);
  const wrongLanguage = input.language === "ru"
    ? verdict === "tg" || verdict === "mixed" || TAJIK_LETTER.test(text)
    : verdict === "ru" || verdict === "mixed" || verdict !== "tg" && !TAJIK_LETTER.test(text);
  if (wrongLanguage) return bad("language");
  if (echoes(text, ownWords)) return bad("echo");
  const key = comparable(text);
  if ((input.priorAssistantTurns ?? []).some(turn => key && comparable(turn).includes(key))) return bad("repeat");
  if ((input.social === "greet" || (input.priorAssistantTurns?.length ?? 0) > 0) && GREETING.test(folded)) return bad("double_greet");
  return { ok: true, text };
}

/** The single place that turns a decision plus its evidence into validator input, so the core and the renderer cannot drift apart. */
export function validateCustomerAgentSayForDecision(input: {
  say: unknown; decision: { kind: string; social?: CustomerAgentSayInput["social"]; refs?: readonly string[]; ref?: string };
  evidence: readonly { ref: string; value: { kind: string; outcome?: unknown } }[];
  language: "ru" | "tg"; surface: CustomerAgentSurface; inputText?: string; verifiedContext?: Pick<CustomerAgentVerifiedContext, "turns">;
  enabledLanguages?: CustomerAgentSayInput["enabledLanguages"];
}): CustomerAgentSayVerdict {
  const refs = new Set(input.decision.kind === "propose" ? [input.decision.ref ?? ""] : input.decision.refs ?? []);
  return validateCustomerAgentSay({ say: input.say, language: input.language, surface: input.surface, inputText: input.inputText, social: input.decision.social,
    selectedEvidence: input.evidence.filter(item => refs.has(item.ref)).map(item => item.value),
    priorAssistantTurns: (input.verifiedContext?.turns ?? []).filter(turn => turn.role === "assistant").map(turn => turn.text),
    enabledLanguages: input.enabledLanguages });
}

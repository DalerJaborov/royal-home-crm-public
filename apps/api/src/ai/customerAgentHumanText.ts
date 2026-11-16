/**
 * WORDS A MODEL MAY NEVER WRITE TO A CUSTOMER, ONE LIST FOR EVERY MODEL-TEXT CHANNEL (review #211, 16.11.2026).
 *
 * Both model-text channels read these lists: the short phrase (`say`, customerAgentSay.ts) and the human part of the whole reply
 * (`answer`, customerAgentAnswer.ts). One list, so a rule can never differ between the two (owner rule «одна дверь»).
 *
 *  - informal address: «ты» and the verb forms that say «ты» without the pronoun (ru «хочешь», «подскажи»; tg «дорӣ», «бигӯ»).
 *    The bot speaks to customers strictly on «вы» / «шумо» (owner rule).
 *  - foreign words: a Russian word inside a Tajik reply and a Tajik word inside a Russian one (audit 14.11: 14 chats).
 *  - service claims: yes/no, «we work / sell / rent», documents, years, distances, «free», amounts, praise of an object.
 *    These are facts. Only a server template line may carry a fact; the model's words never do.
 *
 * Pure: no clock, randomness, database or network. Tests: tests/customer-agent-human-text.test.ts (every list entry).
 */
import { BW, EW, TAIL } from "./wordBoundary.js";

const lower = (value: string) => value.normalize("NFKC").toLowerCase();
/** Letter runs (Cyrillic incl. Tajik, Latin); a hyphen inside a word keeps it one word («қисм-қисм»). */
const words = (value: string) => lower(value).match(/\p{L}+(?:-\p{L}+)*/gu) ?? [];

// ── informal address («ты») ─────────────────────────────────────────────────────────────────────────────────────────
/** Russian «ты» pronouns. */
export const INFORMAL_RU_PRONOUNS = ["ты", "тебе", "тебя", "тобой", "тобою", "твой", "твоя", "твоё", "твое", "твои", "твоего", "твоей", "твоему", "твоих",
  "твоим", "твоими", "твою", "твоём", "твоем"] as const;
/** Russian imperative singular: the polite form ends in «-те» («подскажите»), these never do. */
export const INFORMAL_RU_IMPERATIVES = ["скажи", "подскажи", "расскажи", "покажи", "напиши", "пиши", "позвони", "звони", "перезвони", "смотри", "посмотри", "глянь",
  "пришли", "присылай", "отправь", "скинь", "кинь", "дай", "давай", "оставь", "уточни", "выбери", "выбирай", "реши", "подумай", "думай", "жди", "подожди", "приходи",
  "приезжай", "заходи", "зайди", "знай", "слушай", "послушай", "ответь", "сообщи", "назови", "бери", "возьми", "купи", "продай", "будь", "извини", "прости",
  "помоги", "проверь", "обратись", "свяжись", "определись", "торопись", "поторопись", "не волнуйся", "волнуйся", "стесняйся", "пойми", "поверь", "представь",
  "укажи", "добавь", "загляни", "набери", "звякни", "черкни", "отпиши"] as const;
/** Words that end like a 2nd-person verb («-ешь», «-ишь») but are not verbs. */
const RU_NOT_VERBS = new Set(["лишь", "мышь", "тишь", "брешь", "плешь", "вошь", "ишь", "камыш", "малыш", "шалаш"]);
/** Tajik «ту» pronouns and the 2nd-person-singular possessive («номат» = your name, informal). */
export const INFORMAL_TG_PRONOUNS = ["ту", "туро", "ба ту", "аз ту", "бо ту", "барои ту", "дар ту", "худат", "аз худат", "ба худат", "номат", "рақамат",
  "пулат", "хонаат", "телефонат", "барот", "ҳолат чӣ", "чӣ хел ту"] as const;
/** Tajik imperative singular: the polite form ends in «-ед» («бигӯед», «нависед»), these never do. */
export const INFORMAL_TG_IMPERATIVES = ["бигӯ", "гӯ", "навис", "бинавис", "кун", "бикун", "деҳ", "бидеҳ", "биё", "бифирист", "фирист", "бигир", "гир", "бубин",
  "бизан", "занг зан", "бихар", "бифурӯш", "бимон", "бош", "бирав", "рав", "бипурс", "пурс", "биёб", "бифаҳм", "бишин", "интизор шав", "бишав",
  "нишон деҳ", "хабар деҳ", "гӯй", "бигӯй"] as const;
/** Tajik 2nd-person-singular verb forms that are not built by a rule below («дорӣ», «ҳастӣ»). */
export const INFORMAL_TG_VERBS = ["дорӣ", "надорӣ", "ҳастӣ", "нестӣ", "бошӣ", "набошӣ", "хоҳӣ", "нахоҳӣ", "тавонӣ", "метавонӣ", "мехоҳӣ", "медонӣ", "нависӣ"] as const;
/** Tajik past stems: stem + «-ӣ» is «you did» informally («гуфтӣ», «харидӣ»). */
const TG_PAST_STEMS = ["кард", "гуфт", "омад", "фиристод", "хост", "дид", "навишт", "гирифт", "дод", "монд", "рафт", "фаҳмид", "пурсид", "ёфт", "шунид", "донист",
  "тавонист", "буд", "шуд", "харид", "фурӯхт", "интихоб кард"];
/** «ме-…-ӣ» present forms («мехарӣ», «мефурӯшӣ»), except nouns and adjectives that merely start with «ме» («меҳрубонӣ», «мебелӣ»). */
const TG_ME_NOT_VERBS = /^(?:меҳ|меъ|мева|мебел|метр|металл|мерос|меню|механ|медал|меҳмон)/u;

/** The first «ты» word of the text, or null. Built only from the lists above. */
export function informalAddress(text: string, language: "ru" | "tg"): string | null {
  const list = words(text), joined = ` ${list.join(" ")} `;
  const phrase = (entries: readonly string[]) => entries.find(entry => joined.includes(` ${entry} `)) ?? null;
  if (language === "ru") {
    const found = phrase(INFORMAL_RU_PRONOUNS) ?? phrase(INFORMAL_RU_IMPERATIVES);
    if (found) return found;
    // 2nd person singular present/future: «хочешь», «рассчитываешь», «можешь», «ищешь», «звонишь» (and reflexive «-ешься»).
    const verb = list.find(word => /(?:ешь|ёшь|ишь|ешься|ёшься|ишься)$/u.test(word) && !RU_NOT_VERBS.has(word));
    if (verb) return verb;
    // Reflexive imperative singular («не стесняйся», «свяжись»): «-йся» except participles («-щийся», «-вшийся»).
    return list.find(word => /[^иы]йся$/u.test(word)) ?? null;
  }
  const found = phrase(INFORMAL_TG_PRONOUNS) ?? phrase(INFORMAL_TG_IMPERATIVES) ?? phrase(INFORMAL_TG_VERBS) ??
    phrase(TG_PAST_STEMS.flatMap(stem => [`${stem}ӣ`, `на${stem}ӣ`]));
  if (found) return found;
  return list.find(word => /^(?:на)?ме\p{L}{2,}ӣ$/u.test(word) && !TG_ME_NOT_VERBS.test(word.replace(/^на/u, ""))) ??
    // Subjunctive «би-…-ӣ» («бигӯӣ», «бихарӣ»).
    list.find(word => /^би\p{L}{2,}ӣ$/u.test(word)) ?? null;
}

// ── foreign words (mixed language) ──────────────────────────────────────────────────────────────────────────────────
/** Letters Tajik does not have (ц, щ, ы, ь): a word with one of them is Russian. */
const RUSSIAN_ONLY_LETTER = /[цщыь]/u;
/** Letters Russian does not have. */
const TAJIK_ONLY_LETTER = /[ғӣқӯҳҷ]/u;
/** Common Russian words written with letters Tajik shares (they would pass the letter rule). */
export const RUSSIAN_WORDS_IN_TAJIK = ["хорошо", "понял", "поняла", "понятно", "понимаю", "спасибо", "конечно", "ладно", "да", "нет", "очень", "пожалуйста",
  "здравствуйте", "привет", "добрый", "вы", "вас", "вам", "ваш", "ваша", "ваше", "ваши", "для", "это", "как", "что", "где", "когда", "сколько", "можно", "нужно",
  "хотите", "если", "или", "но", "уже", "ещё", "еще", "только", "тоже", "также", "сейчас", "квартира", "квартиру", "хороший", "хорошая", "хорошее", "семья",
  "семьи", "отлично", "давайте", "подскажите", "скажите", "напишите", "звоните", "сотрудник", "вариант", "варианты", "район", "комнат", "деньги", "сумма",
  "агентство", "недвижимость", "так", "вот", "есть", "будет", "был", "была", "мы", "наш", "наши", "по", "за", "от", "при", "про"] as const;
/** Common Tajik words written with letters Russian shares. */
export const TAJIK_WORDS_IN_RUSSIAN = ["салом", "ассалом", "ассалому", "алейкум", "алайкум", "ваалайкум", "рахмат", "ташаккур", "хуб", "бале", "шумо", "шуморо",
  "мо", "ман", "ва", "барои", "аст", "дар", "бо", "аз", "ин", "хона", "хонаи", "мехохед", "лутфан", "чи", "кадом", "чанд", "кай", "кучо", "нест", "хаст",
  "мешавад", "мекунем", "бемалол", "агенти", "ки", "сомони", "нархи", "нархаш", "ё", "хам", "фахмидам", "майлаш", "раҳмат", "хуш", "омадед", "мебошад"] as const;
const RU_IN_TG = new Set<string>(RUSSIAN_WORDS_IN_TAJIK), TG_IN_RU = new Set<string>(TAJIK_WORDS_IN_RUSSIAN);

/** The first word of the other language, or null. */
export function foreignLanguageWord(text: string, language: "ru" | "tg"): string | null {
  for (const word of words(text)) {
    if (/\p{Script=Latin}/u.test(word)) return word;
    if (language === "tg" ? RUSSIAN_ONLY_LETTER.test(word) || RU_IN_TG.has(word) : TAJIK_ONLY_LETTER.test(word) || TG_IN_RU.has(word)) return word;
  }
  return null;
}

// ── service claims: facts that only a server line may carry ─────────────────────────────────────────────────────────
/**
 * Regex SOURCE (Tajik letters are folded by the caller with the same fold as the text). Every alternative is a whole word.
 * Yes/no, existence, «we do X» verbs, documents, years, distances, landmarks, free/price words, amounts and praise of an object.
 */
export const SERVICE_CLAIM_SOURCE = `${BW}(?:${[
  // yes / no / existence: «Да, в Худжанде тоже», «аренды нет», «Ҳа», «нест», «надорем»
  "да", "нет", "нету", "не", "ни", "ага", "угу", "ҳа", "бале", "хайр", "нест", `нест${TAIL}`, "ҳаст", `ҳастанд`, "есть", "имеется", "имеются", "дорем", "дорад", "доранд",
  `надор${TAIL}`, `наме\\p{L}+`, `на(?:шуд|буд|бош|тавон|ёфт)${TAIL}`, "конечно", "разумеется", "безусловно", "точно", "верно", "правильно", "именно",
  "албатта", "ҳатман", "аниқ", "дуруст", "тоже", "также", "ҳам",
  // «we work / sell / rent / help»: finite verbs (infinitives «купить», «продать» stay for the role question)
  `работа(?:ем|ет|ют)`, `обслужива${TAIL}`, `занима(?:емся|ется|ются)`, `помога(?:ем|ет|ют)`, `сда(?:ём|ем|ёт|ет|ют|ётся|ется|ются|н|на|но|ны)`,
  `прода(?:ём|ем|ёт|ет|ют|ётся|ется|ются)`, `продан${TAIL}`, `покупаем`, `выкупаем`, `бер[её]м`, `принимаем`, `предлагаем`, `оформля${TAIL}`, `выезжаем`,
  `показываем`, `покажем`, `отправляем`, `вышлем`, `сопровожда${TAIL}`, `консультиру${TAIL}`, `делаем`, `сделаем`, `ищем`, `подбираем`, `выда[её]м`,
  "в\\s+продаже", `кор\\s+мекун${TAIL}`, `кӯмак\\s+мекун${TAIL}`, `ёрӣ\\s+мерасон${TAIL}`, `ёрдам${TAIL}`, `хизмат\\s+мерасон${TAIL}`,
  // Tajik «we …» present: «мефурӯшем», «мекунем», «метавонем»; «it/they …»: «мешавад», «мефурӯшанд»
  `ме\\p{L}+(?:ем|ад|анд)`,
  // documents, legal, new building, keys, years and other time spans
  `документ${TAIL}`, `ҳуҷҷат${TAIL}`, `кадастр${TAIL}`, `свидетельств${TAIL}`, `техпаспорт${TAIL}`, `справк${TAIL}`, `договор${TAIL}`, `шартнома${TAIL}`, `нотари${TAIL}`,
  `новостро${TAIL}`, `навсохт${TAIL}`, `построен${TAIL}`, `сохта\\s+шуд${TAIL}`, `готов${TAIL}`, `тайёр${TAIL}`, `ключ${TAIL}`, `калид${TAIL}`,
  `год${TAIL}`, "лет", `сол${TAIL}`, `моҳ${TAIL}`, `месяц${TAIL}`, `недел${TAIL}`, `ҳафта${TAIL}`, `минут${TAIL}`, `дақиқа${TAIL}`,
  // distance, landmarks, geography: «до центра 15 минут», «рядом школа», «по всей стране»
  `центр${TAIL}`, `марказ${TAIL}`, "рядом", "близко", "недалеко", `наздик${TAIL}`, `метро`, `остановк${TAIL}`, `школ${TAIL}`, `мактаб${TAIL}`, `садик${TAIL}`, `боғча${TAIL}`,
  `рын(?:ок|ка|ке|ку)`, `бозор${TAIL}`, `магазин${TAIL}`, `мағоза${TAIL}`, `больниц${TAIL}`, `парк${TAIL}`, `мечет${TAIL}`, `масҷид${TAIL}`, `ошён${TAIL}`, `площад${TAIL}`,
  `масоҳат${TAIL}`, `город${TAIL}`, `шаҳр${TAIL}`, `вилоят${TAIL}`, `област${TAIL}`, `регион${TAIL}`, `стран${TAIL}`, `кишвар${TAIL}`, "везде", "всюду", "повсюду",
  "ҳама\\s+ҷо", `республик${TAIL}`, `район${TAIL}`, `ноҳия${TAIL}`, `мавзе${TAIL}`, `микрорайон${TAIL}`, "мкр", `тараф${TAIL}`,
  // money and price words: «бесплатно», «без комиссии», «акция», «бонус»
  `бесплатн${TAIL}`, "даром", "ройгон", "бепул", `акци${TAIL}`, `бонус${TAIL}`, `подар${TAIL}`, `тӯҳфа${TAIL}`, `деньг${TAIL}`, `сумм${TAIL}`, `бюджет${TAIL}`,
  `маблағ${TAIL}`, "пул", `пули`, `цен${TAIL}`, `стоимост${TAIL}`, "стоит", "стоят", `нарх${TAIL}`, `комисси${TAIL}`,
  // amounts: «много вариантов», «все варианты», «якчанд»
  "много", "мало", "несколько", `множеств${TAIL}`, "полно", "все", "всех", "всем", "всеми", "бисёр", "зиёд", "кам", "якчанд", "ҳамаи", "ҳама",
  // praise or pity of an object or a status: «отличный вариант», «к сожалению», «новая квартира»
  `отличн${TAIL}`, `прекрасн${TAIL}`, `замечательн${TAIL}`, `чудесн${TAIL}`, `идеальн${TAIL}`, `лучш${TAIL}`, `хорош(?:ий|ая|ее|ие|его|ую|ей|им|их|ими)`,
  `нов(?:ый|ая|ое|ые|ого|ую|ой|ом|ых|ым)`, `светл${TAIL}`, `просторн${TAIL}`, `уютн${TAIL}`, `тепл${TAIL}`, `тих${TAIL}`, `солнечн${TAIL}`, `чист${TAIL}`,
  `мебел${TAIL}`, `ремонт${TAIL}`, `беҳтарин${TAIL}`, `хубтарин${TAIL}`, "олӣ", "аъло", `зебо${TAIL}`, "нав", `навтарин${TAIL}`, `калон${TAIL}`,
  "к\\s+сожалению", "увы", "жаль", "мутаассифона", `афсӯс${TAIL}`, "хушбахтона", "к\\s+счастью", `новост${TAIL}`, "хушхабар",
].join("|")})${EW}`;

/** Topic words of each question the model may word itself; they are allowed in THAT question only (cut out before the claim check). */
export const ASK_TOPIC_SOURCES = {
  budget: `${BW}(?:бюджет${TAIL}|сумм${TAIL}|маблағ${TAIL}|рассчитыва${TAIL}|потратить|пул|пули|цен${TAIL}|стоимост${TAIL}|нарх${TAIL}|деньг${TAIL})${EW}`,
  location: `${BW}(?:район${TAIL}|ноҳия${TAIL}|мавзе${TAIL}|тараф${TAIL}|шаҳр${TAIL}|город${TAIL}|микрорайон${TAIL}|мкр|где|куда|куҷо|кучо|қисм${TAIL}|ҷой${TAIL})${EW}`,
  rooms: `${BW}(?:\\p{L}*комнат${TAIL}|ҳуҷра${TAIL}|хонаг${TAIL})${EW}`,
  name: `${BW}(?:зовут|имя|имени|обращаться|ном|номи|номатон|номаш)${EW}`,
  callback_consent: `${BW}(?:занг\\s+занад|занг\\s+занем|(?:по|пере)?звон${TAIL}|созвон${TAIL}|занг${TAIL})${EW}`,
  role: `${BW}(?:купить|продать|покупк${TAIL}|продаж${TAIL}|харид${TAIL}|фурӯш${TAIL}|фурӯхтан|мехаред|мефурӯшед)${EW}`,
  // «недвижимость» is in both the role and the topic template question: it names neither, so it is neutral.
  topic: `${BW}(?:работ${TAIL}|кор|вакан${TAIL}|ҷои\\s+кор)${EW}`,
} as const;
export type CustomerAgentAskKind = keyof typeof ASK_TOPIC_SOURCES;
export const CUSTOMER_AGENT_ASK_KINDS = Object.keys(ASK_TOPIC_SOURCES) as CustomerAgentAskKind[];
/** A consent question must ASK for consent, never announce the call («Сотрудник позвонит вам, хорошо?»). */
export const CALLBACK_CONSENT_ASK_SOURCE = `${BW}(?:хотите|хотели|удобно|можно|не\\s+против|согласны|мехоҳед|мумкин|розӣ|майл\\s+доред)${EW}`;

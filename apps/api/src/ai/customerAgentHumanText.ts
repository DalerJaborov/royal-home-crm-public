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
/** Letter runs (Cyrillic incl. Tajik, Latin); a hyphen splits («Скажи-ка», «Бигӯ-чӣ»: each part is a word of its own). */
const words = (value: string) => lower(value).match(/\p{L}+/gu) ?? [];
/** Tajik typed without the Tajik letters («дори», «бигу», «мехари»): the lists are matched in this fold too. */
const TG_FOLD: Record<string, string> = { "ӣ": "и", "ӯ": "у", "ҳ": "х", "ҷ": "ч", "қ": "к", "ғ": "г" };
const tgFold = (value: string) => value.replace(/[ӣӯҳҷқғ]/gu, ch => TG_FOLD[ch]);

// ── informal address («ты») ─────────────────────────────────────────────────────────────────────────────────────────
/** Russian «ты» pronouns. */
export const INFORMAL_RU_PRONOUNS = ["ты", "тебе", "тебя", "тобой", "тобою", "твой", "твоя", "твоё", "твое", "твои", "твоего", "твоей", "твоему", "твоих",
  "твоим", "твоими", "твою", "твоём", "твоем"] as const;
/** Russian imperative singular: the polite form ends in «-те» («подскажите»), these never do. */
export const INFORMAL_RU_IMPERATIVES = ["скажи", "подскажи", "расскажи", "покажи", "напиши", "пиши", "позвони", "звони", "перезвони", "смотри", "посмотри", "глянь",
  "пришли", "присылай", "отправь", "скинь", "кинь", "дай", "давай", "оставь", "уточни", "выбери", "выбирай", "реши", "подумай", "думай", "жди", "подожди", "приходи",
  "приезжай", "заходи", "зайди", "знай", "слушай", "послушай", "ответь", "сообщи", "назови", "бери", "возьми", "купи", "продай", "будь", "извини", "прости",
  "помоги", "проверь", "обратись", "свяжись", "определись", "торопись", "поторопись", "не волнуйся", "волнуйся", "стесняйся", "пойми", "поверь", "представь",
  "укажи", "добавь", "загляни", "набери", "звякни", "черкни", "отпиши", "поделись", "спроси", "опиши", "объясни", "посоветуй", "уточняй",
  "пойдем", "пойдём", "ка"] as const;
/** Familiar address: never to a customer (review #211, round 2). «Ака» is respect in Tajik speech and is not listed. */
export const FAMILIAR_ADDRESS = ["брат", "братан", "братишка", "бро", "дружище", "дружок", "друг", "приятель", "бародар", "додар", "ҷӯра", "бача"] as const;
/** Words that end like a 2nd-person verb («-ешь», «-ишь») but are not verbs. */
const RU_NOT_VERBS = new Set(["лишь", "мышь", "тишь", "брешь", "плешь", "вошь", "ишь", "камыш", "малыш", "шалаш"]);
/** Tajik «ту» pronouns and the 2nd-person-singular possessive («номат» = your name, informal). */
export const INFORMAL_TG_PRONOUNS = ["ту", "туро", "ба ту", "аз ту", "бо ту", "барои ту", "дар ту", "худат", "аз худат", "ба худат", "номат", "рақамат",
  "пулат", "хонаат", "телефонат", "барот", "ҳолат чӣ", "чӣ хел ту"] as const;
/** Tajik imperative singular: the polite form ends in «-ед» («бигӯед», «нависед»), these never do. */
export const INFORMAL_TG_IMPERATIVES = ["бигӯ", "гӯ", "навис", "бинавис", "кун", "бикун", "деҳ", "бидеҳ", "биё", "бифирист", "фирист", "бигир", "гир", "бубин",
  "бизан", "занг зан", "бихар", "бифурӯш", "бимон", "бош", "бирав", "рав", "бипурс", "пурс", "биёб", "бифаҳм", "бишин", "интизор шав", "бишав",
  "нишон деҳ", "хабар деҳ", "гӯй", "бигӯй", "шав", "биёр", "ор", "фикр кун", "бубахш"] as const;
/** Tajik 2nd-person-singular verb forms that are not built by a rule below («дорӣ», «ҳастӣ»). */
export const INFORMAL_TG_VERBS = ["дорӣ", "надорӣ", "ҳастӣ", "нестӣ", "бошӣ", "набошӣ", "хоҳӣ", "нахоҳӣ", "тавонӣ", "метавонӣ", "мехоҳӣ", "медонӣ", "нависӣ"] as const;
/** Tajik past stems: stem + «-ӣ» is «you did» informally («гуфтӣ», «харидӣ»). */
const TG_PAST_STEMS = ["кард", "гуфт", "омад", "фиристод", "хост", "дид", "навишт", "гирифт", "дод", "монд", "рафт", "фаҳмид", "пурсид", "ёфт", "шунид", "донист", "дошт",
  "тавонист", "буд", "шуд", "харид", "фурӯхт", "интихоб кард"];
/** «ме-…-ӣ» present forms («мехарӣ», «мефурӯшӣ»), except nouns and adjectives that merely start with «ме» («меҳрубонӣ», «мебелӣ»). */
const TG_ME_NOT_VERBS = /^(?:меҳ|меъ|мева|мебел|метр|металл|мерос|меню|механ|медал|меҳмон)/u;

/** The first «ты» word of the text, or null. Built only from the lists above. */
export function informalAddress(text: string, language: "ru" | "tg"): string | null {
  const list = words(text), joined = ` ${list.join(" ")} `, folded = tgFold(joined);
  const phrase = (entries: readonly string[]) => entries.find(entry => joined.includes(` ${entry} `) ||
    language === "tg" && folded.includes(` ${tgFold(entry)} `)) ?? null;
  const familiar = phrase(FAMILIAR_ADDRESS);
  if (familiar) return familiar;
  if (language === "ru") {
    const found = phrase(INFORMAL_RU_PRONOUNS) ?? phrase(INFORMAL_RU_IMPERATIVES);
    if (found) return found;
    // A question in the past singular with no «вы» («Уже определился с районом?», «Нашёл подходящий район?», «хотел бы?»).
    for (const sentence of text.split(/(?<=[?])/u).filter(part => /[?]/u.test(part))) {
      const own = words(sentence);
      if (own.some(word => ["вы", "вас", "вам", "ваш", "ваша", "ваше", "ваши"].includes(word))) continue;
      const past = own.find(word => /(?:лся|лась|ёл|ел|ал|ил|ыл|ял|ол|ул|ла)$/u.test(word) && word.length >= 4 && !["могла", "стола", "села", "дела", "пола"].includes(word));
      if (past) return past;
    }
    // 2nd person singular present/future: «хочешь», «рассчитываешь», «можешь», «ищешь», «звонишь» (and reflexive «-ешься»).
    const verb = list.find(word => /(?:ешь|ёшь|ишь|ешься|ёшься|ишься)$/u.test(word) && !RU_NOT_VERBS.has(word));
    if (verb) return verb;
    // Reflexive imperative singular («не стесняйся», «свяжись»): «-йся» except participles («-щийся», «-вшийся»).
    return list.find(word => /[^иы]йся$/u.test(word)) ?? null;
  }
  const found = phrase(INFORMAL_TG_PRONOUNS) ?? phrase(INFORMAL_TG_IMPERATIVES) ?? phrase(INFORMAL_TG_VERBS) ??
    phrase(TG_PAST_STEMS.flatMap(stem => [`${stem}ӣ`, `на${stem}ӣ`]));
  if (found) return found;
  // «-ӣ», or «-и» when the word has no Tajik letter at all (typed without them: «мехари», «дори»).
  const secondSingular = (word: string) => /ӣ$/u.test(word) || /и$/u.test(word) && !/[ӣӯҳҷқғ]/u.test(word);
  return list.find(word => /^(?:на)?ме\p{L}{2,}$/u.test(word) && secondSingular(word) && !TG_ME_NOT_VERBS.test(word.replace(/^на/u, ""))) ??
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

/** The question kinds a model may word itself (from an approved list only, APPROVED_ASKS below). */
export const CUSTOMER_AGENT_ASK_KINDS = ["budget", "location", "rooms", "name", "callback_consent", "role", "topic"] as const;
export type CustomerAgentAskKind = typeof CUSTOMER_AGENT_ASK_KINDS[number];

// ── ALLOWLIST of WHOLE PHRASES for the model's human words (review #211, round 3) ─────────────────────────────────────────
/**
 * The ONLY sentences a model `lead` (1–2 of them) or `close` (one) may be. Whole vetted phrases, not words: a word allowlist still
 * composed claims («Это ваше.» over «уже продан», «Ин барои шумо.», «Понимаю, могу.», «Это очень хорошо.»; third review). Tajik from
 * the `tajik-phrasebook` skill (greetings-politeness.md, live-agent-phrases.md: literary spelling, «шумо»), Russian the same meanings.
 * Only case, punctuation, spaces and invisible characters are normalized; anything else (another word, a hyphen join, a homoglyph)
 * is not a phrase and the template goes out.
 *  - `greeting`: only where the template greets (it then replaces that line); no time-of-day greeting (the bot does not know the
 *    customer's hour well enough: «Добрый вечер» at 9 a.m. is worse than «Здравствуйте»);
 *  - `agree` («Хорошо», «Хуб», «Майлаш»): reads as «да», so never when the customer ASKS for something (a discount, a viewing
 *    tomorrow, «можно…?», «мумкин…?») and never next to a refusal;
 *  - `warm`: never next to a refusal / sold / unavailable / zone line; `neutral`: always;
 *  - `farewell` (close only, «Саломат бошед!»): also after a refusal (tajik-phrasebook: «Прощание после отказа»).
 */
export type HumanPhraseKind = "greeting" | "neutral" | "warm" | "agree" | "farewell";
export const HUMAN_PHRASES: Record<"ru" | "tg", Record<"lead" | "close", ReadonlyArray<readonly [string, HumanPhraseKind]>>> = {
  ru: {
    lead: [
      ["Здравствуйте!", "greeting"],
      ["Понимаю вас.", "neutral"], ["Понял вас.", "neutral"], ["Поняла вас.", "neutral"], ["Понял, спасибо.", "neutral"], ["Понял вас, спасибо.", "neutral"],
      ["Ясно, спасибо.", "neutral"], ["Спасибо!", "neutral"], ["Спасибо, что написали!", "neutral"], ["Спасибо, что вы написали.", "neutral"],
      ["Спасибо, что обратились к нам.", "neutral"], ["Спасибо за ваше сообщение.", "neutral"], ["Спасибо за интерес.", "neutral"],
      ["Спасибо, что дождались ответа.", "neutral"], ["Благодарю за терпение.", "neutral"], ["Спасибо за терпение.", "neutral"],
      ["Извините за задержку.", "neutral"], ["Извините, что пришлось ждать.", "neutral"], ["Извините за ожидание.", "neutral"],
      ["Понимаю, это важный вопрос.", "neutral"], ["Вот что могу сказать.", "neutral"], ["Вот информация по вашему вопросу.", "neutral"],
      ["Рады вашему сообщению.", "warm"], ["С удовольствием расскажу.", "warm"], ["Рады, что вы обратились.", "warm"],
      ["Хорошо.", "agree"], ["Хорошо, понял вас.", "agree"], ["Хорошо, понимаю вас.", "agree"], ["Хорошо, спасибо.", "agree"],
    ],
    close: [
      ["Всего доброго!", "farewell"], ["Всего хорошего!", "farewell"], ["Спасибо!", "farewell"], ["Спасибо за ваш вопрос!", "farewell"],
      ["Будем рады вашему сообщению.", "warm"], ["Будем рады, если напишете.", "warm"],
    ],
  },
  tg: {
    lead: [
      ["Ассалому алайкум!", "greeting"], ["Ассалому алейкум!", "greeting"], ["Ваалайкум ассалом!", "greeting"], ["Салом!", "greeting"], ["Хуш омадед!", "greeting"],
      ["Фаҳмидам.", "neutral"], ["Мефаҳмам.", "neutral"], ["Фаҳмидам, раҳмат.", "neutral"], ["Раҳмат, фаҳмидам.", "neutral"], ["Фаҳмидам, ташаккур.", "neutral"],
      ["Раҳмат!", "neutral"], ["Ташаккур!", "neutral"], ["Раҳмати калон!", "neutral"], ["Раҳмат, ки навиштед!", "neutral"],
      ["Ташаккур, ки ба мо муроҷиат кардед.", "neutral"], ["Ташаккур барои саволатон.", "neutral"], ["Ташаккур барои паёматон.", "neutral"],
      ["Ташаккур барои таваҷҷуҳ.", "neutral"], ["Раҳмат барои сабр.", "neutral"], ["Ташаккур барои сабр.", "neutral"], ["Бубахшед барои таъхир.", "neutral"],
      ["Бубахшед, ки интизор шудед.", "neutral"], ["Инак маълумот.", "neutral"],
      ["Хуб.", "agree"], ["Хеле хуб.", "agree"], ["Хуб, фаҳмидам.", "agree"], ["Майлаш.", "agree"],
    ],
    close: [
      ["Саломат бошед!", "farewell"], ["Хайр, саломат бошед!", "farewell"], ["Ташаккур, саломат бошед!", "farewell"], ["Раҳмат!", "farewell"],
      ["Ташаккур!", "farewell"], ["Бо эҳтиром.", "farewell"], ["Барори кор!", "warm"],
    ],
  },
};
/** Case, «ё», punctuation, spaces and invisible characters only; a hyphen or any other letter stays and breaks the match. */
const phraseKey = (text: string) => text.normalize("NFKC").replace(/[\p{Cf}]/gu, "").toLowerCase().replace(/ё/gu, "е")
  .replace(/[.,!…«»"':;]/gu, " ").replace(/\s+/gu, " ").trim();
const PHRASE_INDEX = Object.fromEntries((["ru", "tg"] as const).map(language => [language,
  Object.fromEntries((["lead", "close"] as const).map(role => [role, new Map(HUMAN_PHRASES[language][role].map(([text, kind]) => [phraseKey(text), kind]))]))])) as
  Record<"ru" | "tg", Record<"lead" | "close", Map<string, HumanPhraseKind>>>;
/** The kinds of the 1–2 vetted sentences a lead / close consists of, or null when any sentence is not a vetted phrase. */
export function humanPhraseKinds(text: string, language: "ru" | "tg", role: "lead" | "close"): HumanPhraseKind[] | null {
  const sentences = text.normalize("NFKC").replace(/[\p{Cf}]/gu, "").split(/(?<=[.!…])\s+/u).map(part => part.trim()).filter(Boolean);
  if (!sentences.length || sentences.length > (role === "lead" ? 2 : 1)) return null;
  const kinds: HumanPhraseKind[] = [];
  for (const sentence of sentences) {
    const kind = PHRASE_INDEX[language][role].get(phraseKey(sentence));
    if (!kind) return null;
    kinds.push(kind);
  }
  return kinds;
}
/**
 * The customer ASKS for something an «Хорошо» / «Хуб» would grant (a discount, a viewing, a date, «можно…?», «мумкин…?»): then no
 * agreement-like phrase may open the reply, whatever the template lines say (third review: «Можно скидку?» → «Хорошо.» + price).
 */
const CUSTOMER_REQUEST = new RegExp(`${BW}(?:можно|можете|могли|могу\\s+ли|дайте|сделайте|давайте|разрешите|скидк${TAIL}|уступ${TAIL}|торг${TAIL}|дешевле|завтра|сегодня|послезавтра|` +
  `посмотреть|показ${TAIL}|просмотр${TAIL}|запиш${TAIL}|встрет${TAIL}|приехать|прийти|бронь|заброниру${TAIL}|мумкин|мешавад|метавонед|тахфиф|арзон${TAIL}|` +
  `кам\\s+кунед|диҳед|дихед|пагоҳ|пагох|имрӯз|имруз|фардо|дидан|бинам|бубинам|тамошо|омадан|биёям|сабт)${EW}`, "iu");
export function customerRequestInText(text: string): boolean {
  return CUSTOMER_REQUEST.test(text.normalize("NFKC").toLowerCase());
}

/**
 * The ONLY questions a model `ask` may be: approved wordings per question kind (ru / tg), or nothing (the template question stays).
 * No free paraphrase: «…позвонил вам прямо сейчас?», «…или написал?», «позвонить вашему мужу?», «в каком городе?» cannot exist.
 * The call question and the name question are consent / identity records, so their list is the strictest (review #211, round 2).
 */
export const APPROVED_ASKS: Record<"ru" | "tg", Record<CustomerAgentAskKind, readonly string[]>> = {
  ru: {
    budget: ["Какой бюджет вы рассматриваете?", "На какую сумму вы рассчитываете?", "Подскажите, на какую сумму вы рассчитываете?", "Какой у вас бюджет?"],
    location: ["Какой район вам подходит?", "В каком районе вам было бы удобнее?", "Подскажите, в каком районе вам удобнее?", "Какой район вы рассматриваете?"],
    rooms: ["Сколько комнат вам нужно?", "Сколько комнат вы рассматриваете?", "Подскажите, сколько комнат вам нужно?"],
    name: ["Как к вам обращаться?", "Как я могу к вам обращаться?", "Подскажите, как к вам обращаться?", "Как вас зовут?"],
    callback_consent: ["Вы хотите, чтобы сотрудник вам позвонил?", "Хотите, чтобы сотрудник вам позвонил?", "Хотите, чтобы наш сотрудник вам позвонил?"],
    role: ["Вы хотите купить или продать недвижимость?", "Подскажите, вы хотите купить или продать недвижимость?", "Вы хотите купить или продать?"],
    topic: ["Вы хотите узнать о недвижимости или о работе?", "Вас интересует недвижимость или работа?"],
  },
  tg: {
    budget: ["Чӣ қадар маблағ дар назар доред?", "Бемалол бигӯед, чӣ қадар маблағ дар назар доред?"],
    location: ["Кадом тарафи шаҳрро мехоҳед?", "Кадом ноҳия ба шумо мувофиқ аст?", "Дар кадом ноҳия бошад, беҳтар аст?"],
    rooms: ["Чанд ҳуҷра?", "Чанд ҳуҷра лозим аст?"],
    name: ["Номи шумо чист?", "Номатон чист?"],
    callback_consent: ["Мехоҳед корманд ба шумо занг занад?", "Мехоҳед, ки корманд ба шумо занг занад?", "Мехоҳед, ки корманди мо ба шумо занг занад?"],
    role: ["Шумо хона мехаред ё мефурӯшед?", "Шумо хона харидан мехоҳед ё фурӯхтан?"],
    topic: ["Шумо дар бораи хона маълумот мехоҳед ё дар бораи кор?"],
  },
};
const askKey = (text: string) => text.normalize("NFKC").replace(/[\p{Cf}]/gu, "").toLowerCase().replace(/ё/gu, "е").replace(/[.,!«»"':;]/gu, " ").replace(/\s+/gu, " ").replace(/\s+\?/gu, "?").trim();
const ASK_INDEX = new Map<string, { kind: CustomerAgentAskKind; language: "ru" | "tg" }>((["ru", "tg"] as const).flatMap(language =>
  (Object.entries(APPROVED_ASKS[language]) as [CustomerAgentAskKind, readonly string[]][]).flatMap(([kind, list]) =>
    list.map(text => [askKey(text), { kind, language }] as const))));
/** The kind of an approved question wording (any punctuation inside, one «?» at the end), or null. */
export function approvedAsk(text: string): { kind: CustomerAgentAskKind; language: "ru" | "tg" } | null {
  return /[?]\s*$/u.test(text) && (text.match(/[?]/gu)?.length ?? 0) === 1 ? ASK_INDEX.get(askKey(text)) ?? null : null;
}

import { customerSearchBudgetSane, type CustomerBuyerNeeds } from "@royal-home/shared";
import { officialDistrictIn } from "../lib/searchPlace.js";
import { BW, EW, TAIL } from "./wordBoundary.js";

/**
 * ЧТО ПОКУПАТЕЛЬ УЖЕ НАЗВАЛ — ОДНО ЧТЕНИЕ ДЛЯ АНКЕТЫ И ДЛЯ ПОИСКА (14.11.2026, аудит «регулярка решает вместо ИИ»).
 *
 * Раньше у бота было два чтения слов клиента, и оба промахивались по-разному: анкета (`customerAgentIntake`) «узнавала»
 * бюджет только после слов «бюджет/до/то» и цифры, комнаты только как «3 комнаты», район только из четырёх названий, а поиск
 * (`customerAgentSearchIntent`) требовал слово-маркер перед суммой. «5000», «50к», «$50 000», «500 000 сомони», «3 хонагӣ»,
 * «82 мкр» не узнавались ни там, ни там — бот спрашивал то, что ему уже сказали, а поиск уходил без бюджета.
 *
 * Здесь это одно: слова клиента -> `CustomerBuyerNeeds` (тип, комнаты, бюджет, район). Модель видит тот же результат в
 * `conversationIntakeProgress.buyerNeeds` и заполняет им аргументы поиска; эта регулярка — запасной путь, который не даёт
 * потерять сказанное, если модель его не перенесла. Чистый текст на входе, ничего не доказывает (ни согласия, ни объекта).
 */

export type BuyerNeedKey = "location" | "rooms" | "budget";
export type BuyerPropertyType = NonNullable<CustomerBuyerNeeds["type"]>;
type Currency = "TJS" | "USD";

const norm = (text: string) => text.toLowerCase().replaceAll("ё", "е").normalize("NFKC");

// ---- Запрос на подбор (вынесено из customerAgentSearchIntent, чтобы анкета не зависела от рендера) ----

const SELLER_OR_JOB = new RegExp([
  `${BW}(?:продам|продаю|продается|продаётся|продается|продать|сдам|сдаю|сдать|сдается)${EW}`, `${BW}продаж${TAIL}`,
  `${BW}(?:(?:ме)?фур[уӯ]ш${TAIL}|фур[уӯ]хт${TAIL}|ба иҷора медиҳам|иҷорa медиҳам)`,
  `${BW}(?:вакан${TAIL}|резюме|работ[аеуы]${EW}|ҷойи\\s+кор|кор\\s+меҷӯям|маош)`,
].join("|"), "iu");

// An explicit ask to find / show / name the options (not a bare fact question about one shown object).
const REQUEST = new RegExp([
  `${BW}(?:ищу|ищем|искал${TAIL}|подбер${TAIL}|подбир${TAIL}|подыщ${TAIL}|подскаж${TAIL}|покаж${TAIL}|показать|скин${TAIL}|пришл${TAIL}|вариант${TAIL})${EW}`,
  `${BW}(?:нужн${TAIL}|нужен|нужно|нужны)${EW}`,
  `${BW}(?:хочу|хотим|хотел${TAIL}|планирую|собираюсь)\\s+(?:\\p{L}+\\s+){0,2}?(?:купить|приобрести|найти|квартир${TAIL}|дом${EW}|участок|двушк${TAIL}|однушк${TAIL}|трешк${TAIL})`,
  `${BW}куплю${EW}`, `${BW}(?:присматриваю|рассматриваю)${EW}`,
  `${BW}есть\\s+ли${EW}`, `${BW}что\\s+есть${EW}`, `${BW}есть\\s+(?:у\\s+вас|что)${EW}`, `${BW}какие\\s+(?:есть|у\\s+вас)${EW}`,
  `${BW}сколько\\s+(?:стоит|стоят)${EW}`, `${BW}какие\\s+цены${EW}`, `${BW}цены\\s+на${EW}`,
  // tg
  `${BW}(?:меҷӯям|меҷӯем|ҷустуҷӯ${TAIL}|лозим|даркор|мехарам|мехаред|хариданӣ|харидан\\s+мехоҳ${TAIL}|мехоҳам\\s+(?:\\p{L}+\\s+){0,2}?харам)`,
  `${BW}(?:доред|доред\\s+ё|ҳаст\\s+ки|нишон\\s+диҳ${TAIL}|интихоб\\s+кун${TAIL}|вариант${TAIL}|мавҷуд\\s+аст)`,
  `${BW}(?:чанд\\s+(?:пул|нарх)|нархи)\\s+(?:\\p{L}+\\s+){0,2}?(?:хона|квартир${TAIL}|ҳавлӣ|ҳавли|замин)`,
  `${BW}(?:мехоҳам|мехоҳем)\\s+(?:\\p{L}+\\s+){0,2}?(?:хона|квартир${TAIL}|ҳавлӣ|ҳавли|замин)`,
].join("|"), "iu");

const RENT_ONLY = new RegExp(`${BW}(?:снять|сниму|аренд${TAIL}|иҷора${TAIL}|ичора${TAIL})${EW}`, "iu");

/** The text is a request to PICK properties (and not a seller, a job inquiry, a rent ask). Same reading as the server search. */
export function customerSearchRequested(text: string): boolean {
  const own = norm(text);
  if (!own.trim() || own.length > 300) return false;
  return !SELLER_OR_JOB.test(own) && !RENT_ONLY.test(own) && REQUEST.test(own);
}
export const customerSellerOrJobWords = (text: string) => SELLER_OR_JOB.test(norm(text));
export const customerRentOnlyWords = (text: string) => RENT_ONLY.test(norm(text));

// ---- Тип ----

const TYPES: Array<{ type: BuyerPropertyType; re: RegExp }> = [
  { type: "LAND", re: new RegExp(`${BW}(?:участ(?:ок|ка|ки|ку|ке)|земл${TAIL}|замин${TAIL}|қитъа${TAIL}|китъа${TAIL}|сотк${TAIL})${EW}`, "iu") },
  { type: "COMMERCIAL", re: new RegExp(`${BW}(?:коммерч${TAIL}|офис${TAIL}|магазин${TAIL}|склад${TAIL}|помещени${TAIL}|торгов${TAIL}\\s+площад${TAIL}|дукон${TAIL}|дўкон${TAIL}|анбор${TAIL}|тиҷорат${TAIL})`, "iu") },
  { type: "HOUSE", re: new RegExp(`${BW}(?:дом(?:а|у|е|ом|ов|ики)?|коттедж${TAIL}|особняк${TAIL}|таунхаус${TAIL}|ҳавлӣ|ҳавли|хавли|ҳавлиҳо|хавлй)${EW}`, "iu") },
  { type: "APARTMENT", re: new RegExp(`${BW}(?:квартир${TAIL}|кв-р${TAIL}|апартамент${TAIL}|новостройк${TAIL}|двушк${TAIL}|однушк${TAIL}|трешк${TAIL}|трёшк${TAIL}|студи[яюи]|хонаи\\s+истиқомат${TAIL}|манзил${TAIL})`, "iu") },
];

// ---- Комнаты ----

const ROOM_NOUN = `(?:комнат${TAIL}|комн${TAIL}|ҳуҷр${TAIL}|хучр${TAIL}|хонагӣ|хонаги|хона${EW}|хонаи${EW})`;
const ROOM_WORDS: Array<{ n: number; re: RegExp }> = [
  { n: 1, re: new RegExp(`${BW}(?:однушк${TAIL}|одно\\s*комнат${TAIL}|одно-комнат${TAIL}|одной\\s+комнат${TAIL}|одну\\s+комнат${TAIL}|як\\s*${ROOM_NOUN})`, "iu") },
  { n: 2, re: new RegExp(`${BW}(?:двушк${TAIL}|двух\\s*комнат${TAIL}|двухкомн${TAIL}|двух-комнат${TAIL}|две\\s+комнат${TAIL}|двумя\\s+комнат${TAIL}|ду\\s*${ROOM_NOUN})`, "iu") },
  { n: 3, re: new RegExp(`${BW}(?:трешк${TAIL}|трёшк${TAIL}|трех\\s*комнат${TAIL}|трехкомн${TAIL}|трех-комнат${TAIL}|три\\s+комнат${TAIL}|се\\s*${ROOM_NOUN})`, "iu") },
  { n: 4, re: new RegExp(`${BW}(?:четырех\\s*комнат${TAIL}|четырехкомн${TAIL}|четырех-комнат${TAIL}|четыре\\s+комнат${TAIL}|чор\\s*${ROOM_NOUN})`, "iu") },
  { n: 5, re: new RegExp(`${BW}(?:пятикомнат${TAIL}|пяти\\s*комнат${TAIL}|пять\\s+комнат${TAIL}|панҷ\\s*${ROOM_NOUN})`, "iu") },
];
// «3 комнаты», «3-комн», «3 хонагӣ», «2к», «2-к квартира» (the digit must stand right before the room word, not before «этаж»/«м2»).
const ROOMS_DIGIT_BEFORE = new RegExp(`${BW}([1-9])\\s*[-–]?\\s*(?:${ROOM_NOUN}|к${EW}(?!\\s*(?:долл|\\$|usd|сомон|тыс)))`, "iu");
const ROOMS_RANGE = new RegExp(`${BW}([1-9])\\s*[-–]\\s*[1-9]\\s*${ROOM_NOUN}`, "iu");
const ROOMS_DIGIT_AFTER = new RegExp(`${BW}(?:комнат${TAIL}|ҳуҷр${TAIL})\\s*[:\\-]?\\s*([1-9])${EW}`, "iu");
const ROOM_NUMBER_WORDS: Array<[RegExp, number]> = [
  [new RegExp(`^(?:один|одна|одну|одно|як)${EW}`, "iu"), 1], [new RegExp(`^(?:два|две|двух|ду)${EW}`, "iu"), 2],
  [new RegExp(`^(?:три|трех|се)${EW}`, "iu"), 3], [new RegExp(`^(?:четыре|четырех|чор)${EW}`, "iu"), 4], [new RegExp(`^(?:пять|пяти|панҷ)${EW}`, "iu"), 5],
];

function roomsOf(own: string, asked: BuyerNeedKey | undefined): number | undefined {
  const byRange = ROOMS_RANGE.exec(own)?.[1];
  if (byRange) return Number(byRange);
  const byWord = ROOM_WORDS.find(({ re }) => re.test(own))?.n;
  if (byWord) return byWord;
  const byDigit = ROOMS_DIGIT_BEFORE.exec(own)?.[1] ?? ROOMS_DIGIT_AFTER.exec(own)?.[1];
  if (byDigit) return Number(byDigit);
  // The answer to «Сколько комнат?» is often just «3» / «три» / «две».
  if (asked === "rooms") {
    const bare = /^\s*([1-9])\s*(?:шт\.?|штуки)?\s*[.!]*\s*$/iu.exec(own)?.[1];
    if (bare) return Number(bare);
    const word = own.trim();
    for (const [re, n] of ROOM_NUMBER_WORDS) if (re.test(word) && word.length <= 30) return n;
  }
  return undefined;
}

// ---- Район ----

const DISTRICT_FORMS: Array<{ name: string; re: RegExp }> = [
  // The shared reader (lib/searchPlace.officialDistrictIn) handles the nominative and most Tajik spellings; these add case forms and slips.
  { name: "Сино", re: new RegExp(`${BW}(?:сино|синою|сине|синой|синого|синогӣ|синои)${EW}`, "iu") },
  { name: "Шохмансур", re: new RegExp(`${BW}(?:ш[оа][хҳ]мансор${TAIL}|ш[аоӣ][хҳ]мансур${TAIL}|шохмансур${TAIL}|шоҳмансур${TAIL})`, "iu") },
  { name: "Фирдавси", re: new RegExp(`${BW}фирдавс${TAIL}`, "iu") },
  { name: "Исмоили Сомони", re: new RegExp(`${BW}(?:исмоил${TAIL}\\s+сомон${TAIL}|и\\.?\\s*сомон${TAIL})`, "iu") },
];
const MICRO = new RegExp(`${BW}(?:(\\d{1,3})\\s*[-–]?\\s*(?:й\\s*)?(?:мкр${TAIL}|микр${TAIL})|(?:мкр${TAIL}|микрорайон${TAIL})\\s*[№#]?\\s*(\\d{1,3}))${EW}`, "iu");
const ANYWHERE = new RegExp([
  `${BW}(?:любо[йе]|любом|не\\s+важн${TAIL}|неважн${TAIL})\\s+район${TAIL}`, `${BW}район${TAIL}\\s+(?:любой|не\\s+важен|неважен|не\\s+важно|неважно)`,
  `${BW}(?:везде|где\\s+угодно|неважно\\s+где|не\\s+важно\\s+где|все\\s+равно\\s+(?:где|какой\\s+район)|без\\s+разницы)${EW}`,
  `${BW}ҳар\\s+кадом\\s+(?:ноҳия|ҷо|ҷой)`, `${BW}ноҳия${TAIL}\\s+(?:фарқ\\s+надорад|муҳим\\s+нест)`, `${BW}фарқ\\s+надорад${EW}`,
].join("|"), "iu");
// A place phrase: «в Зарафшоне», «возле Корвона», «дар Рудаки», «назди Айнӣ». «в/во/дар/на» + any word would catch «в новостройке» / «на 5 этаже» / «в долларах»
// (the generic words below), so a bare preposition needs a word that is not one of them; a LOCATIONAL preposition takes any word.
const LOCATIONAL = `(?:возле|около|рядом\\s+с|в\\s+районе|недалеко\\s+от|близко\\s+к|назди|наздикии|атрофи|дар\\s+назди|тарафи|ориентир(?:\\s+на)?)`;
const PLACE_STRONG = new RegExp(`${BW}${LOCATIONAL}\\s+(\\p{L}[\\p{L}-]{2,}(?:\\s+\\p{L}[\\p{L}-]{2,})?)`, "iu");
const PLACE_WEAK = new RegExp(`${BW}(?:в|во|дар)\\s+(\\p{L}[\\p{L}-]{2,}(?:\\s+\\p{L}[\\p{L}-]{2,})?)`, "iu");
const PLACE_NAMED = /(?<![\p{L}\p{N}])(?:[Нн]а|[Уу])\s+([А-ЯЁӮҶҲҚҒӢ][\p{L}-]{2,})/u;
const NOT_PLACE = new RegExp(`^(?:новостройк${TAIL}|город${TAIL}|любом|любой|наличии|продаже|продаж${TAIL}|сомони|долларах|рассрочк${TAIL}|ипотек${TAIL}|кредит${TAIL}|сентябр${TAIL}|квартир${TAIL}|дом${TAIL}|вас|ваш${TAIL}|этом|данн${TAIL}|момент${TAIL}|сумм${TAIL}|вторичк${TAIL}|сейчас|этой|тот|том|наличи${TAIL}|ҳолати|шумо|дастрас${TAIL}|фурӯш${TAIL}|нав${TAIL}|бино${TAIL}|ин|он|ҳамин|течени${TAIL}|месяц${TAIL}|году|год${TAIL}|будущем|целом|общем|принципе|хорошем|нормальн${TAIL}|идеальн${TAIL}|отличн${TAIL}|состояни${TAIL}|ремонт${TAIL}|кирпичн${TAIL}|панельн${TAIL}|монолитн${TAIL}|цене|размере|пределах|рамках|первом|втором|третьем|четвертом|пятом|шестом|седьмом|восьмом|девятом|этаж${TAIL}|комнат${TAIL}|сомонӣ|доллар${TAIL}|ҳолат${TAIL}|таъмир${TAIL}|ипотека|қарз|нарх${TAIL}|маблағ${TAIL}|муддат${TAIL}|ояндаи|баъд|наздик${TAIL}|ҳудуд${TAIL}|тысяч${TAIL}|тыс${TAIL}|миллион${TAIL}|млн|душанб${TAIL}|ҳазор${TAIL}|шаҳр${TAIL}|таджикистан${TAIL}|тоҷикистон${TAIL})`, "iu");

export interface BuyerPlace { districtName?: string; placeText?: string; anywhere?: true }
function placeOf(text: string, own: string, asked: BuyerNeedKey | undefined): BuyerPlace | undefined {
  const official = officialDistrictIn(text) ?? DISTRICT_FORMS.find(({ re }) => re.test(own))?.name;
  if (official) return { districtName: official };
  const micro = MICRO.exec(own);
  const micronumber = micro?.[1] ?? micro?.[2];
  if (micronumber) return { placeText: `${micronumber} мкр` };
  if (ANYWHERE.test(own)) return { anywhere: true };
  const strong = PLACE_STRONG.exec(own)?.[1]?.trim();
  if (strong && !NOT_PLACE.test(strong)) return { placeText: strong };
  const weak = PLACE_WEAK.exec(own)?.[1]?.trim();
  if (weak && !NOT_PLACE.test(weak)) return { placeText: weak };
  // «на Зарафшоне», «у Шохмансура»: with these two prepositions only a capitalized name counts (the original text, not the folded one).
  const named = PLACE_NAMED.exec(text)?.[1]?.trim().toLowerCase();
  if (named && !NOT_PLACE.test(named)) return { placeText: named };
  // The answer to «Какой район?» is often one bare word («Зарафшон», «Корвон»).
  if (asked === "location") {
    const bare = /^\s*(?:район\s+|ноҳияи\s+)?(\p{L}[\p{L}-]{2,}(?:\s+\p{L}[\p{L}-]{2,})?)\s*[.!]*\s*$/iu.exec(own)?.[1]?.trim();
    if (bare && !NOT_PLACE.test(bare) && !/^(?:не знаю|незнаю|нет|да|неважно|любой|спасибо|хорошо|ладно|ok|окей)$/iu.test(bare)) return { placeText: bare };
  }
  return undefined;
}

// ---- Бюджет ----

const NUM = `(\\d{1,3}(?:[ \\u00a0.,]\\d{3})+|\\d+(?:[.,]\\d{1,2})?)`;
const UNIT = `(тыс${TAIL}\\.?|ҳазор${TAIL}|хазор${TAIL}|млн\\.?|миллион${TAIL}|к${EW}|k${EW})`;
const USD = `(?:\\$|usd|долл${TAIL}\\.?|доллар${TAIL}|дол\\.?${EW}|бакс${TAIL}|у\\.\\s?е\\.?|уе${EW})`;
const TJS = `(?:сомон${TAIL}|смн\\.?|сом${EW}|tjs|тжс)`;
const CUR = `(${USD}|${TJS})`;
const TOKEN = new RegExp(`(\\$\\s*)?(?<![\\p{L}\\p{N}])${NUM}(?:\\s*${UNIT})?(?:\\s*${CUR})?`, "giu");
// What follows a number that makes it NOT money: floors, areas, rooms, minutes, years, percents, a microdistrict or house number.
const NOT_MONEY_AFTER = new RegExp(`^\\s*(?:комнат${TAIL}|комн${TAIL}|этаж${TAIL}|эт${EW}|м2|м²|кв\\.?\\s*м${TAIL}|квадрат${TAIL}|метр${TAIL}|мин${TAIL}|час${TAIL}|лет${EW}|год${TAIL}|месяц${TAIL}|%|процент${TAIL}|человек${TAIL}|сотк${TAIL}|соток|ҳуҷр${TAIL}|хучр${TAIL}|хонагӣ|ошён${TAIL}|мкр|микр${TAIL}|соат${TAIL}|сол${EW}|моҳ${EW}|дақиқа${TAIL}|шт${EW}|штук${TAIL})`, "iu");
const NOT_MONEY_BEFORE = /(?:мкр\p{L}*|микрорайон\p{L}*|дом|дома|ул\.?|улица|кв\.?|квартира|№|#|\+|тел\.?|телефон\p{L}*|рақам\p{L}*|номер\p{L}*|этаж\p{L}*)\s*$/iu;
const PRICE_QUESTION = /[?؟]|(?<![\p{L}\p{N}])(?:стоит|стоят|цена|цену|цены|цене|нарх\p{L}*|чанд\s+(?:пул|нарх)|скидк\p{L}*|торг\p{L}*)/iu;
const MAX_BEFORE = /(?<![\p{L}\p{N}])(?:до|не\s+дороже|не\s+более|не\s+больше|максимум|макс\.?|в\s+пределах|в\s+рамках|то|аз\s+зиёд\s+не|зиёда\s+аз|не\s+выше)\s*[:=]?\s*$/iu;
const MIN_BEFORE = /(?<![\p{L}\p{N}])(?:от|не\s+дешевле|не\s+менее|минимум|мин\.?|аз)\s*[:=]?\s*$/iu;
const BUDGET_WORD_BEFORE = /(?<![\p{L}\p{N}])(?:бюджет\p{L}*|буҷет\p{L}*|буджет\p{L}*|бучет\p{L}*|потрач\p{L}*|заплат\p{L}*|рассчитыва\p{L}*|маблағ\p{L}*|готов\p{L}*|могу|имею|имеется|есть)(?:\s+\p{L}{1,10}){0,3}\s*[:=—–-]?\s*$/iu;
const APPROX_BEFORE = /(?<![\p{L}\p{N}])(?:около|примерно|порядка|где-то|в\s+районе|за|на|тахминан|қариб|ориентировочно|ориентир)\s*$/iu;
const FILLER_BEFORE = /(?<![\p{L}\p{N}])(?:около|примерно|порядка|где-то|тахминан|қариб|ориентировочно|~|≈)\s*$/iu;

interface AmountToken { value: number; currency?: Currency; hasUnit: boolean; hasCurrency: boolean; kind: "min" | "max" | "plain"; marked: boolean; index: number; end: number;
  unitMultiplier: number; bareValue: number }

function multiplierOf(unit: string | undefined): number {
  const u = (unit ?? "").toLowerCase();
  if (u.startsWith("тыс") || u.startsWith("ҳазор") || u.startsWith("хазор") || u === "к" || u === "k") return 1000;
  if (u.startsWith("млн") || u.startsWith("миллион")) return 1_000_000;
  return 1;
}
function currencyOf(word: string | undefined): Currency | undefined {
  if (!word) return undefined;
  return new RegExp(`^${USD}$`, "iu").test(word.trim()) ? "USD" : "TJS";
}
function parseNumber(raw: string, multiplier: number): number | null {
  const decimal = /^\d+[.,]\d{1,2}$/.test(raw);
  if (decimal && multiplier === 1) return null; // «5,5» alone is not a price
  const value = decimal ? Number(raw.replace(",", ".")) * multiplier : Number(raw.replace(/[\s .,]/g, "")) * multiplier;
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function tokensOf(own: string): AmountToken[] {
  const result: AmountToken[] = [];
  for (const match of own.matchAll(TOKEN)) {
    const [whole, dollarPrefix, rawNumber, unit, currencyWord] = match;
    const index = match.index ?? 0, end = index + whole.length;
    const after = own.slice(end);
    if (NOT_MONEY_AFTER.test(after) && !currencyWord) continue;
    const before = own.slice(Math.max(0, index - 40), index);
    if (NOT_MONEY_BEFORE.test(before)) continue;
    const digits = rawNumber.replace(/[^\d]/g, "");
    // A long bare digit run with no currency is a phone / document number, not a budget.
    if (!currencyWord && !dollarPrefix && !unit && digits.length >= 9) continue;
    const multiplier = multiplierOf(unit);
    // «50к» is money; «2к квартира», «3к» is rooms (rooms are read first): a one-digit «к» is never a thousand.
    if ((unit === "к" || unit === "k") && Number(digits) < 10) continue;
    const value = parseNumber(rawNumber, multiplier);
    if (value === null) continue;
    const currency = dollarPrefix ? "USD" as const : currencyOf(currencyWord);
    const stripped = before.replace(FILLER_BEFORE, "");
    const kind = MAX_BEFORE.test(stripped) ? "max" as const : MIN_BEFORE.test(stripped) ? "min" as const : "plain" as const;
    const marked = kind !== "plain" || BUDGET_WORD_BEFORE.test(stripped) || APPROX_BEFORE.test(stripped);
    result.push({ value, ...(currency ? { currency } : {}), hasUnit: !!unit, hasCurrency: !!currency, kind, marked, index, end,
      unitMultiplier: multiplier, bareValue: Number(digits) });
  }
  return result;
}

export interface BuyerBudgetReading { min?: number; max?: number; currency?: Currency }

/** The amounts in a customer's message as a budget (min/max in the customer's own currency), or undefined. Never invents a currency. */
function budgetOf(own: string, asked: BuyerNeedKey | undefined): BuyerBudgetReading | undefined {
  const all = tokensOf(own);
  const priceQuestion = PRICE_QUESTION.test(own);
  // A token is money when it names a currency or a thousand/million, or sits after a budget marker with a plausible size.
  const money = all.filter(token => {
    if (token.hasCurrency || token.hasUnit) return token.marked || !priceQuestion;
    // «от 40 до 60 тысяч»: the lower bound carries no unit of its own, the upper one does.
    if (token.kind === "min" && token.bareValue < 1000) return all.some(other => other.index > token.index && (other.hasUnit || other.hasCurrency));
    return token.marked && token.bareValue >= 1000;
  });
  if (!money.length) {
    // «5000» as the whole answer to the bot's budget question.
    if (asked === "budget") {
      const bare = /^\s*[~≈]?\s*(\d[\d\s .,]*\d|\d)\s*[.!]*\s*$/u.exec(own)?.[1];
      const value = bare ? parseNumber(bare, 1) : null;
      if (value && value >= 1000) return { max: value };
    }
    return undefined;
  }
  const minToken = money.find(t => t.kind === "min"), maxToken = money.find(t => t.kind === "max") ?? money.find(t => t.kind === "plain" && t !== minToken);
  let { min, max } = { min: minToken?.value, max: maxToken?.value };
  // «от 40 до 60 тысяч»: the unit/currency stand on the last number only.
  if (minToken && maxToken && !minToken.hasUnit && maxToken.hasUnit && minToken.bareValue * maxToken.unitMultiplier <= maxToken.value) min = minToken.bareValue * maxToken.unitMultiplier;
  // «40-60к $»: a plain range with one unit.
  const range = /(?<![\p{L}\p{N}])(\d{1,3}(?:[.,]\d)?)\s*[-–]\s*(\d{1,3}(?:[.,]\d)?)\s*(тыс\p{L}*\.?|ҳазор\p{L}*|хазор\p{L}*|млн\.?|миллион\p{L}*|к(?![\p{L}\p{N}])|k(?![\p{L}\p{N}]))/iu.exec(own);
  if (range && !minToken && maxToken?.kind !== "max") {
    const m = multiplierOf(range[3]);
    min = Math.round(Number(range[1].replace(",", ".")) * m); max = Math.round(Number(range[2].replace(",", ".")) * m);
  }
  const currency = money.find(t => t.currency)?.currency;
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && min > max) [min, max] = [max, min];
  // Sanity (the shared bounds): «до 50» or an extra zero must not become a real ceiling. Without a currency only the widest bounds apply.
  const sane = (value: number | undefined) => value === undefined ? undefined : currency
    ? customerSearchBudgetSane(value, currency) ? value : undefined
    : customerSearchBudgetSane(value, "USD") || customerSearchBudgetSane(value, "TJS") ? value : undefined;
  min = sane(min); max = sane(max);
  if (min === undefined && max === undefined) return undefined;
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(currency ? { currency } : {}) };
}

/** «в долларах», «сомони», «$»: the answer to «в какой валюте?». */
function currencyOnlyOf(own: string): Currency | undefined {
  const text = own.trim().replace(/[.!]+$/u, "");
  if (text.length > 25 || /\d/u.test(text)) return undefined;
  const m = new RegExp(`^(?:в|ба|на)?\\s*${CUR}\\s*$`, "iu").exec(text);
  return m ? currencyOf(m[1]) : undefined;
}

// ---- Итог: что клиент назвал ----

export interface BuyerNeedsReading {
  type?: BuyerPropertyType; rooms?: number; budget?: BuyerBudgetReading; currencyOnly?: Currency; place?: BuyerPlace;
}

/** What one customer message names. `asked` is the bot's question it answers (a bare «3» / «5000» / «Сино» means something only then). */
export function readBuyerNeeds(text: string, asked?: BuyerNeedKey): BuyerNeedsReading {
  const own = norm(text);
  const reading: BuyerNeedsReading = {};
  if (!own.trim() || own.length > 600) return reading;
  for (const { type, re } of TYPES) if (re.test(own)) { reading.type = type; break; }
  const rooms = roomsOf(own, asked);
  if (rooms) { reading.rooms = rooms; if (!reading.type) reading.type = "APARTMENT"; }
  const budget = budgetOf(own, asked);
  if (budget) reading.budget = budget;
  else {
    const currencyOnly = currencyOnlyOf(own);
    if (currencyOnly) reading.currencyOnly = currencyOnly;
  }
  const place = placeOf(text, own, asked);
  if (place) reading.place = place;
  return reading;
}

/** Which of the three questions the bot's last message asked (its last line wins: a bot question closes its message). */
export function buyerQuestionAsked(assistantText: string | undefined): BuyerNeedKey | undefined {
  const lines = (assistantText ?? "").split("\n").map(line => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (!last) return undefined;
  if (/бюджет|буҷет|буджет|какую\s+сумм|на\s+какую\s+сумм|маблағ|сумм\p{L}*\s+(?:для|примерно|рассчит)|ҳисоб\s+мекунед|чӣ\s+қадар/iu.test(last)) return "budget";
  if (/сколько\s+комнат|чанд\s+ҳуҷра|ҳуҷра\s+лозим/iu.test(last)) return "rooms";
  if (/какой\s+район|в\s+каком\s+районе|кадом\s+ноҳия|ноҳия\s+мувофиқ/iu.test(last)) return "location";
  return undefined;
}

const fromNumber = (value: number) => String(value);

/** Later words win (a correction), field by field; a new district clears an older place phrase and the other way round. */
export function mergeBuyerNeeds(base: CustomerBuyerNeeds, reading: BuyerNeedsReading): CustomerBuyerNeeds {
  const next: CustomerBuyerNeeds = { ...base };
  if (reading.type) next.type = reading.type;
  if (reading.rooms) next.rooms = reading.rooms;
  if (reading.budget) {
    const { min, max, currency } = reading.budget;
    // A correction without a currency («нет, до 50 тысяч») keeps the one already named, when the new amount fits it.
    const previous = base.budget?.currency;
    const kept = currency ?? (previous && [min, max].every(bound => bound === undefined || customerSearchBudgetSane(bound, previous)) ? previous : undefined);
    next.budget = { ...(min !== undefined ? { min: fromNumber(min) } : {}), ...(max !== undefined ? { max: fromNumber(max) } : {}),
      ...(kept ? { currency: kept } : {}) };
  } else if (reading.currencyOnly && next.budget && !next.budget.currency) {
    const sane = [next.budget.min, next.budget.max].every(bound => bound === undefined || customerSearchBudgetSane(bound, reading.currencyOnly!));
    if (sane) next.budget = { ...next.budget, currency: reading.currencyOnly };
  }
  if (reading.place) {
    delete next.districtName; delete next.placeText; delete next.anywhere;
    if (reading.place.districtName) next.districtName = reading.place.districtName;
    else if (reading.place.placeText) next.placeText = reading.place.placeText;
    else if (reading.place.anywhere) next.anywhere = true;
  }
  return next;
}

/** `over` (newer) on top of `base` (older), the same rules as a later message: a correction replaces its field, a new place replaces the old one. */
export function overlayBuyerNeeds(base: CustomerBuyerNeeds | undefined, over: CustomerBuyerNeeds | undefined): CustomerBuyerNeeds | undefined {
  if (!base) return over;
  if (!over) return base;
  const next: CustomerBuyerNeeds = { ...base };
  if (over.type) next.type = over.type;
  if (over.rooms) next.rooms = over.rooms;
  if (over.budget) {
    const previous = base.budget?.currency;
    const kept = over.budget.currency ?? (previous && [over.budget.min, over.budget.max].every(bound => bound === undefined || customerSearchBudgetSane(bound, previous)) ? previous : undefined);
    next.budget = { ...over.budget, ...(kept ? { currency: kept } : {}) };
  }
  if (over.districtName || over.placeText || over.anywhere) {
    delete next.districtName; delete next.placeText; delete next.anywhere;
    if (over.districtName) next.districtName = over.districtName;
    else if (over.placeText) next.placeText = over.placeText;
    else next.anywhere = true;
  }
  return next;
}

/** The buyer's wishes from the customer's own messages in order, each with the bot's question it answered (if known). */
export function buyerNeedsFromMessages(messages: readonly { text: string; asked?: string }[], initial: CustomerBuyerNeeds = {}): CustomerBuyerNeeds {
  let needs = initial;
  for (const message of messages) needs = mergeBuyerNeeds(needs, readBuyerNeeds(message.text, buyerQuestionAsked(message.asked)));
  return needs;
}

/** What is already answered, in the order the bot asks. */
export function buyerNeedsKnown(needs: CustomerBuyerNeeds | undefined): BuyerNeedKey[] {
  if (!needs) return [];
  const known: BuyerNeedKey[] = [];
  if (needs.districtName || needs.placeText || needs.anywhere) known.push("location");
  if (needs.rooms) known.push("rooms");
  if (needs.budget && (needs.budget.min !== undefined || needs.budget.max !== undefined)) known.push("budget");
  return known;
}
const ORDER: readonly BuyerNeedKey[] = ["location", "rooms", "budget"];
/** THE one «what is still unknown» for a buyer: the next unanswered question, or `preferences` once all three are known. */
export function buyerNextQuestion(known: readonly BuyerNeedKey[]): BuyerNeedKey | "preferences" {
  return ORDER.find(key => !known.includes(key)) ?? "preferences";
}

/** Only the keys that carry a value (the strict schema rejects `undefined`-valued keys in some paths). */
export function compactBuyerNeeds(needs: CustomerBuyerNeeds): CustomerBuyerNeeds | undefined {
  return Object.keys(needs).length ? needs : undefined;
}

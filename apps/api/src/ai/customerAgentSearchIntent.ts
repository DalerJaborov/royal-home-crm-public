import { customerAgentPropertySearchCallSchema, type CustomerAgentPropertySearchArgs } from "@royal-home/shared";
import { BW, EW, TAIL } from "./wordBoundary.js";
import { customerAgentQuestionCatalog } from "./customerAgentRenderer.js";

/**
 * The customer's explicit request to PICK properties ("ищу двушку в Сино", "есть ли двушки", "хочу купить квартиру до 600000
 * сомони", "меҷӯям хонаи 2 ҳуҷрагӣ"), read from the customer's own words only (31.10.2026, live Gemini attack: on such
 * messages the model answered `propose` without ever calling `search_public_properties`, and the buyer got a bare question
 * or silence). The server turns the intent into a bounded catalogue read BEFORE the model answers, exactly like the
 * "cheaper" read. Pure and conservative: a seller, a job inquiry or a question about one shown object is not a search.
 * It grants nothing (no consent, no preference stored): the result is only evidence for the normal renderer.
 */

export type CustomerSearchType = "APARTMENT" | "HOUSE" | "LAND" | "COMMERCIAL";
export interface CustomerSearchIntent {
  type?: CustomerSearchType;
  /** One of the official districts, named by the customer. */
  districtName?: string;
  /** A place phrase after a preposition ("в Зарафшоне"); the caller resolves it against the place directory, it is not trusted as a district. */
  placeText?: string;
  rooms?: number;
  budget?: { max: string; currency: "TJS" | "USD" };
  sort?: "cheap";
}

const norm = (text: string) => text.toLowerCase().replaceAll("ё", "е").normalize("NFKC");

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

// Fact/price questions about one concrete object ("двушка свободна?", "эта цена окончательная?") carry no request word above.

const RENT_ONLY = new RegExp(`${BW}(?:снять|сниму|аренд${TAIL}|иҷора${TAIL}|ичора${TAIL})${EW}`, "iu");

const TYPES: Array<{ type: CustomerSearchType; re: RegExp }> = [
  { type: "LAND", re: new RegExp(`${BW}(?:участ(?:ок|ка|ки|ку|ке)|земл${TAIL}|замин${TAIL}|қитъа${TAIL}|китъа${TAIL}|сотк${TAIL})${EW}`, "iu") },
  { type: "COMMERCIAL", re: new RegExp(`${BW}(?:коммерч${TAIL}|офис${TAIL}|магазин${TAIL}|склад${TAIL}|помещени${TAIL}|торгов${TAIL}\\s+площад${TAIL}|дукон${TAIL}|дўкон${TAIL}|анбор${TAIL}|тиҷорат${TAIL})`, "iu") },
  { type: "HOUSE", re: new RegExp(`${BW}(?:дом(?:а|у|е|ом|ов|ики)?|коттедж${TAIL}|особняк${TAIL}|таунхаус${TAIL}|ҳавлӣ|ҳавли|хавли|ҳавлиҳо|хавлй)${EW}`, "iu") },
  { type: "APARTMENT", re: new RegExp(`${BW}(?:квартир${TAIL}|кв-р${TAIL}|апартамент${TAIL}|новостройк${TAIL}|двушк${TAIL}|однушк${TAIL}|трешк${TAIL}|трёшк${TAIL}|студи[яюи]|хонаи\\s+истиқомат${TAIL}|манзил${TAIL})`, "iu") },
];

const ROOM_WORDS: Array<{ n: number; re: RegExp }> = [
  { n: 1, re: new RegExp(`${BW}(?:однушк${TAIL}|одно\\s*комнат${TAIL}|1[-\\s]?комн${TAIL}|1[-\\s]?к${EW})|як\\s*ҳуҷра${TAIL}|як\\s*хона${TAIL}|1[-\\s]?ҳуҷр${TAIL}`, "iu") },
  { n: 2, re: new RegExp(`${BW}(?:двушк${TAIL}|двух\\s*комнат${TAIL}|двухкомн${TAIL}|2[-\\s]?комн${TAIL}|2[-\\s]?к${EW})|ду\\s*ҳуҷра${TAIL}|ду\\s*хона${TAIL}|2[-\\s]?ҳуҷр${TAIL}`, "iu") },
  { n: 3, re: new RegExp(`${BW}(?:трешк${TAIL}|трёшк${TAIL}|трех\\s*комнат${TAIL}|трехкомн${TAIL}|3[-\\s]?комн${TAIL}|3[-\\s]?к${EW})|се\\s*ҳуҷра${TAIL}|се\\s*хона${TAIL}|3[-\\s]?ҳуҷр${TAIL}`, "iu") },
  { n: 4, re: new RegExp(`${BW}(?:четырех\\s*комнат${TAIL}|четырехкомн${TAIL}|4[-\\s]?комн${TAIL}|4[-\\s]?к${EW})|чор\\s*ҳуҷра${TAIL}|4[-\\s]?ҳуҷр${TAIL}`, "iu") },
];
const ROOMS_NUMBER_AFTER = new RegExp(`${BW}([1-9])\\s*(?:комнат${TAIL}|комн${TAIL}|ҳуҷра${TAIL}|ҳуҷрагӣ|хонагӣ)`, "iu");
const ROOMS_NUMBER_BEFORE = new RegExp(`${BW}(?:комнат${TAIL}|ҳуҷра${TAIL})\\s*[:\\-]?\\s*([1-9])${EW}`, "iu");

const DISTRICTS: Array<{ name: string; re: RegExp }> = [
  { name: "Исмоили Сомони", re: new RegExp(`${BW}(?:исмоил${TAIL}\\s+сомон${TAIL}|и\\.?\\s*сомон${TAIL})`, "iu") },
  { name: "Шохмансур", re: new RegExp(`${BW}(?:шохмансур${TAIL}|шоҳмансур${TAIL}|шохмансор${TAIL})`, "iu") },
  { name: "Фирдавси", re: new RegExp(`${BW}фирдавс${TAIL}`, "iu") },
  { name: "Сино", re: new RegExp(`${BW}(?:сино|синою|сине|синой|синогӣ)${EW}`, "iu") },
];
// «в Зарафшоне», «возле Корвона», «дар Сино», «назди Айнӣ»: one or two words after a place preposition.
const PLACE = new RegExp(`${BW}(?:в|во|на|возле|около|рядом\\s+с|у|дар|назди|наздикии|атрофи)\\s+(\\p{L}[\\p{L}-]{2,}(?:\\s+\\p{L}[\\p{L}-]{2,})?)`, "iu");
const NOT_PLACE = new RegExp(`^(?:новостройк${TAIL}|центр${TAIL}|город${TAIL}|любом|любой|наличии|продаже|продаж${TAIL}|сомони|долларах|рассрочк${TAIL}|ипотек${TAIL}|сентябр${TAIL}|квартир${TAIL}|дом${TAIL}|вас|вашем|вашей|вашего|этом|этой|тот|том|том|том|наличи${TAIL}|ҳолати|шумо|дастрас${TAIL}|фурӯш${TAIL}|нав${TAIL}|бино${TAIL}|ин|он|ҳамин)`, "iu");

const SOMONI = `(?:сомон[иӣ]?|смн|сом${EW}|tjs|тжс)`, USD = `(?:\\$|долл${TAIL}|дол${EW}|usd|у\\.е\\.?|доллар${TAIL})`;
const BUDGET = new RegExp(`${BW}(?:до|не\\s+дороже|максимум|бюджет(?:\\s+до)?|то|аз\\s+зиёд\\s+не)\\s*:?\\s*(\\$)?\\s*(\\d[\\d\\s.,]*\\d|\\d)\\s*(тыс${TAIL}|ҳазор${TAIL}|к${EW}|k${EW}|млн${TAIL}|миллион${TAIL})?\\s*(${SOMONI}|${USD})?`, "iu");

function budgetOf(text: string): CustomerSearchIntent["budget"] | undefined {
  const match = BUDGET.exec(text);
  if (!match) return undefined;
  const [, dollarPrefix, rawNumber, unit, currencyWord] = match;
  // «до 2 комнат», «до 3 этажа»: the number is not money unless a currency sign or word stands with it.
  const currency = dollarPrefix || (currencyWord && new RegExp(USD, "iu").test(currencyWord)) ? "USD" : currencyWord ? "TJS" : null;
  if (!currency) return undefined;
  const digits = rawNumber.replace(/[\s.,]/g, "");
  let value = Number(digits);
  if (!Number.isFinite(value)) return undefined;
  const u = (unit ?? "").toLowerCase();
  if (u.startsWith("тыс") || u.startsWith("ҳазор") || u === "к" || u === "k") value *= 1000;
  else if (u.startsWith("млн") || u.startsWith("миллион")) value *= 1_000_000;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 999_999_999_999) return undefined;
  return { max: String(value), currency };
}

/** The customer asks to pick/show properties; null for anything else (seller, job, a fact about one object, rent, chit-chat). */
export function customerSearchIntent(text: string, _language: "ru" | "tg" = "ru"): CustomerSearchIntent | null {
  const own = norm(text);
  if (!own.trim() || own.length > 300) return null;
  if (SELLER_OR_JOB.test(own) || RENT_ONLY.test(own)) return null;
  if (!REQUEST.test(own)) return null;
  return readIntent(own);
}

function readIntent(own: string): CustomerSearchIntent {
  const intent: CustomerSearchIntent = {};
  for (const { type, re } of TYPES) if (re.test(own)) { intent.type = type; break; }
  const roomsByWord = ROOM_WORDS.find(({ re }) => re.test(own))?.n;
  const roomsByNumber = Number(ROOMS_NUMBER_AFTER.exec(own)?.[1] ?? ROOMS_NUMBER_BEFORE.exec(own)?.[1]) || undefined;
  const rooms = roomsByWord ?? roomsByNumber;
  if (rooms) { intent.rooms = rooms; if (!intent.type) intent.type = "APARTMENT"; }
  const budget = budgetOf(own);
  if (budget) intent.budget = budget;
  const district = DISTRICTS.find(({ re }) => re.test(own));
  if (district) intent.districtName = district.name;
  else {
    const place = PLACE.exec(own)?.[1]?.trim();
    if (place && !NOT_PLACE.test(place)) intent.placeText = place;
  }
  // «Недорого» without a stated ceiling asks for the cheapest first; with a ceiling the budget already bounds the list.
  if (!budget && new RegExp(`${BW}(?:недорог${TAIL}|подешевл${TAIL}|дешев${TAIL}|арзон${TAIL}|бюджетн${TAIL})`, "iu").test(own)) intent.sort = "cheap";
  return intent;
}

const hasCondition = (intent: CustomerSearchIntent) => !!(intent.type || intent.districtName || intent.placeText || intent.rooms || intent.budget);

/**
 * The customer ANSWERS the bot's own question about a district / rooms / budget ("двушка" -> «Какой район вам подходит?» ->
 * "в Фирдавси", live 31.10: the bot asked "Какой объект вы имеете в виду?"). The answer carries no request word, so the conditions
 * are the answer plus what the customer said in the last user turns. Only right after the bot's fixed location/rooms/budget question;
 * the answer itself must name a condition ("не знаю" is not one).
 */
export function customerSearchContinuation(text: string, turns: ReadonlyArray<{ role: "user" | "assistant"; text: string }>): CustomerSearchIntent | null {
  const last = turns.at(-1);
  if (last?.role !== "assistant") return null;
  const lines = last.text.split("\n").map(line => line.trim());
  const asked = (["ru", "tg"] as const).some(language => customerAgentQuestionCatalog(language).some(({ question, text: sentence }) =>
    (question === "location" || question === "rooms" || question === "budget") && lines.includes(sentence)));
  const own = norm(text);
  if (!asked || !own.trim() || own.length > 120 || !hasCondition(readIntent(own))) return null;
  const combined = norm([...turns.filter(turn => turn.role === "user").slice(-2).map(turn => turn.text), text].join(". "));
  if (SELLER_OR_JOB.test(combined) || RENT_ONLY.test(combined)) return null;
  return readIntent(combined);
}

/**
 * The bounded catalogue read for a search intent, or null when the tool's own required arguments (a type or a district)
 * are not there. `districtName` is the already-resolved district (the caller verified a place phrase), never the raw phrase.
 */
export function customerSearchPreRead(intent: CustomerSearchIntent | null, districtName?: string):
  { name: "search_public_properties"; args: CustomerAgentPropertySearchArgs } | null {
  if (!intent) return null;
  const district = intent.districtName ?? districtName;
  if (!intent.type && !district) return null;
  // A bare «хочу купить квартиру» is a consultation, not a search: three arbitrary cards would hijack qualification and the
  // callback flow (cloud ship #80). The server searches only with at least one concrete condition beyond the type.
  if (!district && !intent.rooms && !intent.budget && !intent.sort) return null;
  const parsed = customerAgentPropertySearchCallSchema.safeParse({ name: "search_public_properties", args: {
    ...(intent.type ? { type: intent.type } : {}), ...(district ? { districtName: district } : {}),
    ...(intent.rooms ? { rooms: intent.rooms } : {}),
    ...(intent.budget ? { budget: intent.budget } : {}), ...(intent.sort ? { sort: intent.sort } : {}) } });
  return parsed.success ? parsed.data : null;
}

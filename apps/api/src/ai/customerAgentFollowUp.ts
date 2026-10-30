import { customerAgentPropertySearchCallSchema, type CustomerAgentPropertySearchArgs, type CustomerPropertyFacts } from "@royal-home/shared";
import { customerAgentQuestionCatalog } from "./customerAgentRenderer.js";
import { BW, EW, TAIL } from "./wordBoundary.js";

/**
 * Two server-side reads of the customer's short words (30.10.2026, live Instagram cases):
 *  - "дорого / дешевле есть?" about the object in focus: the cheaper alternatives are read from the
 *    catalogue BEFORE the model answers (it used to ask for a budget and then be silenced by the repeat guard);
 *  - a bare "да / ҳа / ok" right after the bot's own clarifying question: it answers nothing, so the
 *    server asks again with a different wording instead of letting the model thank the customer.
 * Customer words only. Neither read grants consent, identity or a stored preference.
 */

const norm = (text: string) => text.toLowerCase().replaceAll("ё", "е").normalize("NFKC");

const CHEAPER = [
  // ru: «дорого», «дороговато», «а дешевле есть?», «подешевле», «бюджет меньше»
  `${BW}дорог(?:о|овато|овата|ой|ая|ое|ие)${EW}`, `${BW}(?:по)?дешевл${TAIL}`,
  `${BW}бюджет${TAIL}\\s+(?:меньше|ниже|поменьше)${EW}`,
  // tg: «гарон», «қимат/кимат», «арзон(тар)», «нарх баланд», «нарх/буҷет камтар»
  `${BW}гарон${TAIL}`, `${BW}[қк]имат${TAIL}`, `${BW}арзон${TAIL}`, `${BW}нарх${TAIL}\\s+баланд${EW}`,
  `${BW}(?:нарх|бу[ҷч]ет)${TAIL}\\s+(?:\\p{L}+\\s+)?камтар${EW}`,
].map(source => new RegExp(source, "iu"));
const NOT_CHEAP_PROBLEM = new RegExp(`${BW}(?:не|ни)\\s*дорог${TAIL}|${BW}недорог${TAIL}|${BW}не\\s+(?:гарон|[қк]имат)${TAIL}`, "iu");

/** The customer calls the shown object expensive or asks for something cheaper. */
export function customerCheaperRequested(text: string): boolean {
  const own = norm(text);
  if (!own.trim() || own.length > 300) return false;
  if (NOT_CHEAP_PROBLEM.test(own)) return false;
  return CHEAPER.some(pattern => pattern.test(own));
}

const SEARCH_TYPES = new Set(["APARTMENT", "HOUSE", "LAND", "COMMERCIAL"]);
/** Largest price strictly below the focus price, in the focus currency (a whole unit; "820000" -> "819999"). */
function belowPrice(price: string): string | null {
  const [integer, fraction] = price.split(".");
  const value = BigInt(integer);
  const max = fraction && /[1-9]/.test(fraction) ? value : value - 1n;
  return max > 0n ? max.toString() : null;
}

/** The bounded catalogue search for "cheaper than the object in focus": same type and district, cheapest first. */
export function customerCheaperSearchCall(facts: CustomerPropertyFacts | null | undefined): { name: "search_public_properties"; args: CustomerAgentPropertySearchArgs } | null {
  if (!facts || facts.availability === "SOLD" || !facts.price) return null;
  const max = belowPrice(facts.price);
  const type = facts.characteristics && SEARCH_TYPES.has(facts.characteristics.type) ? facts.characteristics.type as "APARTMENT" | "HOUSE" | "LAND" | "COMMERCIAL" : undefined;
  // publicAddress is "district, city" (deduplicated); the district is the first segment.
  const districtName = facts.publicAddress?.split(",")[0]?.trim() || undefined;
  if (!max || (!type && !districtName)) return null;
  const parsed = customerAgentPropertySearchCallSchema.safeParse({ name: "search_public_properties",
    args: { ...(type ? { type } : {}), ...(districtName ? { districtName } : {}), budget: { max, currency: facts.currency }, sort: "cheap" } });
  return parsed.success ? parsed.data : null;
}

const AFFIRMATIONS = new Set(["да", "ага", "угу", "ок", "окей", "ok", "okay", "yes", "хорошо", "ладно", "конечно", "давайте", "да-да",
  "ҳа", "ха", "бале", "хуб", "хуб-хуб", "майлаш", "албатта", "ҳа-ҳа", "ха-ха", "оре", "ore"]);
/** Nothing but "yes" (any of the common ru/tg short forms, optional punctuation or emoji). */
export function customerBareAffirmation(text: string): boolean {
  if (/\p{N}/u.test(text)) return false;
  const words = norm(text).replace(/[^\p{L}\s-]/gu, " ").split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 3 && words.every(word => AFFIRMATIONS.has(word));
}

const REPAIRABLE = new Set(["budget", "location", "rooms", "property", "topic", "role"]);
// «О какой квартире вы хотите узнать подробнее?», «Дар бораи кадом хона маълумот мехоҳед?»
const WHICH_OBJECT = new RegExp(`${BW}(?:какой|какую|какого|какие|каком|кадом|кадомаш)${EW}[^?]{0,40}?${BW}(?:квартир${TAIL}|объект${TAIL}|недвижимост${TAIL}|дом${EW}|дома${EW}|хона${TAIL}|ҳавлӣ|ҳавли|амвол${TAIL}|манзил${TAIL})`, "iu");

/**
 * What the bot's last turn asked, when a bare "yes" must NOT reach the model:
 *  - "clarify_previous": one of the renderer's own fixed questions (budget, district, rooms, object, topic, role): the
 *    renderer re-asks it in its separate "я уточнял ..." wording, which the repeat guard lets through;
 *  - "property": a free-worded "which object / apartment?" question: the standard object question is asked.
 * Anything else (confirmations, callback consent, a yes/no offer) is a real answer and stays with the model.
 */
export function customerAffirmationFollowUp(previousAssistantText: string | undefined, hasResolvedFocus: boolean): "clarify_previous" | "property" | null {
  if (!previousAssistantText) return null;
  const lines = previousAssistantText.split("\n").map(line => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  // The first catalogue entry of each question is its plain template; later ones are the repairs (no repair of a repair).
  const plain = new Map<string, Set<string>>();
  const repairs = new Set<string>();
  for (const language of ["ru", "tg"] as const) {
    const seen = new Set<string>();
    for (const { question, text } of customerAgentQuestionCatalog(language)) {
      if (!seen.has(question)) { seen.add(question); (plain.get(question) ?? plain.set(question, new Set()).get(question)!).add(text); }
      else repairs.add(text);
    }
  }
  if (lines.some(line => repairs.has(line))) return null;
  const purposes = [...REPAIRABLE].filter(question => lines.some(line => plain.get(question)?.has(line)));
  if (purposes.length === 1) return "clarify_previous";
  if (purposes.length > 1) return null;
  const last = lines.at(-1)!;
  return !hasResolvedFocus && last.includes("?") && WHICH_OBJECT.test(last) ? "property" : null;
}

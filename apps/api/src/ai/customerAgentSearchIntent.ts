import { customerAgentPropertySearchCallSchema, type CustomerAgentPropertySearchArgs, type CustomerBuyerNeeds } from "@royal-home/shared";
import { BW, TAIL } from "./wordBoundary.js";
import { customerAgentQuestionCatalog } from "./customerAgentRenderer.js";
import { buyerNeedsFromMessages, customerRentOnlyWords, customerSearchRequested, customerSellerOrJobWords, readBuyerNeeds,
  type BuyerNeedKey, type BuyerNeedsReading, type BuyerPropertyType } from "./customerBuyerNeeds.js";

/**
 * The customer's explicit request to PICK properties ("ищу двушку в Сино", "есть ли двушки", "хочу купить квартиру до 600000
 * сомони", "меҷӯям хонаи 2 ҳуҷрагӣ"), read from the customer's own words only (31.10.2026, live Gemini attack: on such
 * messages the model answered `propose` without ever calling `search_public_properties`, and the buyer got a bare question
 * or silence). The server turns the intent into a bounded catalogue read BEFORE the model answers, exactly like the
 * "cheaper" read. Pure and conservative: a seller, a job inquiry or a question about one shown object is not a search.
 * It grants nothing (no consent, no preference stored): the result is only evidence for the normal renderer.
 *
 * 14.11.2026: the conditions (budget, rooms, district) are read by ONE reader shared with the intake (`customerBuyerNeeds`), and
 * what the buyer named earlier in the conversation is carried into the search (`customerSearchIntentWithKnownNeeds`): a budget
 * said on the first turn is still in the search on the third.
 */

export type CustomerSearchType = BuyerPropertyType;
export interface CustomerSearchIntent {
  type?: CustomerSearchType;
  /** One of the official districts, named by the customer. */
  districtName?: string;
  /** A place phrase after a preposition ("в Зарафшоне"); the caller resolves it against the place directory, it is not trusted as a district. */
  placeText?: string;
  rooms?: number;
  budget?: { min?: string; max?: string; currency: "TJS" | "USD" };
  /** An amount was named without a currency ("до 60 тысяч"): the search runs without a ceiling and the bot asks USD or TJS. */
  budgetNoCurrency?: true;
  sort?: "cheap";
}

const norm = (text: string) => text.toLowerCase().replaceAll("ё", "е").normalize("NFKC");

/** The customer asks to pick/show properties; null for anything else (seller, job, a fact about one object, rent, chit-chat). */
export function customerSearchIntent(text: string, _language: "ru" | "tg" = "ru"): CustomerSearchIntent | null {
  const own = norm(text);
  if (!own.trim() || own.length > 300) return null;
  if (!customerSearchRequested(text)) return null;
  return intentOf(readBuyerNeeds(text), own);
}

function intentOf(reading: BuyerNeedsReading, own: string): CustomerSearchIntent {
  const intent: CustomerSearchIntent = {};
  if (reading.type) intent.type = reading.type;
  if (reading.rooms) intent.rooms = reading.rooms;
  const budget = reading.budget;
  if (budget) {
    if (budget.currency) intent.budget = { ...(budget.min !== undefined ? { min: String(budget.min) } : {}), ...(budget.max !== undefined ? { max: String(budget.max) } : {}), currency: budget.currency };
    else intent.budgetNoCurrency = true;
  }
  if (reading.place?.districtName) intent.districtName = reading.place.districtName;
  else if (reading.place?.placeText) intent.placeText = reading.place.placeText;
  // «Недорого» without a stated ceiling asks for the cheapest first; with a ceiling the budget already bounds the list.
  if (!budget && new RegExp(`${BW}(?:недорог${TAIL}|подешевл${TAIL}|дешев${TAIL}|арзон${TAIL}|бюджетн${TAIL})`, "iu").test(own)) intent.sort = "cheap";
  return intent;
}

function intentFromNeeds(needs: CustomerBuyerNeeds, own: string): CustomerSearchIntent {
  const intent: CustomerSearchIntent = {};
  if (needs.type) intent.type = needs.type;
  if (needs.rooms) intent.rooms = needs.rooms;
  if (needs.budget) {
    if (needs.budget.currency) intent.budget = { ...(needs.budget.min ? { min: needs.budget.min } : {}), ...(needs.budget.max ? { max: needs.budget.max } : {}), currency: needs.budget.currency };
    else intent.budgetNoCurrency = true;
  }
  if (needs.districtName) intent.districtName = needs.districtName;
  else if (needs.placeText) intent.placeText = needs.placeText;
  if (!needs.budget && new RegExp(`${BW}(?:недорог${TAIL}|подешевл${TAIL}|дешев${TAIL}|арзон${TAIL}|бюджетн${TAIL})`, "iu").test(own)) intent.sort = "cheap";
  return intent;
}

const hasCondition = (reading: BuyerNeedsReading) => !!(reading.type || reading.place || reading.rooms || reading.budget || reading.currencyOnly);

const ASKED_KEY: Partial<Record<string, BuyerNeedKey>> = { location: "location", rooms: "rooms", budget: "budget", budget_currency: "budget" };

/**
 * The customer ANSWERS the bot's own question about a district / rooms / budget ("двушка" -> «Какой район вам подходит?» ->
 * "в Фирдавси", live 31.10: the bot asked "Какой объект вы имеете в виду?"). The answer carries no request word, so the conditions
 * are the answer plus what the customer said in the last user turns. Only right after the bot's fixed location/rooms/budget question;
 * the answer itself must name a condition ("не знаю" is not one). A bare «3» / «70 000» / «Зарафшон» counts: it is the answer.
 */
export function customerSearchContinuation(text: string, turns: ReadonlyArray<{ role: "user" | "assistant"; text: string }>): CustomerSearchIntent | null {
  const last = turns.at(-1);
  if (last?.role !== "assistant") return null;
  const lines = last.text.split("\n").map(line => line.trim());
  const askedQuestion = (["ru", "tg"] as const).flatMap(language => customerAgentQuestionCatalog(language).filter(({ question, text: sentence }) =>
    ASKED_KEY[question] !== undefined && lines.includes(sentence)).map(({ question }) => question))[0];
  const asked = askedQuestion ? ASKED_KEY[askedQuestion] : undefined;
  const own = norm(text);
  if (!asked || !own.trim() || own.length > 120 || !hasCondition(readBuyerNeeds(text, asked))) return null;
  const earlier = turns.filter(turn => turn.role === "user").slice(-2).map(turn => ({ text: turn.text }));
  const combined = norm([...earlier.map(turn => turn.text), text].join(". "));
  if (customerSellerOrJobWords(combined) || customerRentOnlyWords(combined)) return null;
  // Each message is read on its own (an amount in one turn and its currency in the next are joined by the accumulation, not by punctuation).
  const needs = buyerNeedsFromMessages([...earlier, { text, asked: last.text }]);
  return intentFromNeeds(needs, combined);
}

/**
 * What the buyer named EARLIER in the conversation (the intake's `buyerNeeds`, the same words the bot does not ask again) fills the
 * conditions this message left out: «бюджет до 60 тысяч долларов» on the first turn is still in the search on «покажите двушки» three
 * turns later. The current message wins on every field it names (a correction); nothing is invented.
 */
export function customerSearchIntentWithKnownNeeds(intent: CustomerSearchIntent | null, known: CustomerBuyerNeeds | undefined): CustomerSearchIntent | null {
  if (!intent || !known) return intent;
  const merged: CustomerSearchIntent = { ...intent };
  if (!merged.type && known.type) merged.type = known.type;
  if (!merged.rooms && known.rooms) merged.rooms = known.rooms;
  if (!merged.budget && !merged.budgetNoCurrency && known.budget) {
    if (known.budget.currency) merged.budget = { ...(known.budget.min ? { min: known.budget.min } : {}), ...(known.budget.max ? { max: known.budget.max } : {}), currency: known.budget.currency };
    else merged.budgetNoCurrency = true;
  }
  if (!merged.districtName && !merged.placeText) {
    if (known.districtName) merged.districtName = known.districtName;
    else if (known.placeText) merged.placeText = known.placeText;
  }
  // A ceiling bounds the list; «cheapest first» is only for a search without one.
  if (merged.budget && merged.sort === "cheap" && !intent.sort) delete merged.sort;
  return merged;
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
  // An amount without a currency is not a condition the search can apply: «хочу купить квартиру до 60 тысяч» stays a consultation.
  if (!district && !intent.rooms && !intent.budget && !intent.sort) return null;
  const parsed = customerAgentPropertySearchCallSchema.safeParse({ name: "search_public_properties", args: {
    ...(intent.type ? { type: intent.type } : {}), ...(district ? { districtName: district } : {}),
    ...(intent.rooms ? { rooms: intent.rooms } : {}),
    ...(intent.budget ? { budget: intent.budget } : {}), ...(intent.sort ? { sort: intent.sort } : {}) } });
  return parsed.success ? parsed.data : null;
}

import { describe, expect, it } from "vitest";
import { customerAgentPropertySearchCallSchema, customerAgentVerifiedContextSchema, type CustomerAgentEvidence, type CustomerAgentVerifiedContext } from "@royal-home/shared";
import { customerAgentIntake } from "../src/ai/customerAgentIntake.js";
import { customerAgentRenderedQuestion, customerAgentQuestionCatalog } from "../src/ai/customerAgentRenderer.js";
import { customerSearchContinuation, customerSearchIntent, customerSearchIntentWithKnownNeeds, customerSearchPreRead } from "../src/ai/customerAgentSearchIntent.js";

/** The conversation as the server sees it: history -> intake -> «what to ask next» -> search. No model, no network. */
const turn = (role: "user" | "assistant", text: string) => ({ role, text });
const bot = (question: "budget" | "rooms" | "location" | "budget_currency", language: "ru" | "tg" = "ru") =>
  customerAgentQuestionCatalog(language).find(entry => entry.question === question)!.text;
function contextFor(turns: ReturnType<typeof turn>[], current: string): CustomerAgentVerifiedContext {
  const last = turns.at(-1);
  const intake = customerAgentIntake(turns, current, "unknown", last?.role === "assistant" ? last.text : undefined);
  return customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: "a".repeat(64), turns: turns.slice(-6),
    publicState: { language: "ru", topic: "unknown", openQuestion: "none" }, intake });
}
const ask = (question: "budget" | "rooms" | "location", verifiedContext: CustomerAgentVerifiedContext, inputText: string,
  evidence: CustomerAgentEvidence[] = [], refs: string[] = []) =>
  customerAgentRenderedQuestion({ decision: { kind: "clarify", refs, social: "none", question }, evidence, surface: "dm", knownPhoneSource: "none", verifiedContext, inputText });

describe("a buyer is not asked again for what was already said (budget on the first turn, search on the third)", () => {
  it("RU: budget on turn 1, district on turn 2, «покажите двушки» on turn 3: no budget question, budget in the search", () => {
    const turns = [turn("user", "Хочу купить квартиру, бюджет до 60 тысяч долларов"), turn("assistant", bot("location")), turn("user", "в Сино"), turn("assistant", bot("rooms"))];
    const current = "покажите двушки";
    const context = contextFor(turns, current);
    expect(context.intake?.buyerNeeds).toMatchObject({ districtName: "Сино", rooms: 2, budget: { max: "60000", currency: "USD" } });
    expect(context.intake?.buyerKnown).toEqual(["location", "rooms", "budget"]);
    // the model (or its fallback) wants to ask the budget again: the server turns it into the next unknown, here «preferences»
    expect(ask("budget", context, current)).toBe("preferences");
    expect(ask("rooms", context, current)).toBe("preferences");
    // the search carries every condition named on any turn
    const intent = customerSearchIntentWithKnownNeeds(customerSearchIntent(current), context.intake?.buyerNeeds);
    expect(customerSearchPreRead(intent)).toMatchObject({ name: "search_public_properties", args: {
      type: "APARTMENT", districtName: "Сино", rooms: 2, budget: { max: "60000", currency: "USD" } } });
  });
  it("TJ: «Сино», «3 хонагӣ», «то 60 ҳазор доллар» on three turns, then «нишон диҳед»", () => {
    const turns = [turn("user", "Хона харидан мехоҳам"), turn("assistant", bot("location", "tg")), turn("user", "Сино"), turn("assistant", bot("rooms", "tg")),
      turn("user", "3 хонагӣ"), turn("assistant", bot("budget", "tg"))];
    const current = "то 60 ҳазор доллар";
    const context = contextFor(turns, current);
    expect(context.intake?.buyerNeeds).toMatchObject({ districtName: "Сино", rooms: 3, budget: { max: "60000", currency: "USD" } });
    expect(ask("budget", context, current)).toBe("preferences");
    const later = contextFor([...turns, turn("user", current), turn("assistant", "Ман се вариант ёфтам.")], "нишон диҳед боз");
    const intent = customerSearchIntentWithKnownNeeds(customerSearchIntent("нишон диҳед боз"), later.intake?.buyerNeeds);
    expect(customerSearchPreRead(intent)?.args).toMatchObject({ districtName: "Сино", rooms: 3, budget: { max: "60000", currency: "USD" } });
  });
  it("bare answers: «Сино», «3», «70000» count after the bot's own question, and not without it", () => {
    const answered = contextFor([turn("user", "Хочу купить квартиру"), turn("assistant", bot("location")), turn("user", "Сино"), turn("assistant", bot("rooms")),
      turn("user", "3"), turn("assistant", bot("budget"))], "70000");
    expect(answered.intake?.buyerNeeds).toMatchObject({ districtName: "Сино", rooms: 3, budget: { max: "70000" } });
    const unasked = contextFor([turn("user", "Хочу купить квартиру"), turn("assistant", "Подскажите, что вас интересует?")], "3");
    expect(unasked.intake?.buyerNeeds).toEqual({ type: "APARTMENT" });
    expect(unasked.intake?.buyerKnown).toEqual([]);
  });
  it("what was said BEFORE the customer said «купить» is not lost", () => {
    const context = contextFor([turn("user", "Сино 3 хонагӣ до 60000 долларов"), turn("assistant", "Салом! Шумо харидан мехоҳед ё фурӯхтан?")], "Харидан мехоҳам");
    expect(context.intake).toMatchObject({ role: "buyer", buyerKnown: ["location", "rooms", "budget"] });
  });
  it("a search request alone makes the customer a buyer and records what it named", () => {
    const context = contextFor([], "ищу двушку в Сино до 60000$");
    expect(context.intake).toMatchObject({ role: "buyer", buyerKnown: ["location", "rooms", "budget"] });
    expect(ask("location", context, "ищу двушку в Сино до 60000$")).toBe("preferences");
  });
  it("an amount with no currency: the currency is asked once, not the budget again; the answer completes it", () => {
    const first = contextFor([turn("user", "Хочу купить квартиру")], "бюджет 60 тысяч");
    expect(first.intake?.buyerNeeds?.budget).toEqual({ max: "60000" });
    expect(ask("budget", first, "бюджет 60 тысяч")).toBe("budget_currency");
    // asked already: not twice in a row
    const second = contextFor([turn("user", "Хочу купить квартиру"), turn("user", "бюджет 60 тысяч"), turn("assistant", bot("budget_currency"))], "не знаю");
    expect(ask("budget", second, "не знаю")).toBe("location");
    const done = contextFor([turn("user", "Хочу купить квартиру"), turn("user", "бюджет 60 тысяч"), turn("assistant", bot("budget_currency"))], "в долларах");
    expect(done.intake?.buyerNeeds?.budget).toEqual({ max: "60000", currency: "USD" });
  });
  it("a correction replaces the old wish; a seller's facts never become a buyer's wishes", () => {
    const context = contextFor([turn("user", "Продаю 3 комнаты 90 м2 в Сино за 700000 сомони"), turn("user", "Теперь хочу купить квартиру, до 80 тысяч долларов")], "нет, до 70 тысяч");
    expect(context.intake).toMatchObject({ role: "buyer", sellerKnown: [] });
    expect(context.intake?.buyerNeeds).toEqual({ type: "APARTMENT", budget: { max: "70000", currency: "USD" } });
  });
  it("a price question about one object is not a buyer's wish", () => {
    expect(contextFor([], "Здравствуйте, сколько стоит объект 123").intake?.role).toBe("unknown");
  });
  it("a seller asking for market prices is not turned into a buyer", () => {
    const context = contextFor([turn("user", "Продаю двушку в Сино")], "а сколько стоят двушки у вас?");
    expect(context.intake?.role).toBe("seller");
  });
  it("the object card of a buyer fills rooms and district, never the budget", () => {
    const context = contextFor([turn("user", "Хочу купить квартиру")], "сколько стоит №123?");
    const card = { ref: "e0", value: { kind: "facts", kinds: ["price"], facts: { propertyId: "11111111-1111-4111-8111-111111111111", shortId: 123, price: "50000", currency: "USD",
      availability: "AVAILABLE", publicAddress: "Сино, Душанбе", addressPolicy: "district_city_only", builder: null,
      characteristics: { type: "APARTMENT", rooms: 2, areaSqm: null, landAreaSotka: null, floor: null, totalFloors: null, condition: null, marketType: null, stage: null },
      publicLink: null, updatedAt: "2026-11-14T00:00:00.000Z", signature: "sig" } } } as unknown as CustomerAgentEvidence;
    expect(ask("rooms", context, "сколько стоит №123?", [card], ["e0"])).toBe("budget");
    expect(ask("location", context, "сколько стоит №123?", [card], ["e0"])).toBe("budget");
    expect(ask("budget", context, "сколько стоит №123?", [card], ["e0"])).toBe("budget");
  });
});

describe("search intent forms (the same reader as the intake)", () => {
  it.each([
    ["ищу двушку в Сино 50к $", { type: "APARTMENT", rooms: 2, districtName: "Сино", budget: { max: "50000", currency: "USD" } }],
    ["есть ли квартиры $50 000 в Шоҳмансур", { districtName: "Шохмансур", budget: { max: "50000", currency: "USD" } }],
    ["нужна квартира 82 мкр до 500 000 сомони", { placeText: "82 мкр", budget: { max: "500000", currency: "TJS" } }],
    ["квартира меҷӯям дар Фирдавсӣ то 60 ҳазор доллар", { districtName: "Фирдавси", budget: { max: "60000", currency: "USD" } }],
    ["ищу квартиру от 40 до 60 тысяч долларов", { budget: { min: "40000", max: "60000", currency: "USD" } }],
    ["ищу трёшку в Сине до 70 тыс долларов", { rooms: 3, districtName: "Сино", budget: { max: "70000", currency: "USD" } }],
  ] as const)("%s", (text, expected) => {
    expect(customerSearchIntent(text)).toMatchObject(expected);
  });
  it("an amount without a currency does not become a ceiling, and a bare wish stays a consultation", () => {
    const intent = customerSearchIntent("ищу двушку до 60 тысяч");
    expect(intent).toMatchObject({ rooms: 2, budgetNoCurrency: true });
    expect(customerSearchPreRead(intent)?.args.budget).toBeUndefined();
    expect(customerSearchPreRead(customerSearchIntent("ищу квартиру до 60 тысяч"))).toBeNull();
  });
  it("the answer to the bot's budget question searches with the earlier wishes", () => {
    const turns = [turn("user", "ищу двушку в Сино"), turn("assistant", bot("budget"))];
    const intent = customerSearchContinuation("5000", turns);
    expect(intent).toMatchObject({ rooms: 2, districtName: "Сино", budgetNoCurrency: true });
    const after = customerSearchContinuation("в долларах", [...turns, turn("user", "до 60 тысяч"), turn("assistant", bot("budget_currency"))]);
    expect(customerSearchPreRead(after)?.args).toMatchObject({ rooms: 2, districtName: "Сино", budget: { max: "60000", currency: "USD" } });
  });
});

describe("the contract code holds (model arguments and the stored summary)", () => {
  it("the search tool refuses an insane budget for its currency", () => {
    const call = (budget: unknown) => customerAgentPropertySearchCallSchema.safeParse({ name: "search_public_properties", args: { type: "APARTMENT", budget } }).success;
    expect(call({ max: "60000", currency: "USD" })).toBe(true);
    expect(call({ max: "500000", currency: "TJS" })).toBe(true);
    expect(call({ max: "60", currency: "USD" })).toBe(false);
    expect(call({ max: "900000000000", currency: "USD" })).toBe(false);
    expect(call({ min: "40000", max: "60000", currency: "USD" })).toBe(true);
  });
  it("the verified context carries buyerNeeds strictly", () => {
    const base = { surface: "dm", revisionId: "a".repeat(64), turns: [], publicState: { language: "ru", topic: "unknown", openQuestion: "none" } };
    const parse = (buyerNeeds: unknown) => customerAgentVerifiedContextSchema.safeParse({ ...base, intake: { role: "buyer", sellerKnown: [], buyerKnown: [], buyerNeeds } }).success;
    expect(parse({ rooms: 2, districtName: "Сино", budget: { max: "60000", currency: "USD" } })).toBe(true);
    expect(parse({ rooms: 2, secret: "x" })).toBe(false);
    expect(parse({ budget: { currency: "USD" } })).toBe(false);
  });
});

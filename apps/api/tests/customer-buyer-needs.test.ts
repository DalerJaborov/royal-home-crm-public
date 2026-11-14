import { describe, expect, it } from "vitest";
import { buyerNeedsFromMessages, buyerNeedsKnown, buyerNextQuestion, buyerQuestionAsked, customerSearchRequested, readBuyerNeeds } from "../src/ai/customerBuyerNeeds.js";

/** Real forms (RU / TJ / mixed) in which a buyer names budget, rooms and place. Pure text, no model. */
describe("budget in the customer's own words", () => {
  const cases: Array<[string, { min?: number; max?: number; currency?: "TJS" | "USD" } | undefined]> = [
    ["до 50 тысяч долларов", { max: 50000, currency: "USD" }],
    ["50к", { max: 50000 }],
    ["50к $", { max: 50000, currency: "USD" }],
    ["$50 000", { max: 50000, currency: "USD" }],
    ["500 000 сомони", { max: 500000, currency: "TJS" }],
    ["бюджет 500000 смн", { max: 500000, currency: "TJS" }],
    ["хочу квартиру за 60 тысяч долларов", { max: 60000, currency: "USD" }],
    ["не дороже 80000 usd", { max: 80000, currency: "USD" }],
    ["максимум 1,5 млн сомони", { max: 1500000, currency: "TJS" }],
    ["бюджет у меня 45 000", { max: 45000 }],
    ["от 40 до 60 тысяч долларов", { min: 40000, max: 60000, currency: "USD" }],
    ["40-60к $", { min: 40000, max: 60000, currency: "USD" }],
    ["то 60 ҳазор доллар", { max: 60000, currency: "USD" }],
    ["Сино 3 хонагӣ то 60 ҳазор доллар", { max: 60000, currency: "USD" }],
    ["буҷет 500 ҳазор сомонӣ", { max: 500000, currency: "TJS" }],
    ["аз 300 то 450 ҳазор сомонӣ", { min: 300000, max: 450000, currency: "TJS" }],
    ["тахминан 70 ҳазор доллар", { max: 70000, currency: "USD" }],
    ["ищу двушку до 70000$", { max: 70000, currency: "USD" }],
    // not money
    ["до 5 этажа", undefined],
    ["до 2 комнат", undefined],
    ["3 комнаты 54 м2", undefined],
    ["82 мкр", undefined],
    ["мой номер 927773726", undefined],
    ["в 2026 году", undefined],
    ["через 5 минут", undefined],
    ["Она стоит 500000 сомони?", undefined],
    ["сколько стоит квартира за 60000$ в Сино", { max: 60000, currency: "USD" }],
    ["до 40", undefined],
  ];
  it.each(cases)("%s", (text, expected) => {
    expect(readBuyerNeeds(text).budget).toEqual(expected);
  });
  it("a bare number is a budget only as the answer to the bot's budget question", () => {
    expect(readBuyerNeeds("5000").budget).toBeUndefined();
    expect(readBuyerNeeds("5000", "budget").budget).toEqual({ max: 5000 });
    expect(readBuyerNeeds("60 000", "budget").budget).toEqual({ max: 60000 });
    expect(readBuyerNeeds("3", "budget").budget).toBeUndefined();
  });
  it("rejects an amount outside the sane range for its currency (an extra zero, a floor number)", () => {
    expect(readBuyerNeeds("до 500 долларов").budget).toBeUndefined();
    expect(readBuyerNeeds("до 900000000 долларов").budget).toBeUndefined();
  });
});

describe("rooms in the customer's own words", () => {
  const cases: Array<[string, number | undefined, ("rooms" | undefined)?]> = [
    ["ищу двушку", 2], ["нужна однушка", 1], ["хочу трёшку", 3], ["3 комнаты", 3], ["3-комнатная", 3], ["2к квартира", 2], ["2-к", 2],
    ["трехкомнатную", 3], ["четырехкомнатная квартира", 4], ["комнат 3", 3], ["пятикомнатную", 5],
    ["3 хонагӣ", 3], ["ду ҳуҷра", 2], ["ду ҳуҷрагӣ лозим", 2], ["се хонагӣ мехоҳам", 3], ["як ҳуҷрагӣ", 1], ["2-3 комнаты", 2],
    ["Сино, 3 комнаты, до 70000$", 3],
    ["3 этаж", undefined], ["до 5 этажа", undefined], ["54 м2", undefined], ["50к", undefined], ["82 мкр", undefined],
    ["3", 3, "rooms"], ["три", 3, "rooms"], ["две", 2, "rooms"], ["3", undefined],
  ];
  it.each(cases)("%s", (text, expected, asked) => {
    expect(readBuyerNeeds(text, asked).rooms).toBe(expected);
  });
});

describe("place in the customer's own words", () => {
  const cases: Array<[string, { districtName?: string; placeText?: string; anywhere?: true } | undefined, ("location" | undefined)?]> = [
    ["Сино", { districtName: "Сино" }], ["в Сине", { districtName: "Сино" }], ["Шохмансур", { districtName: "Шохмансур" }],
    ["Шоҳмансур", { districtName: "Шохмансур" }], ["дар Шоҳмансур", { districtName: "Шохмансур" }], ["Фирдавси", { districtName: "Фирдавси" }],
    ["Фирдавсӣ", { districtName: "Фирдавси" }], ["Исмоили Сомони", { districtName: "Исмоили Сомони" }], ["район Сино", { districtName: "Сино" }],
    ["82 мкр", { placeText: "82 мкр" }], ["82-й микрорайон", { placeText: "82 мкр" }], ["мкр 91", { placeText: "91 мкр" }],
    ["в Зарафшоне", { placeText: "зарафшоне" }], ["возле Корвона", { placeText: "корвона" }], ["дар назди Айнӣ", { placeText: "айнӣ" }],
    ["любой район", { anywhere: true }], ["неважно где", { anywhere: true }], ["ноҳия фарқ надорад", { anywhere: true }],
    ["в Душанбе", undefined], ["в новостройке", undefined], ["в рассрочку", undefined], ["на 5 этаже", undefined], ["в долларах", undefined],
    ["около 60 тысяч", undefined], ["в хорошем состоянии", undefined],
    ["Зарафшон", { placeText: "зарафшон" }, "location"], ["Зарафшон", undefined],
  ];
  it.each(cases)("%s", (text, expected, asked) => {
    expect(readBuyerNeeds(text, asked).place).toEqual(expected);
  });
});

describe("the question the bot asked", () => {
  it.each([
    ["Какой бюджет вы рассматриваете?", "budget"], ["На какую сумму примерно рассчитываете?", "budget"],
    ["Шумо чӣ қадар буҷет дар назар доред?", "budget"], ["Тахминан ба кадом маблағ ҳисоб мекунед?", "budget"],
    ["Я уточнял сумму для покупки. Какой у вас бюджет?", "budget"],
    ["Сколько комнат вам нужно?", "rooms"], ["Ба шумо чанд ҳуҷра лозим аст?", "rooms"],
    ["Какой район вам подходит?", "location"], ["Кадом ноҳия ба шумо мувофиқ аст?", "location"],
    ["Спасибо, записал.\nКакой бюджет вы рассматриваете?", "budget"], ["Здравствуйте!", undefined],
  ] as const)("%s", (text, expected) => { expect(buyerQuestionAsked(text)).toBe(expected); });
});

describe("accumulation across turns", () => {
  it("later words correct earlier ones, field by field", () => {
    const needs = buyerNeedsFromMessages([{ text: "Хочу квартиру в Сино, 2 комнаты, до 60 тысяч долларов" }, { text: "нет, до 50 тысяч" }, { text: "лучше в Фирдавси" }]);
    expect(needs).toMatchObject({ type: "APARTMENT", rooms: 2, districtName: "Фирдавси", budget: { max: "50000", currency: "USD" } });
  });
  it("an amount without currency waits for the currency answer", () => {
    const first = buyerNeedsFromMessages([{ text: "до 60 тысяч" }]);
    expect(first.budget).toEqual({ max: "60000" });
    expect(buyerNeedsFromMessages([{ text: "в долларах" }], first).budget).toEqual({ max: "60000", currency: "USD" });
    // an implausible currency for the amount is not attached
    expect(buyerNeedsFromMessages([{ text: "сомони" }], { budget: { max: "600" } }).budget).toEqual({ max: "600" });
  });
  it("answers to the bot's questions count only after that question", () => {
    const needs = buyerNeedsFromMessages([
      { text: "Хочу купить квартиру" },
      { text: "Сино", asked: "Какой район вам подходит?" },
      { text: "3", asked: "Сколько комнат вам нужно?" },
      { text: "70 000", asked: "На какую сумму примерно рассчитываете?" },
    ]);
    expect(needs).toMatchObject({ districtName: "Сино", rooms: 3, budget: { max: "70000" } });
    expect(buyerNeedsKnown(needs)).toEqual(["location", "rooms", "budget"]);
    expect(buyerNeedsFromMessages([{ text: "3" }, { text: "70 000" }])).toEqual({});
  });
  it("one place of «what is still unknown»", () => {
    expect(buyerNextQuestion([])).toBe("location");
    expect(buyerNextQuestion(["location"])).toBe("rooms");
    expect(buyerNextQuestion(["location", "rooms"])).toBe("budget");
    expect(buyerNextQuestion(["budget", "location", "rooms"])).toBe("preferences");
    expect(buyerNextQuestion(["budget", "rooms"])).toBe("location");
  });
});

describe("search request (moved from the search intent, same reading)", () => {
  it.each(["ищу двушку в Сино", "есть ли двушки", "меҷӯям хонаи 2 ҳуҷрагӣ"])("%s", text => expect(customerSearchRequested(text)).toBe(true));
  it.each(["продам двушку", "сдаю квартиру", "хочу снять квартиру", "спасибо"])("%s is not", text => expect(customerSearchRequested(text)).toBe(false));
});

import { describe, expect, it } from "vitest";
import { customerSearchIntent, customerSearchPreRead } from "../src/ai/customerAgentSearchIntent.js";

describe("customerSearchIntent", () => {
  const cases: Array<[string, "ru" | "tg", Record<string, unknown>]> = [
    ["ищу двушку в Сино", "ru", { type: "APARTMENT", rooms: 2, districtName: "Сино" }],
    ["есть ли двушки", "ru", { type: "APARTMENT", rooms: 2 }],
    ["хочу купить квартиру до 600000 сомони", "ru", { type: "APARTMENT", budget: { max: "600000", currency: "TJS" } }],
    ["что есть в Шохмансуре", "ru", { districtName: "Шохмансур" }],
    ["нужна однокомнатная недорого", "ru", { type: "APARTMENT", rooms: 1, sort: "cheap" }],
    ["сколько стоит квартира в новостройке 3 комнаты", "ru", { type: "APARTMENT", rooms: 3 }],
    ["Подберите дом до 80 тыс долларов", "ru", { type: "HOUSE", budget: { max: "80000", currency: "USD" } }],
    ["ищу участок в Рудаки", "ru", { type: "LAND", placeText: "рудаки" }],
    ["нужен офис в Фирдавси", "ru", { type: "COMMERCIAL", districtName: "Фирдавси" }],
    ["куплю трешку до $90 000", "ru", { type: "APARTMENT", rooms: 3, budget: { max: "90000", currency: "USD" } }],
    ["покажите варианты квартир в Исмоили Сомони", "ru", { type: "APARTMENT", districtName: "Исмоили Сомони" }],
    ["квартира меҷӯям дар Сино", "tg", { type: "APARTMENT", districtName: "Сино" }],
    ["ду ҳуҷрагӣ лозим аст, квартира", "tg", { type: "APARTMENT", rooms: 2 }],
    ["харидани ҳавлӣ мехоҳам, дар Шоҳмансур доред?", "tg", { type: "HOUSE", districtName: "Шохмансур" }],
    ["замин доред дар Фирдавсӣ", "tg", { type: "LAND", districtName: "Фирдавси" }],
    ["нишон диҳед квартира то 500000 сомонӣ", "tg", { type: "APARTMENT", budget: { max: "500000", currency: "TJS" } }],
  ];
  it.each(cases)("%s", (text, language, expected) => {
    expect(customerSearchIntent(text, language)).toMatchObject(expected);
  });
  it.each([
    "продам двушку в Сино", "двушка свободна?", "сдаю квартиру", "ищу работу", "здравствуйте", "спасибо", "хочу снять квартиру",
    "квартира до 2 минут от метро?", "фурӯшам хона дорам", "а этаж какой?",
  ])("not a search: %s", text => {
    expect(customerSearchIntent(text)).toBeNull();
  });
  it("does not turn a bare number with no currency into a budget", () => {
    expect(customerSearchIntent("ищу квартиру до 5 этажа")?.budget).toBeUndefined();
  });
  it("pre-read needs a type or a district, like the tool itself", () => {
    expect(customerSearchPreRead(customerSearchIntent("есть ли двушки"))).toMatchObject({ name: "search_public_properties", args: { type: "APARTMENT", rooms: 2 } });
    expect(customerSearchPreRead(customerSearchIntent("скиньте варианты"))).toBeNull();
    expect(customerSearchPreRead(customerSearchIntent("что есть у вас"))).toBeNull();
    expect(customerSearchPreRead(customerSearchIntent("ищу что-нибудь в Зарафшоне"), "Сино")?.args.districtName).toBe("Сино");
    expect(customerSearchPreRead(null)).toBeNull();
  });
});

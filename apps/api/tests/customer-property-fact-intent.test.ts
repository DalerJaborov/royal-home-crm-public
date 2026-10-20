import { describe, expect, it } from "vitest";
import type { CustomerPropertyFactKind } from "@royal-home/shared";
import { classifyCustomerPropertyFactIntent } from "../src/lib/customerPropertyFactIntent.js";

describe("customer property fact-only intent", () => {
  it("a social reel URL alone does not prove a property topic", () => {
    const text = "Можно подробнее https://www.instagram.com/reel/SOCIAL/";
    expect(classifyCustomerPropertyFactIntent(text)).toBeNull();
    expect(classifyCustomerPropertyFactIntent(text, { hasPropertyContext: true })).toEqual(["price", "address"]);
  });
  it.each<[string, CustomerPropertyFactKind[]]>([
    ["Нархш чансумай?", ["price"]],
    ["Салом, нархаш чанд сомонӣ?", ["price"]],
    ["Цена?", ["price"]],
    ["Подскажите, сколько стоит эта квартира?", ["price"]],
    ["Объект 123, какая цена?", ["price"]],
    ["№123 — цена и адрес?", ["price", "address"]],
    ["https://royalhome.tj/listing/123\nСколько стоит?", ["price"]],
    ["Где находится?", ["address"]],
    ["Ин хона дар куҷост?", ["address"]],
    ["Кто застройщик?", ["builder"]],
    ["Ширкати сохтмонӣ?", ["builder"]],
    ["Кӣ сохтааст?", ["builder"]],
    ["Нарх ва куҷо?", ["price", "address"]],
    ["Объект №123, можно подробнее?", ["price", "address"]],
    ["https://royalhome.tj/listing/123 Можно подробнее?", ["price", "address"]],
  ])("routes a simple question: %s", (text, expected) => {
    expect(classifyCustomerPropertyFactIntent(text)).toEqual(expected);
  });

  // Literal anonymized golden-set cases; these assert routing only, not model
  // quality or the accuracy of unavailable historical cards/referral payloads.
  it.each([
    "Привет! Можно узнать об этом подробнее?", // Д221/285/287/342/379/397/429/888
    "Здравствуйте! Можно узнать об этом подробнее?", // Д705, before its later video
    "Маълумоти бештар гирифта метавонам?",
  ])("does not infer a property from a generic opener without context: %s", (text) => {
    expect(classifyCustomerPropertyFactIntent(text)).toBeNull();
    expect(classifyCustomerPropertyFactIntent(text, { hasPropertyContext: true })).toEqual(["price", "address"]);
  });

  it("routes the simple Tajik price question from golden Д791", () => {
    expect(classifyCustomerPropertyFactIntent("нархша фахмем")).toEqual(["price"]);
  });

  it("routes literal golden Д905/t1/occ1 glued price question with or without property context", () => {
    expect(classifyCustomerPropertyFactIntent("Нархшчансумай")).toEqual(["price"]);
    expect(classifyCustomerPropertyFactIntent("Нархшчансумай", { hasPropertyContext: true })).toEqual(["price"]);
  });

  it.each(["Нархшчансумай позвоните завтра", "Нархшчансумайба"])("keeps a mixed/unknown suffix on the Д905 compound in legacy routing: %s", (text) => {
    expect(classifyCustomerPropertyFactIntent(text)).toBeNull();
    expect(classifyCustomerPropertyFactIntent(text, { hasPropertyContext: true })).toBeNull();
  });

  it.each([
    ["Д247", "Нархи хизмат чанд"],
    ["Д709/714/759", "Можно ли договориться о цене?"],
    ["Д055", "Нархш 750хазор бо Чи зу Чораш Акачон Бо муомила дора"],
    ["Д133", "квартира в районе где Ласточка за 920 .000 продадите"],
    ["Д136", "Мода даркор ки шумо биен бинен ябор хонара оценка кнен ку чанд кадар монем нархаша"],
    ["Д145", "Ман хаминаша фахмидан мехостам оё бо хамин нарх меёфта бошам хона"],
    ["Д893", "Хоб хонамон 2 700.000 хазор буд мо арзонаш кардем 2.200.000 хазор Кардем нархаша срочно метавонен нархи хонаро алиш кунеду таргетба сар тиенаш максад суми таргеташа ман худам перевод мекунам"],
  ])("preserves non-fact intent from golden %s", (_id, text) => {
    expect(classifyCustomerPropertyFactIntent(text, { hasPropertyContext: true })).toBeNull();
  });

  it.each([
    "Цена и запишите меня на показ",
    "Сколько стоит, позвоните завтра",
    "Нархаш чанд? Ба ман занг занед",
    "Где находится и можно осмотр?",
    "Цена, мой номер +992 90 123 45 67",
    "Цена 900000000, наберите",
    "Нархаш? Рақамам 901234567",
    "Какая цена в долларах по сегодняшнему курсу?",
    "Цена не нужна",
    "Не сообщайте адрес",
    "Можно подробнее про вакансию?",
    "Хочу продать квартиру, какая цена?",
    "Сколько стоит аренда?",
    "Нархаш иҷора чанд?",
    "Квартира в рассрочку, какая цена?",
    "Сколько стоит ремонт?",
    "Где мой агент?",
    "Можно подробнее и отменить заявку?",
    "Цена и https://wa.me/992901234567",
    "Можно подробнее https://royalhome.tj/vacancy/123",
    "Где https://example.com/cancel-request",
    "Цена 1000000?",
    "Привет",
    "Объект 123",
    "",
    "цена? ".repeat(110),
  ])("leaves mixed, unsupported or absent intent to the existing path: %s", (text) => {
    expect(classifyCustomerPropertyFactIntent(text)).toBeNull();
  });
});

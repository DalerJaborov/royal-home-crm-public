import { describe, expect, it } from "vitest";
import { customerRoleSignals, customerTextRole, foldCustomerTextForRole } from "../src/ai/customerAgentRole.js";
import { classifyInbound, INTENT_UNKNOWN_NOTE } from "../src/services/leads/intakePolicy.js";
import { watchdogLeadDraft } from "../src/lib/phoneLeadWatchdog.js";

/**
 * Журнал прода 13–16.11.2026: 10 карточек «прочее обращение: намерение не
 * определено, агенту не назначается», из них ~6 — живые продавцы и покупатели.
 * Слова ниже — из журнала (обрезаны там же, где обрезал журнал).
 */
const history = (...texts: string[]) => texts.map((content) => ({ role: "user" as const, content }));

describe("намерение по словам клиента — таджикский латиницей и вопросы покупателя", () => {
  it("латиница переписывается кириллицей только для чтения роли", () => {
    expect(foldCustomerTextForRole("xonai furushi dorum")).toBe("хонаи фуруши дорум");
    expect(foldCustomerTextForRole("Prodayu kvartiru")).toBe("продаю квартиру");
    // Слово с цифрами и кириллица не трогаются.
    expect(foldCustomerTextForRole("2xona Сино")).toBe("2xona сино");
  });

  it.each([
    ["xonai furushi dorum", "seller"],
    ["Xonai furushi dorum 900000000 votsap", "seller"],
    ["prodayu kvartiru v Sino", "seller"],
    ["Хачу продат сваю квартиру", "seller"],
    ["hochu kupit kvartiru", "buyer"],
    ["Хами хонара видеоша дорен", "buyer"],
    ["Квадрат аз 100 боло, вариант пешниход кунед", "buyer"],
    ["kvadrat az 100 bolo variant peshnihod kuned", "buyer"],
    ["скиньте варианты двушек", "buyer"],
  ])("«%s» → %s", (text, role) => {
    expect(customerTextRole(text, false)).toBe(role);
  });

  it("предложение продавца и «у меня есть» не становятся покупателем", () => {
    expect(customerTextRole("Хонаи худам дорам, пешниход мекунам", false)).toBe("seller");
    expect(customerRoleSignals("предлагаю вариант своей квартиры").buyWeak).toBe(false);
    expect(customerRoleSignals("хона дорам").buyWeak).toBe(false);
  });

  it("аренда латиницей — по-прежнему аренда", () => {
    expect(customerRoleSignals("kvartira v arendu nado").rent).toBe(true);
  });

  it("сторож номера берёт намерение из латиницы и для старого пути", () => {
    expect(watchdogLeadDraft({ draft: null, coreTopic: null, history: history("Salom", "xonai furushi dorum") }).intent).toBe("sell");
    expect(watchdogLeadDraft({ draft: null, coreTopic: "unknown", history: history("Хами хонара видеоша дорен") }).intent).toBe("buy");
  });
});

describe("намерение не определено — общая раздача с пометкой, а не «прочее» без агента", () => {
  it("переписка: описание квартиры без глагола → покупатель с пометкой «уточнить»", () => {
    const decision = classifyInbound({ clientText: "2 хучрага хона, ошёна 5, Ремонтош", channel: "chat" });
    expect(decision.kind).toBe("BUYER");
    expect(decision.intentUnknown).toBe(true);
    expect(decision.label).toBe(INTENT_UNKNOWN_NOTE);
  });

  it("комментарий под постом — так же", () => {
    expect(classifyInbound({ clientText: "Салом", channel: "comment" }).kind).toBe("BUYER");
  });

  it("явные отсечки остаются «прочими»: работа, аренда, услуги, «модель не уверена»", () => {
    expect(classifyInbound({ intent: "job", clientText: "увидела вакансию", channel: "chat" }).kind).toBe("OTHER");
    expect(classifyInbound({ intent: "rent", clientText: "сниму квартиру", channel: "chat" }).kind).toBe("OTHER");
    expect(classifyInbound({ intent: "other", clientText: "делаю ремонт квартир", channel: "chat" }).kind).toBe("OTHER");
    const lowConfidence = classifyInbound({ intent: "buy", confident: false, clientText: "здравствуйте", channel: "chat" });
    expect(lowConfidence.intentUnknown).toBeUndefined();
  });

  it("звонок без намерения правило не меняет (там своя анкета)", () => {
    expect(classifyInbound({ clientText: "алло", channel: "call" }).kind).toBe("OTHER");
  });
});

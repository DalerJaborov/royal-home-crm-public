import { describe, expect, it } from "vitest";
import { deriveOwnBuyerPreferences } from "../src/lib/customerBuyerPreferences.js";

describe("deriveOwnBuyerPreferences", () => {
  it("maps only clear buyer-stated type, room count and explicit TJS budget bounds", () => {
    expect(deriveOwnBuyerPreferences([
      "Ищу квартиру, 2 комнаты.",
      "Мой бюджет — до 500 000 TJS.",
    ])).toEqual({ desiredType: "APARTMENT", desiredRooms: 2, budgetMax: 500_000 });
  });

  it("maps a literal Tajik somoni amount with an explicit upper-bound marker", () => {
    expect(deriveOwnBuyerPreferences(["Ищу дом, 3 ҳуҷра, мой бюджет то 600000 сомонӣ."]))
      .toEqual({ desiredType: "HOUSE", desiredRooms: 3, budgetMax: 600_000 });
  });

  it("keeps a budget when the same wish separately states total area", () => {
    expect(deriveOwnBuyerPreferences(["Ищу квартиру, 2 комнаты, 60 м2. Мой бюджет до 600000 сомони."]))
      .toEqual({ desiredType: "APARTMENT", desiredRooms: 2, budgetMax: 600_000 });
  });

  it("recognizes a directly requested numbered apartment", () => {
    expect(deriveOwnBuyerPreferences(["Ищу 3-комнатную квартиру."]))
      .toEqual({ desiredType: "APARTMENT", desiredRooms: 3 });
  });

  it("omits USD, per-square-meter, range, and bare-amount budgets", () => {
    for (const text of [
      "Ищу квартиру, бюджет до 50000 USD",
      "Ищу квартиру до 500000 TJS за м²",
      "Ищу квартиру от 300000 до 500000 TJS",
      "Ищу квартиру, мой бюджет 500000 TJS",
    ]) {
      expect(deriveOwnBuyerPreferences([text])).not.toHaveProperty("budgetMin");
      expect(deriveOwnBuyerPreferences([text])).not.toHaveProperty("budgetMax");
    }
  });

  it("does not infer preferences from quoted listings, documents, CRM notes, or negated text", () => {
    for (const text of [
      'Мне прислали объявление: "квартира 3 комнаты до 500000 TJS"',
      "В объявлении квартира 3 комнаты, до 500000 TJS",
      "<document>квартира 3 комнаты до 500000 TJS</document>",
      "<crm_note>Ищет квартиру 3 комнаты до 500000 TJS</crm_note>",
      "Не нужна квартира с 3 комнатами и бюджетом до 500000 TJS",
    ]) {
      expect(deriveOwnBuyerPreferences([text])).toEqual({});
    }
  });

  it("omits conflicting values across the authenticated customer history", () => {
    expect(deriveOwnBuyerPreferences([
      "Ищу квартиру на 2 комнаты, мой бюджет до 500000 TJS.",
      "Нужен дом, 3 комнаты, мой бюджет до 700000 TJS.",
    ])).toEqual({});
  });

  it("does not treat district names or staff fields as buyer preference values", () => {
    expect(deriveOwnBuyerPreferences(["Ищу квартиру в Сино, 2 комнаты, мой бюджет до 400000 TJS."]))
      .toEqual({ desiredType: "APARTMENT", desiredRooms: 2, budgetMax: 400_000 });
  });

  it("ignores listing questions and buyer statements that negate or correct a criterion", () => {
    expect(deriveOwnBuyerPreferences(["Сколько стоит эта квартира с 3 комнатами за 500000 TJS?"]))
      .toEqual({});
    expect(deriveOwnBuyerPreferences(["Хочу купить эту квартиру с 3 комнатами за 500000 TJS."]))
      .toEqual({});
    expect(deriveOwnBuyerPreferences(["Ищу квартиру, но не 3 комнаты, бюджет до 500000 TJS."]))
      .toEqual({});
    expect(deriveOwnBuyerPreferences(["Ищу 2 комнаты, поправка: лучше 3 комнаты."]))
      .toEqual({});
    expect(deriveOwnBuyerPreferences(["Ищу квартиру, есть 3 комнаты?"]))
      .toEqual({ desiredType: "APARTMENT" });
  });

  it("invalidates an earlier criterion when the customer later corrects it, and accepts a later clear wish", () => {
    const prior = "Ищу 2-комнатную квартиру, мой бюджет до 500000 TJS.";
    expect(deriveOwnBuyerPreferences([prior, "Передумал, не 2 комнаты."]))
      .toEqual({ desiredType: "APARTMENT", budgetMax: 500_000 });
    expect(deriveOwnBuyerPreferences([prior, "Передумал, не 2 комнаты.", "Теперь ищу квартиру на 3 комнаты."]))
      .toEqual({ desiredType: "APARTMENT", desiredRooms: 3, budgetMax: 500_000 });
  });

  it("does not let a quoted or third-party correction invalidate the customer's own earlier wish", () => {
    const prior = "Ищу 2-комнатную квартиру, мой бюджет до 500000 TJS.";
    expect(deriveOwnBuyerPreferences([prior, "Мой брат передумал, не 2 комнаты."]))
      .toEqual({ desiredType: "APARTMENT", desiredRooms: 2, budgetMax: 500_000 });
    expect(deriveOwnBuyerPreferences([prior, 'В объявлении «дом, 5 комнат, до 900000 TJS»']))
      .toEqual({ desiredType: "APARTMENT", desiredRooms: 2, budgetMax: 500_000 });
  });
});

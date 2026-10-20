import { describe, expect, it } from "vitest";
import { customerPublicModerationPlan } from "../src/lib/customerPublicModerationPolicy.js";

describe("existing spam rules in the managed public channel", () => {
  it.each([
    "Продаю квартиру 2 комнаты, 65 м2, цена 650000 сомони, +992987654321",
    "Хона дорем 58 квадрат 15 этаж нарх 580 хазор сомон номер 987654321",
  ])("keeps seller conversion separate from removal: %s", text => {
    expect(customerPublicModerationPlan(text)).toEqual({ category: "seller_ad", steps: ["hide", "private_reply", "delete"] });
  });
  it.each([
    "Хочу продать квартиру, какие у вас условия? Мой номер +992987654321",
    "Помогите продать мою квартиру, 65 м2, цена 650000 сомони, +992987654321",
    "Хочу продать через вас квартиру 65 м2, цена 650000 сомони, +992987654321",
    "Нужна двушка до 500 тысяч, позвоните мне +992987654321",
    "Нужен номер телефона Royal Home", "Мне никто не позвонил", "Плохое агентство, долго отвечаете",
    "🔥🔥👏", "Раҳмат", "Можно подробнее?", "Мне не нравится цена",
  ])("never removes a buyer, direct request, criticism or praise: %s", text => {
    expect(customerPublicModerationPlan(text)).toBeNull();
  });
  it("does not pitch a sale to a landlord advertising unsupported rental service", () => {
    expect(customerPublicModerationPlan("Сдаю квартиру 2 комнаты, 65 м2, цена 3000 сомони, +992987654321"))
      .toEqual({ category: "spam", steps: ["hide"] });
  });
});

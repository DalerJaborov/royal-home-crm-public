import { describe, expect, it } from "vitest";
import { scoreClientProperty } from "../src/routes/matching.js";

/**
 * «РАЙОН СОВПАЛ» ТОЛЬКО ПРИ НАЗВАННОМ РАЙОНЕ (находка О11 проверки 02.10.2026).
 *
 * Бонус района начислялся по `client.desiredDistrictId === property.districtId` —
 * и при null у обоих (клиент район не называл, закрытый объект без района)
 * давал «район совпал» и лишние баллы: такой объект поднимался в подборе выше
 * объектов в районе, который клиент действительно назвал.
 */
const money = { usdToTjs: 11 };

describe("scoreClientProperty: район", () => {
  it("клиент без района и объект без района — бонуса района нет", () => {
    const { reasons } = scoreClientProperty(
      { desiredDistrictId: null, desiredRooms: null, budgetMin: null, budgetMax: null, currency: "TJS", desiredType: null },
      { id: "p", price: 400000, currency: "TJS", districtId: null, rooms: 2 },
      money
    );
    expect(reasons).not.toContain("район совпал");
  });

  it("названный район совпал — бонус есть", () => {
    const { reasons } = scoreClientProperty(
      { desiredDistrictId: "d1", desiredRooms: null, budgetMin: null, budgetMax: null, currency: "TJS", desiredType: null },
      { id: "p", price: 400000, currency: "TJS", districtId: "d1", rooms: 2 },
      money
    );
    expect(reasons).toContain("район совпал");
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_MATCH_POLICY } from "../src/lib/matchPolicy.js";
import { clientTextWishes, compareClientProperties, currentBuyerMatchingCriteria, evaluateClientProperty, hasClientMatchingCriteria,
  type MatchingBuyerCriteria, type MatchingPropertyFacts } from "../src/lib/clientPropertyMatching.js";

const money = { usdToTjs: 10 };
const buyer: MatchingBuyerCriteria = {
  currency: "TJS", budgetMin: null, budgetMax: 600000, desiredDistrictId: "test-district",
  desiredType: "APARTMENT", desiredRooms: 3, desiredPlaces: [], requirementsNotes: null,
};
const property: MatchingPropertyFacts = {
  id: "test-property", shortId: 1, type: "APARTMENT", districtId: "test-district", price: 550000,
  currency: "TJS", rooms: 3, areaSqm: 70, floor: 2, totalFloors: 5, lat: null, lng: null,
  condition: "GOOD", marketType: "SECONDARY", amenities: [], details: {}, description: null,
  intakeAgentId: "test-other-agent",
};
const compare = (criteria: Partial<MatchingBuyerCriteria> = {}, facts: Partial<MatchingPropertyFacts> = {}) =>
  evaluateClientProperty({ ...buyer, ...criteria }, { ...property, ...facts }, money, DEFAULT_MATCH_POLICY, "test-agent");

describe("client property recommendations: factual evidence", () => {
  it("shows the difference between a real match and a budget/room compromise", () => {
    const exact = compare()!;
    const alternative = compare({}, { price: 630000, rooms: 2 })!;
    expect(exact.match.tier).toBe("exact");
    expect(exact.match.reasons).toContain("В бюджете");
    expect(alternative.match.tier).toBe("alternative");
    expect(alternative.match.tradeoffs).toContain("2 комнаты вместо 3");
    expect(alternative.match.tradeoffs.some(value => value.includes("30"))).toBe(true);
    expect(compare({}, { price: 700000 })).toBeNull();
  });
  it("converts currencies before checking the budget", () => {
    expect(compare({}, { price: 55000, currency: "USD" })?.match.reasons).toContain("В бюджете");
    expect(compare({}, { price: 70000, currency: "USD" })).toBeNull();
  });
  it("checks the actual circle when only an orientation is requested", () => {
    const criteria = { desiredDistrictId: null, desiredPlaces: [{ lat: 0, lng: 0, radiusM: 1000 }] };
    // Inside a +/- 1km bbox but outside the 1km circle.
    expect(compare(criteria, { lat: 0.008, lng: 0.008 })).toBeNull();
    expect(compare(criteria, { lat: 0.004, lng: 0.004 })?.distanceM).toBeLessThan(1000);
    expect(compare(criteria, { lat: null, lng: null })).toBeNull();
  });
  it("retains a named district match when the property has no coordinates, honestly", () => {
    const result = compare({ desiredPlaces: [{ lat: 38, lng: 68, radiusM: 1000 }] })!;
    expect(result.match.reasons).toContain("Нужный район");
    expect(result.match.unknowns).toContain("Расстояние до ориентира не проверено");
  });
  it("never promotes an inferior own property ahead of a better foreign property", () => {
    const own = compare({}, { id: "own", rooms: 2, intakeAgentId: "test-agent" })!;
    const other = compare({}, { id: "other" })!;
    expect([own, other].sort(compareClientProperties).map(item => item.id)).toEqual(["other", "own"]);
    expect(compareClientProperties(compare({}, { intakeAgentId: "test-agent" })!, other)).toBeLessThan(0);
  });
  it("negation in buyer notes and property description is not a positive amenity", () => {
    expect(clientTextWishes("Без мебели, без ремонта")).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "furniture", wanted: false }), expect.objectContaining({ key: "renovated", wanted: false }),
    ]));
    const bad = compare({ requirementsNotes: "С мебелью, нужен лифт" }, { details: { furniture: "Без мебели" }, description: "Лифта нет" })!;
    expect(bad.match.tradeoffs).toEqual(expect.arrayContaining(["Мебель: не соответствует пожеланию", "Лифт: не соответствует пожеланию"]));
    expect(bad.match.reasons.some(reason => reason === "Лифт: есть")).toBe(false);
    const good = compare({ requirementsNotes: "Без мебели, без ремонта" }, { condition: "NEEDS_REPAIR", details: { furniture: "Без мебели" } })!;
    expect(good.match.tradeoffs).toHaveLength(0);
  });
  it("an unrecorded amenity is unknown, not a match", () => {
    const result = compare({ requirementsNotes: "Нужен лифт" })!;
    expect(result.match.unknowns).toContain("Лифт: нужно уточнить");
    expect(result.match.tier).toBe("needs_verification");
  });
  it("does not turn an optional or unimportant feature into a presence or absence requirement", () => {
    for (const notes of ["Лифт не нужен", "Не нужен лифт", "Ремонт не важен", "Не нужен ремонт"]) {
      expect(clientTextWishes(notes), notes).toEqual([]);
      expect(compare({ requirementsNotes: notes })!.match.tradeoffs, notes).toEqual([]);
    }
    expect(clientTextWishes("Ремонт не важен, нужен лифт")).toEqual([
      expect.objectContaining({ key: "lift", wanted: true }),
    ]);
    expect(clientTextWishes("Без ремонта, без лифта")).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "renovated", wanted: false }), expect.objectContaining({ key: "lift", wanted: false }),
    ]));
  });
  it("distinguishes explicit absence from unknown amenity details", () => {
    const missing = compare({ requirementsNotes: "Нужен лифт" }, { details: { elevator: "нет лифта" } })!;
    expect(missing.match.tradeoffs).toContain("Лифт: не соответствует пожеланию");
    for (const value of ["неизвестно", "не указано"]) {
      const unknown = compare({ requirementsNotes: "Нужен лифт" }, { details: { elevator: value } })!;
      expect(unknown.match.unknowns).toContain("Лифт: нужно уточнить");
      expect(unknown.match.tradeoffs).not.toContain("Лифт: не соответствует пожеланию");
      expect(unknown.match.reasons).not.toContain("Лифт: есть");
    }
  });
  it("recognises zero as an explicitly set floor boundary rather than an empty request", () => {
    const empty = { ...buyer, budgetMax: null, desiredDistrictId: null, desiredType: null, desiredRooms: null };
    expect(hasClientMatchingCriteria(empty)).toBe(false);
    expect(hasClientMatchingCriteria({ ...empty, desiredFloorMin: 0 })).toBe(true);
    expect(hasClientMatchingCriteria({ ...empty, desiredFloorMax: 0 })).toBe(true);
    expect(compare({ ...empty, desiredFloorMax: 0 }, { floor: 2 })).toBeNull();
  });
  it("honours not-first and not-last notes, and does not guess missing floors", () => {
    expect(compare({ requirementsNotes: "Не первый и не последний этаж" }, { floor: 1 })).toBeNull();
    expect(compare({ requirementsNotes: "Не последний этаж" }, { floor: 5 })).toBeNull();
    expect(compare({ requirementsNotes: "Не последний этаж" }, { totalFloors: null })?.match.unknowns).toContain("Неизвестно, последний ли этаж");
  });
  it("does not suggest a different property type, or treat an empty request as confirmed fit", () => {
    expect(compare({}, { type: "LAND" })).toBeNull();
    const result = compare({ budgetMax: null, desiredType: null, desiredRooms: null, desiredDistrictId: null })!;
    expect(result.match.tier).toBe("needs_verification");
    expect(result.match.reasons).toEqual([]);
  });
  it("does not mistake the old seller's expected price for a buyer's budget", () => {
    const normalized = currentBuyerMatchingCriteria({ ...buyer, requirementsFieldsKind: "SELLER", budgetMax: 100,
      desiredAreaMin: 200, desiredFloorMin: 12, desiredPlaces: [{ lat: 0, lng: 0, radiusM: 10 }], requirementsNotes: "старое описание продавца" });
    expect(normalized).toMatchObject({ budgetMax: null, desiredAreaMin: null, desiredFloorMin: null, desiredPlaces: [], requirementsNotes: null });
    const result = evaluateClientProperty(normalized, property, money, DEFAULT_MATCH_POLICY, "test-agent")!;
    expect(result.match.reasons).toEqual([]);
    expect(result.match.tier).toBe("needs_verification");
    expect(currentBuyerMatchingCriteria({ ...buyer, requirementsFieldsKind: null }).budgetMax).toBe(600000);
  });
});

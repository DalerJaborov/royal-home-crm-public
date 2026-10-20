import { describe, expect, it } from "vitest";
import { buildCreateBody, EMPTY_WIZARD_VALUES, validateStep, valuesForTypeChange, type WizardValues } from "../types";

/** Владелец 08.10.2026: у дома нет «этажа» и «новостройки/вторички»; смена типа
 *  чистит лишнее, и оно не уходит на сервер. */
const filled: WizardValues = {
  ...EMPTY_WIZARD_VALUES,
  type: "APARTMENT",
  rooms: "3",
  areaSqm: "90",
  floor: "5",
  totalFloors: "9",
  windowCount: "4",
  price: "500000",
  marketType: "NEW_BUILD",
  stage: "SHELL",
  condition: "NEW_BUILDING",
  sellerName: "Али",
  sellerPhone: "+992 93 700 0001",
  details: { ...EMPTY_WIZARD_VALUES.details, elevator: "1 лифт", heating: "Автономное" },
};

describe("мастер: поля по типу объекта", () => {
  it("квартира → дом: этаж, «новостройка» и лифт очищаются", () => {
    const next = { ...filled, ...valuesForTypeChange(filled, "HOUSE") };
    expect(next.floor).toBe("");
    expect(next.marketType).toBe("");
    expect(next.stage).toBe("");
    expect(next.condition).toBe("GOOD");
    expect(next.totalFloors).toBe("9");
    expect(next.details.elevator).not.toBe("1 лифт");
    expect(next.details.heating).toBe("Автономное");
  });

  it("дом не требует этажа, а в теле запроса нет ни этажа, ни «новостройки»", () => {
    const house: WizardValues = { ...filled, type: "HOUSE" };
    expect(validateStep("main", { ...house, floor: "" }).floor).toBeUndefined();
    const body = buildCreateBody(house);
    expect(body.floor).toBeUndefined();
    expect(body.marketType).toBeUndefined();
    expect(body.stage).toBeUndefined();
    expect(body.totalFloors).toBe(9);
    expect(body.details).toEqual({ heating: "Автономное" });
  });

  it("коммерция без комнат проходит шаг", () => {
    expect(validateStep("main", { ...filled, type: "COMMERCIAL", rooms: "" }).rooms).toBeUndefined();
  });

  it("квартира по-прежнему требует этаж", () => {
    expect(validateStep("main", { ...filled, floor: "" }).floor).toBe("Укажите этаж");
  });

  it("участок: в запросе нет комнат, этажей, окон и характеристик", () => {
    const land = { ...filled, ...valuesForTypeChange(filled, "LAND"), landAreaSotka: "6" };
    const body = buildCreateBody(land);
    expect(body.rooms).toBeUndefined();
    expect(body.floor).toBeUndefined();
    expect(body.windowCount).toBeUndefined();
    expect(body.details).toBeUndefined();
    expect(body.areaSqm).toBe(600);
  });
});

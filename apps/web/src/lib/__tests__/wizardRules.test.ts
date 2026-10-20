import { describe, expect, it } from "vitest";
import { fieldsForNewBuildPhase, newBuildPhaseOf, propertyFinishSummary } from "@royal-home/shared";
import { buildCreateBody, EMPTY_WIZARD_VALUES, validateStep, type WizardValues } from "../../components/property-wizard/types";

/**
 * Правила мастера добавления объекта (23.09.2026, аудит к стабильной версии):
 * этаж не выше этажности, сотки у участка, пустые поля закрытого объекта не
 * уходят нулями, новостройка раскладывается одной фазой.
 */
const base: WizardValues = {
  ...EMPTY_WIZARD_VALUES,
  type: "APARTMENT",
  price: "500000",
  areaSqm: "60",
  rooms: "2",
  floor: "3",
  totalFloors: "9",
  windowCount: "4",
};

describe("мастер объекта", () => {
  it("этаж выше этажности — ошибка на поле «Этаж»", () => {
    expect(validateStep("main", { ...base, floor: "5", totalFloors: "2" }).floor).toMatch(/выше этажности/);
    expect(validateStep("main", { ...base, floor: "2", totalFloors: "2" }).floor).toBeUndefined();
  });

  it("участок: площадь в сотках, в м² уходит ×100", () => {
    const land = { ...base, type: "LAND" as const, areaSqm: "", landAreaSotka: "6" };
    expect(validateStep("main", land).areaSqm).toBeUndefined();
    expect(buildCreateBody(land).areaSqm).toBe(600);
    expect(validateStep("main", { ...land, landAreaSotka: "" }).landAreaSotka).toBeTruthy();
  });

  it("закрытый объект без комнат и этажей не шлёт нули", () => {
    const body = buildCreateBody({ ...base, offSite: true, rooms: "", floor: "", totalFloors: "", windowCount: "" });
    expect(body).not.toHaveProperty("rooms");
    expect(body).not.toHaveProperty("floor");
    expect(body).not.toHaveProperty("windowCount");
  });

  it("новостройка: фаза раскладывается в поля и читается обратно", () => {
    const f = fieldsForNewBuildPhase("ROUGH_FINISH");
    expect(f).toEqual({ marketType: "NEW_BUILD", stage: "ROUGH_FINISH", condition: "NEW_BUILDING" });
    expect(newBuildPhaseOf(f)).toBe("ROUGH_FINISH");
    expect(propertyFinishSummary(f)).toBe("Новостройка, черновые работы сделаны");
    expect(newBuildPhaseOf(fieldsForNewBuildPhase("FOUNDATION_PIT"))).toBe("FOUNDATION_PIT");
    expect(propertyFinishSummary({ marketType: "SECONDARY", condition: "GOOD" })).toBe("Вторичка, хорошее состояние");
  });
});

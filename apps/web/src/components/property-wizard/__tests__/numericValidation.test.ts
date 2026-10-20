import { describe, expect, it } from "vitest";
import { EMPTY_WIZARD_VALUES, validateStep, type WizardValues } from "../types";

const valid: WizardValues = { ...EMPTY_WIZARD_VALUES, rooms: "2", areaSqm: "72.5", price: "820000", floor: "3", totalFloors: "9", windowCount: "4" };

describe("wizard numeric inputs agree with the create schema", () => {
  it.each(["rooms", "floor", "totalFloors", "windowCount"] as const)("rejects a fractional %s before submission", (field) => {
    expect(validateStep("main", { ...valid, [field]: "1.5" })[field]).toBeTruthy();
  });

  it("validates optional integers when they are provided for a private object", () => {
    expect(validateStep("main", { ...valid, offSite: true, rooms: "1.5" }).rooms).toBeTruthy();
    expect(validateStep("main", { ...valid, type: "COMMERCIAL", rooms: "1.5" }).rooms).toBeTruthy();
  });

  it("accepts fractional area, a negative floor, and zero windows", () => {
    expect(validateStep("main", { ...valid, floor: "-1", windowCount: "0" })).toEqual({});
  });
});

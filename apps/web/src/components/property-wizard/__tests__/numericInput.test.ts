import { describe, expect, it } from "vitest";
import { normalizeWizardNumber } from "../numericInput";

describe("wizard numeric entry", () => {
  it("keeps decimal area and negative floors", () => {
    expect(normalizeWizardNumber("72,5", "decimal")).toBe("72.5");
    expect(normalizeWizardNumber("-1", "signedInteger")).toBe("-1");
    expect(normalizeWizardNumber("−2", "signedInteger")).toBe("-2");
  });
  it("preserves an invalid fractional count for validation instead of changing its magnitude", () => {
    expect(normalizeWizardNumber("1.5", "integer")).toBe("1.5");
  });
  it("accepts grouped prices without losing thousands", () => {
    expect(normalizeWizardNumber("820 000", "money")).toBe("820000");
    expect(normalizeWizardNumber("250,000", "money")).toBe("250000");
  });
});

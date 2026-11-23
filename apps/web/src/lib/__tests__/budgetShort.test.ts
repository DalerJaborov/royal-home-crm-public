import { describe, expect, it } from "vitest";
import { budgetShort } from "../budgetShort";

const plain = (s: string | null) => (s ?? "").replace(/⁠/g, "").replace(/[  ]/g, " ");

describe("бюджет клиента во второй строке", () => {
  it("края в одной единице — общая единица: «55–70 тыс.»", () => {
    expect(plain(budgetShort({ budgetMin: 55_000, budgetMax: 70_000, currency: "USD" }))).toBe("$55–70 тыс.");
    expect(plain(budgetShort({ budgetMin: 1_100_000, budgetMax: 1_300_000, currency: "TJS" }))).toBe("1,1–1,3 млн с.");
  });
  it("края в разных единицах — у каждого своя: не «0,3–100 млн» (К10.5)", () => {
    const t = plain(budgetShort({ budgetMin: 300_000, budgetMax: 99_999_999, currency: "TJS" }));
    expect(t).toBe("300 тыс. – 100 млн с.");
    expect(t).not.toContain("0,3");
  });
  it("до / от / пусто", () => {
    expect(plain(budgetShort({ budgetMax: 45_000, currency: "USD" }))).toBe("до $45 тыс.");
    expect(plain(budgetShort({ budgetMin: 1_200_000, currency: "TJS" }))).toBe("от 1,2 млн с.");
    expect(budgetShort({})).toBeNull();
  });
});

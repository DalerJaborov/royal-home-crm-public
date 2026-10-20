import { describe, expect, it } from "vitest";
import { sumCommissionTjs } from "../format";

/** Пульт «Ждут подписи»: доллары и сомони не складываются один к одному (23.09.2026, №19). */
describe("sumCommissionTjs", () => {
  it("доллары приводятся по курсу, сомони — как есть", () => {
    expect(
      sumCommissionTjs(
        [
          { commissionAmount: 100, currency: "USD" },
          { commissionAmount: 500, currency: "TJS" },
        ],
        10
      )
    ).toBe(1500);
  });

  it("без суммы и без валюты — ноль и сомони", () => {
    expect(sumCommissionTjs([{ commissionAmount: null }, { commissionAmount: 200 }], 10)).toBe(200);
  });
});

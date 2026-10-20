import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dealSubmitCurrencyProps } from "../dealSubmitCurrency";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("валюта окна «На закрытие» (№210)", () => {
  it("берёт валюту сделки, даже если у объекта другая", () => {
    const p = dealSubmitCurrencyProps({ currency: "TJS", property: { price: "100000", currency: "USD" } });
    expect(p.currency).toBe("TJS");
    // Цена объявления — в долларах, под подписью «сомони» её не показываем.
    expect(p.listedPrice).toBe("0");
  });
  it("валюты совпали — подсказка с ценой объявления остаётся", () => {
    expect(dealSubmitCurrencyProps({ currency: "USD", property: { price: "50000", currency: "USD" } })).toEqual({
      currency: "USD",
      listedPrice: "50000",
    });
  });
  it("у сделки валюты нет (старая запись) — берём валюту объекта", () => {
    expect(dealSubmitCurrencyProps({ currency: null, property: { price: "70000", currency: "TJS" } }).currency).toBe("TJS");
  });
  for (const file of ["../../pages/Deals.tsx", "../../components/mobile/MobileDeals.tsx"]) {
    it(`${file}: окно закрытия не берёт валюту из объекта напрямую`, () => {
      const src = read(file);
      expect(src).toMatch(/dealSubmitCurrencyProps\(deal\)/);
      expect(src).not.toMatch(/<DealSubmitModal[^>]*currency=\{deal\.property\.currency\}/s);
    });
  }
});

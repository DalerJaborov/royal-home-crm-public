import { describe, expect, it } from "vitest";
import { EMPTY_WIZARD_VALUES, fillEmptyFromDraftValues } from "../types";

/** FORMS01: цена продавца и её валюта переносятся парой (04.10.2026). */
describe("fillEmptyFromDraftValues: цена и валюта", () => {
  it("пустая цена берётся вместе с валютой продавца", () => {
    const r = fillEmptyFromDraftValues(EMPTY_WIZARD_VALUES, { price: "100000", currency: "USD" });
    expect(r.price).toBe("100000");
    expect(r.currency).toBe("USD");
  });

  it("введённая цена не трогается, валюта тоже", () => {
    const cur = { ...EMPTY_WIZARD_VALUES, price: "500000", currency: "TJS" as const };
    const r = fillEmptyFromDraftValues(cur, { price: "100000", currency: "USD" });
    expect(r.price).toBe("500000");
    expect(r.currency).toBe("TJS");
  });

  it("у продавца нет цены: валюта формы остаётся", () => {
    const cur = { ...EMPTY_WIZARD_VALUES, currency: "USD" as const };
    const r = fillEmptyFromDraftValues(cur, { currency: "TJS", rooms: "3" });
    expect(r.currency).toBe("USD");
    expect(r.rooms).toBe("3");
  });

  it("у продавца цена без валюты: валюта формы остаётся", () => {
    const r = fillEmptyFromDraftValues(EMPTY_WIZARD_VALUES, { price: "7" });
    expect(r.price).toBe("7");
    expect(r.currency).toBe("TJS");
  });
});

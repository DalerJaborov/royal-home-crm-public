import { describe, expect, it } from "vitest";
import { parseExpenseAmount } from "../src/lib/expenseAmountParse.js";

/** Один разборщик сумм расходов (ревью 10.11.2026, п. 4–5): таблица, фото, поправка. */
describe("parseExpenseAmount", () => {
  it.each([
    ["2 млн", 2_000_000], ["1,5 тыс", 1_500], ["5 т", 5_000], ["5т", 5_000], ["1E+3", 1_000], ["1.200", 1_200], ["1,200", 1_200],
    ["12.50", 12.5], ["1,5", 1.5], ["1 200 000", 1_200_000], ["1 200,50", 1_200.5], ["1,200.50", 1_200.5],
    ["1.200,50", 1_200.5], ["12.10", 12.1], ["400 сомонӣ", 400], ["5 000 с.", 5_000],
  ])("%s → %d", (text, amount) => {
    expect(parseExpenseAmount(text)).toMatchObject({ ok: true, amount });
  });

  it("доллар узнаётся знаком и словом, сомони — словом", () => {
    expect(parseExpenseAmount("$22")).toEqual({ ok: true, amount: 22, currency: "USD" });
    expect(parseExpenseAmount("22 доллара")).toEqual({ ok: true, amount: 22, currency: "USD" });
    expect(parseExpenseAmount("22 TJS")).toEqual({ ok: true, amount: 22, currency: "TJS" });
    expect(parseExpenseAmount("22")).toEqual({ ok: true, amount: 22 });
  });

  it("бухгалтерские скобки и минус — отказ, а не плюс", () => {
    expect(parseExpenseAmount("(500)")).toMatchObject({ ok: false, reason: "negative" });
    expect(parseExpenseAmount("-200")).toMatchObject({ ok: false, reason: "negative" });
  });

  it("евро, рубли и прочие валюты не превращаются в сомони", () => {
    expect(parseExpenseAmount("€100")).toMatchObject({ ok: false, reason: "unsupported_currency", currency: "€" });
    expect(parseExpenseAmount("100 руб")).toMatchObject({ ok: false, reason: "unsupported_currency", currency: "₽" });
    expect(parseExpenseAmount("100 KZT")).toMatchObject({ ok: false, reason: "unsupported_currency" });
  });

  it("два числа в ячейке и текст без числа — не сумма", () => {
    expect(parseExpenseAmount("5 ноя 400")).toMatchObject({ ok: false });
    expect(parseExpenseAmount("абв")).toMatchObject({ ok: false, reason: "not_number" });
    expect(parseExpenseAmount("")).toMatchObject({ ok: false, reason: "empty" });
  });
});

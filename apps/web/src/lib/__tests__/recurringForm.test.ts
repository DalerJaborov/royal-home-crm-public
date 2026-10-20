import { describe, expect, it } from "vitest";
import { parseRecurringForm } from "../recurringForm";

/** FORMS06: сумма с запятой не подменяется прежней молча (04.10.2026). */
describe("parseRecurringForm", () => {
  it("запятая и пробелы: 1 200,50 это 1200.5", () => {
    expect(parseRecurringForm("1\u00a0200,50", "5")).toEqual({ ok: true, amount: 1200.5, dayOfMonth: 5 });
    expect(parseRecurringForm(" 1 200 ", "5")).toEqual({ ok: true, amount: 1200, dayOfMonth: 5 });
  });

  it("не число или не больше нуля: ошибка у суммы, а не прежняя сумма", () => {
    expect(parseRecurringForm("abc", "5")).toEqual({ ok: false, error: "Введите сумму числом больше нуля" });
    expect(parseRecurringForm("0", "5")).toEqual({ ok: false, error: "Введите сумму числом больше нуля" });
    expect(parseRecurringForm("", "5")).toEqual({ ok: false, error: "Введите сумму числом больше нуля" });
  });

  it("число месяца: целое от 1 до 28, иначе ошибка", () => {
    expect(parseRecurringForm("10", "28")).toEqual({ ok: true, amount: 10, dayOfMonth: 28 });
    expect(parseRecurringForm("10", "29")).toEqual({ ok: false, error: "Число месяца: от 1 до 28" });
    expect(parseRecurringForm("10", "0")).toEqual({ ok: false, error: "Число месяца: от 1 до 28" });
    expect(parseRecurringForm("10", "x")).toEqual({ ok: false, error: "Число месяца: от 1 до 28" });
    expect(parseRecurringForm("10", "2.5")).toEqual({ ok: false, error: "Число месяца: от 1 до 28" });
  });
});

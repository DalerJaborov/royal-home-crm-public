import { describe, expect, it } from "vitest";
import { expenseRowsFromTable } from "../src/lib/expenseTableRows.js";
import { readXlsxFirstSheet, XlsxReadError } from "../src/lib/xlsxRead.js";
import { decodeCsvBytes, rowsFromSpreadsheet } from "../src/telegram/assistantExpenseBatchIntake.js";
import { xlsxFixture } from "./helpers/xlsxFixture.js";

/** Таблица расходов без ИИ: ревью 10.11.2026, пункты 3, 4, 5, 11, 12, формулы, даты, zip-бомба. */
describe("таблица расходов — деньги и даты не путаются", () => {
  it("п.3: Excel без заголовка — серийная дата справа от суммы не становится суммой", () => {
    const parsed = expenseRowsFromTable([["Бензин", "122", "45962"], ["Интернет", "400"]]);
    expect(parsed.rows.map((r) => [r.title, r.amount])).toEqual([["Интернет", 400]]);
    expect(parsed.skipped).toEqual([{ line: 1, reason: "ambiguous" }]);
  });

  it("п.3: ячейка с форматом даты Excel читается датой, а не числом", () => {
    const file = xlsxFixture([["Название", "Сумма", "Дата"], ["Аренда", 5000, { v: 45962, s: 1 }]], { xfs: [0, 14] });
    expect(readXlsxFirstSheet(file)[1]).toEqual(["Аренда", "5000", "2025-11-01"]);
    const rows = rowsFromSpreadsheet("xlsx", file)!.rows;
    expect(rows[0]).toMatchObject({ title: "Аренда", amount: 5000, date: "2025-11-01" });
  });

  it("формула Excel — берётся сохранённое значение", () => {
    const file = xlsxFixture([["Название", "Сумма"], ["Бензин", { f: "61*2", v: 122 }]]);
    expect(rowsFromSpreadsheet("xlsx", file)!.rows[0]).toMatchObject({ title: "Бензин", amount: 122 });
  });

  it("п.4: «2 млн», «1,5 тыс», «1E+3» — числом; скобки и минус — строка не пишется", () => {
    const parsed = expenseRowsFromTable([["Название", "Сумма"], ["Ремонт", "2 млн"], ["Канцтовары", "1,5 тыс"], ["Вода", "1E+3"], ["Возврат", "(500)"], ["Скидка", "-200"]]);
    expect(parsed.rows.map((r) => r.amount)).toEqual([2_000_000, 1_500, 1_000]);
    expect(parsed.skipped).toEqual([{ line: 5, reason: "negative" }, { line: 6, reason: "negative" }]);
  });

  it("п.5: «Сумма, $» — доллары; € и руб — не записываются и не становятся сомони", () => {
    const parsed = expenseRowsFromTable([["Название", "Сумма, $"], ["Хостинг", "22"], ["Домен", "€100"], ["Перевод", "100 руб"]]);
    expect(parsed.rows).toEqual([expect.objectContaining({ title: "Хостинг", amount: 22, currency: "USD" })]);
    expect(parsed.skipped).toEqual([
      { line: 3, reason: "unsupported_currency", currency: "€" },
      { line: 4, reason: "unsupported_currency", currency: "₽" },
    ]);
    const euroColumn = expenseRowsFromTable([["Название", "Сумма", "Валюта"], ["Билет", "300", "EUR"]]);
    expect(euroColumn.rows).toEqual([]);
    expect(euroColumn.skipped[0]).toMatchObject({ reason: "unsupported_currency" });
  });

  it("п.5: формат ячейки Excel «$» — доллары, «€» — не записывается", () => {
    const file = xlsxFixture([["Название", "Сумма"], ["Хостинг", { v: 22, s: 1 }], ["Билет", { v: 300, s: 2 }]],
      { xfs: [0, 164, 165], numFmts: { 164: "[$$-409]#,##0.00", 165: "#,##0.00 [$€-1]" } });
    const parsed = rowsFromSpreadsheet("xlsx", file)!;
    expect(parsed.rows).toEqual([expect.objectContaining({ title: "Хостинг", amount: 22, currency: "USD" })]);
    expect(parsed.skipped).toEqual([{ line: 3, reason: "unsupported_currency", currency: "€" }]);
  });

  it("валюта не названа нигде — строка помечена, а не тихо сомони", () => {
    expect(expenseRowsFromTable([["Название", "Сумма"], ["Свет", "180"]]).rows[0]).toMatchObject({ currencyUnstated: true });
  });

  it("п.11: id листа с символами регулярки не ломает чтение (без ReDoS)", () => {
    const file = xlsxFixture([["Название", "Сумма"], ["Свет", 180]], { relId: "rId1.*(a+)+$" });
    const started = Date.now();
    expect(readXlsxFirstSheet(file)).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("zip-бомба: заявленный размер листа больше предела — отказ, а не распаковка", () => {
    const file = xlsxFixture([["Название", "Сумма"], ["Свет", 180]], { declaredSize: 40 * 1024 * 1024 });
    expect(() => readXlsxFirstSheet(file)).toThrow(XlsxReadError);
    expect(rowsFromSpreadsheet("xlsx", file)).toBeNull();
  });

  it("п.12: CSV в cp1251 читается кириллицей", () => {
    // «Название;Сумма\nАренда;5000» в windows-1251.
    const cp1251 = Buffer.from([0xcd, 0xe0, 0xe7, 0xe2, 0xe0, 0xed, 0xe8, 0xe5, 0x3b, 0xd1, 0xf3, 0xec, 0xec, 0xe0, 0x0a,
      0xc0, 0xf0, 0xe5, 0xed, 0xe4, 0xe0, 0x3b, 0x35, 0x30, 0x30, 0x30, 0x0a]);
    expect(decodeCsvBytes(cp1251)).toBe("Название;Сумма\nАренда;5000\n");
    expect(rowsFromSpreadsheet("csv", cp1251)!.rows[0]).toMatchObject({ title: "Аренда", amount: 5000 });
    expect(decodeCsvBytes(Buffer.from("﻿Название;Сумма", "utf8"))).toBe("Название;Сумма");
  });
});

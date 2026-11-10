import { describe, expect, it } from "vitest";
import { readXlsFirstSheet, XlsReadError } from "../src/lib/xlsRead.js";
import { rowsFromSpreadsheet } from "../src/telegram/assistantExpenseBatchIntake.js";
import { xlsFixture } from "./helpers/xlsFixture.js";

/** Старый Excel .xls (BIFF8) без библиотеки: строки, числа, даты, валюта, формулы и пределы. */
describe("чтение .xls", () => {
  it("строки (SST), числа, RK, формула со строковым результатом", () => {
    const file = xlsFixture([["Название", "Сумма"], ["Аренда офиса", 5000], ["Интернет", { rk: 400 }], [{ formula: "Бензин" }, 122.5]]);
    expect(readXlsFirstSheet(file)).toEqual([["Название", "Сумма"], ["Аренда офиса", "5000"], ["Интернет", "400"], ["Бензин", "122.5"]]);
  });

  it("дата по формату ячейки и валюта по формату — как у .xlsx", () => {
    const file = xlsFixture([["Название", "Сумма", "Дата"], ["Хостинг", { v: 22, xf: 2 }, { v: 45962, xf: 1 }], ["Билет", { v: 300, xf: 3 }, ""]],
      { xfFormats: [0, 14, 164, 165], formats: { 164: "[$$-409]#,##0.00", 165: "#,##0.00 [$€-1]" } });
    const parsed = rowsFromSpreadsheet("xls", file)!;
    expect(parsed.rows).toEqual([expect.objectContaining({ title: "Хостинг", amount: 22, currency: "USD", date: "2025-11-01" })]);
    expect(parsed.skipped).toEqual([{ line: 3, reason: "unsupported_currency", currency: "€" }]);
  });

  it("строка SST, разрезанная записью CONTINUE посреди символов, читается целиком", () => {
    const file = xlsFixture([["Stationery", 90], ["Канцелярия", 45]], { splitSst: true });
    expect(readXlsFirstSheet(file)).toEqual([["Stationery", "90"], ["Канцелярия", "45"]]);
  });

  it("бомба: заявленный размер потока больше предела — отказ; не CFB — отказ", () => {
    expect(() => readXlsFirstSheet(xlsFixture([["Свет", 180]], { declaredStreamSize: 2_000_000_000 }))).toThrow(XlsReadError);
    expect(() => readXlsFirstSheet(Buffer.alloc(1024))).toThrow(XlsReadError);
    expect(rowsFromSpreadsheet("xls", Buffer.from("not an xls file at all, padded".padEnd(600, "x")))).toBeNull();
  });

  it("цикл в цепочке секторов — отказ, а не бесконечный цикл", () => {
    const file = xlsFixture([["Свет", 180]]);
    // FAT: сектор 2 (начало потока) ссылается сам на себя.
    file.writeUInt32LE(2, 512 + 2 * 4);
    expect(() => readXlsFirstSheet(file)).toThrow(XlsReadError);
  });
});

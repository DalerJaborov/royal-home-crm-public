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

  it("п.1: вредный файл — fatSectors=0xFFFFFFFF и самоссылка DIFAT — отказ без раздувания памяти", () => {
    const file = xlsFixture([["Свет", 180]]);
    file.writeUInt32LE(0xffffffff, 0x2c); // заявлено 4 млрд секторов FAT
    expect(() => readXlsFirstSheet(file)).toThrow(XlsReadError);
    const loop = xlsFixture([["Свет", 180]]);
    loop.writeUInt32LE(110, 0x2c);        // секторов FAT больше, чем помещается в заголовке, — пошли бы по DIFAT…
    loop.writeUInt32LE(1, 0x48);
    loop.writeUInt32LE(0, 0x44);          // …а DIFAT начинается с сектора 0 (это FAT) и ссылается сам на себя
    const heapBefore = process.memoryUsage().heapUsed;
    expect(() => readXlsFirstSheet(loop)).toThrow(XlsReadError);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(200 * 1024 * 1024);
    const repeat = xlsFixture([["Свет", 180]]);
    repeat.writeUInt32LE(2, 0x2c);
    repeat.writeUInt32LE(0, 0x4c + 4);    // тот же сектор FAT дважды
    expect(() => readXlsFirstSheet(repeat)).toThrow(XlsReadError);
  });

  it("пароль (FILEPASS) и Excel 95 (поток Book) — честный отказ своими словами", () => {
    expect(() => readXlsFirstSheet(xlsFixture([["Свет", 180]], { filepass: true }))).toThrow("encrypted");
    expect(rowsFromSpreadsheet("xls", xlsFixture([["Свет", 180]], { filepass: true }))).toEqual({ refused: "encrypted" });
    expect(rowsFromSpreadsheet("xls", xlsFixture([["Свет", 180]], { streamName: "Book" }))).toEqual({ refused: "old_format" });
  });

  it("книга 1904 — даты от 1904 года; формат времени — не дата; короткая запись XF — отказ", () => {
    const file = xlsFixture([["Название", "Сумма", "Дата", "Время"], ["Свет", 180, { v: 44500, xf: 1 }, { v: 45000, xf: 2 }]], { xfFormats: [0, 14, 20], date1904: true });
    expect(readXlsFirstSheet(file)[1]).toEqual(["Свет", "180", "2025-11-01", "45000"]);
    expect(() => readXlsFirstSheet(xlsFixture([["Свет", 180]], { shortXf: true }))).toThrow(XlsReadError);
  });

  it("мини-сектор не 64 байта — отказ (так требует формат)", () => {
    const file = xlsFixture([["Свет", 180]]);
    file.writeUInt16LE(31, 0x20);
    expect(() => readXlsFirstSheet(file)).toThrow("mini size");
  });

  it("записей больше 300 тыс. — отказ; ненужные записи в меньшем числе пропускаются, файл читается", () => {
    expect(() => readXlsFirstSheet(xlsFixture([["Свет", 180]], { junkRecords: 300_001 }))).toThrow("too many records");
    expect(readXlsFirstSheet(xlsFixture([["Свет", 180]], { junkRecords: 200_000 }))).toEqual([["Свет", "180"]]);
  });

  it("цикл в цепочке секторов — отказ, а не бесконечный цикл", () => {
    const file = xlsFixture([["Свет", 180]]);
    // FAT: сектор 2 (начало потока) ссылается сам на себя.
    file.writeUInt32LE(2, 512 + 2 * 4);
    expect(() => readXlsFirstSheet(file)).toThrow(XlsReadError);
  });
});

import { describe, expect, it } from "vitest";
import { csvToRecords, parseCsv } from "../src/lib/csv.js";

describe("CSV delimiter detection uses the first logical record", () => {
  it.each(["\n", "\r\n", "\r"])("ignores quoted semicolons in comma headers with %j rows", (newline) => {
    const header = 'Имя,Телефон,"Дополнительно; важное; заметки; прочее"';
    const parsed = csvToRecords(`${header}${newline}Synthetic,synthetic-phone,ignored${newline}`);
    expect(parsed.headers).toEqual(["имя", "телефон", "дополнительно; важное; заметки; прочее"]);
    expect(parsed.records[0]).toMatchObject({ имя: "Synthetic", телефон: "synthetic-phone" });
  });

  it("ignores quoted commas in a semicolon header", () => {
    expect(parseCsv('Имя;"Заметки, адрес, район, этаж"\nSynthetic;value\n')).toEqual([
      ["Имя", "Заметки, адрес, район, этаж"], ["Synthetic", "value"],
    ]);
  });

  it.each(["\n", "\r\n", "\r"])("reads past %j inside a quoted field before choosing the separator", (newline) => {
    const firstHeader = `Имя, заметка${newline}продолжение`;
    const input = `"${firstHeader}";Телефон;Источник${newline}Synthetic;synthetic-phone;WALK_IN${newline}`;
    expect(parseCsv(input)).toEqual([[firstHeader, "Телефон", "Источник"], ["Synthetic", "synthetic-phone", "WALK_IN"]]);
  });

  it("handles a BOM and escaped quotes while ignoring quoted separators", () => {
    expect(parseCsv('\uFEFFИмя;"Заметки ""цитата, район, адрес"""\r\nSynthetic;"a;b"\r\n')).toEqual([
      ["Имя", 'Заметки "цитата, район, адрес"'], ["Synthetic", "a;b"],
    ]);
  });

  it.each([",", ";"])("keeps ordinary %s files and quoted multiline values", (delimiter) => {
    expect(parseCsv(`one${delimiter}two\n"a\nb"${delimiter}"c""d"\n`)).toEqual([
      ["one", "two"], ["a\nb", 'c"d'],
    ]);
  });
});

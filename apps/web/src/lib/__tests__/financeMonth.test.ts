import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { effectiveMonth } from "../financeMonth";

/** Аудит 04.10.2026, WEB-PAGES12: сокращение диапазона убирало выбранный месяц и переключатель. */
const months = (...keys: string[]) => keys.map((month) => ({ month }));

describe("месяц финансовой сводки после смены диапазона", () => {
  const short = months("2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09");

  it("выбранный месяц есть в диапазоне: остаётся", () => {
    expect(effectiveMonth("2026-07", short)).toBe("2026-07");
  });

  it("выбранный месяц старше диапазона: берём ближайший, первый", () => {
    expect(effectiveMonth("2025-03", short)).toBe("2026-04");
  });

  it("выбранный месяц позже диапазона: берём последний", () => {
    expect(effectiveMonth("2026-12", short)).toBe("2026-09");
  });

  it("сводка ещё не пришла: выбор не трогаем", () => {
    expect(effectiveMonth("2025-03", [])).toBe("2025-03");
  });
});

describe("Finance", () => {
  it("все потребители месяца получают эффективный месяц", () => {
    const src = readFileSync(fileURLToPath(new URL("../../pages/Finance.tsx", import.meta.url)), "utf8");
    expect(src).toContain("effectiveMonth(");
    expect(src).toContain("setSelectedMonth(");
  });
});

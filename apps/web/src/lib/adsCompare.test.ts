import { describe, expect, it } from "vitest";
import { previousAdPeriod } from "./adsCompare";

describe("прошлый период «Рекламы» — отрезок той же длины прямо перед выбранным", () => {
  it.each([
    ["today", "2026-11-20", { from: "2026-11-19", to: "2026-11-19" }],
    ["yesterday", "2026-11-20", { from: "2026-11-18", to: "2026-11-18" }],
    ["7d", "2026-11-20", { from: "2026-11-07", to: "2026-11-13" }],
    ["30d", "2026-11-20", { from: "2026-09-22", to: "2026-10-21" }],
    ["month", "2026-11-20", { from: "2026-10-01", to: "2026-10-20" }],
    // 31 марта: в феврале 28 дней — конец не уходит в март
    ["month", "2026-03-31", { from: "2026-02-01", to: "2026-02-28" }],
    ["month", "2026-01-15", { from: "2025-12-01", to: "2025-12-15" }],
    ["prev_month", "2026-01-15", { from: "2025-11-01", to: "2025-11-30" }],
  ] as const)("%s на %s", (preset, today, expected) => {
    expect(previousAdPeriod(preset, today)).toEqual(expected);
  });
  it("за всё время сравнивать не с чем", () => expect(previousAdPeriod("all", "2026-11-20")).toBeNull());
  it("7 и 30 дней: прошлый отрезок той же длины и не пересекается с текущим", () => {
    const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000 + 1;
    const w7 = previousAdPeriod("7d", "2026-11-20")!;
    expect(days(w7.from, w7.to)).toBe(7);
    const w30 = previousAdPeriod("30d", "2026-11-20")!;
    expect(days(w30.from, w30.to)).toBe(30);
    expect(w30.to < "2026-10-22").toBe(true);
  });
});

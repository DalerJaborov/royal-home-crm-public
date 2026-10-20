import { describe, expect, it } from "vitest";
import { claudeCalendarDays, nextClaudeRecurringDates, shiftClaudeMonth } from "./ClaudeFinancePresentation";
import { claudePivotDrilldown, claudeTableRange } from "./ClaudeExpenseTable";
describe("Claude finance dates and drilldown", () => {
 it("anchors month-end recurrences instead of turning February into March 28", () => {
  expect(nextClaudeRecurringDates({ nextDate: "2026-01-31", startsOn: "2026-01-31", endsOn: null, dayOfMonth: 31, period: "MONTH" }, 3)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
 });
 it("keeps the contractual day after a February-clamped first payment", () => {
  expect(nextClaudeRecurringDates({ nextDate: "2026-02-28", startsOn: "2026-02-28", dayOfMonth: 31, period: "MONTH" }, 3)).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
 });
 it("supports actual weekly, quarterly and yearly dates including leap years", () => {
  const base = { nextDate: "2024-02-29", startsOn: "2024-02-29", endsOn: null, dayOfMonth: 29 };
  expect(nextClaudeRecurringDates({ ...base, period: "WEEK" }, 3)).toEqual(["2024-02-29", "2024-03-07", "2024-03-14"]);
  expect(nextClaudeRecurringDates({ ...base, period: "QUARTER" }, 3)).toEqual(["2024-02-29", "2024-05-29", "2024-08-29"]);
  expect(nextClaudeRecurringDates({ ...base, period: "YEAR" }, 5)).toEqual(["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"]);
 });
 it("stops at end date, skips actual skipped occurrences and invents no missing next date", () => {
  expect(nextClaudeRecurringDates({ nextDate: "2026-10-09", startsOn: "2026-10-09", endsOn: "2026-10-23", dayOfMonth: 9, period: "WEEK", skippedDates: ["2026-10-16"] })).toEqual(["2026-10-09", "2026-10-23"]);
  expect(nextClaudeRecurringDates({ nextDate: null, dayOfMonth: 9 })).toEqual([]);
 });
 it("renders full Monday-first weeks with real outside dates", () => {
  const days = claudeCalendarDays("2026-10");expect(days.length % 7).toBe(0);expect(days[0].key).toBe("2026-09-28");expect(days.filter(d => d.inMonth)).toHaveLength(31);expect(days.at(-1)?.key).toBe("2026-11-01");expect(shiftClaudeMonth("2026-12", 1)).toBe("2027-01");
 });
 it("uses complete quarter/year boundaries and valid February end", () => {
  expect(claudeTableRange("2026-02", "month")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  expect(claudeTableRange("2026-05", "quarter")).toEqual({ from: "2026-04-01", to: "2026-06-30" });
  expect(claudeTableRange("2026-10", "year")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
 });
 it("drills aggregate cells to exact category/month paid records rather than fuzzy title search", () => {
  const row = { categoryId: "9d90f80f-f1c2-4bfc-9a3f-7b8ff7b65a53", title: "Интернет", rootCategory: "OFFICE" as const, color: "#5B7CFA", values: { "2026-10": 200 } };
  expect(claudePivotDrilldown(row, "2026-10")).toEqual({ from: "2026-10-01", to: "2026-10-31", categoryId: row.categoryId, status: "PAID", page: 1 });
  expect(claudePivotDrilldown({ ...row, categoryId: "OFFICE" }, "2026-10")).toHaveProperty("rootCategory", "OFFICE");
 });
});

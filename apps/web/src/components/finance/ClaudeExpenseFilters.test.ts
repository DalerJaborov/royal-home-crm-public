import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claudeExpenseFilterKey, keepExpensePagePlaceholder } from "../../lib/claudeFinanceApi";
import { claudeExpenseEmptyKind } from "./ClaudeExpenseFeed";

describe("expense page placeholder", () => {
  const rows = { items: [1], total: 1 };
  it("drops old rows when a filter changes even if month is absent (expense table)", () => {
    expect(keepExpensePagePlaceholder(rows, { from: "2026-10-01", to: "2026-10-31" }, { from: "2026-09-01", to: "2026-09-30" })).toBeUndefined();
    expect(keepExpensePagePlaceholder(rows, { categoryId: "a" }, { categoryId: "b" })).toBeUndefined();
    expect(keepExpensePagePlaceholder(rows, { q: "a" }, { q: "ab" })).toBeUndefined();
  });
  it("keeps old rows while only paging and ignores key order / empty values", () => {
    expect(keepExpensePagePlaceholder(rows, { month: "2026-10", page: 1 }, { page: 2, month: "2026-10", q: "" })).toBe(rows);
    expect(claudeExpenseFilterKey({ to: "b", from: "a" })).toBe(claudeExpenseFilterKey({ from: "a", to: "b" }));
  });
});

describe("expense feed", () => {
  it("says nothing found when filters or search are active", () => {
    expect(claudeExpenseEmptyKind(0, true)).toBe("no-match");
    expect(claudeExpenseEmptyKind(0, false)).toBe("first");
  });
  it("debounces the search query", () => {
    const src = readFileSync(new URL("./ClaudeExpenseFeed.tsx", import.meta.url), "utf8");
    expect(src).toContain("useDebouncedValue(search.trim()");
    expect(src).toContain("q:q||undefined");
    expect(src).not.toContain("q:search||undefined");
  });
});

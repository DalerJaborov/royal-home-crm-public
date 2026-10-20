import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearRecentSearches, loadRecentSearches, recentSearchKey, saveRecentSearch } from "../recentSearches";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
});
describe("actor-owned recent search", () => {
  it("never restores legacy labels and separates actors with the same role", () => {
    localStorage.setItem("royalhome:recentSearches", JSON.stringify([{ label: "Private legacy", url: "/clients/1", ts: 1 }]));
    saveRecentSearch("A", { label: "A private label", url: "/clients/1", ts: 2 });
    saveRecentSearch("B", { label: "B own label", url: "/clients/2", ts: 3 });
    expect(loadRecentSearches("B").map(item => item.label)).toEqual(["B own label"]);
    expect(loadRecentSearches(null)).toEqual([]);
    expect(localStorage.getItem("royalhome:recentSearches")).toBeNull();
    clearRecentSearches("A"); expect(localStorage.getItem(recentSearchKey("A"))).toBeNull();
    expect(loadRecentSearches("B")).toHaveLength(1);
  });
  it("deduplicates, bounds and rejects malformed or external entries", () => {
    for (let n = 0; n < 12; n++) saveRecentSearch("A", { label: `${n}`, url: `/clients/${n}`, ts: n });
    saveRecentSearch("A", { label: "new", url: "/clients/11", ts: 20 });
    expect(loadRecentSearches("A")).toHaveLength(8);
    expect(loadRecentSearches("A")[0].label).toBe("new");
    localStorage.setItem(recentSearchKey("A"), JSON.stringify([{}, null, { label: "bad", url: "//evil.test", ts: 1 }]));
    expect(loadRecentSearches("A")).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearIdleActivity, idleActivityKey } from "../../lib/idleActivity";
import { loadRecentSearches, recentSearchKey, saveRecentSearch } from "../../lib/recentSearches";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("window", { localStorage, sessionStorage: new MemoryStorage() });
});
afterEach(() => { vi.resetModules(); vi.unstubAllGlobals(); });
const actor = (id: string) => ({ id, role: "AGENT" as const, fullName: id, phone: "" });

describe("auth privacy boundary", () => {
  it("logout removes current actor and legacy histories; next actor retains only their own", async () => {
    const { useAuthStore } = await import("../auth");
    useAuthStore.getState().setSession(actor("A"), "unit-test-only");
    saveRecentSearch("A", { label: "Private A", url: "/clients/1", ts: 1 });
    saveRecentSearch("B", { label: "Own B", url: "/clients/2", ts: 2 });
    localStorage.setItem("royalhome:recentSearches", "legacy private label");
    localStorage.setItem(idleActivityKey("A"), "1");
    useAuthStore.getState().logout();
    expect(localStorage.getItem(recentSearchKey("A"))).toBeNull();
    expect(localStorage.getItem("royalhome:recentSearches")).toBeNull();
    expect(localStorage.getItem(idleActivityKey("A"))).toBeNull();
    useAuthStore.getState().setSession(actor("B"), "unit-test-only");
    expect(loadRecentSearches("B").map(item => item.label)).toEqual(["Own B"]);
  });
  it("direct setSession A to B clears A labels and does not inherit the old idle deadline", async () => {
    const { useAuthStore } = await import("../auth");
    useAuthStore.getState().setSession(actor("A"), "unit-test-only");
    saveRecentSearch("A", { label: "Private A", url: "/clients/1", ts: 1 });
    localStorage.setItem("royal-home-last-activity", "1");
    localStorage.setItem(idleActivityKey("B"), "1");
    useAuthStore.getState().setSession(actor("B"), "unit-test-only");
    expect(loadRecentSearches("A")).toEqual([]);
    expect(localStorage.getItem("royal-home-last-activity")).toBeNull();
    expect(localStorage.getItem(idleActivityKey("B"))).toBeNull();
    clearIdleActivity("B");
  });
});

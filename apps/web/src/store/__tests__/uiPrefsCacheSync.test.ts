import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiPreferences } from "@royal-home/shared";
import type { MyProfile } from "../../lib/meProfile";

const put = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({ api: (...args: unknown[]) => args[0] === "/me" ? get(...args) : put(...args) }));

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
vi.stubGlobal("localStorage", new MemoryStorage());
// Zustand's current default persistence reads window.localStorage, not globalThis.
vi.stubGlobal("window", { localStorage });

const LIGHT = "royal-home-2026-light";
const NIGHT = "royal-home-2026-night";
type CachedProfile = Pick<MyProfile, "id" | "preferences" | "fullName">;
const profile = (id = "agent-1", preferences: UiPreferences = { theme: LIGHT }): CachedProfile => ({ id, fullName: "Preserved name", preferences });
function pending() {
  let resolve!: (value?: unknown) => void;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  (localStorage as unknown as MemoryStorage).values.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T06:00:00Z"));
  put.mockReset();
  get.mockReset(); get.mockResolvedValue(profile());
  put.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.resetModules();
});

async function load() {
  const { useAuthStore } = await import("../auth");
  const { queryClient } = await import("../../lib/queryClient");
  useAuthStore.setState({ agent: { id: "agent-1" } as never, hasSession: true, sessionEpoch: 7 });
  const { useUiPrefs } = await import("../uiPrefs");
  queryClient.setQueryData(["me"], profile());
  return { useUiPrefs, useAuthStore, queryClient };
}

describe("acknowledged UI preferences and persisted profile cache", () => {
  it("immediate reload after PUT ignores old disk profile and hydrates night from a fresh GET", async () => {
    const { useUiPrefs, queryClient } = await load();
    expect(localStorage.getItem("royal-home-auth")).not.toBeNull();
    const { buildVersion, restoreQueryCache } = await import("../../lib/queryPersist");
    localStorage.setItem("royal-home-query-cache-v1", JSON.stringify({
      userId: "agent-1", savedAt: Date.now(), build: buildVersion(), entries: [
        { key: ["me"], data: profile(), dataUpdatedAt: Date.now() },
        { key: ["properties"], data: { items: [{ id: "cached-property" }] }, dataUpdatedAt: Date.now() },
      ],
    }));
    useUiPrefs.getState().setTheme(NIGHT);
    await vi.advanceTimersByTimeAsync(600);
    expect(useUiPrefs.getState().syncedAt).toBe(useUiPrefs.getState().updatedAt);
    expect(queryClient.getQueryData<CachedProfile>(["me"])?.preferences?.theme).toBe(NIGHT);
    expect(queryClient.getQueryData<CachedProfile>(["me"])?.fullName).toBe("Preserved name");

    // Reload immediately: no 1000 ms disk-save debounce has elapsed after the ACK.
    queryClient.clear();
    useUiPrefs.setState({ serverHydrated: false });
    await restoreQueryCache();
    expect(queryClient.getQueryData(["me"])).toBeUndefined();
    expect(queryClient.getQueryData(["properties"])).toBeUndefined();
    get.mockResolvedValueOnce(profile("agent-1", { theme: NIGHT }));
    const { api } = await import("../../lib/api");
    const fresh = await queryClient.fetchQuery({ queryKey: ["me"], queryFn: () => api<CachedProfile>("/me") });
    useUiPrefs.getState().hydrateFromServer(fresh.preferences);
    expect(useUiPrefs.getState().theme).toBe(NIGHT);
    expect(put).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("caches the acknowledged snapshot, not a newer unsaved local theme", async () => {
    const request = pending();
    put.mockReturnValueOnce(request.promise);
    const { useUiPrefs, queryClient } = await load();
    useUiPrefs.getState().setTheme(NIGHT);
    await vi.advanceTimersByTimeAsync(600);
    useUiPrefs.getState().setTheme(LIGHT);
    request.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(queryClient.getQueryData<CachedProfile>(["me"])?.preferences?.theme).toBe(NIGHT);
    expect(useUiPrefs.getState().theme).toBe(LIGHT);
    expect(useUiPrefs.getState().updatedAt).toBeGreaterThan(useUiPrefs.getState().syncedAt);
    useUiPrefs.getState().hydrateFromServer(queryClient.getQueryData<CachedProfile>(["me"])?.preferences);
    expect(useUiPrefs.getState().theme).toBe(LIGHT);
  });

  it("serializes whole-document PUTs so an older request cannot land after the newer one", async () => {
    const older = pending(), newer = pending();
    put.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { useUiPrefs, queryClient } = await load();
    useUiPrefs.getState().setTheme(NIGHT);
    await vi.advanceTimersByTimeAsync(600);
    useUiPrefs.getState().setTheme(LIGHT);
    await vi.advanceTimersByTimeAsync(600);
    expect(put).toHaveBeenCalledTimes(1);
    older.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1][1].body.theme).toBe(LIGHT);
    newer.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(queryClient.getQueryData<CachedProfile>(["me"])?.preferences?.theme).toBe(LIGHT);
    expect(useUiPrefs.getState().syncedAt).toBe(useUiPrefs.getState().updatedAt);
  });

  it.each(["different account", "same account new epoch"])("ignores old PUT completion after %s", async (scenario) => {
    const request = pending();
    put.mockReturnValueOnce(request.promise);
    const { useUiPrefs, useAuthStore, queryClient } = await load();
    useUiPrefs.getState().setTheme(NIGHT);
    await vi.advanceTimersByTimeAsync(600);
    const id = scenario === "different account" ? "agent-2" : "agent-1";
    useAuthStore.setState({ agent: { id } as never, sessionEpoch: 8 });
    queryClient.setQueryData(["me"], profile(id));
    request.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(queryClient.getQueryData<CachedProfile>(["me"])).toEqual(profile(id));
    expect(useUiPrefs.getState().syncedAt).toBe(0);
  });

  it("never patches a profile cache belonging to another owner", async () => {
    const { useUiPrefs, queryClient } = await load();
    queryClient.setQueryData(["me"], profile("agent-2"));
    useUiPrefs.getState().setTheme(NIGHT);
    await vi.advanceTimersByTimeAsync(600);
    expect(queryClient.getQueryData<CachedProfile>(["me"])).toEqual(profile("agent-2"));
  });

  it("cancels debounce and retry when the same account starts another session", async () => {
    const { useUiPrefs, useAuthStore } = await load();
    useUiPrefs.getState().setTheme(NIGHT);
    useAuthStore.setState({ sessionEpoch: 8 });
    await vi.advanceTimersByTimeAsync(600);
    expect(put).not.toHaveBeenCalled();
    put.mockRejectedValue(new Error("network"));
    useUiPrefs.getState().setTheme(LIGHT);
    await vi.advanceTimersByTimeAsync(600);
    expect(put).toHaveBeenCalledTimes(1);
    useAuthStore.setState({ sessionEpoch: 9 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("distinguishes consecutive edits within the same clock millisecond", async () => {
    const { useUiPrefs } = await load();
    useUiPrefs.getState().setTheme(NIGHT);
    const first = useUiPrefs.getState().updatedAt;
    useUiPrefs.getState().setGlass(false);
    expect(useUiPrefs.getState().updatedAt).toBeGreaterThan(first);
  });

  it.each([{ theme: LIGHT }, null] satisfies (UiPreferences | null)[])("late initial GET %j preserves local choice and actually sends its PUT", async (serverPreferences) => {
    const { useUiPrefs } = await load();
    useUiPrefs.getState().setTheme(NIGHT);
    await vi.advanceTimersByTimeAsync(300);
    useUiPrefs.getState().hydrateFromServer(serverPreferences);
    expect(useUiPrefs.getState().theme).toBe(NIGHT);
    await vi.advanceTimersByTimeAsync(600);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1].body.theme).toBe(NIGHT);
    expect(useUiPrefs.getState().syncedAt).toBe(useUiPrefs.getState().updatedAt);
    expect(JSON.parse(localStorage.getItem("royal-home-ui")!).state.theme).toBe(NIGHT);
  });

  it("reload with an unsynced persisted choice resumes PUT after the fresh old GET", async () => {
    const beforeReload = await load();
    beforeReload.useUiPrefs.getState().setTheme(NIGHT);
    expect(put).not.toHaveBeenCalled();
    // A reload destroys timers/modules but leaves the browser's storage intact.
    vi.clearAllTimers();
    vi.resetModules();
    const afterReload = await load();
    expect(afterReload.useUiPrefs.getState().theme).toBe(NIGHT);
    expect(afterReload.useUiPrefs.getState().updatedAt).toBeGreaterThan(afterReload.useUiPrefs.getState().syncedAt);
    afterReload.useUiPrefs.getState().hydrateFromServer({ theme: LIGHT });
    await vi.advanceTimersByTimeAsync(600);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1].body.theme).toBe(NIGHT);
    expect(afterReload.useUiPrefs.getState().syncedAt).toBe(afterReload.useUiPrefs.getState().updatedAt);
  });

  it("forced login hydration still cancels the previous pending choice", async () => {
    const { useUiPrefs } = await load();
    useUiPrefs.getState().setTheme(NIGHT);
    useUiPrefs.getState().hydrateFromServer({ theme: LIGHT }, true);
    await vi.advanceTimersByTimeAsync(600);
    expect(put).not.toHaveBeenCalled();
    expect(useUiPrefs.getState().theme).toBe(LIGHT);
  });
});

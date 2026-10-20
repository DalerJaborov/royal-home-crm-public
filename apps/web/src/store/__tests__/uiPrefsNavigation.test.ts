import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiPreferencesSchema } from "@royal-home/shared";

const put = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({ api: (...args: unknown[]) => put(...args) }));
const values = new Map<string, string>();
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
vi.stubGlobal("localStorage", storage);
vi.stubGlobal("window", { localStorage: storage });
function deferred() {
  let resolve!: () => void, reject!: (cause: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
async function load() {
  const { useAuthStore } = await import("../auth");
  useAuthStore.setState({ agent: { id: "one" } as never, sessionEpoch: 7 });
  const { useUiPrefs } = await import("../uiPrefs");
  useUiPrefs.getState().hydrateFromServer({ theme: undefined }, true);
  return { useUiPrefs, useAuthStore };
}
beforeEach(() => { values.clear(); put.mockReset(); put.mockResolvedValue(undefined); vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.resetModules(); });

describe("server-backed personal navigation", () => {
  it("reports exhausted background writes without acknowledging local changes", async () => {
    const { useUiPrefs } = await load();
    const { useToastStore } = await import("../toast");
    useToastStore.setState({ toasts: [] });
    put.mockImplementation((path: string) => path === "/me"
      ? Promise.resolve({ id: "one", preferences: {} }) : Promise.reject(new Error("Нет связи")));
    useUiPrefs.getState().setTheme("royal-home-2026-night");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(useToastStore.getState().toasts.at(-1)?.text).toContain("Настройки не сохранены");
    expect(useUiPrefs.getState().syncedAt).toBeLessThan(useUiPrefs.getState().updatedAt);
  });
  it("does not retry READ_ONLY_ROLE and explains local-only preferences", async () => {
    const { useUiPrefs } = await load();
    const { useToastStore } = await import("../toast");
    useToastStore.setState({ toasts: [] });
    put.mockImplementation((path: string) => path === "/me"
      ? Promise.resolve({ id: "one", preferences: {} })
      : Promise.reject(Object.assign(new Error("Forbidden"), { data: { code: "READ_ONLY_ROLE" } })));
    useUiPrefs.getState().setTheme("royal-home-2026-night");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(put.mock.calls.filter(([path]) => path === "/me/preferences")).toHaveLength(1);
    expect(useToastStore.getState().toasts.at(-1)?.text).toContain("Режим просмотра");
  });
  it("preserves a newer order from another device even after this actor's local hydration", async () => {
    const { useUiPrefs } = await load();
    useUiPrefs.getState().hydrateFromServer({ theme: undefined, navigation: { desktopOrder: ["/clients"] } }, true);
    put.mockResolvedValueOnce({ id: "one", preferences: { navigation: { desktopOrder: ["/messages", "/finance"] } } });
    useUiPrefs.getState().setTheme("royal-home-2026-night");
    await vi.advanceTimersByTimeAsync(600);
    expect(put.mock.calls[1][1].body.navigation.desktopOrder).toEqual(["/messages", "/finance"]);
  });
  it("a theme change before hydration preserves the current actor's server order", async () => {
    const { useUiPrefs } = await load();
    useUiPrefs.setState({ navigationOwnerId: "previous", desktopNavigationOrder: ["/finance"] });
    put.mockResolvedValueOnce({ id: "one", preferences: { navigation: { desktopOrder: ["/messages", "/clients"] } } });
    useUiPrefs.getState().setTheme("royal-home-2026-night");
    await vi.advanceTimersByTimeAsync(600);
    expect(put.mock.calls[0][0]).toBe("/me");
    expect(put.mock.calls[1][1].body.navigation.desktopOrder).toEqual(["/messages", "/clients"]);
  });
  it("validates strict bounded unique path IDs, with backwards-compatible optional navigation", () => {
    expect(uiPreferencesSchema.safeParse({ theme: "royal-home-2026-light" }).success).toBe(true);
    expect(uiPreferencesSchema.safeParse({ navigation: { desktopOrder: [] } }).success).toBe(true);
    for (const navigation of [{ desktopOrder: ["/clients", "/clients"] }, { desktopOrder: ["https://evil.test"] }, { desktopOrder: ["/clients?all=1"] }, { desktopOrder: ["/clients"], enabled: true }, { desktopOrder: Array.from({ length: 65 }, (_, i) => `/route-${i}`) }]) {
      expect(uiPreferencesSchema.safeParse({ navigation }).success).toBe(false);
    }
  });
  it("waits for actual server ACK and preserves the rest of the preferences document", async () => {
    const request = deferred(); put.mockReturnValueOnce(request.promise);
    const { useUiPrefs } = await load();
    useUiPrefs.getState().hydrateFromServer({ theme: "royal-home-2026-night", dashboard: { hidden: ["map"] }, security: { autoLogoutMinutes: 15 } }, true);
    const saving = useUiPrefs.getState().saveDesktopNavigationOrder(["/messages", "/clients"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(useUiPrefs.getState().desktopNavigationOrder).toEqual([]);
    expect(put.mock.calls[0][1]).toMatchObject({ expectAgentId: "one", body: { theme: "royal-home-2026-night", dashboard: { hidden: ["map"] }, security: { autoLogoutMinutes: 15 }, navigation: { desktopOrder: ["/messages", "/clients"] } } });
    request.resolve(); await saving;
    expect(useUiPrefs.getState().desktopNavigationOrder).toEqual(["/messages", "/clients"]);
    expect(useUiPrefs.getState().syncedAt).toBe(useUiPrefs.getState().updatedAt);
  });
  it("does not overwrite a not-yet-hydrated server document", async () => {
    const { useUiPrefs } = await load();
    useUiPrefs.setState({ serverHydrated: false });
    await expect(useUiPrefs.getState().saveDesktopNavigationOrder(["/messages"])).rejects.toThrow("ещё загружаются");
    expect(put).not.toHaveBeenCalled();
  });
  it("does not apply completion after the same account opens a new session", async () => {
    const request = deferred(); put.mockReturnValueOnce(request.promise);
    const { useUiPrefs, useAuthStore } = await load();
    const saving = useUiPrefs.getState().saveDesktopNavigationOrder(["/messages"]).catch((cause: Error) => cause.message);
    await vi.advanceTimersByTimeAsync(0);
    useAuthStore.setState({ sessionEpoch: 8 });
    useUiPrefs.getState().hydrateFromServer({ theme: undefined, navigation: { desktopOrder: ["/clients"] } }, true);
    request.resolve(); expect(await saving).toContain("Сессия сменилась");
    expect(useUiPrefs.getState().desktopNavigationOrder).toEqual(["/clients"]);
  });
  it("rejects failed save without applying draft and permits explicit retry", async () => {
    put.mockRejectedValueOnce(new Error("Нет связи"));
    const { useUiPrefs } = await load();
    useUiPrefs.getState().hydrateFromServer({ theme: undefined, navigation: { desktopOrder: ["/clients"] } }, true);
    await expect(useUiPrefs.getState().saveDesktopNavigationOrder(["/messages"])).rejects.toThrow("Нет связи");
    expect(useUiPrefs.getState().desktopNavigationOrder).toEqual(["/clients"]);
    await useUiPrefs.getState().saveDesktopNavigationOrder(["/messages"]);
    expect(useUiPrefs.getState().desktopNavigationOrder).toEqual(["/messages"]);
  });
  it("does not apply an old account's response to the new owner", async () => {
    const request = deferred(); put.mockReturnValueOnce(request.promise);
    const { useUiPrefs, useAuthStore } = await load();
    const saving = useUiPrefs.getState().saveDesktopNavigationOrder(["/messages"]).catch((cause: Error) => cause.message);
    await vi.advanceTimersByTimeAsync(0);
    useAuthStore.setState({ agent: { id: "two" } as never, sessionEpoch: 8 });
    useUiPrefs.getState().hydrateFromServer({ theme: undefined, navigation: { desktopOrder: ["/properties"] } }, true);
    request.resolve(); expect(await saving).toContain("Сессия сменилась");
    expect(useUiPrefs.getState().navigationOwnerId).toBe("two");
    expect(useUiPrefs.getState().desktopNavigationOrder).toEqual(["/properties"]);
    useUiPrefs.getState().hydrateFromServer({ theme: "royal-home-2026-light" }, true);
    expect(useUiPrefs.getState().desktopNavigationOrder).toEqual([]);
  });
  it("reload restores acknowledged order and server hydration/reset remain authoritative", async () => {
    const { useUiPrefs } = await load();
    await useUiPrefs.getState().saveDesktopNavigationOrder(["/messages", "/clients"]);
    vi.resetModules();
    const restored = await import("../uiPrefs");
    expect(restored.useUiPrefs.getState().desktopNavigationOrder).toEqual(["/messages", "/clients"]);
    expect(restored.useUiPrefs.getState().navigationOwnerId).toBe("one");
    restored.useUiPrefs.getState().hydrateFromServer({ theme: undefined, navigation: { desktopOrder: ["/properties"] } }, true);
    expect(restored.useUiPrefs.getState().desktopNavigationOrder).toEqual(["/properties"]);
    await restored.useUiPrefs.getState().saveDesktopNavigationOrder([]);
    expect(put.mock.calls.at(-1)?.[1].body.navigation.desktopOrder).toEqual([]);
  });
  it("serializes a theme change behind navigation ACK without losing either setting", async () => {
    const request = deferred(); put.mockReturnValueOnce(request.promise);
    const { useUiPrefs } = await load();
    const saving = useUiPrefs.getState().saveDesktopNavigationOrder(["/messages"]);
    await vi.advanceTimersByTimeAsync(0);
    useUiPrefs.getState().setTheme("royal-home-2026-night");
    await vi.advanceTimersByTimeAsync(600);
    expect(put).toHaveBeenCalledTimes(1);
    put.mockResolvedValueOnce({ id: "one", preferences: { navigation: { desktopOrder: ["/messages"] } } });
    request.resolve(); await saving; await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledTimes(3);
    expect(put.mock.calls[1][0]).toBe("/me");
    expect(put.mock.calls[2][1].body).toMatchObject({ theme: "royal-home-2026-night", navigation: { desktopOrder: ["/messages"] } });
    expect(useUiPrefs.getState().theme).toBe("royal-home-2026-night");
    expect(useUiPrefs.getState().syncedAt).toBe(useUiPrefs.getState().updatedAt);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCleanClients, memoizedChunk, permitsCleanChunkWarming, scheduleCleanRouteChunks, warmCleanRouteChunk } from "../cleanRouteChunks";

vi.mock("../../pages/Clients", () => ({ Clients: "client-page" }));

afterEach(() => vi.restoreAllMocks());

describe("clean code chunk warming", () => {
  it("does not import until called and shares concurrent and completed loads", async () => {
    const importer = vi.fn(async () => ({ default: "component" }));
    const load = memoizedChunk(importer);
    expect(importer).not.toHaveBeenCalled();
    const first = load();
    expect(load()).toBe(first);
    await first;
    expect(load()).toBe(first);
    expect(importer).toHaveBeenCalledTimes(1);
  });
  it("releases a rejected chunk for a real later navigation retry", async () => {
    const importer = vi.fn().mockRejectedValueOnce(new Error("chunk unavailable")).mockResolvedValueOnce("loaded");
    const load = memoizedChunk(importer);
    await expect(load()).rejects.toThrow("chunk unavailable");
    await expect(load()).resolves.toBe("loaded");
    expect(importer).toHaveBeenCalledTimes(2);
  });
  it("handles synchronous importer failure without poisoning the cache", async () => {
    const load = memoizedChunk(vi.fn().mockImplementationOnce(() => { throw new Error("import failed"); }).mockResolvedValue("loaded"));
    await expect(load()).rejects.toThrow("import failed");
    await expect(load()).resolves.toBe("loaded");
  });
  it("unknown paths never load modules or request data", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(warmCleanRouteChunk("https://outside.example")).resolves.toBe(false);
    await expect(warmCleanRouteChunk("/me/royal-score")).resolves.toBe(false);
    await expect(warmCleanRouteChunk("/clients?all=1")).resolves.toBe(false);
    await expect(warmCleanRouteChunk("__proto__")).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("the warmed known route shares its named component loader with lazy navigation", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(warmCleanRouteChunk("/clients")).resolves.toBe(true);
    await expect(loadCleanClients()).resolves.toEqual({ default: "client-page" });
    expect(loadCleanClients()).toBe(loadCleanClients());
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["slow-2g", "2g", "3g"])("does not warm on %s connections", (effectiveType) => {
    expect(permitsCleanChunkWarming({ effectiveType })).toBe(false);
  });
  it("respects data saver and permits normal or unknown network types", () => {
    expect(permitsCleanChunkWarming({ saveData: true, effectiveType: "4g" })).toBe(false);
    expect(permitsCleanChunkWarming({ effectiveType: "4g" })).toBe(true);
    expect(permitsCleanChunkWarming()).toBe(true);
  });
});

function harness() {
  const slots: Array<() => void> = [];
  const cancellations = vi.fn();
  const warm = vi.fn(async (_path: string) => {});
  const requestIdle = vi.fn((run: () => void) => { slots.push(run); return cancellations; });
  return { slots, cancellations, warm, requestIdle };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("cancelable permission-supplied idle queue", () => {
  it("only warms supplied supported paths, deduplicated, one at a time", async () => {
    const h = harness();
    let resolve!: () => void;
    h.warm.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    scheduleCleanRouteChunks(["/clients", "/clients", "/settings", "/finance"], { ...h, canWarm: () => true });
    expect(h.warm).not.toHaveBeenCalled();
    h.slots.shift()!(); await flush();
    expect(h.warm.mock.calls).toEqual([["/clients"]]);
    expect(h.slots).toHaveLength(0);
    resolve(); await flush();
    h.slots.shift()!(); await flush();
    expect(h.warm.mock.calls).toEqual([["/clients"], ["/finance"]]);
    expect(h.slots).toHaveLength(0);
  });
  it("cancel before idle prevents imports even if the idle callback is delivered", async () => {
    const h = harness();
    const cancel = scheduleCleanRouteChunks(["/clients"], { ...h, canWarm: () => true });
    cancel(); h.slots.shift()!(); await flush();
    expect(h.cancellations).toHaveBeenCalledTimes(1);
    expect(h.warm).not.toHaveBeenCalled();
  });
  it("cancel during an import never schedules the next route", async () => {
    const h = harness();
    let resolve!: () => void;
    h.warm.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const cancel = scheduleCleanRouteChunks(["/clients", "/finance"], { ...h, canWarm: () => true });
    h.slots.shift()!(); await flush(); cancel(); resolve(); await flush();
    expect(h.warm).toHaveBeenCalledTimes(1);
    expect(h.slots).toHaveLength(0);
  });
  it("rechecks account/layout eligibility and network before executing idle", async () => {
    for (const guard of ["active", "network"] as const) {
      const h = harness(); let allowed = true;
      scheduleCleanRouteChunks(["/clients"], { ...h, isActive: () => guard === "active" ? allowed : true, canWarm: () => guard === "network" ? allowed : true });
      allowed = false; h.slots.shift()!(); await flush();
      expect(h.warm).not.toHaveBeenCalled();
    }
  });
  it("reports a warm failure and continues without retrying it or replacing route errors", async () => {
    const h = harness(); const error = new Error("warm failed"); const onError = vi.fn();
    h.warm.mockRejectedValueOnce(error);
    scheduleCleanRouteChunks(["/clients", "/finance"], { ...h, canWarm: () => true, onError });
    h.slots.shift()!(); await flush();
    expect(onError).toHaveBeenCalledWith(error, "/clients");
    h.slots.shift()!(); await flush();
    expect(h.warm.mock.calls).toEqual([["/clients"], ["/finance"]]);
  });
});

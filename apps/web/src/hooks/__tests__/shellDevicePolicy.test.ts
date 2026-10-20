import { afterEach, describe, expect, it, vi } from "vitest";
import { agentMobilePreviewEnabled, agentMobilePreviewOverride, cleanShellAllowedOnDevice, savedAgentMobilePreview, saveAgentMobilePreview } from "../shellDevicePolicy";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("local agent phone preview policy", () => {
  it.each(["localhost", "127.0.0.1", "::1", "[::1]"])("accepts an explicit opt-in on %s only in a preview build", (host) => {
    expect(agentMobilePreviewEnabled("?shell=clean&agentMobilePreview=1", host, true)).toBe(true);
    expect(agentMobilePreviewEnabled("?shell=clean&agentMobilePreview=1", host, false)).toBe(false);
    expect(agentMobilePreviewEnabled("?shell=clean", host, true)).toBe(false);
    expect(agentMobilePreviewEnabled("?shell=legacy&agentMobilePreview=1", host, true)).toBe(false);
  });
  it.each(["crm.example.com", "localhost.example.com", "192.168.1.10", "0.0.0.0"])("rejects %s even in a preview build", (host) => {
    expect(agentMobilePreviewEnabled("?shell=clean&agentMobilePreview=1", host, true)).toBe(false);
  });
  it("retains the agent default and enables every known non-agent phone role", () => {
    expect(cleanShellAllowedOnDevice(true, "AGENT")).toBe(false);
    expect(cleanShellAllowedOnDevice(true, undefined)).toBe(false);
    for (const role of ["DIRECTOR", "ADMIN", "MANAGER", "SHAREHOLDER"]) expect(cleanShellAllowedOnDevice(true, role)).toBe(true);
    expect(cleanShellAllowedOnDevice(true, "AGENT", true)).toBe(true);
    expect(cleanShellAllowedOnDevice(false, "AGENT")).toBe(true);
  });
  it("keeps preview across routes in actor-scoped session storage and supports explicit off", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("window", { location: { hostname: "localhost" }, sessionStorage: {
      getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key),
    } });
    vi.stubEnv("DEV", true);
    expect(savedAgentMobilePreview("one")).toBe(false);
    saveAgentMobilePreview("one", true);
    expect(agentMobilePreviewOverride("") ?? savedAgentMobilePreview("one")).toBe(true);
    expect(savedAgentMobilePreview("two")).toBe(false);
    expect(agentMobilePreviewOverride("?shell=legacy")).toBe(false);
    expect(agentMobilePreviewOverride("?agentMobilePreview=0")).toBe(false);
    saveAgentMobilePreview("one", false);
    expect(savedAgentMobilePreview("one")).toBe(false);
  });
  it("never reads or writes production preview storage, and fails closed if storage throws", () => {
    const getItem = vi.fn(() => { throw new Error("blocked"); });
    const setItem = vi.fn();
    vi.stubGlobal("window", { location: { hostname: "localhost" }, sessionStorage: { getItem, setItem } });
    vi.stubEnv("DEV", false); vi.stubEnv("VITE_AGENT_MOBILE_PREVIEW", "0");
    saveAgentMobilePreview("one", true);
    expect(savedAgentMobilePreview("one")).toBe(false);
    expect(getItem).not.toHaveBeenCalled(); expect(setItem).not.toHaveBeenCalled();
    vi.stubEnv("VITE_AGENT_MOBILE_PREVIEW", "1");
    expect(savedAgentMobilePreview("one")).toBe(false);
    expect(getItem).toHaveBeenCalledOnce();
  });
});

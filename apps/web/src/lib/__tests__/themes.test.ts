import { afterEach, describe, expect, it, vi } from "vitest";
import { initialDeviceTheme } from "../themes";

afterEach(() => vi.unstubAllGlobals());
describe("theme before personal preferences arrive", () => {
  it("starts dark on a dark device without following it later", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    expect(initialDeviceTheme()).toBe("royal-home-2026-night");
  });
  it("uses the light fallback when matchMedia is unavailable", () => {
    vi.stubGlobal("window", {});
    expect(initialDeviceTheme()).toBe("royal-home-2026-light");
  });
});

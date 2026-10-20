import { afterEach, describe, expect, it, vi } from "vitest";
import { isMotionDisabled } from "./motionPolicy";

afterEach(() => vi.unstubAllGlobals());

describe("motion policy", () => {
  it("disables motion in Clean even when the device allows it", () => {
    vi.stubGlobal("document", { documentElement: { dataset: { shell: "clean" } } });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    expect(isMotionDisabled()).toBe(true);
  });
  it("retains legacy motion when the device allows it", () => {
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    expect(isMotionDisabled()).toBe(false);
  });
  it("honours reduced motion in legacy", () => {
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    expect(isMotionDisabled()).toBe(true);
  });
  it("is safe outside the browser", () => {
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("window", undefined);
    expect(isMotionDisabled()).toBe(false);
  });
});

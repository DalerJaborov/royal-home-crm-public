import { describe, expect, it } from "vitest";
import { leakIndex } from "../propertyFunnel";

describe("leakIndex — где теряются люди", () => {
  it("худшая доля перехода", () => {
    // 1000 → 100 (10%) → 20 (20%) → 10 (50%)
    expect(leakIndex([{ count: 1000 }, { count: 100 }, { count: 20 }, { count: 10 }])).toBe(1);
  });
  it("ступень без числа и переход с нуля пропускаются", () => {
    expect(leakIndex([{ count: null }, { count: 50 }, { count: 5 }, { count: 0 }, { count: 0 }])).toBe(3);
  });
  it("рост — не потеря; нигде не теряются — null", () => {
    expect(leakIndex([{ count: 10 }, { count: 12 }, { count: 12 }])).toBeNull();
  });
});

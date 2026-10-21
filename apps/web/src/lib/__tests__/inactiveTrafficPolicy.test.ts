import { describe, expect, it } from "vitest";
import { DEFAULT_INACTIVE_TRAFFIC_POLICY, inactiveTrafficHours, normalizeInactiveTrafficPolicy } from "@royal-home/shared";

describe("inactive traffic policy preserves relationship depth without earlier loss", () => {
  it("leaves the canonical policy unchanged", () => {
    expect(normalizeInactiveTrafficPolicy(DEFAULT_INACTIVE_TRAFFIC_POLICY)).toEqual(DEFAULT_INACTIVE_TRAFFIC_POLICY);
  });
  it("repairs legacy inverted values by extending warmer clients, never shortening red", () => {
    const saved = { ...DEFAULT_INACTIVE_TRAFFIC_POLICY, inactiveGreenMaxAttempts: 2, inactiveRedPingHours: 72 };
    const effective = normalizeInactiveTrafficPolicy(Object.freeze(saved));
    expect(effective.inactiveGreenPingHours).toBe(72);
    expect(effective.inactiveYellowPingHours).toBe(72);
    expect(effective.inactiveRedPingHours).toBe(72);
    for (const color of ["Green", "Yellow", "Red"] as const)
      expect(inactiveTrafficHours(effective, color)).toBeGreaterThanOrEqual(inactiveTrafficHours(saved, color));
    expect(normalizeInactiveTrafficPolicy(effective)).toEqual(effective);
  });
  it("rounds up custom steps without reversing the order", () => {
    const saved = { ...DEFAULT_INACTIVE_TRAFFIC_POLICY, inactiveGreenPingHours: 10,
      inactiveGreenMaxAttempts: 1, inactiveYellowMaxAttempts: 1, inactiveRedPingHours: 37 };
    const effective = normalizeInactiveTrafficPolicy(saved);
    expect(inactiveTrafficHours(effective, "Green")).toBeGreaterThanOrEqual(inactiveTrafficHours(effective, "Yellow"));
    expect(inactiveTrafficHours(effective, "Yellow")).toBeGreaterThanOrEqual(inactiveTrafficHours(effective, "Red"));
    expect(effective.inactiveGreenMaxAttempts).toBe(saved.inactiveGreenMaxAttempts);
    expect(effective.inactiveYellowMaxAttempts).toBe(saved.inactiveYellowMaxAttempts);
  });
  it("allows partially edited form values to reach ordinary form validation", () => {
    const partial = { ...DEFAULT_INACTIVE_TRAFFIC_POLICY, inactiveGreenPingHours: Number.NaN };
    expect(Number.isNaN(normalizeInactiveTrafficPolicy(partial).inactiveGreenPingHours)).toBe(true);
  });
  it("unrelated zero-valued settings cannot disable the ordering guard", () => {
    const saved = { ...DEFAULT_INACTIVE_TRAFFIC_POLICY, inactiveGreenMaxAttempts: 2,
      inactiveRedPingHours: 72, inactivateCooldownHours: 0 };
    expect(normalizeInactiveTrafficPolicy(saved).inactiveGreenPingHours).toBe(72);
  });
});

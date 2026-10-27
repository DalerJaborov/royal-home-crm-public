import { describe, expect, it } from "vitest";
import { isNewAfterActivation } from "../src/lib/somonLeads/freshness.js";

describe("Somon activation cutoff", () => {
  const start = new Date("2026-10-27T12:00:00Z");
  it("rejects old and equal timestamps", () => {
    expect(isNewAfterActivation(start, new Date("2026-10-27T11:59:59Z"))).toBe(false);
    expect(isNewAfterActivation(start, start)).toBe(false);
  });
  it("accepts original publication after activation", () => {
    expect(isNewAfterActivation(start, new Date("2026-10-27T12:00:01Z"))).toBe(true);
  });
  it("fails closed when publication time is unknown or invalid", () => {
    expect(isNewAfterActivation(start, null)).toBe(false);
    expect(isNewAfterActivation(start, new Date("bad"))).toBe(false);
  });
});

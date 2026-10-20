import { describe, expect, it } from "vitest";
import { validateExactShowingSlot } from "../src/lib/showingBooking.js";

const now = new Date("2026-10-15T05:00:00Z");
describe("customer ISO showing instant uses the existing Dushanbe business resolver", () => {
  it("retains the exact instant when 20:00 Dushanbe is requested with its offset", () => {
    const at = new Date("2026-10-16T20:00:00+05:00");
    expect(validateExactShowingSlot(at, now)).toEqual({ ok: true, at });
  });
  it("does not accept 21:00 merely because the ISO instant is in the future", () => {
    expect(validateExactShowingSlot(new Date("2026-10-16T21:00:00+05:00"), now)).toEqual({ ok: false, reason: "outside_hours" });
  });
  it("retains the thirty-minute preparation requirement", () => {
    expect(validateExactShowingSlot(new Date("2026-10-15T10:20:00+05:00"), now)).toEqual({ ok: false, reason: "past" });
  });
  it("keeps the existing thirty-day horizon instead of creating an independent ninety-day policy", () => {
    expect(validateExactShowingSlot(new Date("2026-11-15T15:00:00+05:00"), now)).toEqual({ ok: false, reason: "too_far" });
  });
  it("does not silently turn a seconds-bearing instant into a different minute appointment", () => {
    expect(validateExactShowingSlot(new Date("2026-10-16T15:00:30+05:00"), now)).toEqual({ ok: false, reason: "no_time" });
  });
});

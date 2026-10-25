import { describe, expect, it } from "vitest";
import { showingMomentOf } from "../src/lib/showingMoment.js";

describe("showing occurrence without telephony dependencies", () => {
  const createdAt = new Date("2026-10-20T06:00:00Z");
  const completedAt = new Date("2026-10-21T13:00:00Z");
  it("keeps an explicitly evidenced midnight appointment", () => {
    const nextActionDate = new Date("2026-10-20T19:00:00Z");
    expect(showingMomentOf({ createdAt, completedAt, nextActionDate, showingEvidenceVersion: 1 })).toEqual(nextActionDate);
  });
  it("uses completion for legacy date-only midnight in Dushanbe", () => {
    expect(showingMomentOf({ createdAt, completedAt, nextActionDate: new Date("2026-10-20T19:00:00Z") })).toEqual(completedAt);
  });
  it("keeps the scheduled exact time ahead of later completion", () => {
    const nextActionDate = new Date("2026-10-21T07:30:00Z");
    expect(showingMomentOf({ createdAt, completedAt, nextActionDate })).toEqual(nextActionDate);
  });
  it("retains the creation fallback without fabricated occurrence", () => {
    expect(showingMomentOf({ createdAt, completedAt: null, nextActionDate: null })).toEqual(createdAt);
  });
});

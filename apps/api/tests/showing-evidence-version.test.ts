import { describe, expect, it, vi } from "vitest";
import { interactionCreateSchema } from "@royal-home/shared";
vi.mock("../src/db.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: { $disconnect: vi.fn() } }));
import { isConductedShowing } from "../src/lib/conductedShowing.js";

const propertyId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-10-25T10:00:00Z");
const input = { type: "SHOWING", notes: "Показ", propertyId, nextActionDate: "2026-10-25T12:00:00+05:00" };
describe("future showing evidence, historical compatibility", () => {
  it("requires a time and a known object or explicit described off-CRM object", () => {
    expect(interactionCreateSchema.safeParse(input).success).toBe(true);
    for (const row of [{ ...input, nextActionDate: undefined }, { ...input, nextActionDate: "2026-10-25" }, { ...input, nextActionDate: "2026-02-30T12:00:00Z" },
      { ...input, propertyId: undefined }, { ...input, showingOffCrm: true },
      { ...input, propertyId: undefined, showingOffCrm: true, showingOffCrmDetails: "дом" }])
      expect(interactionCreateSchema.safeParse(row).success).toBe(false);
    expect(interactionCreateSchema.safeParse({ ...input, propertyId: undefined, showingOffCrm: true, showingOffCrmDetails: "Дом по адресу Рудаки 12" }).success).toBe(true);
    expect(interactionCreateSchema.safeParse({ type: "CALL", notes: "Не ответил" }).success).toBe(true);
  });
  it("does not trust caller version or early completedAt; preserves only v0 history", () => {
    expect(interactionCreateSchema.parse({ ...input, showingEvidenceVersion: 0 })).not.toHaveProperty("showingEvidenceVersion");
    const row = { type: "SHOWING", propertyId, declinedAt: null, completedAt: now, nextActionDate: new Date(now.getTime() + 60_000), showingEvidenceVersion: 1 };
    expect(isConductedShowing(row, now)).toBe(false);
    expect(isConductedShowing({ ...row, nextActionDate: null }, now)).toBe(false);
    expect(isConductedShowing({ ...row, nextActionDate: now }, now)).toBe(true);
    expect(isConductedShowing({ ...row, nextActionDate: now, taskCancelledAt: now }, now)).toBe(false);
    expect(isConductedShowing({ ...row, showingEvidenceVersion: 0, nextActionDate: null }, now)).toBe(true);
  });
});

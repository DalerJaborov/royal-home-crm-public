import { describe, expect, it } from "vitest";
import { classifySellerInventory } from "../src/lib/sellerControlPreview.js";

describe("seller inventory shadow", () => {
  const assignedAt = new Date("2026-10-01T00:00:00Z");
  const declaredAt = new Date("2026-10-02T00:00:00Z");
  it("shows three expected versus two submitted; photo/video drafts do not close the gap", () => {
    expect(classifySellerInventory({ expected: 3, declaredAt, assignedAt, statuses: ["AVAILABLE", "PENDING_REVIEW", "AWAITING_PHOTOS", "AWAITING_VIDEO"] }))
      .toMatchObject({ state: "MISSING", accepted: 2, drafts: 2, missing: 1 });
  });
  it("does not infer counts from unknown, old assignment or terminal property evidence", () => {
    expect(classifySellerInventory({ expected: null, declaredAt, assignedAt, statuses: [] }).state).toBe("UNCERTAIN");
    expect(classifySellerInventory({ expected: 1, declaredAt: new Date(0), assignedAt, statuses: ["AVAILABLE"] }).state).toBe("UNCERTAIN");
    expect(classifySellerInventory({ expected: 1, declaredAt, assignedAt, statuses: ["SOLD"] }).state).toBe("UNCERTAIN");
    expect(classifySellerInventory({ expected: 1, declaredAt, assignedAt, statuses: ["AVAILABLE"] }).state).toBe("COMPLETE");
  });
});

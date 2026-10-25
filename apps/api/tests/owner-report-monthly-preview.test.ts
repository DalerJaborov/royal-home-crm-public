import { beforeEach, describe, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({ settings: vi.fn(), optIns: vi.fn(), prepare: vi.fn(), execute: vi.fn() }));
vi.mock("../src/db.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: { $disconnect: vi.fn(), settings: { findUnique: s.settings }, ownerReportSubscription: { findMany: s.optIns } } }));
vi.mock("../src/lib/ownerReport/delivery.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/ownerReport/delivery.js")>(), prepareOwnerReportDelivery: s.prepare, executeQueuedOwnerReports: s.execute }));
import { prepareMonthlyOwnerReportPreviews } from "../src/lib/ownerReport/monthlyPreview.js";
describe("monthly consent scheduler", () => {
  beforeEach(() => { vi.clearAllMocks(); s.settings.mockResolvedValue({ propertyNarrationConfig: { ownerReportPreviewEnabled: true } }); s.optIns.mockResolvedValue([{ propertyId: "p" }]); s.prepare.mockResolvedValue({ id: "draft" }); });
  it("is off by default and does not enumerate owners", async () => {
    s.settings.mockResolvedValue({ propertyNarrationConfig: {} });
    expect(await prepareMonthlyOwnerReportPreviews()).toEqual({ prepared: 0 }); expect(s.optIns).not.toHaveBeenCalled(); expect(s.execute).not.toHaveBeenCalled();
  });
  it("uses persisted active consent, not historical preview drafts", async () => {
    const now = new Date("2026-10-31T20:00:00Z");
    expect(await prepareMonthlyOwnerReportPreviews(now)).toEqual({ prepared: 1 });
    expect(s.optIns).toHaveBeenCalledWith({ where: { active: true, revokedAt: null }, select: { propertyId: true } });
    expect(s.prepare).toHaveBeenCalledWith("p", now);
  });
  it("does not count blocked owner/contact/link snapshots as prepared", async () => {
    s.prepare.mockResolvedValue(null); expect(await prepareMonthlyOwnerReportPreviews()).toEqual({ prepared: 0 });
  });
});

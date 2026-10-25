import { beforeEach, describe, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({ settings: vi.fn(), optIns: vi.fn(), property: vi.fn(), client: vi.fn(), create: vi.fn(), link: vi.fn() }));
vi.mock("../src/db.js", () => ({ prisma: { $disconnect: vi.fn(), settings: { findUnique: s.settings }, ownerReportDelivery: { findMany: s.optIns, createMany: s.create }, property: { findFirst: s.property }, client: { findFirst: s.client } } }));
vi.mock("../src/lib/ownerReport/link.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/ownerReport/link.js")>(), findActiveOwnerReportLink: s.link, presentOwnerReportLink: () => ({ url: "/o/test" }) }));
import { prepareMonthlyOwnerReportPreviews } from "../src/lib/ownerReport/monthlyPreview.js";
describe("monthly owner preview only", () => {
  beforeEach(() => { vi.clearAllMocks(); s.settings.mockResolvedValue({ propertyNarrationConfig: { ownerReportPreviewEnabled: true } }); s.optIns.mockResolvedValue([{ propertyId: "p", sellerClientId: "owner", createdById: "staff" }]); s.property.mockResolvedValue({ id: "p" }); s.client.mockResolvedValue({ id: "owner" }); s.link.mockResolvedValue({}); s.create.mockResolvedValue({ count: 1 }); });
  it("is off by default and does not enumerate owners", async () => {
    s.settings.mockResolvedValue({ propertyNarrationConfig: {} });
    expect(await prepareMonthlyOwnerReportPreviews()).toEqual({ prepared: 0 }); expect(s.optIns).not.toHaveBeenCalled();
  });
  it("prepares only current local month from existing explicit opt-ins with deduplication", async () => {
    expect(await prepareMonthlyOwnerReportPreviews(new Date("2026-10-31T20:00:00Z"))).toEqual({ prepared: 1 });
    expect(s.create).toHaveBeenCalledWith({ data: [{ propertyId: "p", sellerClientId: "owner", createdById: "staff", period: "2026-11", reportUrl: "/o/test", status: "PREVIEW" }], skipDuplicates: true });
  });
  it("does not renew drafts after owner changed or report link was revoked", async () => {
    s.property.mockResolvedValue(null); await prepareMonthlyOwnerReportPreviews(); expect(s.create).not.toHaveBeenCalled();
    s.property.mockResolvedValue({ id: "p" }); s.link.mockResolvedValue(null); await prepareMonthlyOwnerReportPreviews(); expect(s.create).not.toHaveBeenCalled();
  });
});

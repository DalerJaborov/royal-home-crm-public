import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({ property: vi.fn(), sub: vi.fn(), seller: vi.fn(), link: vi.fn(), claim: vi.fn(), row: vi.fn(), upsert: vi.fn(), send: vi.fn(), updates: [] as any[], inTx: false }));
vi.mock("../src/db.js", async (importOriginal) => {
  const tx = { $queryRaw: vi.fn(), property: { findUnique: s.property }, ownerReportSubscription: { findUnique: s.sub }, client: { findFirst: s.seller }, propertyOwnerReportLink: { findFirst: s.link },
    ownerReportDelivery: { findUniqueOrThrow: s.row, findUnique: s.row, upsert: s.upsert, updateMany: vi.fn(async (args: any) => { s.updates.push(args); return { count: 1 }; }) } };
  return { ...await importOriginal<typeof import("../src/db.js")>(), prisma: { ...tx, $disconnect: vi.fn(), $transaction: async (fn: any) => { s.inTx = true; try { return await fn(tx); } finally { s.inTx = false; } }, ownerReportDelivery: { ...tx.ownerReportDelivery, updateMany: s.claim } } };
});
vi.mock("../src/lib/sms/index.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/sms/index.js")>(), sendSms: s.send }));
import { executeOwnerReportDelivery, prepareOwnerReportDelivery } from "../src/lib/ownerReport/delivery.js";
import { mediaRecipientHash, ownerReportPeriod } from "../src/lib/mediaExecution.js";
import { narrationHash } from "../src/lib/propertyNarration.js";
describe("owner report execution receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks(); s.updates.length = 0; vi.stubEnv("JWT_ACCESS_SECRET", "isolated-test-key"); vi.stubEnv("CRM_PUBLIC_URL", "https://crm.example.test"); vi.stubEnv("CRM_OWNER_REPORT_EXECUTION_MODE", "LIVE");
    s.property.mockResolvedValue({ id: "p", shortId: 42, sellerClientId: "seller", status: "ACTIVE", deletedAt: null });
    s.sub.mockResolvedValue({ sellerClientId: "seller", active: true, consentAt: new Date(), revokedAt: null, revision: 3, executionMode: "LIVE", consentById: "actor" });
    s.seller.mockResolvedValue({ id: "seller", phone: "992900000001" }); s.link.mockResolvedValue({ id: "link", token: "token" }); s.claim.mockImplementation(async (args: any) => { if (args.data.claimStartedAt) { const row = await s.row(); s.row.mockResolvedValue({ ...row, status: "SENDING", claimStartedAt: args.data.claimStartedAt }); } return { count: 1 }; }); s.upsert.mockImplementation(async (x: any) => x.create);
    const period = ownerReportPeriod(), url = "https://crm.example.test/o/token", text = `Royal Home. Ежемесячный отчёт по объекту №42 (${period}): ${url}`;
    s.row.mockResolvedValue({ id: "delivery", propertyId: "p", sellerClientId: "seller", createdById: "actor", period, subscriptionVersion: 3, recipientHash: mediaRecipientHash("seller", "992900000001"), contentHash: narrationHash({ text, linkId: "link" }) });
    s.send.mockResolvedValue({ ok: true, id: "sms", providerMessageId: "receipt", dryRun: false, deliveryStatus: "SERVICE_ACCEPTED" });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("default gate never claims or calls a provider", async () => {
    vi.stubEnv("CRM_OWNER_REPORT_EXECUTION_MODE", ""); expect(await executeOwnerReportDelivery("delivery")).toEqual({ status: "PREVIEW" }); expect(s.send).not.toHaveBeenCalled(); expect(s.claim).not.toHaveBeenCalled();
  });
  it("PREVIEW consent stays preview when server becomes LIVE and creates only current month", async () => {
    s.sub.mockResolvedValue({ ...(await s.sub()), executionMode: "PREVIEW" });
    const result = await prepareOwnerReportDelivery("p", new Date("2026-10-31T20:00:00Z"));
    expect(result).toMatchObject({ period: "2026-11", status: "PREVIEW", executionMode: "PREVIEW" });
    expect(s.upsert.mock.calls[0][0].update).toEqual({}); expect(s.send).not.toHaveBeenCalled();
  });
  it.each(["owner", "phone", "consent", "link", "period"])("cancels when %s changed after preparation", async kind => {
    if (kind === "owner") s.property.mockResolvedValue({ ...(await s.property()), sellerClientId: "another" });
    if (kind === "phone") s.seller.mockResolvedValue({ id: "seller", phone: "992900000002" });
    if (kind === "consent") s.sub.mockResolvedValue({ ...(await s.sub()), active: false });
    if (kind === "link") s.link.mockResolvedValue(null);
    if (kind === "period") s.row.mockResolvedValue({ ...(await s.row()), period: "2020-01" });
    expect(await executeOwnerReportDelivery("delivery")).toEqual({ status: "CANCELLED" }); expect(s.send).not.toHaveBeenCalled();
  });
  it("records acceptance with receipt, never claims final client delivery", async () => {
    expect(await executeOwnerReportDelivery("delivery")).toEqual({ status: "SENT" });
    expect(s.updates[0].data.providerReceipt).toMatchObject({ smsMessageId: "sms", providerMessageId: "receipt", deliveryStatus: "SERVICE_ACCEPTED" }); expect(s.updates[0].data).not.toHaveProperty("deliveredAt");
  });
  it.each([[{ ok: true, id: "sms", dryRun: true }, "PREVIEW"], [{ ok: false, error: "timeout", failureOutcome: "unknown" }, "UNKNOWN"], [{ ok: false, error: "refused", failureOutcome: "refused" }, "FAILED"], [{ ok: true, id: "sms", dryRun: false, providerMessageId: null }, "UNKNOWN"]])("does not mislabel dry-run/ambiguous/refused responses", async (response, status) => {
    s.send.mockResolvedValue(response); expect(await executeOwnerReportDelivery("delivery")).toEqual({ status }); expect(s.send).toHaveBeenCalledOnce();
  });
  it("a lost claim prevents duplicate sends", async () => { s.claim.mockResolvedValue({ count: 0 }); expect(await executeOwnerReportDelivery("delivery")).toEqual({ status: "NOT_CLAIMED" }); expect(s.send).not.toHaveBeenCalled(); });
  it("network runs without transaction locks; late proof preserves manually reconciled state", async () => {
    s.send.mockImplementation(async () => { expect(s.inTx).toBe(false); s.row.mockResolvedValue({ ...(await s.row()), status: "FAILED", providerReceipt: { earlier: "retained" } }); return { ok: true, id: "sms-late", providerMessageId: "late-provider-id", dryRun: false }; });
    expect(await executeOwnerReportDelivery("delivery")).toEqual({ status: "UNKNOWN" }); expect(s.send).toHaveBeenCalledOnce();
    expect(s.updates[0].data).not.toHaveProperty("status"); expect(s.updates[0].data.providerReceipt).toMatchObject({ earlier: "retained", lateReceipt: { smsMessageId: "sms-late" } });
  });});

import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  logSystemError: vi.fn(async (..._args: unknown[]) => {}),
  pinned: vi.fn(),
  policy: vi.fn(), stored: vi.fn(),
}));
vi.mock("../src/lib/systemError.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: h.logSystemError }));
vi.mock("../src/lib/customerAgentRuntimeArchive.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/customerAgentRuntimeArchive.js")>()), loadPinnedCustomerAgentRuntime: h.pinned }));
vi.mock("../src/db.js", () => ({ prisma: {
  $disconnect: async () => {}, customerRuntimePolicy: { findUnique: h.policy }, customerAgentRevision: { findUnique: h.stored } } }));
import { createCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import { buildCurrentCustomerAgentManifest, loadVerifiedCustomerAgentRevision } from "../src/lib/customerAgentRegistration.js";
import { customerAgentManifestId, decodeCustomerAgentRevision } from "../src/lib/customerAgentRevision.js";
import { reportCustomerAgentRevisionHeld, resetCustomerAgentRevisionAlertMemo } from "../src/lib/customerAgentRevisionAlert.js";
import { checkActiveCustomerAgentRevisionOnStart } from "../src/lib/customerAgentRevisionStartCheck.js";

const snapshot = createCustomerAgentProviderSnapshot();
async function revisionWith(change: Record<string, string>) {
  const manifest = { ...(await buildCurrentCustomerAgentManifest(snapshot)), ...change };
  return decodeCustomerAgentRevision({ id: customerAgentManifestId(manifest), manifestJson: manifest });
}
const rowOf = (revision: { id: string }) => ({ id: revision.id, manifestJson: (({ id: _id, ...manifest }) => manifest)(revision as { id: string }) });
beforeEach(() => { vi.clearAllMocks(); resetCustomerAgentRevisionAlertMemo(); });

describe("stale core is journalled, once per revision", () => {
  it("mismatch writes one Russian ai-journal line for any number of turns", async () => {
    const stale = await revisionWith({ coreHash: "0".repeat(64) });
    h.pinned.mockResolvedValue({ status: "current", snapshot });
    for (let i = 0; i < 3; i++) expect(await loadVerifiedCustomerAgentRevision(stale)).toEqual({ status: "held", reason: "current_artifact_revision_mismatch" });
    expect(h.logSystemError).toHaveBeenCalledTimes(1);
    const [source, text, ctx] = h.logSystemError.mock.calls[0] as unknown as [string, string, { dedupKey: string }];
    expect(source).toBe("ai");
    expect(text).toContain("Ядро нового бота остановлено");
    expect(text).toContain("Обновить версию бота");
    expect(text).toContain(stale.id.slice(0, 12));
    expect(ctx.dedupKey).toBe(`customer-agent-revision-held:${stale.id}`);
  });
  it("a current revision stays silent", async () => {
    const current = await revisionWith({});
    h.pinned.mockResolvedValue({ status: "current", snapshot });
    expect((await loadVerifiedCustomerAgentRevision(current)).status).toBe("current");
    expect(h.logSystemError).not.toHaveBeenCalled();
  });
  it("a swallowed exception reaches the journal with its text and no stack", async () => {
    const stale = await revisionWith({ providerProfileHash: "9".repeat(64) }); // own cache key: the manifest is built afresh
    h.pinned.mockResolvedValue({ status: "current", snapshot: null }); // building throws on a missing snapshot
    expect(await loadVerifiedCustomerAgentRevision(stale)).toEqual({ status: "held", reason: "current_artifact_verification_unavailable" });
    expect(h.logSystemError).toHaveBeenCalledTimes(1);
    const [, text, ctx] = h.logSystemError.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(text).toContain("не удалось проверить");
    expect(ctx.stack).toBeUndefined();
  });
  it("two different revisions are reported separately", async () => {
    await reportCustomerAgentRevisionHeld("a".repeat(64), "current_artifact_revision_mismatch");
    await reportCustomerAgentRevisionHeld("b".repeat(64), "current_artifact_revision_mismatch");
    expect(h.logSystemError).toHaveBeenCalledTimes(2);
  });
  it("a failing journal never throws into the turn", async () => {
    h.logSystemError.mockRejectedValueOnce(new Error("db down"));
    await expect(reportCustomerAgentRevisionHeld("c".repeat(64), "current_artifact_revision_mismatch")).resolves.toBeUndefined();
  });
});

describe("boot-time check", () => {
  const active = { contractVersion: "scoped", rolloutMode: "ACTIVE" };
  it("journals at boot when the ACTIVE revision differs from the installed code", async () => {
    const stale = await revisionWith({ coreHash: "1".repeat(64) });
    h.policy.mockResolvedValue({ ...active, activeAgentRevisionId: stale.id });
    h.stored.mockResolvedValue(rowOf(stale));
    h.pinned.mockResolvedValue({ status: "current", snapshot });
    expect(await checkActiveCustomerAgentRevisionOnStart()).toBe("held");
    expect(h.logSystemError).toHaveBeenCalledTimes(1);
  });
  it("is silent when the revision matches", async () => {
    const current = await revisionWith({});
    h.policy.mockResolvedValue({ ...active, activeAgentRevisionId: current.id });
    h.stored.mockResolvedValue(rowOf(current));
    h.pinned.mockResolvedValue({ status: "current", snapshot });
    expect(await checkActiveCustomerAgentRevisionOnStart()).toBe("ok");
    expect(h.logSystemError).not.toHaveBeenCalled();
  });
  it("does nothing while the policy is not ACTIVE", async () => {
    h.policy.mockResolvedValue({ contractVersion: "scoped", rolloutMode: "OFF", activeAgentRevisionId: "d".repeat(64) });
    expect(await checkActiveCustomerAgentRevisionOnStart()).toBe("inactive");
    expect(h.stored).not.toHaveBeenCalled();
    expect(h.logSystemError).not.toHaveBeenCalled();
  });
  it("a missing active row is reported, an unreadable policy never throws", async () => {
    h.policy.mockResolvedValue({ ...active, activeAgentRevisionId: "e".repeat(64) });
    h.stored.mockResolvedValue(null);
    expect(await checkActiveCustomerAgentRevisionOnStart()).toBe("held");
    expect(h.logSystemError).toHaveBeenCalledTimes(1);
    h.policy.mockRejectedValue(new Error("db down"));
    expect(await checkActiveCustomerAgentRevisionOnStart()).toBe("failed");
  });
});

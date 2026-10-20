import { beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { createCustomerAgentProviderSnapshot, customerAgentProviderIdentities } from "../src/ai/customerAgentProviderConfig.js";
import { archiveCustomerAgentRuntimeTx, loadPinnedCustomerAgentRuntime } from "../src/lib/customerAgentRuntimeArchive.js";
import type { CustomerAgentRevision } from "@royal-home/shared";

// Normal PostgreSQL immutable archive tests, no model/provider call or activation.
const snapshot = createCustomerAgentProviderSnapshot(), identity = customerAgentProviderIdentities(snapshot), h = "e".repeat(64);
const revision: CustomerAgentRevision = { id: h, coreHash: h, rendererHash: h, modelSchemaHash: h, toolSchemaHash: h,
  knowledgeSchemaHash: h, knowledgeSourceHash: h, promptHash: h, providerProfileHash: identity.providerProfileHash,
  providerPolicyHash: identity.providerPolicyHash, limits: { ...snapshot.turn, maxModelOutputTokens: snapshot.wire.maxOutputTokens } };
beforeAll(async () => { await prisma.$transaction(tx => archiveCustomerAgentRuntimeTx(tx, snapshot)); });
describe("immutable customer runtime archive", () => {
  it("registers the exact hash pair idempotently and resolves the pinned configuration", async () => {
    expect(await prisma.$transaction(tx => archiveCustomerAgentRuntimeTx(tx, snapshot))).toEqual(snapshot);
    expect(await loadPinnedCustomerAgentRuntime(revision)).toEqual({ status: "current", snapshot });
    expect(await prisma.customerAgentRuntimeSnapshot.count({ where: { providerProfileHash: identity.providerProfileHash,
      providerPolicyHash: identity.providerPolicyHash } })).toBe(1);
  });
  it("cannot edit/delete an archived revision or use a newer model/hash/limit as the old pin", async () => {
    await expect(prisma.customerAgentRuntimeSnapshot.update({ where: { id: identity.snapshotHash }, data: { snapshotJson: {} } })).rejects.toThrow();
    await expect(prisma.customerAgentRuntimeSnapshot.delete({ where: { id: identity.snapshotHash } })).rejects.toThrow();
    expect(await loadPinnedCustomerAgentRuntime({ ...revision, providerProfileHash: "0".repeat(64) })).toMatchObject({ status: "held" });
    expect(await loadPinnedCustomerAgentRuntime({ ...revision, limits: { ...revision.limits, maxRounds: 4 } })).toEqual({ status: "held", reason: "runtime_manifest_limits_mismatch" });
  });
  it("expiry cannot silently select current Settings or renew the archived price window", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(snapshot.wire.validUntil));
    try { expect(await loadPinnedCustomerAgentRuntime(revision)).toMatchObject({ status: "held" }); }
    finally { clock.mockRestore(); }
  });
});

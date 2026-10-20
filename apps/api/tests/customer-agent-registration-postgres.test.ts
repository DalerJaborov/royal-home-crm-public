import { describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { createCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import { buildCurrentCustomerAgentManifest, registerCurrentCustomerAgentRevision,
  loadVerifiedCustomerAgentRevision } from "../src/lib/customerAgentRegistration.js";
import { customerAgentManifestId } from "../src/lib/customerAgentRevision.js";

// Normal PG + actual release artifacts: no provider, activation or fake issuer.
describe("customer release registration", () => {
  it("archives actual code/schemas/policy without activating it and verifies the exact pin", async () => {
    const before = await prisma.customerRuntimePolicy.findUnique({ where: { id: "singleton" } });
    const snapshot = createCustomerAgentProviderSnapshot();
    const manifest = await buildCurrentCustomerAgentManifest(snapshot);
    const registered = await registerCurrentCustomerAgentRevision(snapshot);
    expect(registered.id).toBe(customerAgentManifestId(manifest));
    expect(registered).toEqual({ id: registered.id, ...manifest });
    expect(await registerCurrentCustomerAgentRevision(snapshot)).toEqual(registered);
    expect(await prisma.customerAgentRevision.count({ where: { id: registered.id } })).toBe(1);
    expect(await loadVerifiedCustomerAgentRevision(registered)).toMatchObject({ status: "current", revision: registered, snapshot });
    expect(await prisma.customerRuntimePolicy.findUnique({ where: { id: "singleton" } })).toEqual(before);
  });

  it("does not accept a supplied prompt hash, altered policy or expired registration", async () => {
    const snapshot = createCustomerAgentProviderSnapshot();
    const revision = await registerCurrentCustomerAgentRevision(snapshot);
    expect(await loadVerifiedCustomerAgentRevision({ ...revision, promptHash: "0".repeat(64) })).toEqual({
      status: "held", reason: "current_artifact_revision_mismatch",
    });
    await expect(registerCurrentCustomerAgentRevision({ ...snapshot, wire: { ...snapshot.wire, maxOutputTokens: 8192 } })).rejects.toThrow();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(snapshot.wire.validUntil));
    try { await expect(registerCurrentCustomerAgentRevision(snapshot)).rejects.toThrow("validity"); }
    finally { clock.mockRestore(); }
  });
});

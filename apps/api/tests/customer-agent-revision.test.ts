import { describe, expect, it } from "vitest";
import { customerAgentManifestId, customerAgentTurnDeadline, decodeCustomerAgentRevision } from "../src/lib/customerAgentRevision.js";

// Pure cases do not mock a CustomerPrincipal or DB grant.
const hash = "a".repeat(64);
const manifest = { coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash, knowledgeSchemaHash: hash, knowledgeSourceHash: hash,
  providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
  limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 60_000 } };
describe("customer agent revision content identity", () => {
  it("same JSON values with different insertion order have the same content ID", () => {
    const reversed = Object.fromEntries(Object.entries(manifest).reverse());
    const id = customerAgentManifestId(manifest);
    expect(customerAgentManifestId(reversed)).toBe(id);
    expect(decodeCustomerAgentRevision({ id, manifestJson: reversed })).toMatchObject({ id, coreHash: hash });
  });
  it("a genuine different prompt/tool/renderer/knowledge/profile/price revision changes identity", () => {
    for (const field of ["promptHash", "toolSchemaHash", "rendererHash", "knowledgeSchemaHash", "knowledgeSourceHash", "providerProfileHash", "providerPolicyHash"] as const) {
      expect(customerAgentManifestId({ ...manifest, [field]: "b".repeat(64) })).not.toBe(customerAgentManifestId(manifest));
    }
  });
  it("a content-id mismatch cannot be decoded as an approved revision", () => {
    const id = customerAgentManifestId(manifest);
    expect(() => decodeCustomerAgentRevision({ id, manifestJson: { ...manifest, limits: { ...manifest.limits, maxRounds: 4 } } })).toThrow();
  });
  it("unknown fields/id-in-payload/zero bounds fail strict parsing", () => {
    expect(() => customerAgentManifestId({ ...manifest, enabled: true })).toThrow();
    expect(() => customerAgentManifestId({ ...manifest, id: hash })).toThrow();
    expect(() => customerAgentManifestId({ ...manifest, limits: { ...manifest.limits, maxToolCalls: 0 } })).toThrow();
  });
  it("decoded nested manifest cannot be mutated to raise caps under the same ID", () => {
    const revision = decodeCustomerAgentRevision({ id: customerAgentManifestId(manifest), manifestJson: manifest });
    expect(Object.isFrozen(revision)).toBe(true); expect(Object.isFrozen(revision.limits)).toBe(true);
    expect(() => { (revision.limits as { maxRounds: number }).maxRounds = 8; }).toThrow();
    expect(revision.limits.maxRounds).toBe(3);
  });
});
describe("original capture deadline", () => {
  it("uses original capture plus limit, never a retry's now", () => {
    const received = Date.parse("2026-10-15T10:00:00Z");
    expect(customerAgentTurnDeadline(received, 60_000)).toBe(received + 60_000);
    expect(customerAgentTurnDeadline(received, 60_000)).toBe(customerAgentTurnDeadline(received, 60_000));
  });
  it("clips to the END OF ORIGINAL Dushanbe day, not host UTC day", () => {
    const received = Date.parse("2026-10-15T18:59:50Z"); //23:59:50 Dushanbe
    expect(customerAgentTurnDeadline(received, 60_000)).toBe(Date.parse("2026-10-15T19:00:00Z"));
  });
  it("does not extend past original15-minute proof and rejects renewed/unbounded limits", () => {
    const received = Date.parse("2026-10-15T10:00:00Z");
    expect(customerAgentTurnDeadline(received, 900_000)).toBe(received + 900_000);
    expect(() => customerAgentTurnDeadline(received, 900_001)).toThrow();
    expect(() => customerAgentTurnDeadline(Number.NaN, 60_000)).toThrow();
  });
});

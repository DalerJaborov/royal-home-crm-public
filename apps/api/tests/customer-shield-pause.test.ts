import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CustomerFence } from "@royal-home/shared";
import { customerShieldPauseMatches } from "../src/lib/customerShieldPause.js";

function fence(): CustomerFence {
  return { inquiryId: randomUUID(), nativeId: randomUUID(), endpoint: { endpointScopeId: randomUUID(),
    channel: "WHATSAPP", accountId: null, peerId: "fixture-peer", threadId: "" }, ownerToken: randomUUID(),
    stateRevision: "10", intentRevision: "2", ownershipEpoch: "7", bindingRevision: "3", scopeRevision: "4", policyRevision: "8" };
}
describe("shield undo controller fence", () => {
  it("permits the exact resulting pause epoch and public semantic progress only", () => {
    const current = fence();
    expect(customerShieldPauseMatches({ version: 1, fence: current }, current)).toBe(true);
    expect(customerShieldPauseMatches({ version: 1, fence: current }, { ...current, stateRevision: "11", intentRevision: "3" })).toBe(true);
  });
  it.each(["ownershipEpoch", "bindingRevision", "scopeRevision", "policyRevision"] as const)("rejects %s ABA even if visible pause dates are identical", key => {
    const current = fence();
    expect(customerShieldPauseMatches({ version: 1, fence: current }, { ...current, [key]: String(BigInt(current[key]) + 2n) })).toBe(false);
  });
  it("rejects another endpoint/native or owner token and old timestamp-only records", () => {
    const current = fence(), stored = { version: 1, fence: current };
    expect(customerShieldPauseMatches(stored, { ...current, nativeId: randomUUID() })).toBe(false);
    expect(customerShieldPauseMatches(stored, { ...current, ownerToken: randomUUID() })).toBe(false);
    expect(customerShieldPauseMatches(stored, { ...current, endpoint: { ...current.endpoint, endpointScopeId: randomUUID() } })).toBe(false);
    expect(customerShieldPauseMatches(null, current)).toBe(false);
    expect(customerShieldPauseMatches({ pausedUntil: new Date().toISOString() }, current)).toBe(false);
  });
});

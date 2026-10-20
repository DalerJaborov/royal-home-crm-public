import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCustomerAgentProviderSnapshot, customerAgentProviderIdentities, customerAgentProviderBudgetPolicy,
  customerAgentProviderSnapshotSchema, customerAgentCountResponseSchema, decodeCustomerAgentProviderSnapshot,
  loadCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import { frozenGeminiRuntimeProfileHash } from "../src/ai/geminiOperationRuntime.js";
import { calculateProviderCost, providerUsdUnits } from "../src/ai/providerBudget.js";
import { createGeminiCapabilityRegistry } from "../src/ai/geminiCapabilities.js";

const originalIdentities = {
  // Count policy is part of the new immutable profile. Its predecessor stays
  // stored under its old hash; it is not upgraded to this profile in place.
  snapshotHash: "2a30c35659698d0cff7f493b37855d089fbfc9e2cc322a7c10d2eea91474da3b",
  providerProfileHash: "62d51dccddcef2e77ef4220b2327a71a6883d520833d4d3eb2b3c25bc091090d",
  providerPolicyHash: "bc13463c229bd6cd4a29aefe732c00cc4dfca74a0331bc4a202681ab222238bd",
};
function reversedObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedObjectKeys);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reversedObjectKeys(child)]));
  return value;
}
const nowMs = Date.parse("2026-10-15T12:00:00Z");

describe("key-free CustomerAgent provider configuration (pure; no activation/tokenizer/provider I/O)", () => {
  it("matches actual frozen-profile hashing and the existing ordered JSON.stringify budget identity", () => {
    const snapshot = createCustomerAgentProviderSnapshot(), policy = customerAgentProviderBudgetPolicy(snapshot);
    expect(customerAgentProviderIdentities(snapshot)).toEqual(originalIdentities);
    expect(frozenGeminiRuntimeProfileHash(snapshot.profile)).toBe(originalIdentities.providerProfileHash);
    expect(createHash("sha256").update(JSON.stringify(policy)).digest("hex")).toBe(originalIdentities.providerPolicyHash);
    expect(Object.keys(policy)).toEqual(["enabled", "policyKey", "maxOperationUsd", "maxDailyUsd", "maxAttemptUsd",
      "maxAttempts", "profileRevision", "pricingRevision", "pricingSource", "rates", "profiles", "usageProtocol"]);
    // The ledger contract is intentionally different from a sorted-key snapshot hash.
    expect(createHash("sha256").update(JSON.stringify(reversedObjectKeys(policy))).digest("hex"))
      .not.toBe(originalIdentities.providerPolicyHash);
  });
  it("normalizes archive object order without changing profile/policy identity and freezes all retained rows", () => {
    const raw = structuredClone(createCustomerAgentProviderSnapshot());
    const decoded = decodeCustomerAgentProviderSnapshot(reversedObjectKeys(raw));
    expect(customerAgentProviderIdentities(decoded)).toEqual(originalIdentities);
    expect(Object.isFrozen(decoded.profile.runtime.fallbackModels)).toBe(true);
    expect(Object.isFrozen(decoded.budget.rates[0])).toBe(true);
    raw.profile.runtime.model = "synthetic-changed-after-decode";
    expect(decoded.profile.runtime.model).toBe("gemini-3.6-flash");
    const policy = customerAgentProviderBudgetPolicy(decoded);
    (policy.profiles[0].adapters as string[]).push("live");
    expect(decoded.profile.capabilities[0].adapters).toEqual(["tools"]);
  });
  it("derives reserve from complete counted input plus the shared thinking/output budget, with no daily ceiling", () => {
    const snapshot = createCustomerAgentProviderSnapshot(), policy = customerAgentProviderBudgetPolicy(snapshot);
    const totalOutput = snapshot.wire.maxOutputTokens;
    const usage = { source: "reported" as const, completeness: "complete" as const,
      inputTokens: snapshot.wire.maxCountedInputTokens, outputTokens: totalOutput / 2, thinkingTokens: totalOutput / 2,
      cacheReadTokens: 0, audioInputTokens: null, audioOutputTokens: null, searchUnits: null };
    const cost = calculateProviderCost(policy, { model: snapshot.wire.model, api: "generateContent", adapter: "tools" }, usage);
    expect(cost).toBe(32_256_000n);
    expect(providerUsdUnits(policy.maxAttemptUsd)).toBe(cost);
    expect(providerUsdUnits(policy.maxOperationUsd)).toBe(cost! * BigInt(policy.maxAttempts));
    expect(policy.maxDailyUsd).toBeNull();
    expect(policy.pricingSource).toBe("reference");
    expect(calculateProviderCost(policy, { model: snapshot.wire.model, api: "generateContent", adapter: "tools" },
      { ...usage, thinkingTokens: totalOutput / 2 + 1 })!).toBeGreaterThan(cost!);
  });
  it("qualifies only the exact tools/text profile, never the deprecated alias or cache/media/Live", () => {
    const snapshot = createCustomerAgentProviderSnapshot(), registry = createGeminiCapabilityRegistry(snapshot.profile.capabilities);
    const spec = { provider: "google" as const, model: "gemini-3.6-flash", api: "generateContent" as const, adapter: "tools" as const,
      profileRevision: snapshot.profile.profileRevision, endpoint: "assistant-tools", maxOutputTokens: 2048,
      features: { functions: true, thinking: "level" as const } };
    expect(registry.supports(spec)).toBe(true);
    expect(registry.supports({ ...spec, model: "gemini-3.5-flash" })).toBe(false);
    expect(registry.supports({ ...spec, maxOutputTokens: 2049 })).toBe(false);
    expect(registry.supports({ ...spec, features: { ...spec.features, images: true } })).toBe(false);
    expect(registry.supports({ ...spec, features: { ...spec.features, cache: true } })).toBe(false);
    expect(registry.supports({ ...spec, api: "bidiGenerateContent", adapter: "live" })).toBe(false);
  });
  it("does not renew the archived pricing window or accept a different pinned manifest hash pair", () => {
    const snapshot = createCustomerAgentProviderSnapshot();
    expect(loadCustomerAgentProviderSnapshot(snapshot, { ...originalIdentities, nowMs })).toEqual(snapshot);
    for (const time of [Date.parse("2026-10-14T23:59:59.999Z"), Date.parse("2027-01-01T00:00:00Z"), NaN]) {
      expect(() => loadCustomerAgentProviderSnapshot(snapshot, { ...originalIdentities, nowMs: time })).toThrow(/validity/);
    }
    expect(() => loadCustomerAgentProviderSnapshot(snapshot, { ...originalIdentities, nowMs, providerPolicyHash: "f".repeat(64) }))
      .toThrow(/mismatch/);
    expect(() => loadCustomerAgentProviderSnapshot(snapshot, { ...originalIdentities, nowMs, providerProfileHash: "f".repeat(64) }))
      .toThrow(/mismatch/);
    expect(() => loadCustomerAgentProviderSnapshot(snapshot, { ...originalIdentities, nowMs,
      snapshotHash: "ac9d86afe91b1fb822ede1aee3d69a319aacf5e762c68c58cd853d562c5b985c",
      providerProfileHash: "edaec2f364914dd4c48552bf0558d0fa30d8f0c738c90b99ffd27730a5431906",
    })).toThrow(/mismatch/);
  });
  it("rejects keys/unknown fields and unsupported fallback/thinking/reserve drift instead of silently enabling them", () => {
    const snapshot = structuredClone(createCustomerAgentProviderSnapshot());
    expect(customerAgentProviderSnapshotSchema.safeParse({ ...snapshot, apiKey: "synthetic-forbidden" }).success).toBe(false);
    expect(customerAgentProviderSnapshotSchema.safeParse({ ...snapshot, profile: { ...snapshot.profile, apiKey: "synthetic-forbidden" } }).success).toBe(false);
    snapshot.profile.runtime.fallbackModels.push("gemini-3.5-flash");
    expect(customerAgentProviderSnapshotSchema.safeParse(snapshot).success).toBe(false);
    snapshot.profile.runtime.fallbackModels = [];
    snapshot.profile.capabilities[0].thinking = "none";
    expect(customerAgentProviderSnapshotSchema.safeParse(snapshot).success).toBe(false);
    snapshot.profile.capabilities[0].thinking = "level";
    snapshot.budget.maxAttemptUsd = "0.000001";
    expect(customerAgentProviderSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });
  it("validates count response strictly without accepting coercion, cache, media or inconsistent totals", () => {
    expect(customerAgentCountResponseSchema.safeParse({ totalTokens: 32768, promptTokensDetails: [{ modality: "TEXT", tokenCount: 32768 }] }).success).toBe(true);
    for (const raw of [{ totalTokens: "32768" }, { totalTokens: -1 }, { totalTokens: 32769 },
      { totalTokens: 1, cachedContentTokenCount: 1 }, { totalTokens: 1, extra: true },
      { totalTokens: 1, promptTokensDetails: [{ modality: "TEXT", tokenCount: 2 }] },
      { totalTokens: 1, promptTokensDetails: [{ modality: "IMAGE", tokenCount: 1 }] }]) {
      expect(customerAgentCountResponseSchema.safeParse(raw).success).toBe(false);
    }
  });
});

const legacyArchive = () => JSON.parse(readFileSync(new URL("./fixtures/customer-agent-provider-usage-v1.json", import.meta.url), "utf8"));
const legacyIdentities = {
  "snapshotHash": "f451996ea9092cf3800bfcda6d04839a7ecc0652af5a7c94c084ddec8e9d24d3",
  "providerProfileHash": "398878a8bbfcc0ca9dba786f373af56661878b430e296eea6a4f4c3bc7a5409f",
  "providerPolicyHash": "917e1bd0fe9816f2b95e099fb5c4ab9eed91839ba6f1e3b36e51ff77f6e59551"
};
describe("usage protocol archive compatibility", () => {
  it("retains all original v1 hashes and policy property order without injecting a decoder", () => {
    const archived = decodeCustomerAgentProviderSnapshot(legacyArchive());
    expect(customerAgentProviderIdentities(archived)).toEqual(legacyIdentities);
    const policy = customerAgentProviderBudgetPolicy(archived);
    expect(Object.hasOwn(policy, "usageProtocol")).toBe(false);
    expect(Object.keys(policy)).toEqual(["enabled", "policyKey", "maxOperationUsd", "maxDailyUsd", "maxAttemptUsd",
      "maxAttempts", "profileRevision", "pricingRevision", "pricingSource", "rates", "profiles"]);
    expect(loadCustomerAgentProviderSnapshot(archived, { ...legacyIdentities, nowMs }).version).toBe(1);
  });
  it("hashes the new closed protocol into BOTH original profile and ordered policy, never rewriting a v1 archive", () => {
    const current = createCustomerAgentProviderSnapshot();
    expect(current.version).toBe(2);
    expect(current.profile.usageProtocol).toBe(current.budget.usageProtocol);
    expect(customerAgentProviderIdentities(current).providerProfileHash).not.toBe(legacyIdentities.providerProfileHash);
    expect(customerAgentProviderIdentities(current).providerPolicyHash).not.toBe(legacyIdentities.providerPolicyHash);
    expect(() => loadCustomerAgentProviderSnapshot(current, { ...legacyIdentities, nowMs })).toThrow(/mismatch/);
    const injected = legacyArchive(); injected.profile.usageProtocol = current.profile.usageProtocol;
    expect(customerAgentProviderSnapshotSchema.safeParse(injected).success).toBe(false);
  });
  it("rejects a new archive with missing/unknown/crossed usage protocol instead of guessing a decoder", () => {
    const raw = structuredClone(createCustomerAgentProviderSnapshot());
    delete raw.profile.usageProtocol;
    expect(customerAgentProviderSnapshotSchema.safeParse(raw).success).toBe(false);
    const current = createCustomerAgentProviderSnapshot();
    expect(customerAgentProviderSnapshotSchema.safeParse({ ...current, budget: { ...current.budget, usageProtocol: "future-unqualified" } }).success).toBe(false);
    expect(customerAgentProviderSnapshotSchema.safeParse({ ...current, version: 1 }).success).toBe(false);
  });
});

it("v2 requires the exact immutable function declaration protocol while v1 archive stays unchanged", () => {
  const value = structuredClone(createCustomerAgentProviderSnapshot());
  expect(value.profile.countTokens?.functionDeclarationProtocol).toBe("parameters-json-schema-value-v1");
  delete value.wire.functionDeclarationProtocol;
  expect(customerAgentProviderSnapshotSchema.safeParse(value).success).toBe(false);
  const changed = structuredClone(createCustomerAgentProviderSnapshot());
  if (changed.profile.countTokens) delete changed.profile.countTokens.functionDeclarationProtocol;
  expect(customerAgentProviderSnapshotSchema.safeParse(changed).success).toBe(false);
  expect(customerAgentProviderIdentities(legacyArchive())).toEqual(legacyIdentities);
});

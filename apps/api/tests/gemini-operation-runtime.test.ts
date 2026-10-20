import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindGeminiRuntimeToOperation, frozenGeminiRuntimeProfileHash,
  frozenGeminiRuntimeProfileSchema, isGeminiRuntimeBound, resolveGeminiOperationRuntime, type FrozenGeminiRuntimeProfile } from "../src/ai/geminiOperationRuntime.js";
import { callGeminiTools } from "../src/ai/geminiClient.js";
import { createProviderOperation, type ProviderAttemptRecord } from "../src/ai/providerContract.js";
import { createGeminiCapabilityRegistry } from "../src/ai/geminiCapabilities.js";
import { resolveGeminiRuntime } from "../src/ai/geminiSettings.js";

const settings = vi.hoisted(() => ({ model: "synthetic-current-settings", keys: ["synthetic-settings-key"] }));
vi.mock("../src/ai/geminiSettings.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/ai/geminiSettings.js")>()),
  resolveGeminiRuntime: vi.fn(async () => ({ ...settings, keys: [...settings.keys], fallbackModels: [], transcribeModels: [],
    imageModel: "synthetic-image", liteModel: "", explicitCaching: false })),
}));
vi.mock("../src/lib/systemError.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: vi.fn().mockResolvedValue(undefined),
}));
let serial = 0;
function fixture() {
  const prefix = `synthetic-frozen-${++serial}`, key = "synthetic-pinned-key";
  const profile: FrozenGeminiRuntimeProfile = { version: 1, profileRevision: `${prefix}-profile-key`,
    runtime: { model: `${prefix}-primary`, fallbackModels: [`${prefix}-fallback`],
      transcribeModels: [], imageModel: "synthetic-image", liteModel: "", explicitCaching: false },
    capabilities: ["primary", "fallback"].map(suffix => ({ revision: `${prefix}-profile-key`, model: `${prefix}-${suffix}`,
      api: "generateContent", adapters: ["tools"], modalities: ["text"], tools: "function", structuredReply: false,
      thinking: "level", explicitCache: false, grounding: false, maxOutputTokens: 1024 })) };
  const registry = createGeminiCapabilityRegistry(profile.capabilities);
  const records: ProviderAttemptRecord[] = [], reserve = vi.fn(async () => true);
  const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 10_000, maxAttempts: 3,
    profileRevision: profile.profileRevision, supports: registry.supports,
    accountant: { reserve, settle: async record => { records.push(record); } } });
  const hash = frozenGeminiRuntimeProfileHash(profile), keys = [key];
  const input = { profile, expectedProfileRevision: profile.profileRevision, expectedProfileHash: hash, keys };
  const response = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "synthetic useful response" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 0, cachedContentTokenCount: 0 } }));
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response());
  vi.stubGlobal("fetch", fetch);
  const wire = () => callGeminiTools({ apiKey: key, system: "Synthetic pinned prefix", contents: [{ role: "user", parts: [{ text: "Нарх?" }] }],
    tools: [], maxTokens: 512, providerOperation: operation });
  return { profile, hash, keys, input, key, operation, records, reserve, fetch, response, wire };
}
beforeEach(() => { vi.mocked(resolveGeminiRuntime).mockClear(); vi.stubEnv("GEMINI_PROXY_URL", ""); vi.stubEnv("GEMINI_PROXY_KEY", ""); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("one-shot approved Gemini operation runtime", () => {
  it("public content hash is deterministic, contains no credential field, and changes with selected models/capabilities/cache", () => {
    const f = fixture(), reordered = { capabilities: f.profile.capabilities, runtime: f.profile.runtime, profileRevision: f.profile.profileRevision, version: 1 };
    expect(frozenGeminiRuntimeProfileHash(reordered)).toBe(f.hash);
    expect(frozenGeminiRuntimeProfileSchema.safeParse({ ...f.profile, keys: [f.key] }).success).toBe(false);
    expect(frozenGeminiRuntimeProfileSchema.safeParse({ ...f.profile, runtime: { ...f.profile.runtime, keys: [f.key] } }).success).toBe(false);
    for (const delta of [
      { ...f.profile, runtime: { ...f.profile.runtime, model: "synthetic-other-model" } },
      { ...f.profile, runtime: { ...f.profile.runtime, explicitCaching: true } },
      { ...f.profile, capabilities: f.profile.capabilities.map(row => ({ ...row, tools: "none" as const })) },
    ]) expect(frozenGeminiRuntimeProfileHash(delta)).not.toBe(f.hash);
  });
  it("binds the ORIGINAL operation before settings, clones caller config/keys, and preserves actual paid accounting", async () => {
    const f = fixture(), originalModel = f.profile.runtime.model;
    bindGeminiRuntimeToOperation(f.operation, f.input);
    f.profile.runtime.model = "synthetic-changed-after-pin"; f.profile.capabilities[0].tools = "none"; f.keys[0] = "synthetic-rotated-key";
    expect(isGeminiRuntimeBound(f.operation, { profileRevision: f.operation.profileRevision, profileHash: f.hash })).toBe(true);
    expect((await f.wire()).text).toBe("synthetic useful response");
    expect(resolveGeminiRuntime).not.toHaveBeenCalled(); expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({ operationId: f.operation.id, model: originalModel, profileRevision: f.operation.profileRevision, outcome: "success" });
    expect(String(f.fetch.mock.calls[0][0])).toContain(encodeURIComponent(originalModel));
    expect(f.fetch.mock.calls[0][1]?.headers).toMatchObject({ "x-goog-api-key": f.key });
    expect(f.records[0].usage.completeness).toBe("complete");
    const bound = await resolveGeminiOperationRuntime(f.operation);
    expect(() => { bound.model = "synthetic-mutation-through-resolver"; }).toThrow();
    expect(() => { bound.keys.push("synthetic-extra-key"); }).toThrow();
  });
  it("keeps the approved fallback after settings changes, using one original operation and two receipts", async () => {
    const f = fixture(); bindGeminiRuntimeToOperation(f.operation, f.input);
    settings.model = "synthetic-unapproved-new-settings";
    f.fetch.mockResolvedValueOnce(new Response("synthetic primary unavailable", { status: 503 })).mockResolvedValueOnce(f.response());
    expect((await f.wire()).text).toBe("synthetic useful response");
    expect(resolveGeminiRuntime).not.toHaveBeenCalled(); expect(f.records.map(row => row.model)).toEqual([f.profile.runtime.model, f.profile.runtime.fallbackModels[0]]);
    expect(f.records.map(row => row.attemptNo)).toEqual([1, 2]); expect(new Set(f.records.map(row => row.operationId))).toEqual(new Set([f.operation.id]));
  });
  it("rejects one-shot replacement even with identical content before any wire call", () => {
    const f = fixture(); bindGeminiRuntimeToOperation(f.operation, f.input);
    expect(() => bindGeminiRuntimeToOperation(f.operation, f.input)).toThrow("already used");
    expect(isGeminiRuntimeBound(f.operation, { profileRevision: "another-key", profileHash: f.hash })).toBe(false);
    expect(isGeminiRuntimeBound(f.operation, { profileRevision: f.operation.profileRevision, profileHash: "b".repeat(64) })).toBe(false);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
  });
  it("a model/manifest/profile-key mismatch or unapproved tools profile never binds/reserves/sends", () => {
    const f = fixture();
    for (const input of [{ ...f.input, expectedProfileHash: "b".repeat(64) }, { ...f.input, expectedProfileRevision: "other-key" },
      { ...f.input, profile: { ...f.profile, runtime: { ...f.profile.runtime, model: "synthetic-extra-model" } } }]) {
      expect(() => bindGeminiRuntimeToOperation(f.operation, input)).toThrow();
    }
    const wrongTools = { ...f.profile, capabilities: f.profile.capabilities.map(row => ({ ...row, tools: "none" as const })) };
    expect(() => bindGeminiRuntimeToOperation(f.operation, { ...f.input, profile: wrongTools, expectedProfileHash: frozenGeminiRuntimeProfileHash(wrongTools) })).toThrow();
    expect(isGeminiRuntimeBound(f.operation, { profileRevision: f.operation.profileRevision, profileHash: f.hash })).toBe(false);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
  });
  it("binding after first legacy-compatible runtime use cannot replace the existing snapshot", async () => {
    const f = fixture(), operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 10_000, maxAttempts: 2,
      profileRevision: f.profile.profileRevision, supports: () => true, accountant: { reserve: f.reserve, settle: async () => {} } });
    await callGeminiTools({ apiKey: "synthetic-settings-key", system: "fixture", contents: [], tools: [], providerOperation: operation });
    expect(resolveGeminiRuntime).toHaveBeenCalledTimes(1);
    expect(() => bindGeminiRuntimeToOperation(operation, f.input)).toThrow("already used");
  });
  it("bound runtime refuses an unrelated key before reservation or HTTP", async () => {
    const f = fixture(); bindGeminiRuntimeToOperation(f.operation, f.input);
    await expect(callGeminiTools({ apiKey: "synthetic-unrelated-key", system: "fixture", contents: [], tools: [], providerOperation: f.operation })).rejects.toMatchObject({ reason: "unsupported" });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
  });
  it("unmanaged and closed operations cannot bind or claim pinned runtime", async () => {
    const f = fixture(), operation = createProviderOperation({ deadlineAt: Date.now() + 10_000, maxAttempts: 1 });
    expect(() => bindGeminiRuntimeToOperation(operation, f.input)).toThrow();
    bindGeminiRuntimeToOperation(f.operation, f.input); await f.operation.close();
    expect(isGeminiRuntimeBound(f.operation, { profileRevision: f.operation.profileRevision, profileHash: f.hash })).toBe(false);
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

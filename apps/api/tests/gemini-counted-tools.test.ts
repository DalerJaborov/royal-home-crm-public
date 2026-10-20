/** Fake accountant/HTTP boundary tests, no DB/provider or activation claim. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { callGeminiTools } from "../src/ai/geminiClient.js";
import { bindGeminiRuntimeToOperation, frozenGeminiRuntimeProfileHash, boundGeminiCountContext } from "../src/ai/geminiOperationRuntime.js";
import { countGeminiToolsRequest, consumeGeminiToolsCount } from "../src/ai/geminiCountedTools.js";
import { createCustomerAgentProviderSnapshot, customerAgentProviderIdentities } from "../src/ai/customerAgentProviderConfig.js";
import { createProviderOperation, createRecoveredProviderOperation, type ProviderAttemptRecord, type ProviderAttemptSpec } from "../src/ai/providerContract.js";
import { createGeminiCapabilityRegistry } from "../src/ai/geminiCapabilities.js";
vi.mock("../src/lib/systemError.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: vi.fn().mockResolvedValue(undefined),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
function fixture(options: { fallback?: boolean; guard?: (callNo: number) => boolean } = {}) {
  vi.stubEnv("GEMINI_PROXY_URL", "https://synthetic-proxy.invalid"); vi.stubEnv("GEMINI_PROXY_KEY", "synthetic-proxy-key");
  const snapshot = createCustomerAgentProviderSnapshot(), profile = structuredClone(snapshot.profile);
  if (options.fallback) { profile.runtime.fallbackModels.push("synthetic-fallback"); profile.capabilities.push({ ...profile.capabilities[0], model: "synthetic-fallback" }); }
  const profileHash = frozenGeminiRuntimeProfileHash(profile), policyHash = customerAgentProviderIdentities(snapshot).providerPolicyHash;
  const registry = createGeminiCapabilityRegistry(profile.capabilities), events: string[] = [], records: ProviderAttemptRecord[] = [];
  let countResponse: unknown = { totalTokens: 1000 }, countHandler: (() => Promise<Response>) | undefined;
  const controller = new AbortController(), key = "synthetic-counted-key";
  const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 10_000, maxAttempts: 4,
    profileRevision: profile.profileRevision, policyHash, signal: controller.signal, supports: registry.supports,
    accountant: { reserve: async () => { events.push("reserve"); return true; }, settle: async row => { events.push("settle"); records.push(row); } } });
  let guardCalls = 0;
  const guard = vi.fn(async () => { events.push("guard"); return options.guard?.(++guardCalls) ?? true; });
  bindGeminiRuntimeToOperation(operation, { profile, expectedProfileRevision: profile.profileRevision, expectedProfileHash: profileHash,
    keys: [key], countContext: { expectedProviderPolicyHash: policyHash, assertCurrent: guard } });
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const endpoint = String(url);
    if (endpoint === `https://synthetic-proxy.invalid/gemini/v1beta/models/${profile.runtime.model}:countTokens`) {
      events.push("count"); return countHandler ? countHandler() : new Response(JSON.stringify(countResponse));
    }
    if (endpoint === `https://synthetic-proxy.invalid/gemini/v1beta/models/${profile.runtime.model}:generateContent`) {
      events.push("generate"); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "synthetic useful result" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 10, thoughtsTokenCount: 0, cachedContentTokenCount: 0 } }));
    }
    throw new Error("Unexpected synthetic request");
  });
  vi.stubGlobal("fetch", fetch);
  const input: Parameters<typeof callGeminiTools>[0] = { apiKey: key, system: "Synthetic stable prefix", contents: [{ role: "user", parts: [{ text: "Нарх?" }] }],
    tools: [{ name: "get_property_facts", description: "Read public facts", parameters: { type: "object", properties: { kinds: { type: "array" } }, additionalProperties: false } }],
    maxTokens: 2048, providerOperation: operation };
  const wire = () => callGeminiTools(input);
  const spec: ProviderAttemptSpec = { provider: "google", api: "generateContent", adapter: "tools", model: profile.runtime.model,
    profileRevision: operation.profileRevision, endpoint: "assistant-tools", maxOutputTokens: 2048, features: { functions: true, thinking: "level" } };
  function requestFor(attempt: Awaited<ReturnType<typeof operation.begin>>) {
    const target = boundGeminiCountContext(operation)?.selectTarget(profile.runtime.model, key);
    if (!target) throw new Error("Actual server binding target required");
    return { operation, attempt, model: target.model,
      serializedBody: JSON.stringify({ contents: [], systemInstruction: { parts: [{ text: "fixture" }] }, tools: [],
        generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: "minimal" } } }),
      generateUrl: target.generateUrl, headers: target.headers };
  }
  return { profile, policyHash, key, operation, controller, guard, events, records, fetch, input, wire, spec, requestFor,
    setCount(value: unknown) { countResponse = value; }, setCountHandler(value: () => Promise<Response>) { countHandler = value; } };
}
describe("full tools count before generation, same original reserved attempt", () => {
  it("reserves ONCE before count, counts full exact system/functions/parts, and settles generation on the SAME ordinal", async () => {
    const f = fixture(); let definitionReads = 0;
    Object.defineProperty(f.input.tools[0], "description", { enumerable: true, get() { definitionReads++; return "Synthetic complete function definition"; } });
    f.input.contents = [{ role: "model", parts: [{ thoughtSignature: "synthetic-original-signature",
      functionCall: { name: "get_property_facts", id: "synthetic-call-1", args: { kinds: ["price"] } } }] },
    { role: "user", parts: [{ functionResponse: { name: "get_property_facts", id: "synthetic-call-1", response: { result: { status: "observed", ref: "e0" } } } }, { text: "Нарх?" }] }];
    expect((await f.wire()).text).toBe("synthetic useful result");
    expect(f.events).toEqual(["reserve", "guard", "count", "guard", "generate", "settle"]);
    expect(definitionReads).toBe(1); expect(f.fetch).toHaveBeenCalledTimes(2);
    const count = JSON.parse(String(f.fetch.mock.calls[0][1]?.body)).generateContentRequest;
    const { model, ...sameBody } = count;
    expect(model).toBe(`models/${f.profile.runtime.model}`);
    expect(JSON.stringify(sameBody)).toBe(f.fetch.mock.calls[1][1]?.body);
    expect(sameBody.systemInstruction.parts[0].text).toBe(f.input.system);
    expect(sameBody.contents).toEqual(f.input.contents);
    expect(sameBody.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(f.input.tools[0].parameters);
    expect(sameBody.tools[0].functionDeclarations[0]).not.toHaveProperty("parameters");
    expect(sameBody.tools[0].functionDeclarations[0].parametersJsonSchema.additionalProperties).toBe(false);
    expect(f.fetch.mock.calls[0][1]?.headers).toEqual(f.fetch.mock.calls[1][1]?.headers);
    expect(f.records).toHaveLength(1); expect(f.records[0]).toMatchObject({ operationId: f.operation.id, attemptNo: 1, outcome: "success" });
    expect(f.records[0].usage.completeness).toBe("complete");
  });
  it.each([{ totalTokens: 32769 }, { totalTokens: 1, extra: "unreviewed" }, { totalTokens: "1" }, { totalTokens: 1, cachedContentTokenCount: 1 }])(
    "invalid/oversized count %j cannot fall back to any paid generation", async count => {
      const f = fixture({ fallback: true }); f.setCount(count);
      await expect(f.wire()).rejects.toMatchObject({ name: "ProviderOperationError" });
      expect(f.events).toEqual(["reserve", "guard", "count", "settle"]); expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.records).toHaveLength(1); expect(f.records[0].usage.completeness).toBe("missing"); expect(f.records[0].outcome).toBe("unknown");
    });
  it("UTF8 oversize (not just character count) denies even count I/O; reserve is not forged as usage/refund", async () => {
    const f = fixture(); f.input.system = "ҷ".repeat(70000);
    await expect(f.wire()).rejects.toMatchObject({ name: "ProviderOperationError" });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.records[0].usage.source).toBe("missing");
  });
  it.each([1, 2])("original IN/facts changes at guard %i deny generation", async failAt => {
    const f = fixture({ guard: callNo => callNo !== failAt });
    await expect(f.wire()).rejects.toMatchObject({ name: "ProviderOperationError" });
    expect(f.events).not.toContain("generate"); expect(f.fetch).toHaveBeenCalledTimes(failAt - 1);
    expect(f.records[0].usage.completeness).toBe("missing");
  });
  it("a hung count is bounded at 2s even if fetch ignores AbortSignal, with zero generation or fallback", async () => {
    vi.useFakeTimers(); const f = fixture({ fallback: true }); f.setCountHandler(() => new Promise(() => {}));
    const pending = f.wire(), rejected = expect(pending).rejects.toMatchObject({ name: "ProviderOperationError" });
    await vi.advanceTimersByTimeAsync(2001); await rejected;
    expect(f.events).not.toContain("generate"); expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.records).toHaveLength(1);
    expect(f.records[0].usage.completeness).toBe("missing");
  });
  it("original cancellation during count produces no generation and no renewed operation", async () => {
    const f = fixture(); f.setCountHandler(async () => { f.controller.abort(); return new Response('{"totalTokens":1000}'); });
    await expect(f.wire()).rejects.toMatchObject({ name: "ProviderOperationError" });
    expect(f.events).not.toContain("generate"); expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.records[0].operationId).toBe(f.operation.id);
  });
  it("count failure never emits reported generation usage or releases the original fixed reservation", async () => {
    const f = fixture(); f.setCountHandler(async () => new Response("synthetic unavailable", { status: 503 }));
    await expect(f.wire()).rejects.toMatchObject({ name: "ProviderOperationError" });
    expect(f.records[0]).toMatchObject({ outcome: "unknown", usage: { source: "missing", completeness: "missing", inputTokens: null, outputTokens: null } });
    expect(f.records[0].attemptNo).toBe(1); expect(f.events.filter(event => event === "reserve")).toHaveLength(1);
  });
  it("one ordinal cannot count twice; opaque witness is consumed exactly once and forged JSON is denied", async () => {
    const f = fixture(), attempt = await f.operation.begin(f.spec, 5000);
    try {
      const request = f.requestFor(attempt);
      const witness = await countGeminiToolsRequest(request);
      expect(() => consumeGeminiToolsCount({ totalTokens: 1 }, request)).toThrow();
      await expect(countGeminiToolsRequest(request)).rejects.toMatchObject({ name: "ProviderOperationError" });
      expect(consumeGeminiToolsCount(witness, request)).toBe(request.serializedBody);
      expect(() => consumeGeminiToolsCount(witness, request)).toThrow(); expect(f.fetch).toHaveBeenCalledTimes(1);
    } finally { await attempt.finish("unknown"); }
  });
  it.each(["body", "model", "key", "url", "proxy"])("witness mismatch %s denies and burns the witness without generation", async kind => {
    const f = fixture(), attempt = await f.operation.begin(f.spec, 5000);
    try {
      const request = f.requestFor(attempt);
      const witness = await countGeminiToolsRequest(request);
      const changed = kind === "body" ? { ...request, serializedBody: request.serializedBody.replace('"contents":[]', '"contents":[{"role":"user"}]') }
        : kind === "model" ? { ...request, model: "synthetic-other-model" }
          : kind === "key" ? { ...request, headers: { ...request.headers, "x-goog-api-key": "synthetic-other-key" } }
            : kind === "proxy" ? { ...request, headers: { ...request.headers, "x-proxy-key": "synthetic-other-proxy-key" } }
              : { ...request, generateUrl: request.generateUrl + "?changed=1" };
      expect(() => consumeGeminiToolsCount(witness, changed)).toThrow(); expect(() => consumeGeminiToolsCount(witness, request)).toThrow();
      expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.events).not.toContain("generate");
    } finally { await attempt.finish("unknown"); }
  });
  it.each(["model", "key", "host", "path", "proxy", "missing_proxy", "extra_header"])("wrong INITIAL %s is rejected BEFORE any count disclosure or current callback", async kind => {
    const f = fixture(), attempt = await f.operation.begin(f.spec, 5000);
    try {
      const request = f.requestFor(attempt);
      const changed = kind === "model" ? { ...request, model: "synthetic-unselected-model" }
        : kind === "key" ? { ...request, headers: { ...request.headers, "x-goog-api-key": "synthetic-unbound-key" } }
          : kind === "host" ? { ...request, generateUrl: request.generateUrl.replace("https://synthetic-proxy.invalid", "https://other.invalid") }
            : kind === "path" ? { ...request, generateUrl: request.generateUrl.replace("/gemini/v1beta/", "/untrusted/v1beta/") }
              : kind === "proxy" ? { ...request, headers: { ...request.headers, "x-proxy-key": "synthetic-other-proxy-key" } }
                : kind === "missing_proxy" ? { ...request, headers: { "Content-Type": "application/json", "x-goog-api-key": f.key } }
                  : { ...request, headers: { ...request.headers, Authorization: "synthetic-extra-header" } };
      await expect(countGeminiToolsRequest(changed)).rejects.toMatchObject({ name: "ProviderOperationError" });
      expect(f.fetch).not.toHaveBeenCalled(); expect(f.guard).not.toHaveBeenCalled();
    } finally { await attempt.finish("unknown"); }
  });
  it("mutable environment changes after binding cannot select another host/path/key for count or generation", async () => {
    const f = fixture();
    vi.stubEnv("GEMINI_PROXY_URL", "https://other.invalid/untrusted"); vi.stubEnv("GEMINI_PROXY_KEY", "synthetic-rotated-env-proxy-key");
    expect((await f.wire()).text).toBe("synthetic useful result");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of f.fetch.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/synthetic-proxy\.invalid\/gemini\/v1beta\/models\//);
      expect(init?.headers).toMatchObject({ "x-goog-api-key": f.key, "x-proxy-key": "synthetic-proxy-key" });
    }
  });
  it("caller mutation during the first await cannot redirect or change the captured count request", async () => {
    let request: ReturnType<ReturnType<typeof fixture>["requestFor"]> | undefined;
    const f = fixture({ guard: callNo => {
      if (callNo === 1 && request) Object.assign(request, { model: "synthetic-unselected-model", generateUrl: "https://other.invalid/:generateContent",
        headers: { "x-goog-api-key": "synthetic-unbound-key" }, serializedBody: "{}" });
      return true;
    } });
    const attempt = await f.operation.begin(f.spec, 5000);
    try {
      request = f.requestFor(attempt);
      const capturedBody = request.serializedBody, witness = await countGeminiToolsRequest(request);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(String(f.fetch.mock.calls[0][0])).toBe(`https://synthetic-proxy.invalid/gemini/v1beta/models/${f.profile.runtime.model}:countTokens`);
      const { model, ...actualBody } = JSON.parse(String(f.fetch.mock.calls[0][1]?.body)).generateContentRequest;
      expect(model).toBe(`models/${f.profile.runtime.model}`); expect(JSON.stringify(actualBody)).toBe(capturedBody);
      expect(f.fetch.mock.calls[0][1]?.headers).toMatchObject({ "x-goog-api-key": f.key, "x-proxy-key": "synthetic-proxy-key" });
      expect(() => consumeGeminiToolsCount(witness, request!)).toThrow(); expect(f.events).not.toContain("generate");
    } finally { await attempt.finish("unknown"); }
  });
  it("recovered durable ordinal exhaustion prevents even the first new count request", async () => {
    const f = fixture();
    const recovered = createRecoveredProviderOperation({ id: f.operation.id, managed: true, deadlineAt: f.operation.deadlineAt, maxAttempts: 4,
      profileRevision: f.operation.profileRevision, policyHash: f.policyHash, completedAttempts: 4, supports: () => true,
      accountant: { reserve: async () => { throw new Error("No fifth reservation allowed"); }, settle: async () => {} } });
    bindGeminiRuntimeToOperation(recovered, { profile: f.profile, expectedProfileRevision: f.profile.profileRevision,
      expectedProfileHash: frozenGeminiRuntimeProfileHash(f.profile), keys: [f.key], countContext: { expectedProviderPolicyHash: f.policyHash, assertCurrent: f.guard } });
    await expect(callGeminiTools({ ...f.input, providerOperation: recovered })).rejects.toMatchObject({ reason: "attempt_budget" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

it("selected JSON Schema Value profile rejects a legacy Schema field before count/generate without stripping it", async () => {
  const f = fixture(), attempt = await f.operation.begin(f.spec, 5000);
  try {
    const request = f.requestFor(attempt), body = JSON.parse(request.serializedBody);
    body.tools = [{ functionDeclarations: [{ name: "empty", description: "No args", parameters: {
      type: "object", properties: {}, additionalProperties: false,
    } }] }];
    request.serializedBody = JSON.stringify(body);
    await expect(countGeminiToolsRequest(request)).rejects.toMatchObject({ name: "ProviderOperationError" });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.guard).not.toHaveBeenCalled();
  } finally { await attempt.finish("unknown"); }
});

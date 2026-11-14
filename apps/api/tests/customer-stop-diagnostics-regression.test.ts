import { afterEach, describe, expect, it, vi } from "vitest";
import { runCustomerAgentTurn, type CustomerAgentModelTurn, type CustomerCoreFrame, type CustomerCorePorts } from "../src/ai/customerAgentCore.js";
import { createProviderOperation } from "../src/ai/providerContract.js";
import { callGeminiTools } from "../src/ai/geminiClient.js";
import { createCustomerAgentModel } from "../src/ai/customerAgentModel.js";
import { bindGeminiRuntimeToOperation, frozenGeminiRuntimeProfileHash, type FrozenGeminiRuntimeProfile } from "../src/ai/geminiOperationRuntime.js";
import { createGeminiCapabilityRegistry } from "../src/ai/geminiCapabilities.js";
import type { ProviderAttemptRecord } from "../src/ai/providerContract.js";
import { decodeManagedGeminiToolsUsage } from "../src/ai/geminiManagedToolsUsage.js";

vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn(async () => {}),
}));
vi.mock("../src/ai/geminiSettings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiSettings.js")>()),
  resolveGeminiRuntime: vi.fn(async () => ({ model: "synthetic-primary",
  keys: ["synthetic-key"], fallbackModels: [], transcribeModels: [], imageModel: "synthetic-image", liteModel: "", explicitCaching: false })) }));

const hash = "a".repeat(64);
const revision = { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash,
  knowledgeSchemaHash: hash, knowledgeSourceHash: hash, providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
  limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } };
const json = (value: unknown): CustomerAgentModelTurn => ({ text: JSON.stringify(value), calls: [], modelParts: [] });
const callback: CustomerAgentModelTurn = { text: "", calls: [{ name: "request_callback", args: { topic: "synthetic" }, id: "synthetic-callback" }],
  modelParts: [{ functionCall: { name: "request_callback", args: { topic: "synthetic" }, id: "synthetic-callback" } }] };
const profileRevision = "synthetic-profile-v1";
const profile: FrozenGeminiRuntimeProfile = { version: 1, profileRevision,
  runtime: { model: "synthetic-primary", fallbackModels: [], transcribeModels: [], imageModel: "synthetic-image", liteModel: "", explicitCaching: false },
  capabilities: [{ revision: profileRevision, model: "synthetic-primary", api: "generateContent", adapters: ["tools"],
    modalities: ["text"], tools: "function", structuredReply: false, thinking: "level", explicitCache: false, grounding: false,
    maxOutputTokens: 1024 }] };

function wireFixture(responses: Record<string, unknown>[]) {
  const registry = createGeminiCapabilityRegistry(profile.capabilities);
  const records: ProviderAttemptRecord[] = [];
  const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 3,
    profileRevision, supports: registry.supports,
    decodeUsage: usage => decodeManagedGeminiToolsUsage(usage).usage,
    accountant: { reserve: async () => true, settle: async record => { records.push(record); } } });
  const key = "synthetic-key";
  bindGeminiRuntimeToOperation(operation, { profile, expectedProfileRevision: profileRevision,
    expectedProfileHash: frozenGeminiRuntimeProfileHash(profile), keys: [key] });
  const fetch = vi.fn(async () => new Response(JSON.stringify(responses.shift() ?? { candidates: [] })));
  vi.stubGlobal("fetch", fetch);
  const model = createCustomerAgentModel({ apiKey: key, system: "Synthetic pinned system", revision, assertInputBudget: () => {},
    requirePinnedRuntime: () => true, call: callGeminiTools });
  return { operation, key, records, fetch, model };
}

const completeUsage = { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 0, cachedContentTokenCount: 0 };
const validCorrection = { candidates: [{ content: { parts: [{ text: JSON.stringify({ kind: "reply", refs: ["e0"], social: "none", question: "none" }) }] }, finishReason: "STOP" }],
  usageMetadata: completeUsage };
function mutatingCall(finishReason: string, extra: Record<string, unknown> = {}) {
  return { candidates: [{ content: { parts: [{ thoughtSignature: "synthetic-thought-signature",
    functionCall: { name: "request_callback", args: { topic: "synthetic" }, id: "synthetic-callback" } }] }, finishReason }],
    usageMetadata: completeUsage, ...extra };
}

function fixture(overrides: Partial<CustomerCoreFrame> = {}) {
  const controller = new AbortController();
  const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 8, signal: controller.signal,
    accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
  const frame: CustomerCoreFrame = { surface: "dm", language: "ru", inputText: "Синтетический вопрос", knownPhoneSource: "none", requestedFacts: [],
    revision, startedAt: Date.now(), operation, tools: [{ name: "request_callback", description: "Synthetic callback" }], ...overrides };
  const modelTurn = vi.fn<CustomerCorePorts["modelTurn"]>(async () => json({ kind: "reply", refs: [], social: "none", question: "none" }));
  const executeAllowedTool = vi.fn<CustomerCorePorts["executeAllowedTool"]>(async () => ({ status: "observed", observation: { kind: "receipt", outcome: "callback_requested" } }));
  const assertCurrent = vi.fn<CustomerCorePorts["assertCurrent"]>(async () => true);
  const requestStop = vi.fn<CustomerCorePorts["requestStop"]>(reason => controller.abort(reason));
  const observeLateToolResult = vi.fn<CustomerCorePorts["observeLateToolResult"]>();
  return { frame, operation, modelTurn, executeAllowedTool, ports: { modelTurn, executeAllowedTool, assertCurrent,
    requestStop, observeLateToolResult } satisfies CustomerCorePorts };
}

afterEach(() => vi.useRealTimers());

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("synthetic customer-agent stop diagnostics", () => {
  it("classifies a provider failure by its safe cause and stops before tools", async () => {
    const f = fixture();
    f.modelTurn.mockRejectedValue(new Error("provider_quota_exceeded"));

    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held", reason: "turn_unavailable",
      cause: "provider_quota_exceeded", rounds: 0, toolCalls: 0 });
    expect(f.modelTurn).toHaveBeenCalledTimes(1);
    expect(f.executeAllowedTool).not.toHaveBeenCalled();
  });

  it("holds after one bounded correction for a schema-invalid final", async () => {
    const f = fixture();
    f.modelTurn.mockResolvedValueOnce({ text: "not-json", calls: [], modelParts: [{ text: "not-json" }] })
      .mockResolvedValueOnce({ text: "still-not-json", calls: [], modelParts: [{ text: "still-not-json" }] });

    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held", reason: "invalid_model_decision",
      rounds: 2, toolCalls: 0 });
    expect(f.modelTurn).toHaveBeenCalledTimes(2);
    expect(f.executeAllowedTool).not.toHaveBeenCalled();
  });

  it("holds at the pinned round cap when each response asks for another read", async () => {
    const f = fixture({ requestedFacts: [], tools: [{ name: "get_property_facts", description: "Synthetic read" }] });
    f.executeAllowedTool.mockResolvedValue({ status: "observed", observation: { kind: "facts", facts: {
      propertyId: "00000000-0000-4000-8000-000000000001", shortId: 123, price: "123456.78", currency: "TJS",
      availability: "AVAILABLE", publicAddress: "Synthetic district", addressPolicy: "district_city_only", builder: null,
      publicLink: null, updatedAt: "2026-10-15T00:00:00.000Z", signature: hash,
    }, kinds: ["price"] } });
    let read = 0;
    f.modelTurn.mockImplementation(async () => {
      const id = `synthetic-read-${++read}`;
      const call = { name: "get_property_facts" as const, args: { kinds: ["price"] as const }, id };
      return { text: "", calls: [call], modelParts: [{ functionCall: call }] };
    });

    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held", reason: "round_limit", rounds: 3, toolCalls: 3 });
    expect(f.modelTurn).toHaveBeenCalledTimes(3);
    expect(f.executeAllowedTool).toHaveBeenCalledTimes(3);
  });

  it("keeps an uncertain write HELD and never executes it a second time", async () => {
    const f = fixture();
    f.executeAllowedTool.mockResolvedValue({ status: "unknown", reason: "synthetic_delivery_unknown" });
    f.modelTurn.mockResolvedValueOnce(callback);

    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held", reason: "effect_unknown",
      rounds: 1, toolCalls: 1, unknownToolCalls: [{ callKey: "synthetic-callback", name: "request_callback" }] });
    expect(f.modelTurn).toHaveBeenCalledTimes(1);
    expect(f.executeAllowedTool).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["MAX_TOKENS", mutatingCall("MAX_TOKENS"), "model_output_incomplete", "invalid"],
    ["SAFETY", mutatingCall("SAFETY", { promptFeedback: { blockReason: "SAFETY" } }), "model_prompt_blocked", "blocked"],
    ["MALFORMED_FUNCTION_CALL", mutatingCall("MALFORMED_FUNCTION_CALL"), "model_function_call_malformed", "invalid"],
  ])("never executes a valid mutating call from a non-final %s response", async (_label, stoppedResponse, cause, outcome) => {
    const wire = wireFixture([stoppedResponse, validCorrection]);
    const core = fixture({ operation: wire.operation });
    const result = await runCustomerAgentTurn(core.frame, { ...core.ports, modelTurn: wire.model });

    expect({ httpPosts: wire.fetch.mock.calls.length, providerOutcomes: wire.records.map(record => record.outcome),
      executedEffects: core.executeAllowedTool.mock.calls.length, result }).toMatchObject({
      httpPosts: 1, providerOutcomes: [outcome], executedEffects: 0,
      result: { status: "held", reason: "turn_unavailable", cause, rounds: 0, toolCalls: 0 },
    });
    expect(core.executeAllowedTool).not.toHaveBeenCalled();
  });

  it("classifies a missing candidate as a safe stop instead of inventing a model decision", async () => {
    const wire = wireFixture([{ candidates: [], usageMetadata: completeUsage }, validCorrection]);
    const core = fixture({ operation: wire.operation });
    const result = await runCustomerAgentTurn(core.frame, { ...core.ports, modelTurn: wire.model });

    expect({ httpPosts: wire.fetch.mock.calls.length, providerOutcomes: wire.records.map(record => record.outcome),
      executedEffects: core.executeAllowedTool.mock.calls.length, result }).toMatchObject({
      httpPosts: 1, providerOutcomes: ["invalid"], executedEffects: 0,
      result: { status: "held", reason: "turn_unavailable", cause: "model_candidate_missing", rounds: 0, toolCalls: 0 },
    });
  });

  it("preserves STOP function calls and their thought signature", async () => {
    const wire = wireFixture([mutatingCall("STOP")]);
    const result = await wire.model({ contents: [{ role: "user", parts: [{ text: "Synthetic" }] }], tools: [], revision,
      operation: wire.operation, wait: { signal: new AbortController().signal, deadlineAt: wire.operation.deadlineAt } });

    expect(result.calls).toEqual([{ name: "request_callback", args: { topic: "synthetic" }, id: "synthetic-callback" }]);
    expect(result.modelParts).toEqual([{ thoughtSignature: "synthetic-thought-signature",
      functionCall: { name: "request_callback", args: { topic: "synthetic" }, id: "synthetic-callback" } }]);
  });

  it("leaves the unmanaged legacy tool caller on its existing result path", async () => {
    const wire = wireFixture([]);
    const fetch = vi.fn(async () => new Response(JSON.stringify(mutatingCall("MAX_TOKENS"))));
    vi.stubGlobal("fetch", fetch);
    const result = await callGeminiTools({ apiKey: wire.key, system: "Synthetic legacy system", contents: [{ role: "user", parts: [{ text: "Synthetic" }] }], tools: [] });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.calls).toEqual([{ name: "request_callback", args: { topic: "synthetic" }, id: "synthetic-callback" }]);
  });

  it("keeps incomplete declared usage partial and held when the non-final turn contains a write", async () => {
    const response = mutatingCall("MAX_TOKENS", { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } });
    const wire = wireFixture([response, validCorrection]);
    const core = fixture({ operation: wire.operation });
    const result = await runCustomerAgentTurn(core.frame, { ...core.ports, modelTurn: wire.model });

    expect({ httpPosts: wire.fetch.mock.calls.length, records: wire.records, executedEffects: core.executeAllowedTool.mock.calls.length, result }).toMatchObject({
      httpPosts: 1, records: [{ outcome: "invalid", usage: { source: "reported", completeness: "partial" } }], executedEffects: 0,
      result: { status: "held", reason: "turn_unavailable", cause: "model_output_incomplete", rounds: 0, toolCalls: 0 },
    });
    expect(core.executeAllowedTool).not.toHaveBeenCalled();
  });
});

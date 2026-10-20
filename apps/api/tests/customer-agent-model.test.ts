import { describe, expect, it, vi } from "vitest";
import type { callGeminiTools } from "../src/ai/geminiClient.js";
import { createCustomerAgentModel } from "../src/ai/customerAgentModel.js";
import { createProviderOperation } from "../src/ai/providerContract.js";

const hash = "a".repeat(64);
const revision = { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash,
  knowledgeSchemaHash: hash, knowledgeSourceHash: hash, providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
  limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } };
function fixture() {
  const controller = new AbortController();
  const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 3, signal: controller.signal,
    accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
  const call = vi.fn<typeof callGeminiTools>(async () => ({ text: "synthetic", calls: [], modelParts: [], tokens: 1 }));
  const assertInputBudget = vi.fn(), requirePinnedRuntime = vi.fn(() => true as const);
  const model = createCustomerAgentModel({ apiKey: "synthetic-no-network", system: "Synthetic pinned server prefix", revision, assertInputBudget, requirePinnedRuntime, call });
  const input = { contents: [{ role: "user" as const, parts: [{ text: "Салом" }] }], tools: [], revision, operation,
    wait: { signal: controller.signal, deadlineAt: operation.deadlineAt } };
  return { controller, operation, call, assertInputBudget, requirePinnedRuntime, model, input };
}
describe("CustomerAgentModel draft actual adapter contract", () => {
  it("preserves signed sidecar narration without exposing a mixed final decision", async () => {
    const f = fixture(), calls = [{ name: "get_property_facts", args: { kinds: ["price"] }, id: "signed-1" }];
    const parts = [{ text: "Сейчас уточню цену", thoughtSignature: "synthetic-signature" }, { functionCall: calls[0] }];
    f.call.mockResolvedValue({ text: "Сейчас уточню цену", calls, modelParts: parts, tokens: 2 });
    expect(await f.model(f.input)).toEqual({ text: "", calls, modelParts: parts });
    expect(f.call).toHaveBeenCalledTimes(1);
  });
  it("passes the SAME original operation and exact approved output bound to the real wire ABI", async () => {
    const f = fixture(); await f.model(f.input);
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.call.mock.calls[0][0]).toMatchObject({ maxTokens: 1024, apiKey: "synthetic-no-network", providerOperation: f.operation });
    expect(f.call.mock.calls[0][0].providerOperation).toBe(f.operation);
    expect(f.assertInputBudget).toHaveBeenCalledTimes(1);
    expect(f.assertInputBudget.mock.invocationCallOrder[0]).toBeLessThan(f.call.mock.invocationCallOrder[0]);
    expect(f.requirePinnedRuntime).toHaveBeenCalledWith(f.operation, revision.providerProfileHash);
    expect(f.requirePinnedRuntime.mock.invocationCallOrder[0]).toBeLessThan(f.call.mock.invocationCallOrder[0]);
  });
  it("keeps model part signatures/order and call IDs unchanged", async () => {
    const f = fixture();
    const parts = [{ text: "", thoughtSignature: "synthetic-signature" }, { functionCall: { name: "get_property_facts", args: { kinds: ["price"] }, id: "a1" } }];
    const calls = [{ name: "get_property_facts", args: { kinds: ["price"] }, id: "a1" }];
    f.call.mockResolvedValue({ text: "", calls, modelParts: parts, tokens: 2 });
    expect(await f.model(f.input)).toEqual({ text: "", calls, modelParts: parts });
  });
  it("input-budget denial prevents wire I/O", async () => {
    const f = fixture(); f.assertInputBudget.mockImplementation(() => { throw new Error("Unapproved token bound"); });
    await expect(f.model(f.input)).rejects.toThrow("Unapproved token bound"); expect(f.call).not.toHaveBeenCalled();
  });
  it("unbound or changed approved runtime denies BEFORE wire I/O", async () => {
    const f = fixture(); f.requirePinnedRuntime.mockImplementation(() => { throw new Error("Pinned runtime unavailable"); });
    await expect(f.model(f.input)).rejects.toThrow("Pinned runtime unavailable"); expect(f.call).not.toHaveBeenCalled();
  });
  it("revision mismatch and unmanaged operation never fall back to legacy paid I/O", async () => {
    const f = fixture();
    await expect(f.model({ ...f.input, revision: { ...revision, id: "b".repeat(64) } })).rejects.toThrow();
    const operation = createProviderOperation({ deadlineAt: Date.now() + 30_000, maxAttempts: 3 });
    await expect(f.model({ ...f.input, operation })).rejects.toThrow(); expect(f.call).not.toHaveBeenCalled();
  });
  it("cancellation during wire await does not expose a late model result", async () => {
    const f = fixture(); f.call.mockImplementation(async () => { f.controller.abort(); return { text: "synthetic", calls: [], modelParts: [], tokens: 1 }; });
    await expect(f.model(f.input)).rejects.toThrow(); expect(f.call).toHaveBeenCalledTimes(1);
  });
});

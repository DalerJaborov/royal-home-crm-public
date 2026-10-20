import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderOperation, geminiFunctionResponsePart, providerDayDeadline, type ProviderAttemptRecord } from "../src/ai/providerContract.js";
import { createGeminiCapabilityRegistry } from "../src/ai/geminiCapabilities.js";
import { calculateProviderCost } from "../src/ai/providerBudget.js";

const fixture = vi.hoisted(() => ({ runtime: { keys: ["synthetic-key-not-real"], model: "fixture-a", fallbackModels: [] as string[],
  transcribeModels: [], imageModel: "fixture-image", liteModel: "", explicitCaching: false } }));
vi.mock("../src/ai/geminiSettings.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/ai/geminiSettings.js")>()), resolveGeminiRuntime: vi.fn(async () => structuredClone(fixture.runtime)) }));
vi.mock("../src/lib/systemError.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/db.js", async importOriginal => { const original = await importOriginal<typeof import("../src/db.js")>(); return { ...original, prisma: { ...original.prisma,
  $disconnect: original.prisma.$disconnect.bind(original.prisma),
  geminiCache: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({}), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
} }; });
const metadata = { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 3, cachedContentTokenCount: 0 };
const response = (parts: unknown[]) => new Response(JSON.stringify({ candidates: [{ content: { parts }, finishReason: "STOP" }], usageMetadata: metadata }), { status: 200 });
const accounts: ProviderAttemptRecord[] = [];
const reserve = vi.fn(async () => true);
function operation(maxAttempts = 2, options: { signal?: AbortSignal; deadlineAt?: number; onSettle?: () => void; images?: boolean } = {}) {
  const registry = createGeminiCapabilityRegistry(["fixture-a", "fixture-b"].map(model => ({ model, revision: "fixture-v1", api: "generateContent", adapters: ["text", "tools"], modalities: ["text"],
    tools: "function", structuredReply: true, thinking: "level", explicitCache: false, grounding: false, maxOutputTokens: 6000,
    ...(options.images ? { modalities: ["text", "image"] as const } : {}) })));
  return createProviderOperation({ deadlineAt: options.deadlineAt ?? Date.now() + 10_000, signal: options.signal, maxAttempts, managed: true, profileRevision: "fixture-v1", supports: registry.supports,
    accountant: { reserve, settle: async row => { accounts.push(row); await Promise.resolve(); options.onSettle?.(); } } });
}
beforeEach(() => { accounts.length = 0; reserve.mockClear(); fixture.runtime.model = "fixture-a"; fixture.runtime.fallbackModels = []; fixture.runtime.explicitCaching = false; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("actual Gemini facades carry one managed operation, fake HTTP only", () => {
  it.each(["cancelled", "deadline"] as const)("tools do not release calls when %s arrives during settlement", async reason => {
    vi.useFakeTimers(); const controller = new AbortController(); const deadlineAt = Date.now() + 10_000;
    const { callGeminiTools } = await import("../src/ai/geminiClient.js");
    const fetch = vi.fn().mockResolvedValue(response([{ functionCall: { name: "fixture_tool", id: "paid-call", args: {} } }])); vi.stubGlobal("fetch", fetch);
    const op = operation(2, { signal: controller.signal, deadlineAt, onSettle: () => reason === "cancelled" ? controller.abort() : vi.setSystemTime(deadlineAt + 1) });
    await expect(callGeminiTools({ apiKey: "synthetic-key", system: "fixture", contents: [], tools: [], providerOperation: op })).rejects.toMatchObject({ reason });
    expect(fetch).toHaveBeenCalledTimes(1); expect(accounts).toHaveLength(1);
    expect(accounts[0].usage.completeness).toBe("complete"); expect(accounts[0].outcome).toBe("success");
  });
  it.each(["cancelled", "deadline"] as const)("outer retry rechecks the original operation before releasing a %s result", async reason => {
    vi.useFakeTimers(); const controller = new AbortController(); const deadlineAt = Date.now() + 10_000;
    const gemini = await import("../src/ai/geminiClient.js"); const { callAiText } = await import("../src/ai/client.js");
    const op = operation(2, { signal: controller.signal, deadlineAt });
    const call = vi.spyOn(gemini, "callGemini").mockResolvedValueOnce(null).mockImplementationOnce(async () => {
      await Promise.resolve(); if (reason === "cancelled") controller.abort(); else vi.setSystemTime(deadlineAt + 1);
      return { reply: "must not escape" };
    });
    await expect(callAiText({ endpoint: "qa-outer-boundary", system: "fixture", providerOperation: op })).rejects.toMatchObject({ reason });
    expect(call).toHaveBeenCalledTimes(2); expect(call.mock.calls.every(([params]) => params.providerOperation === op)).toBe(true);
    expect(reserve).not.toHaveBeenCalled();
  });
  it.each([
    { inline_data: { mime_type: "image/png", data: "synthetic" } },
    { inlineData: { mimeType: "image/png", data: "synthetic" } },
    { fileData: { mimeType: "image/jpeg", fileUri: "gs://synthetic/image" } },
  ])("text-only tools profile denies actual image carrier before reservation/HTTP: %j", async part => {
    const { callGeminiTools } = await import("../src/ai/geminiClient.js"); const fetch = vi.fn().mockResolvedValue(response([{ text: "unsafe" }])); vi.stubGlobal("fetch", fetch);
    await expect(callGeminiTools({ apiKey: "synthetic-key", system: "fixture", contents: [{ role: "user", parts: [part] }], tools: [], providerOperation: operation() })).rejects.toMatchObject({ reason: "unsupported" });
    expect(fetch).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });
  it.each(["audio/wav", "video/mp4", "application/pdf", ""])("tools deny unwired media %s even on an image profile", async mime => {
    const { callGeminiTools } = await import("../src/ai/geminiClient.js"); const fetch = vi.fn().mockResolvedValue(response([{ text: "unsafe" }])); vi.stubGlobal("fetch", fetch);
    await expect(callGeminiTools({ apiKey: "synthetic-key", system: "fixture", contents: [{ role: "user", parts: [{ fileData: { mimeType: mime, fileUri: "gs://synthetic/media" } }] }], tools: [], providerOperation: operation(2, { images: true }) })).rejects.toMatchObject({ reason: "unsupported" });
    expect(fetch).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });
  it.each([
    { functionResponse: { name: "fixture", response: {}, parts: [{ inlineData: { mimeType: "image/png", data: "synthetic" } }] } },
    { functionResponse: { name: "fixture", response: {}, parts: [{ fileData: { mimeType: "audio/wav", fileUri: "gs://synthetic/audio" } }] } },
    { videoMetadata: { startOffset: "0s" } },
  ])("nested/unknown managed media cannot bypass the actual parts gate: %j", async part => {
    const { callGeminiTools } = await import("../src/ai/geminiClient.js"); const fetch = vi.fn().mockResolvedValue(response([{ text: "unsafe" }])); vi.stubGlobal("fetch", fetch);
    await expect(callGeminiTools({ apiKey: "synthetic-key", system: "fixture", contents: [{ role: "user", parts: [part] }], tools: [], providerOperation: operation() })).rejects.toMatchObject({ reason: "unsupported" });
    expect(fetch).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });
  it("approved tools image retains raw parts but its text token counts are not complete image billing", async () => {
    const { callGeminiTools } = await import("../src/ai/geminiClient.js"); const fetch = vi.fn().mockResolvedValue(response([{ text: "image result" }])); vi.stubGlobal("fetch", fetch);
    const part = { inline_data: { mime_type: "image/png", data: "synthetic" } };
    const result = await callGeminiTools({ apiKey: "synthetic-key", system: "fixture", contents: [{ role: "user", parts: [part] }], tools: [], providerOperation: operation(2, { images: true }) });
    expect(result.text).toBe("image result"); expect(JSON.parse(fetch.mock.calls[0][1].body).contents[0].parts).toEqual([part]);
    expect(accounts).toHaveLength(1); expect(accounts[0].features?.images).toBe(true); expect(accounts[0].usage.completeness).toBe("partial");
    const billed = accounts[0];
    expect(calculateProviderCost({ pricingSource: "reference", rates: [{ model: billed.model, api: billed.api, adapter: billed.adapter,
      inputUsdPerMillion: "1", outputUsdPerMillion: "2", thinkingUsdPerMillion: "3", cacheReadUsdPerMillion: "0.1" }] }, billed, billed.usage)).toBeNull();
  });
  it("reserve wait crossing the pinned Dushanbe boundary produces zero POST", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-14T18:59:59.900Z"));
    const { callGemini } = await import("../src/ai/geminiClient.js"); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const op = createProviderOperation({ deadlineAt: providerDayDeadline(Date.now() + 10_000), maxAttempts: 2, managed: true, profileRevision: "fixture-v1", supports: () => true,
      accountant: { reserve: async () => { vi.setSystemTime(new Date("2026-10-14T19:00:00.001Z")); return true; }, settle: async row => { accounts.push(row); } } });
    await expect(callGemini({ endpoint: "qa-operation", system: "fixture", user: "fixture", providerOperation: op })).rejects.toMatchObject({ reason: "deadline" });
    expect(fetch).not.toHaveBeenCalled(); expect(accounts).toHaveLength(1); expect(accounts[0].outcome).toBe("timeout");
  });
  it("outer retry cannot reset the attempt ceiling and runtime snapshot", async () => {
    const { callAiText } = await import("../src/ai/client.js"); const { resolveGeminiRuntime } = await import("../src/ai/geminiSettings.js");
    vi.mocked(resolveGeminiRuntime).mockClear();
    const fetch = vi.fn().mockResolvedValue(new Response("fixture bad request", { status: 400 })); vi.stubGlobal("fetch", fetch);
    await expect(callAiText({ endpoint: "qa-operation", system: "fixture", user: "fixture", providerOperation: operation(1) })).rejects.toMatchObject({ reason: "attempt_budget" });
    expect(fetch).toHaveBeenCalledTimes(1); expect(reserve).toHaveBeenCalledTimes(1); expect(resolveGeminiRuntime).toHaveBeenCalledTimes(1);
    expect(accounts).toHaveLength(1); expect(accounts[0].usage.completeness).toBe("missing");
  });
  it("a billed malformed model and successful fallback retain separate model usage", async () => {
    fixture.runtime.fallbackModels = ["fixture-b"];
    const { callGemini } = await import("../src/ai/geminiClient.js");
    const fetch = vi.fn().mockResolvedValueOnce(response([{ text: "not JSON" }])).mockResolvedValueOnce(response([{ text: '{"reply":"ok"}' }])); vi.stubGlobal("fetch", fetch);
    expect(await callGemini({ endpoint: "qa-operation", system: "fixture", user: "fixture", providerOperation: operation() })).toEqual({ reply: "ok" });
    expect(accounts.map(row => [row.model, row.outcome, row.usage.thinkingTokens])).toEqual([["fixture-a", "invalid", 3], ["fixture-b", "success", 3]]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("unknown managed profile denies before cache creation or generation HTTP", async () => {
    fixture.runtime.model = "fixture-unapproved"; fixture.runtime.explicitCaching = true;
    const { callGemini } = await import("../src/ai/geminiClient.js"); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(callGemini({ endpoint: "qa-operation", system: "fixture", systemStable: "x".repeat(9000), user: "fixture", providerOperation: operation() })).rejects.toMatchObject({ reason: "unsupported" });
    expect(fetch).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });
  it("tool IDs and thought signatures survive actual request/response history", async () => {
    const { callGeminiTools } = await import("../src/ai/geminiClient.js");
    const signed = { thoughtSignature: "synthetic-signature", functionCall: { name: "fixture_tool", id: "provider-call-7", args: { q: "fixture" } } };
    const fetch = vi.fn().mockResolvedValueOnce(response([signed])).mockResolvedValueOnce(response([{ text: "done" }])); vi.stubGlobal("fetch", fetch);
    const op = operation(); const turn = await callGeminiTools({ apiKey: "synthetic-key", system: "fixture", contents: [], tools: [{ name: "fixture_tool", description: "fixture" }], providerOperation: op });
    expect(turn.calls[0].id).toBe("provider-call-7"); expect(turn.modelParts).toEqual([signed]);
    await callGeminiTools({ apiKey: "synthetic-key", system: "fixture", contents: [
      { role: "model", parts: turn.modelParts }, { role: "user", parts: [geminiFunctionResponsePart(turn.calls[0], { found: true })] },
    ], tools: [{ name: "fixture_tool", description: "fixture" }], providerOperation: op });
    const body = JSON.parse(fetch.mock.calls[1][1].body);
    expect(body.contents[0].parts).toEqual([signed]); expect(body.contents[1].parts[0].functionResponse.id).toBe("provider-call-7");
    expect(accounts.map(row => row.attemptNo)).toEqual([1, 2]);
  });
});

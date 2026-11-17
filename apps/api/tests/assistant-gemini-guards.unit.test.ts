import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeminiRuntime } from "../src/ai/geminiSettings.js";
import { createAssistantAttemptLimit } from "../src/ai/assistant/attemptLimit.js";
const telemetry = vi.hoisted(() => ({ logAiCall: vi.fn() }));

// Fully isolate persistence/settings modules: importing their originals can load .env/DB.
vi.mock("../src/db.js", () => ({ prisma: { $disconnect: vi.fn() } }));
vi.mock("../src/lib/botTurnTrace.js", () => ({
  traceModelStart: vi.fn(), traceModelFinish: vi.fn(), traceModelCache: vi.fn(), traceKnownSecrets: vi.fn(),
}));
vi.mock("../src/ai/shared.js", () => ({
  emptyUsage: () => ({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }),
  extractJson: JSON.parse, logAiCall: telemetry.logAiCall,
}));
vi.mock("../src/lib/systemError.js", () => ({ logSystemError: vi.fn() }));
vi.mock("../src/ai/geminiSettings.js", () => ({ resolveGeminiRuntime: vi.fn(() => { throw new Error("Unexpected settings read"); }) }));
vi.mock("../src/ai/geminiCache.js", () => ({ resolveGeminiCache: vi.fn(() => { throw new Error("Unexpected cache call"); }) }));
vi.mock("../src/ai/geminiOperationRuntime.js", () => ({
  resolveGeminiOperationRuntime: vi.fn(() => { throw new Error("Unexpected runtime resolution"); }),
  assertBoundGeminiRuntimeKey: vi.fn(), boundGeminiCountContext: vi.fn(() => null),
}));
vi.mock("../src/ai/geminiCountedTools.js", () => ({
  countGeminiToolsRequest: vi.fn(() => { throw new Error("Unexpected managed operation"); }),
  consumeGeminiToolsCount: vi.fn(() => { throw new Error("Unexpected managed operation"); }),
}));
// This original is a pure URL/config module: no dotenv, database, or transport side effects.
vi.mock("../src/ai/geminiTransport.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/ai/geminiTransport.js")>(),
  GEMINI_RETRY_DELAYS_MS: [0, 0],
  geminiGenerateUrlFor: (model: string) => `https://provider.invalid/${model}:generateContent`,
  geminiStreamUrlFor: (model: string) => `https://provider.invalid/${model}:streamGenerateContent`,
  geminiProxyHeaders: () => ({}),
}));

const runtime: GeminiRuntime = {
  keys: ["test-key"], model: "gemini-3.1-pro-preview", fallbackModels: [],
  liteModel: "", transcribeModels: [], imageModel: "", explicitCaching: false,
};
const params = () => ({
  apiKey: "test-key", system: "Test assistant", runtime, requireLowThinking: true, requireCompleteTurn: true,
  contents: [{ role: "user" as const, parts: [{ text: "Test request" }] }],
  tools: [{ name: "save_note", description: "Test tool" }], maxTokens: 1500,
});
function reply(finishReason = "STOP") {
  return { candidates: [{ content: { parts: [{ functionCall: { name: "save_note", args: { text: "test" } } }] }, finishReason }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, thoughtsTokenCount: 5 } };
}
function response(stream: boolean, finishReason = "STOP") {
  const payload = reply(finishReason);
  return new Response(stream ? `data: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload), {
    headers: { "content-type": stream ? "text/event-stream" : "application/json" },
  });
}
beforeEach(() => { vi.resetModules(); telemetry.logAiCall.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe.each([false, true])("Gemini assistant guard, stream=%s", (stream) => {
  async function invoke(extra: { beforeAttempt?: (attempt: import("../src/ai/geminiClient.js").AssistantProviderAttempt) => Promise<void> } = {}) {
    const api = await import("../src/ai/geminiClient.js");
    return stream
      ? api.callGeminiToolsStream({ ...params(), ...extra, onToken: vi.fn() })
      : api.callGeminiTools({ ...params(), ...extra });
  }
  it("reserves every physical retry before fetch", async () => {
    const events: string[] = [];
    const beforeAttempt = vi.fn(async () => { events.push("reserve"); });
    const fetch = vi.fn(async () => {
      events.push("fetch");
      return events.length === 2 ? new Response("unavailable", { status: 503 }) : response(stream);
    });
    vi.stubGlobal("fetch", fetch);
    const turn = await invoke({ beforeAttempt });
    expect(turn.calls).toHaveLength(1);
    expect(events).toEqual(["reserve", "fetch", "reserve", "fetch"]);
    expect(beforeAttempt).toHaveBeenCalledTimes(fetch.mock.calls.length);
  });
  it("passes the exact outgoing body and live cancellation signal to the spending guard", async () => {
    let reserved: import("../src/ai/geminiClient.js").AssistantProviderAttempt | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      expect(reserved?.body).toEqual(JSON.parse(String(init.body)));
      expect(reserved?.model).toBe(runtime.model);
      expect(reserved?.apiKey).toBe("test-key");
      expect(reserved?.kind).toBe("generate");
      expect(reserved?.signal?.aborted).toBe(false);
      return response(stream);
    }));
    await invoke({ beforeAttempt: async (attempt) => { reserved = attempt; } });
  });
  it("does not fetch when attempt reservation is denied", async () => {
    const fetch = vi.fn(() => { throw new Error("Must never fetch"); });
    vi.stubGlobal("fetch", fetch);
    const reserve = vi.fn(async () => false);
    await expect(invoke({ beforeAttempt: createAssistantAttemptLimit(reserve) })).rejects.toMatchObject({ code: "assistant_attempt_limit" });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retains explicit low after the provider rejected thinking in a prior request", async () => {
    const bodies: { generationConfig?: { thinkingConfig?: unknown } }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return bodies.length === 1 ? new Response("thinking parameter rejected", { status: 400 }) : response(stream);
    }));
    await expect(invoke()).rejects.toThrow("400");
    expect((await invoke()).calls).toHaveLength(1);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });
  it("returns executable tool calls only for a completed STOP turn", async () => {
    const fetch = vi.fn(async () => response(stream));
    vi.stubGlobal("fetch", fetch);
    expect((await invoke()).calls).toEqual([{ name: "save_note", args: { text: "test" } }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("excludes hidden thought text and counts reasoning tokens", async () => {
    const payload = { candidates: [{ finishReason: "STOP", content: { parts: [
      { text: "Private internal reasoning", thought: true }, { text: "Visible answer" },
    ] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, thoughtsTokenCount: 5 } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream ? `data: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload), {
      headers: { "content-type": stream ? "text/event-stream" : "application/json" },
    })));
    const turn = await invoke();
    expect(turn.text).toBe("Visible answer");
    expect(turn.tokens).toBe(35);
  });
  it("rejects MAX_TOKENS with a tool call without returning or retrying it", async () => {
    const fetch = vi.fn(async () => response(stream, "MAX_TOKENS"));
    vi.stubGlobal("fetch", fetch);
    await expect(invoke()).rejects.toMatchObject({ code: "assistant_incomplete_turn" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("grounded request accounting", () => {
  it("excludes hidden thoughts from grounded text and accounts their tokens", async () => {
    const api = await import("../src/ai/geminiClient.js");
    const payload = { candidates: [{ finishReason: "STOP", content: { parts: [
      { text: "Private reasoning", thought: true }, { text: "Visible answer" },
    ] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, thoughtsTokenCount: 5 } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload))));
    expect((await api.callGeminiGrounded({ apiKey: "test-key", query: "test", runtime, requireCompleteTurn: true }))?.text).toBe("Visible answer");
    expect(telemetry.logAiCall).toHaveBeenCalledWith(expect.objectContaining({ spent: expect.objectContaining({ inputTokens: 20, outputTokens: 15 }) }));
  });
  it("reserves each physical grounded retry, including transient failures", async () => {
    const api = await import("../src/ai/geminiClient.js");
    const events: string[] = [];
    const fetch = vi.fn(async () => {
      events.push("fetch");
      return events.length === 2 ? new Response("busy", { status: 503 }) : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Complete" }] }, finishReason: "STOP" }] }));
    });
    vi.stubGlobal("fetch", fetch);
    const result = await api.callGeminiGrounded({ apiKey: "test-key", query: "test", runtime,
      requireCompleteTurn: true, beforeAttempt: async () => { events.push("reserve"); } });
    expect(result?.text).toBe("Complete");
    expect(events).toEqual(["reserve", "fetch", "reserve", "fetch"]);
  });
  it("reserves each grounded fetch and retains low after prior rejection", async () => {
    const api = await import("../src/ai/geminiClient.js");
    const events: string[] = [], bodies: { generationConfig?: { thinkingConfig?: unknown } }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      events.push("fetch"); bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) return new Response("thinking rejected", { status: 400 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Test grounded answer" }] }, finishReason: "STOP" }] }), { headers: { "content-type": "application/json" } });
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const request = { apiKey: "test-key", query: "test", runtime, requireLowThinking: true,
      requireCompleteTurn: true, beforeAttempt: async () => { events.push("reserve"); } };
    expect(await api.callGeminiGrounded(request)).toBeNull();
    expect((await api.callGeminiGrounded(request))?.text).toBe("Test grounded answer");
    expect(events).toEqual(["reserve", "fetch", "reserve", "fetch"]);
    for (const body of bodies) expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });
  it("rejects incomplete grounded text without another paid attempt", async () => {
    const api = await import("../src/ai/geminiClient.js");
    const fetch = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Partial" }] }, finishReason: "MAX_TOKENS" }] })));
    vi.stubGlobal("fetch", fetch);
    await expect(api.callGeminiGrounded({ apiKey: "test-key", query: "test", runtime, requireCompleteTurn: true })).rejects.toMatchObject({ code: "assistant_incomplete_turn" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

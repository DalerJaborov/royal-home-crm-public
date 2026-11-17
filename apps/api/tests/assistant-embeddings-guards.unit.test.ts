import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ runtime: vi.fn() }));
vi.mock("../src/db.js", () => ({ prisma: { $disconnect: vi.fn() } }));
vi.mock("../src/ai/geminiSettings.js", () => ({ resolveGeminiRuntime: mocked.runtime }));
vi.mock("../src/ai/shared.js", () => ({ emptyUsage: () => ({}), logAiCall: vi.fn() }));
vi.mock("../src/lib/systemError.js", () => ({ logSystemError: vi.fn() }));
vi.mock("../src/ai/seoGenerator.js", () => ({ TYPE_RU: {}, CONDITION_RU: {}, formatPrice: vi.fn() }));
vi.mock("../src/ai/geminiTransport.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/ai/geminiTransport.js")>(),
  GEMINI_EMBEDDING_MODEL: "gemini-embedding-001", GEMINI_EMBEDDING_DIMENSIONS: 768,
  geminiEmbedUrlFor: () => "https://provider.invalid/embedContent", geminiProxyHeaders: () => ({}),
}));
import { embedText } from "../src/ai/embeddings.js";
beforeEach(() => { mocked.runtime.mockReset().mockResolvedValue({ keys: ["test-key-a", "test-key-b", "test-key-c"] }); });
afterEach(() => { vi.unstubAllGlobals(); });
it("bounds key fallback to a single paid attempt when requested", async () => {
  const fetch = vi.fn(async () => new Response("denied", { status: 401 }));
  const reserve = vi.fn(async () => {});
  vi.stubGlobal("fetch", fetch);
  expect(await embedText("Текст", "RETRIEVAL_QUERY", { beforeAttempt: reserve, maxAttempts: 1 })).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1); expect(reserve).toHaveBeenCalledTimes(1);
});
it("passes exact request metadata and reserves before each physical request", async () => {
  const order: string[] = [], metadata: unknown[] = [];
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    order.push("fetch"); calls++;
    return calls === 1 ? new Response("denied", { status: 401 }) : new Response(JSON.stringify({ embedding: { values: [1, 0] } }));
  }));
  const vector = await embedText("  Текст  ", "RETRIEVAL_DOCUMENT", {
    maxAttempts: 2, beforeAttempt: async (value) => { order.push("reserve"); metadata.push(value); },
  });
  expect(vector).toEqual([1, 0]); expect(order).toEqual(["reserve", "fetch", "reserve", "fetch"]);
  expect(metadata).toEqual(Array.from({ length: 2 }, () => ({ model: "gemini-embedding-001", inputCharacters: 5, taskType: "RETRIEVAL_DOCUMENT", outputDimensions: 768 })));
});
it("reservation denial is terminal without trying another key", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const reserve = vi.fn(async () => { throw new Error("budget denied"); });
  await expect(embedText("Текст", "RETRIEVAL_QUERY", { beforeAttempt: reserve, maxAttempts: 3 })).rejects.toThrow("budget denied");
  expect(reserve).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
});
it("propagates external cancellation without a second attempt", async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async () => { controller.abort(new Error("cancelled")); throw controller.signal.reason; });
  vi.stubGlobal("fetch", fetch);
  await expect(embedText("Текст", "RETRIEVAL_QUERY", { signal: controller.signal, maxAttempts: 3 })).rejects.toThrow("cancelled");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("rejects an already cancelled request before resolving runtime", async () => {
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await expect(embedText("Текст", "RETRIEVAL_QUERY", { signal: controller.signal })).rejects.toThrow("cancelled");
  expect(mocked.runtime).not.toHaveBeenCalled();
});

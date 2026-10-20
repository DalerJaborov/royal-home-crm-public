import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * АССИСТЕНТ (callGeminiTools) ОБЯЗАН ПЕРЕХОДИТЬ НА РЕЗЕРВНУЮ МОДЕЛЬ (18.08.2026).
 *
 * У обычных ответов бота (callGemini) фоллбек на GEMINI_FALLBACK_MODELS есть с
 * 16.08 — после дня, когда основная модель не отвечала вообще. У вызовов
 * инструментов CRM (ассистент, callGeminiTools) фоллбека не было: одна модель,
 * одна попытка, при 503/429 сразу throw. Тест закрепляет, что в такой же день
 * ассистент теперь тоже получает свой шанс на резервной модели, как и обычный чат.
 */

const logSystemError = vi.fn();
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: (...a: unknown[]) => logSystemError(...a) }));

const PRIMARY = "gemini-3.7-flash";
const FALLBACK = "gemini-3.6-flash";

type Call = { url: string; body: Record<string, unknown> };

function toolCallResponse(name: string, args: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name, args } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function loadClient() {
  delete process.env.GEMINI_PROXY_URL;
  delete process.env.GEMINI_PROXY_KEY;
  process.env.GEMINI_MODEL = PRIMARY;
  process.env.GEMINI_FALLBACK_MODEL = FALLBACK;
  vi.resetModules();
  return import("../src/ai/geminiClient.js");
}

describe("Ассистент (callGeminiTools): фоллбек на резервную модель", () => {
  const originalFetch = globalThis.fetch;
  let calls: Call[];

  beforeEach(() => {
    calls = [];
    logSystemError.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function stubFetch(handler: (call: Call) => Promise<Response>) {
    globalThis.fetch = vi.fn((url: unknown, init: unknown) => {
      const req = init as { body?: string };
      const call: Call = { url: String(url), body: JSON.parse(req?.body ?? "{}") as Record<string, unknown> };
      calls.push(call);
      return handler(call);
    }) as unknown as typeof fetch;
  }

  it("основная модель перегружена (503) — ассистент отвечает с резервной, а не падает", async () => {
    const { callGeminiTools } = await loadClient();

    stubFetch((call) =>
      Promise.resolve(
        call.url.includes(PRIMARY)
          ? new Response("high demand", { status: 503 })
          : toolCallResponse("submit_reply", { reply: "ответ с резерва" })
      )
    );

    const turn = await callGeminiTools({
      apiKey: "test-key",
      system: "правила ассистента",
      contents: [{ role: "user", parts: [{ text: "покажи клиентов" }] }],
      tools: [{ name: "submit_reply", parameters: { type: "object", properties: { reply: { type: "string" } } } }],
    });

    expect(turn.calls).toEqual([{ name: "submit_reply", args: { reply: "ответ с резерва" } }]);
    expect(calls.some((c) => c.url.includes(FALLBACK))).toBe(true);

    const messages = logSystemError.mock.calls.map((c) => String(c[1])).join("\n");
    expect(messages).toContain("РЕЗЕРВНОЙ модели");
  });

  it("основная модель снята (404) — ассистент уходит на резервную, как обычный чат (CHANNEL-NEW-05)", async () => {
    const { callGeminiTools } = await loadClient();

    stubFetch((call) =>
      Promise.resolve(
        call.url.includes(PRIMARY)
          ? new Response("models/x is not found", { status: 404 })
          : toolCallResponse("submit_reply", { reply: "ответ с резерва" })
      )
    );

    const turn = await callGeminiTools({
      apiKey: "test-key",
      system: "правила ассистента",
      contents: [{ role: "user", parts: [{ text: "покажи клиентов" }] }],
      tools: [{ name: "submit_reply", parameters: { type: "object", properties: { reply: { type: "string" } } } }],
    });

    expect(turn.calls).toEqual([{ name: "submit_reply", args: { reply: "ответ с резерва" } }]);
    expect(calls.some((c) => c.url.includes(FALLBACK))).toBe(true);
  });

  it("400 (не перегрузка, а сам запрос неверный) — резервную модель не пробует", async () => {
    const { callGeminiTools } = await loadClient();

    stubFetch(() => Promise.resolve(new Response("bad request", { status: 400 })));

    await expect(
      callGeminiTools({
        apiKey: "test-key",
        system: "правила ассистента",
        contents: [{ role: "user", parts: [{ text: "покажи клиентов" }] }],
        tools: [{ name: "submit_reply" }],
      })
    ).rejects.toThrow("Gemini HTTP 400");

    expect(calls).toHaveLength(1);
    expect(calls[0].url.includes(PRIMARY)).toBe(true);
  });
});

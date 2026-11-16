import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ЦЕПОЧКА МОДЕЛЕЙ ОЗВУЧКИ ASSISTANT (16.11.2026). Google отключает
 * gemini-2.5-flash-preview-tts 18.12.2026; умолчание — две модели 3.8 (основная
 * lite и запасная), чтобы 404 одной из них не оставлял озвучку молчать.
 * Здесь закреплено: какая цепочка выбирается (умолчание / .env / старое имя
 * переменной / мусор) и что synthesizeSpeech на 404 основной идёт к запасной.
 * База не нужна: ключи и журнал подменены.
 */

const LITE = "gemini-3.8-flash-lite-tts";
const FULL = "gemini-3.8-flash-tts";

async function loadChain(env: Record<string, string | undefined>): Promise<string[]> {
  vi.resetModules();
  for (const k of ["GEMINI_TTS_MODELS", "GEMINI_TTS_MODEL"]) vi.stubEnv(k, env[k] ?? "");
  const mod = await import("../src/ai/geminiTransport.js");
  return mod.GEMINI_TTS_MODELS;
}

describe("выбор цепочки TTS-моделей", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("умолчание: lite первой, 3.8-flash-tts запасной, 2.5 нет совсем", async () => {
    const chain = await loadChain({});
    expect(chain).toEqual([LITE, FULL]);
    expect(chain.join(",")).not.toContain("2.5");
  });

  it("GEMINI_TTS_MODELS из .env перекрывает умолчание, пробелы и пустые имена срезаются", async () => {
    expect(await loadChain({ GEMINI_TTS_MODELS: " model-a , ,model-b," })).toEqual(["model-a", "model-b"]);
  });

  it("старое имя GEMINI_TTS_MODEL всё ещё читается, новое важнее", async () => {
    expect(await loadChain({ GEMINI_TTS_MODEL: "legacy-one" })).toEqual(["legacy-one"]);
    expect(await loadChain({ GEMINI_TTS_MODELS: "new-one", GEMINI_TTS_MODEL: "legacy-one" })).toEqual(["new-one"]);
  });

  it("одни запятые вместо списка — не пустая цепочка, а умолчание", async () => {
    vi.resetModules();
    const { parseGeminiModelList, DEFAULT_GEMINI_TTS_MODELS } = await import("../src/ai/geminiTransport.js");
    expect(parseGeminiModelList(" , ,", DEFAULT_GEMINI_TTS_MODELS)).toEqual([LITE, FULL]);
  });
});

describe("synthesizeSpeech: переход к запасной модели на 404", () => {
  const calls: string[] = [];
  const logged: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    logged.length = 0;
    vi.resetModules();
    for (const k of ["GEMINI_TTS_MODELS", "GEMINI_TTS_MODEL"]) vi.stubEnv(k, "");
    vi.doMock("../src/ai/geminiClient.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/ai/geminiClient.js")>()),
      resolveGeminiKeys: async () => ["AQ.TestTtsChainKeyAAAA0001"], // gitleaks:allow -- reviewed synthetic test value or non-secret identifier
    }));
    vi.doMock("../src/lib/systemError.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
      logSystemError: async (_scope: string, message: string) => {
        logged.push(message);
      },
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.doUnmock("../src/ai/geminiClient.js");
    vi.doUnmock("../src/lib/systemError.js");
  });

  function stubFetch(handler: (model: string) => Response) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const model = /models\/([^:]+):generateContent/.exec(String(url))?.[1] ?? "?";
        calls.push(model);
        return handler(model);
      })
    );
  }

  const audio = () =>
    new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: "AAAA", mimeType: "audio/L16;codec=pcm;rate=24000" } }] } }] }),
      { status: 200 }
    );
  const notFound = () => new Response(JSON.stringify({ error: { code: 404, status: "NOT_FOUND" } }), { status: 404 });

  it("основная жива — запасную не трогаем", async () => {
    stubFetch(() => audio());
    const { synthesizeSpeech } = await import("../src/ai/tts.js");
    const result = await synthesizeSpeech("Здравствуйте! Наш агент вам перезвонит.");
    expect(result).toEqual({ audioBase64: "AAAA", sampleRateHz: 24000 });
    expect(calls).toEqual([LITE]);
  });

  it("основная 404 — звук приходит от запасной, переход записан в журнал", async () => {
    stubFetch((model) => (model === LITE ? notFound() : audio()));
    const { synthesizeSpeech } = await import("../src/ai/tts.js");
    const result = await synthesizeSpeech("Здравствуйте! Наш агент вам перезвонит.");
    expect(result?.audioBase64).toBe("AAAA");
    expect(calls).toEqual([LITE, FULL]);
    expect(logged.some((m) => m.includes(LITE) && m.includes(FULL))).toBe(true);
  });

  it("обе 404 — null без падения, в журнале «резервной модели нет»", async () => {
    stubFetch(() => notFound());
    const { synthesizeSpeech } = await import("../src/ai/tts.js");
    expect(await synthesizeSpeech("Тест")).toBeNull();
    expect(calls).toEqual([LITE, FULL]);
    expect(logged.some((m) => m.includes("резервной модели в цепочке нет"))).toBe(true);
  });

  it("не 404 (например 400) на основной — к запасной не переходим", async () => {
    stubFetch(() => new Response("{}", { status: 400 }));
    const { synthesizeSpeech } = await import("../src/ai/tts.js");
    expect(await synthesizeSpeech("Тест")).toBeNull();
    expect(calls).toEqual([LITE]);
  });
});

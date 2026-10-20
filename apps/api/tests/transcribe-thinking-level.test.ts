import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * РАСШИФРОВКА: ДОРОГАЯ МОДЕЛЬ РАЗМЫШЛЯЕТ И ПОЛУЧАЕТ ВРЕМЯ, ДЕШЁВАЯ — НЕТ (24.09.2026).
 *
 * Живой прод за неделю 17–24.09: каждое пятое голосовое уходило на дешёвую Flash с
 * записью «расшифровано ДЕШЁВОЙ моделью — gemini-3.1-pro-preview (aborted due to
 * timeout)». Проба на записях звонков показала: pro со своими размышлениями отвечает
 * за 42–49 с и даёт чистый таджикский с ценами, срок попытки был 31–34 с; урезать
 * размышления (thinkingLevel "low") быстрее втрое, но текст на шумной записи хуже.
 *
 * Закрепляем: дорогой модели thinkingConfig НЕ уходит, а срок её попытки считается от
 * базы 90 с; дешёвой уходит подходящая ей форма «не размышляй» (у 3.6-flash —
 * "minimal"); отказ 400 на сам блок снимает его для модели и НЕ считается сбоем
 * (журнал молчит); base64 аудио общий для всех попыток.
 */

const logSystemError = vi.fn();
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: (...a: unknown[]) => logSystemError(...a) }));

vi.mock("../src/db.js", () => ({
  prisma: {
    settings: { findUnique: () => Promise.resolve(null) },
    aiLog: { create: () => Promise.resolve({}) },
    $disconnect: () => Promise.resolve(),
  },
}));

type Call = { url: string; body: Record<string, unknown>; timeoutMs: number | null };

function okResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 90 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { code: status, message } }), { status });
}

async function loadTranscribe() {
  delete process.env.GEMINI_PROXY_URL;
  delete process.env.GEMINI_PROXY_KEY;
  delete process.env.GEMINI_API_KEY_2;
  delete process.env.GEMINI_FALLBACK_MODEL;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "gemini-3.6-flash";
  process.env.GEMINI_TRANSCRIBE_MODELS = "gemini-3.1-pro-preview";
  vi.resetModules();
  return import("../src/ai/transcribe.js");
}

describe("расшифровка: размышления и срок по модели", () => {
  const originalFetch = globalThis.fetch;
  let calls: Call[];

  beforeEach(() => {
    calls = [];
    logSystemError.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Срок попытки читаем из сигнала: AbortSignal.timeout подменяем на маркер с числом.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const controller = new AbortController();
      (controller.signal as AbortSignal & { __ms?: number }).__ms = ms;
      return controller.signal;
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function stubFetch(handler: (call: Call) => Promise<Response>) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal as (AbortSignal & { __ms?: number }) | undefined;
      const call: Call = { url: String(input), body: JSON.parse(String(init?.body)), timeoutMs: signal?.__ms ?? null };
      calls.push(call);
      return handler(call);
    }) as typeof fetch;
  }

  it("дорогая модель: без thinkingConfig и со сроком от базы 90 с", async () => {
    stubFetch(async () => okResponse("Ва алейкум салом"));
    const { transcribeAudioResult, transcribeTimeoutFor } = await loadTranscribe();

    const result = await transcribeAudioResult(Buffer.from("audio"), "voice.ogg", "audio/ogg");

    expect(result).toEqual({ text: "Ва алейкум салом", failed: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("gemini-3.1-pro-preview");
    expect(calls[0].body.generationConfig).toBeUndefined();
    expect(calls[0].timeoutMs).toBe(transcribeTimeoutFor(5, true));
    expect(transcribeTimeoutFor(0, true)).toBe(90_000);
    expect(transcribeTimeoutFor(0)).toBe(30_000);
    // Потолок общий: и дорогой модели больше трёх минут не даём.
    expect(transcribeTimeoutFor(50 * 1024 * 1024, true)).toBe(180_000);
    expect(logSystemError).not.toHaveBeenCalled();
  });

  it("дешёвая модель получает свою форму блока (minimal у 3.6-flash) и обычный срок", async () => {
    stubFetch(async (call) =>
      call.url.includes("gemini-3.1-pro-preview") ? errorResponse(404, "not found") : okResponse("Салом")
    );
    const { transcribeAudioResult, transcribeTimeoutFor } = await loadTranscribe();

    const result = await transcribeAudioResult(Buffer.from("audio"), "voice.ogg", "audio/ogg");

    expect(result).toEqual({ text: "Салом", failed: false });
    const flashCall = calls.find((c) => c.url.includes("gemini-3.6-flash"));
    expect(flashCall?.body.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "minimal" } });
    expect(flashCall?.timeoutMs).toBe(transcribeTimeoutFor(5));
    // Аудио в теле — то же самое, что и у pro: base64 общий, а не пересобран.
    const audio = (c: Call) =>
      (c.body.contents as { parts: { inline_data?: { data: string } }[] }[])[0].parts[0].inline_data?.data;
    expect(audio(flashCall!)).toBe(audio(calls[0]));
    expect(audio(calls[0])).toBe(Buffer.from("audio").toString("base64"));
  });

  it("отказ 400 на сам блок снимает его для модели: та же модель, без второго 400 и без лишней записи", async () => {
    // pro закрыта (404), flash отвечает 400, пока в теле есть thinkingConfig, и 200 без него.
    stubFetch(async (call) => {
      if (call.url.includes("gemini-3.1-pro-preview")) return errorResponse(404, "not found");
      return call.body.generationConfig
        ? errorResponse(400, "Thinking level MINIMAL is not supported for this model.")
        : okResponse("Салом");
    });
    const { transcribeAudioResult } = await loadTranscribe();

    const result = await transcribeAudioResult(Buffer.from("audio"), "voice.ogg", "audio/ogg");

    expect(result).toEqual({ text: "Салом", failed: false });
    const flashCalls = calls.filter((c) => c.url.includes("gemini-3.6-flash"));
    expect(flashCalls).toHaveLength(2);
    expect(flashCalls[1].body.generationConfig).toBeUndefined();
    // Единственная запись — про откат на дешёвую из-за 404 у pro; про 400 на блок — ни слова.
    expect(logSystemError).toHaveBeenCalledTimes(1);
    expect(String(logSystemError.mock.calls[0][1])).toContain("HTTP 404");
    expect(String(logSystemError.mock.calls[0][1])).not.toContain("400");

    // Память процесса: следующее голосовое сразу идёт без блока, второго 400 нет.
    calls = [];
    await transcribeAudioResult(Buffer.from("audio"), "voice2.ogg", "audio/ogg");
    const again = calls.filter((c) => c.url.includes("gemini-3.6-flash"));
    expect(again).toHaveLength(1);
    expect(again[0].body.generationConfig).toBeUndefined();
  });
});

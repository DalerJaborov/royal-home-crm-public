import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ПЕРЕБОР «МОДЕЛЬ СНАРУЖИ, КЛЮЧ ВНУТРИ» И ЧЕСТНАЯ «ПУСТОТА ПОСЛЕ ОТКАЗА» (24.09.2026).
 *
 * Три вещи, которые прежний перебор «ключи × модели» не умел и которые легко
 * сломать обратно:
 *
 * 1. Второй ключ пробуется для ТОЙ ЖЕ дорогой модели раньше, чем перебор
 *    соскальзывает на дешёвую (раньше — только после того, как ключ обошёл ВСЕ
 *    модели, включая дешёвую, и дешёвая модель первого ключа звалась раньше
 *    дорогой модели второго).
 * 2. Пустой ответ ДЕШЁВОЙ модели, если хотя бы одна ДОРОГАЯ в этом же вызове не
 *    ответила (а не просто дала пустую расшифровку), — это failed:true и запись в
 *    журнал, а не штатная тишина без повтора.
 * 3. Итоговый отказ перечисляет причину КАЖДОЙ опрошенной модели, а не только
 *    последнюю по порядку попытку; таймаут форматируется как «не ответила за N с»
 *    с реальным сроком попытки этой модели (transcribeTimeoutFor).
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

type Call = { url: string; apiKey: string; body: Record<string, unknown> };

function okResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { code: status, message } }), { status });
}

function timeoutError(): Error {
  // То же, что реально бросает AbortSignal.timeout() при срабатывании — describeError
  // у него не находит cause и отдаёт message как есть.
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

async function loadTranscribe(opts: { secondKey?: boolean } = {}) {
  delete process.env.GEMINI_PROXY_URL;
  delete process.env.GEMINI_PROXY_KEY;
  delete process.env.GEMINI_FALLBACK_MODEL;
  process.env.GEMINI_API_KEY = "key-A";
  if (opts.secondKey) {
    process.env.GEMINI_API_KEY_2 = "key-B";
  } else {
    delete process.env.GEMINI_API_KEY_2;
  }
  process.env.GEMINI_MODEL = "gemini-3.6-flash";
  process.env.GEMINI_TRANSCRIBE_MODELS = "gemini-3.1-pro-preview";
  vi.resetModules();
  return import("../src/ai/transcribe.js");
}

describe("перебор моделей и ключей при расшифровке", () => {
  const originalFetch = globalThis.fetch;
  let calls: Call[];

  beforeEach(() => {
    calls = [];
    logSystemError.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function stubFetch(handler: (call: Call) => Promise<Response>) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const call: Call = {
        url: String(input),
        apiKey: headers?.["x-goog-api-key"] ?? "",
        body: JSON.parse(String(init?.body)),
      };
      calls.push(call);
      return handler(call);
    }) as typeof fetch;
  }

  it("второй ключ пробуется для ТОЙ ЖЕ дорогой модели раньше, чем перебор уходит на дешёвую", async () => {
    stubFetch(async (call) => {
      if (call.url.includes("gemini-3.1-pro-preview")) {
        // Первый ключ на дорогой модели отказывает НЕ повторяемым кодом — раньше
        // это сразу увело бы перебор на дешёвую модель ЭТОГО ЖЕ ключа.
        if (call.apiKey === "key-A") return errorResponse(404, "перегружена/недоступна для этого ключа");
        // Второй ключ на ТОЙ ЖЕ модели отвечает нормально.
        if (call.apiKey === "key-B") return okResponse("Расшифровано вторым ключом");
      }
      // Дешёвая модель не должна понадобиться вовсе — если перебор дошёл сюда,
      // значит порядок перебора снова «ключи снаружи», это и есть регресс.
      return okResponse("НЕ ДОЛЖНО БЫТЬ ВЫЗВАНО");
    });
    const { transcribeAudioResult } = await loadTranscribe({ secondKey: true });

    const result = await transcribeAudioResult(Buffer.from("audio"), "call.wav", "audio/wav");

    expect(result).toEqual({ text: "Расшифровано вторым ключом", failed: false });
    const flashCalls = calls.filter((c) => c.url.includes("gemini-3.6-flash"));
    expect(flashCalls).toHaveLength(0);
    const proCalls = calls.filter((c) => c.url.includes("gemini-3.1-pro-preview"));
    expect(proCalls.map((c) => c.apiKey)).toEqual(["key-A", "key-B"]);
  });

  it("пустой ответ ДЕШЁВОЙ модели после отказа дорогой — это failed:true, а не штатная тишина", async () => {
    stubFetch(async (call) => {
      if (call.url.includes("gemini-3.1-pro-preview")) return errorResponse(404, "модель недоступна");
      return okResponse(""); // дешёвая тоже молчит
    });
    const { transcribeAudioResult } = await loadTranscribe();

    const result = await transcribeAudioResult(Buffer.from("audio"), "call.wav", "audio/wav");

    expect(result.text).toBeNull();
    expect(result.failed).toBe(true);
    expect(result.detail).toContain("gemini-3.1-pro-preview");
    // Одна строка в журнал — через fail(), как и у любого другого настоящего отказа.
    expect(logSystemError).toHaveBeenCalledTimes(1);
    expect(String(logSystemError.mock.calls[0][1])).toContain("не расшифровано");
  });

  it("пустой ответ ДОРОГОЙ модели остаётся штатной тишиной — у звонка без журнала и без failed", async () => {
    stubFetch(async () => okResponse(""));
    const { transcribeAudioResult } = await loadTranscribe();

    const result = await transcribeAudioResult(Buffer.from("audio"), "call.wav", "audio/wav", { kind: "call" });

    expect(result).toEqual({ text: null, failed: false });
    expect(logSystemError).not.toHaveBeenCalled();
    // Дешёвая модель не звалась вовсе — тишина дорогой модели самодостаточна.
    const flashCalls = calls.filter((c) => c.url.includes("gemini-3.6-flash"));
    expect(flashCalls).toHaveLength(0);
  });

  /**
   * ГОЛОСОВОЕ КЛИЕНТА — ОДНА СТРОКА С ПОСТОЯННЫМ НАЧАЛОМ (25.09.2026): бот
   * ответил «паёми овозиро кушода наметавонам», а владелец не видел, почему.
   * failed по-прежнему false — повторять тишину незачем.
   */
  it("пустой ответ на голосовое клиента — строка в журнал с ключом дедупа, failed нет", async () => {
    stubFetch(async () => okResponse(""));
    const { transcribeAudioResult, VOICE_EMPTY_LOG_PREFIX } = await loadTranscribe();

    const result = await transcribeAudioResult(Buffer.from("audio"), "voice.ogg", "audio/ogg");

    expect(result).toEqual({ text: null, failed: false });
    expect(logSystemError).toHaveBeenCalledTimes(1);
    expect(String(logSystemError.mock.calls[0][1]).startsWith(VOICE_EMPTY_LOG_PREFIX)).toBe(true);
    expect(logSystemError.mock.calls[0][2]).toEqual({ dedupKey: VOICE_EMPTY_LOG_PREFIX });
    // Дешёвая модель не звалась вовсе — тишина дорогой модели самодостаточна.
    const flashCalls = calls.filter((c) => c.url.includes("gemini-3.6-flash"));
    expect(flashCalls).toHaveLength(0);
  });

  it("итоговый отказ перечисляет причину КАЖДОЙ модели, таймаут — «не ответила за N с» с реальным сроком", async () => {
    stubFetch(async () => {
      throw timeoutError();
    });
    const { transcribeAudioResult, transcribeTimeoutFor } = await loadTranscribe();

    const result = await transcribeAudioResult(Buffer.from("audio"), "call.wav", "audio/wav");

    expect(result.failed).toBe(true);
    const expensiveSeconds = Math.round(transcribeTimeoutFor(5, true) / 1000);
    const cheapSeconds = Math.round(transcribeTimeoutFor(5, false) / 1000);
    expect(result.detail).toContain(`gemini-3.1-pro-preview: не ответила за ${expensiveSeconds} с`);
    expect(result.detail).toContain(`gemini-3.6-flash: не ответила за ${cheapSeconds} с`);
  }, 20_000);
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * КОНТЕКСТ ЗВОНКА В ИНСТРУКЦИИ РАСШИФРОВКИ (24.09.2026).
 *
 * transcribeAudioResult принимает необязательный 4-й параметр — kind/callerPhone/
 * agentName/agentExtension (см. TranscribeContext в ai/transcribe.ts). Голосовое
 * сообщение клиента (kind не задан) не должно получать ни слова из добавки для
 * звонков — иначе тест «пусто = неразборчиво» и другие существующие проверки
 * голосового различили бы разное поведение по немой правке промта. Для звонка
 * (kind: "call") инструкция обязана: просить писать репликами «Агент:»/«Клиент:»,
 * подставлять имя агента и известный номер клиента, ТОЛЬКО когда они переданы, и
 * всегда просить помечать «?» неразобранные слова — не только цифры, как в базовой
 * инструкции для голосового.
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

type Call = { url: string; body: { contents: { parts: { text?: string }[] }[] } };

function okResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function loadTranscribe() {
  delete process.env.GEMINI_PROXY_URL;
  delete process.env.GEMINI_PROXY_KEY;
  delete process.env.GEMINI_FALLBACK_MODEL;
  delete process.env.GEMINI_API_KEY_2;
  process.env.GEMINI_API_KEY = "key-A";
  process.env.GEMINI_MODEL = "gemini-3.6-flash";
  process.env.GEMINI_TRANSCRIBE_MODELS = "gemini-3.1-pro-preview";
  vi.resetModules();
  return import("../src/ai/transcribe.js");
}

describe("контекст звонка в инструкции расшифровки", () => {
  const originalFetch = globalThis.fetch;
  let calls: Call[];

  beforeEach(() => {
    calls = [];
    logSystemError.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function stubFetch() {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = { url: String(input), body: JSON.parse(String(init?.body)) };
      calls.push(call);
      return okResponse("Здравствуйте");
    }) as typeof fetch;
  }

  /** Текст инструкции, отправленный первой (и единственной удачной) попыткой. */
  function instructionSent(): string {
    const call = calls[calls.length - 1];
    return call.body.contents[0].parts[1]?.text ?? "";
  }

  it("голосовое (context не задан) — без единого слова про реплики", async () => {
    stubFetch();
    const { transcribeAudioResult } = await loadTranscribe();

    await transcribeAudioResult(Buffer.from("audio"), "voice.ogg", "audio/ogg");

    const instruction = instructionSent();
    expect(instruction).not.toContain("РЕПЛИКАМИ");
    expect(instruction).not.toContain("Агент:");
    expect(instruction).not.toContain("Говорящий:");
  });

  it("kind: voice — то же самое, что вовсе без context", async () => {
    stubFetch();
    const { transcribeAudioResult } = await loadTranscribe();

    await transcribeAudioResult(Buffer.from("audio"), "voice.ogg", "audio/ogg", { kind: "voice" });

    expect(instructionSent()).not.toContain("РЕПЛИКАМИ");
  });

  it("kind: call без имени и номера — просит реплики и запрет додумывать любое слово, но без лишних вставок", async () => {
    stubFetch();
    const { transcribeAudioResult } = await loadTranscribe();

    await transcribeAudioResult(Buffer.from("audio"), "call.mp3", "audio/mpeg", { kind: "call" });

    const instruction = instructionSent();
    expect(instruction).toContain("РЕПЛИКАМИ");
    expect(instruction).toContain("«Агент:»");
    expect(instruction).toContain("«Клиент:»");
    expect(instruction).toContain("«Говорящий:»");
    // Неразобранное СЛОВО, не только цифра — то, чего нет в базовой инструкции голосового.
    expect(instruction).toContain("Любое неразобранное слово в разговоре");
    expect(instruction).not.toContain("Сотрудника");
    expect(instruction).not.toContain("Известный номер");
  });

  it("kind: call с agentName — вставляет имя сотрудника и просит не искажать обращение", async () => {
    stubFetch();
    const { transcribeAudioResult } = await loadTranscribe();

    await transcribeAudioResult(Buffer.from("audio"), "call.mp3", "audio/mpeg", {
      kind: "call",
      agentName: "Фарход Назаров",
    });

    const instruction = instructionSent();
    expect(instruction).toContain("Фарход Назаров");
    expect(instruction).toMatch(/не искажай/);
  });

  it("kind: call с callerPhone — номер только для сверки, запрет подставлять непроизнесённый", async () => {
    stubFetch();
    const { transcribeAudioResult } = await loadTranscribe();

    await transcribeAudioResult(Buffer.from("audio"), "call.mp3", "audio/mpeg", {
      kind: "call",
      callerPhone: "+992910001003",
    });

    const instruction = instructionSent();
    expect(instruction).toContain("+992910001003");
    expect(instruction).toContain("ТОЛЬКО для сверки");
    expect(instruction).toMatch(/НИКОГДА не вписывай/);
  });

  it("kind: call с agentName и callerPhone одновременно — обе вставки присутствуют", async () => {
    stubFetch();
    const { transcribeAudioResult } = await loadTranscribe();

    await transcribeAudioResult(Buffer.from("audio"), "call.mp3", "audio/mpeg", {
      kind: "call",
      agentName: "Далер",
      callerPhone: "+992900000000",
    });

    const instruction = instructionSent();
    expect(instruction).toContain("Далер");
    expect(instruction).toContain("+992900000000");
  });

  it("голосовое сообщение сохраняет базовую инструкцию про цифры дословно (не регрессия старого поведения)", async () => {
    stubFetch();
    const { transcribeAudioResult } = await loadTranscribe();

    await transcribeAudioResult(Buffer.from("audio"), "voice.ogg", "audio/ogg");

    const instruction = instructionSent();
    expect(instruction).toContain("Расшифруй это голосовое сообщение дословно");
    expect(instruction).toContain("Если речь неразборчива, ответь пустой строкой");
  });
});

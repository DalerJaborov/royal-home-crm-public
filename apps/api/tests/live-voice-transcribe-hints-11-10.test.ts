import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { AddressInfo } from "node:net";

/**
 * ПОДСКАЗКА ЯЗЫКА РАСПОЗНАВАНИЮ — ПО УМОЛЧАНИЮ (11.10.2026, docs/journal/2026-10-11-transcribe-hints-default.md).
 * Замер на записях прода: gemini-3.8-live принимает `languageCodes: ["tg-TJ","ru-RU"]`, расшифровка
 * клиента идёт кириллицей, переспросов «плохо слышно» 0 вместо 9–12. Словарь отдельного выигрыша не
 * дал — он теперь за своим флагом. Если модель всё же отвергнет setup из-за поля, клиент повторяет
 * ту же модель без подсказки, а не роняет звонок. Настоящий Google — локальный WebSocket-сервер.
 */
vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGeminiKey: async () => "good-key",
  resolveGeminiKeys: async () => ["good-key"],
}));
const logged = vi.hoisted(() => ({ entries: [] as { message: string; key?: string }[] }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logSystemError: vi.fn(async (_s: string, message: string, opts?: { dedupKey?: string }) => {
    logged.entries.push({ message, key: opts?.dedupKey });
  }),
}));

import { buildLiveVoiceSetupMessage, LiveVoiceClient } from "../src/ai/liveVoiceClient.js";
import {
  LIVE_VOICE_TRANSCRIBE_LANGUAGES,
  liveVoiceInputTranscriptionConfig,
  liveVoiceTranscriptionHintLanguage,
} from "../src/ai/liveVoiceTranscriptionHints.js";
import { buildConsultantSystemPrompt } from "../src/ai/liveVoiceConsultantPersona.js";

const ENV_KEYS = ["LIVE_VOICE_TRANSCRIBE_HINTS", "LIVE_VOICE_TRANSCRIBE_VOCAB", "GEMINI_PROXY_URL"] as const;
const envBefore = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (envBefore[key] === undefined) delete process.env[key];
    else process.env[key] = envBefore[key];
  }
}

type TranscriptionConfig = { languageCodes?: string[]; customVocabulary?: string[] };

describe("тело inputAudioTranscription", () => {
  beforeEach(() => {
    delete process.env.LIVE_VOICE_TRANSCRIBE_HINTS;
    delete process.env.LIVE_VOICE_TRANSCRIBE_VOCAB;
  });
  afterEach(restoreEnv);

  it("по умолчанию — таджикский первым и русский, без словаря", () => {
    expect(LIVE_VOICE_TRANSCRIBE_LANGUAGES).toEqual(["tg-TJ", "ru-RU"]);
    const setup = buildLiveVoiceSetupMessage({ systemInstruction: "x" }).setup as { inputAudioTranscription: TranscriptionConfig };
    expect(setup.inputAudioTranscription).toEqual({ languageCodes: ["tg-TJ", "ru-RU"] });
    expect(setup.inputAudioTranscription).not.toHaveProperty("customVocabulary");
    expect(liveVoiceInputTranscriptionConfig(null)).toEqual({ languageCodes: ["tg-TJ", "ru-RU"] });
    expect(liveVoiceInputTranscriptionConfig("tg")).toEqual({ languageCodes: ["tg-TJ", "ru-RU"] });
  });

  it("«только русский» и досье «ru» — одна подсказка ru-RU", () => {
    expect(liveVoiceInputTranscriptionConfig("ru")).toEqual({ languageCodes: ["ru-RU"] });
    // Замок бьёт досье; без замка решает досье; неизвестный язык — слушать оба.
    expect(liveVoiceTranscriptionHintLanguage(true, "tg")).toBe("ru");
    expect(liveVoiceTranscriptionHintLanguage(true, null)).toBe("ru");
    expect(liveVoiceTranscriptionHintLanguage(false, "ru")).toBe("ru");
    expect(liveVoiceTranscriptionHintLanguage(false, "tg")).toBe("tg");
    expect(liveVoiceTranscriptionHintLanguage(false, undefined)).toBeNull();
  });

  it("LIVE_VOICE_TRANSCRIBE_HINTS=0 — прежний пустой объект при любом языке и даже со словарём", () => {
    process.env.LIVE_VOICE_TRANSCRIBE_HINTS = "0";
    process.env.LIVE_VOICE_TRANSCRIBE_VOCAB = "1";
    expect(liveVoiceInputTranscriptionConfig()).toEqual({});
    expect(liveVoiceInputTranscriptionConfig("ru")).toEqual({});
    expect((buildLiveVoiceSetupMessage({ systemInstruction: "x" }).setup as Record<string, unknown>).inputAudioTranscription).toEqual({});
  });

  it("LIVE_VOICE_TRANSCRIBE_VOCAB=1 — словарь мест рядом с подсказкой языка", () => {
    process.env.LIVE_VOICE_TRANSCRIBE_VOCAB = "1";
    const config = liveVoiceInputTranscriptionConfig("ru") as TranscriptionConfig;
    expect(config.languageCodes).toEqual(["ru-RU"]);
    expect(config.customVocabulary).toEqual(expect.arrayContaining(["Royal Home", "Сино"]));
  });

  it("явно переданное тело (мост, откат) перебивает умолчание", () => {
    const setup = buildLiveVoiceSetupMessage({ systemInstruction: "x", inputTranscription: {} }).setup as Record<string, unknown>;
    expect(setup.inputAudioTranscription).toEqual({});
    const ru = buildLiveVoiceSetupMessage({ systemInstruction: "x", inputTranscription: liveVoiceInputTranscriptionConfig("ru") })
      .setup as { inputAudioTranscription: TranscriptionConfig };
    expect(ru.inputAudioTranscription.languageCodes).toEqual(["ru-RU"]);
  });
});

describe("модель отвергла setup из-за подсказки — звонок не падает", () => {
  let server: WebSocketServer;
  let setups: { model: string; transcription: TranscriptionConfig }[] = [];
  /** Как сервер отвечает на setup: принять, отвергнуть подсказку (1007) или отвергнуть всё. */
  let mode: "accept" | "reject-hints" | "reject-hints-1008" | "reject-all" | "reject-hints-1011" | "model-not-found" = "accept";

  beforeEach(async () => {
    delete process.env.LIVE_VOICE_TRANSCRIBE_HINTS;
    delete process.env.LIVE_VOICE_TRANSCRIBE_VOCAB;
    logged.entries.length = 0;
    setups = [];
    mode = "accept";
    server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    server.on("connection", (socket: ServerSocket) => {
      socket.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { setup?: { model: string; inputAudioTranscription: TranscriptionConfig } };
        if (!msg.setup) return;
        const transcription = msg.setup.inputAudioTranscription;
        setups.push({ model: msg.setup.model, transcription });
        const hasHints = Object.keys(transcription).length > 0;
        if (mode === "reject-all") return socket.close(1007, "Request contains an invalid argument.");
        if (mode === "reject-hints" && hasHints)
          return socket.close(1007, 'Invalid JSON payload received. Unknown name "languageCodes"');
        if (mode === "reject-hints-1008" && hasHints) return socket.close(1008, "Request contains an invalid argument.");
        if (mode === "reject-hints-1011" && hasHints) return socket.close(1011, "Internal error");
        if (mode === "model-not-found" && msg.setup.model === "models/gemini-3.8-live")
          return socket.close(1008, "models/gemini-3.8-live is not found for API version v1beta");
        socket.send(JSON.stringify({ setupComplete: {} }));
      });
    });
    process.env.GEMINI_PROXY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    restoreEnv();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("модель приняла подсказку — один setup, подсказка в нём, отката нет", async () => {
    const client = new LiveVoiceClient();
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null });
    expect(setups).toHaveLength(1);
    expect(setups[0].transcription).toEqual({ languageCodes: ["tg-TJ", "ru-RU"] });
    expect(logged.entries.map((e) => e.key)).not.toContain("live-voice-transcribe-hints-rejected");
    client.close();
  });

  it("1007 на подсказку — та же модель повторяется с {} и сессия открывается; в журнале постоянный ключ", async () => {
    mode = "reject-hints";
    const client = new LiveVoiceClient();
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null });
    expect(setups.map((s) => s.model)).toEqual(["models/gemini-3.8-live", "models/gemini-3.8-live"]);
    expect(setups[0].transcription.languageCodes).toEqual(["tg-TJ", "ru-RU"]);
    expect(setups[1].transcription).toEqual({});
    expect(client.activeModel).toBe("gemini-3.8-live");
    expect(logged.entries.map((e) => e.key)).toContain("live-voice-transcribe-hints-rejected");
    client.close();
  });

  it("1008 «invalid argument» на подсказку — тоже откат на той же модели", async () => {
    mode = "reject-hints-1008";
    const client = new LiveVoiceClient();
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null });
    expect(setups.map((s) => s.transcription)).toEqual([{ languageCodes: ["tg-TJ", "ru-RU"] }, {}]);
    expect(client.activeModel).toBe("gemini-3.8-live");
    client.close();
  });

  it("1008 «model not found» — не поле: сразу запасная модель, с подсказкой и без лишнего круга", async () => {
    mode = "model-not-found";
    const client = new LiveVoiceClient();
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null });
    expect(setups).toHaveLength(2);
    expect(setups[1].model).not.toBe("models/gemini-3.8-live");
    expect(setups[1].transcription.languageCodes).toEqual(["tg-TJ", "ru-RU"]);
    expect(logged.entries.map((e) => e.key)).not.toContain("live-voice-transcribe-hints-rejected");
    client.close();
  });

  it("мост передал подсказку «только русский» — откат снимает и её", async () => {
    mode = "reject-hints";
    const client = new LiveVoiceClient();
    await client.connect({
      systemInstruction: "x",
      model: "gemini-3.8-live",
      resumeHandle: null,
      inputTranscription: liveVoiceInputTranscriptionConfig("ru"),
    });
    expect(setups.map((s) => s.transcription)).toEqual([{ languageCodes: ["ru-RU"] }, {}]);
    client.close();
  });

  it("отвергает и без подсказки — откат один раз, дальше обычная цепочка моделей, отказ наружу без зависания", async () => {
    mode = "reject-all";
    const client = new LiveVoiceClient();
    await expect(client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null })).rejects.toThrow(/1007/);
    // Подсказка снята один раз; запасная модель уже идёт без неё.
    expect(setups[0].transcription.languageCodes).toBeDefined();
    expect(setups.slice(1).every((s) => Object.keys(s.transcription).length === 0)).toBe(true);
    expect(setups.filter((s) => Object.keys(s.transcription).length > 0)).toHaveLength(1);
    expect(setups.length).toBeLessThanOrEqual(3);
    client.close();
  });

  it("1011 (сбой Google, не поле) — подсказку не снимаем, идём к запасной модели как раньше", async () => {
    mode = "reject-hints-1011";
    const client = new LiveVoiceClient();
    await expect(client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null })).rejects.toThrow(/1011/);
    expect(setups.every((s) => s.transcription.languageCodes !== undefined)).toBe(true);
    expect(logged.entries.map((e) => e.key)).not.toContain("live-voice-transcribe-hints-rejected");
    client.close();
  });
});

describe("промт консультанта: таджикская орфография", () => {
  const caller = { numberKnown: true, selfName: null, agentName: null, dossier: "", language: null };

  it("без замка — правильные формы приветствия и вопроса; «алейкум» в образцах больше нет", () => {
    const prompt = buildConsultantSystemPrompt({ knowledge: "", caller, withinWorkingHours: true, forceRussianOnly: false });
    expect(prompt).toContain("«Ассалому алайкум» (не «алейкум»)");
    expect(prompt).toContain("«Чӣ мехоҳед?» (не «мекобед»)");
    expect(prompt).not.toContain("Ассалому алейкум");
  });

  it("замок «только русский» — таджикской орфографии в промте нет", () => {
    const prompt = buildConsultantSystemPrompt({ knowledge: "", caller, withinWorkingHours: true, forceRussianOnly: true });
    expect(prompt).not.toContain("Чӣ мехоҳед");
  });
});

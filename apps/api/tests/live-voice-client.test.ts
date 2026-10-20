import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLiveVoiceSetupMessage,
  buildRealtimeAudioMessage,
  liveVoiceWsUrl,
  parseLiveVoiceServerMessage,
  parseProtoDurationMs,
} from "../src/ai/liveVoiceClient.js";

/**
 * Живой голос (пункт 5 очереди ИИ, 23.08.2026) — форма сообщений протокола Gemini
 * Live проверяется как структура JSON, без реального сокета (сеть/звонок не
 * доступны для проверки, см. докстринг файла liveVoiceClient.ts).
 */
/**
 * ВОССТАНАВЛИВАТЬ КЛЮЧАМИ, А НЕ ПЕРЕПРИСВАИВАТЬ ВЕСЬ ОБЪЕКТ (24.08.2026, найдено
 * полным прогоном test:api перед слиянием в main). `process.env = {...}` заменяет
 * специальный объект Node на обычный — в single-fork прогоне (tests/setup.ts,
 * все 323 файла в одном процессе) это уводило VAPID-ключи и роняло `src/push.ts`
 * при загрузке у КАЖДОГО файла, что импортировал его после этого. Тот же приём
 * восстановления, что и в tests/setup.ts::afterAll — мутируем ключи на месте.
 */
const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (process.env[key] !== value) process.env[key] = value;
  }
});

describe("buildLiveVoiceSetupMessage", () => {
  it("включает транскрипцию обеих сторон и модель по умолчанию", () => {
    const msg = buildLiveVoiceSetupMessage({ systemInstruction: "Ты консультант" });
    expect(msg).toMatchObject({
      setup: {
        model: expect.stringMatching(/^models\/gemini-.*live.*/),
        systemInstruction: { parts: [{ text: "Ты консультант" }] },
        generationConfig: { responseModalities: ["AUDIO"] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    });
  });

  // 10.10.2026, «звучит как робот»: температура — только проба за флагом окружения.
  it("температура: без LIVE_VOICE_TEMPERATURE не посылается; с флагом — число 0..2, мусор игнорируется", () => {
    const gen = () =>
      (buildLiveVoiceSetupMessage({ systemInstruction: "x" }).setup as { generationConfig: Record<string, unknown> })
        .generationConfig;
    delete process.env.LIVE_VOICE_TEMPERATURE;
    expect(gen()).not.toHaveProperty("temperature");
    process.env.LIVE_VOICE_TEMPERATURE = "1.1";
    expect(gen().temperature).toBe(1.1);
    for (const bad of ["abc", "3", "-1", ""]) {
      process.env.LIVE_VOICE_TEMPERATURE = bad;
      expect(gen()).not.toHaveProperty("temperature");
    }
    // Поля, которых у gemini-3.8-live нет, не посылаются никогда (иначе setup отвергнут).
    process.env.LIVE_VOICE_TEMPERATURE = "1";
    const setup = buildLiveVoiceSetupMessage({ systemInstruction: "x" }).setup as Record<string, unknown>;
    expect(setup).not.toHaveProperty("proactivity");
    expect(setup.generationConfig).not.toHaveProperty("enableAffectiveDialog");
    expect(setup.generationConfig).not.toHaveProperty("thinkingConfig");
  });

  it("явно заданная модель перебивает GEMINI_LIVE_MODEL", () => {
    const msg = buildLiveVoiceSetupMessage({ systemInstruction: "x", model: "gemini-custom-live" });
    expect((msg.setup as { model: string }).model).toBe("models/gemini-custom-live");
  });

  it("голос указан — попадает в speechConfig", () => {
    const msg = buildLiveVoiceSetupMessage({ systemInstruction: "x", voiceName: "Kore" });
    expect((msg.setup as { generationConfig: Record<string, unknown> }).generationConfig).toMatchObject({
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
    });
  });

  it("голос не указан — speechConfig отсутствует вовсе (не пустой объект)", () => {
    const msg = buildLiveVoiceSetupMessage({ systemInstruction: "x" });
    const generationConfig = (msg.setup as { generationConfig: Record<string, unknown> }).generationConfig;
    expect(generationConfig.speechConfig).toBeUndefined();
  });

  it("tools не указаны — поле tools в setup отсутствует вовсе", () => {
    const msg = buildLiveVoiceSetupMessage({ systemInstruction: "x" });
    expect((msg.setup as Record<string, unknown>).tools).toBeUndefined();
  });

  it("activityDetection не указан — realtimeInputConfig в setup отсутствует вовсе", () => {
    const msg = buildLiveVoiceSetupMessage({ systemInstruction: "x" });
    expect((msg.setup as Record<string, unknown>).realtimeInputConfig).toBeUndefined();
  });

  it("activityDetection указан — заворачивается в realtimeInputConfig.automaticActivityDetection", () => {
    const msg = buildLiveVoiceSetupMessage({
      systemInstruction: "x",
      activityDetection: {
        startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
        endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
        silenceDurationMs: 700,
      },
    });
    expect((msg.setup as Record<string, unknown>).realtimeInputConfig).toEqual({
      automaticActivityDetection: {
        startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
        endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
        silenceDurationMs: 700,
      },
    });
  });

  it("tools указаны — заворачиваются в functionDeclarations", () => {
    const msg = buildLiveVoiceSetupMessage({
      systemInstruction: "x",
      tools: [
        {
          name: "end_call",
          description: "Положить трубку",
          parameters: { type: "OBJECT", properties: { reason: { type: "STRING", description: "почему" } } },
        },
      ],
    });
    expect((msg.setup as Record<string, unknown>).tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "end_call",
            description: "Положить трубку",
            parameters: { type: "OBJECT", properties: { reason: { type: "STRING", description: "почему" } } },
          },
        ],
      },
    ]);
  });
});

describe("buildRealtimeAudioMessage", () => {
  it("кодирует PCM в base64 и указывает частоту в mimeType", () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const msg = buildRealtimeAudioMessage(pcm, 16000);
    expect(msg).toEqual({
      realtimeInput: { audio: { data: pcm.toString("base64"), mimeType: "audio/pcm;rate=16000" } },
    });
  });

  it("частота по умолчанию — 16000 (вход канала)", () => {
    const msg = buildRealtimeAudioMessage(Buffer.from([9]));
    expect((msg.realtimeInput as { audio: { mimeType: string } }).audio.mimeType).toBe("audio/pcm;rate=16000");
  });
});

describe("parseLiveVoiceServerMessage", () => {
  it("setupComplete — распознаётся", () => {
    expect(parseLiveVoiceServerMessage({ setupComplete: {} }).setupComplete).toBe(true);
  });

  it("аудио-чанк модели — вынимается из serverContent.modelTurn.parts[].inlineData", () => {
    const audioB64 = Buffer.from([10, 20, 30]).toString("base64");
    const update = parseLiveVoiceServerMessage({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: audioB64, mimeType: "audio/pcm;rate=24000" } }] } },
    });
    expect(update.audioChunks).toHaveLength(1);
    expect(Array.from(update.audioChunks[0])).toEqual([10, 20, 30]);
  });

  it("не-аудио part (например текст) — не попадает в audioChunks", () => {
    const update = parseLiveVoiceServerMessage({
      serverContent: { modelTurn: { parts: [{ text: "привет" } as unknown as Record<string, unknown>] } },
    });
    expect(update.audioChunks).toHaveLength(0);
  });

  it("транскрипция обеих сторон читается независимо друг от друга", () => {
    const update = parseLiveVoiceServerMessage({
      serverContent: { inputTranscription: { text: "Здравствуйте" }, outputTranscription: { text: "Ассалому алейкум" } },
    });
    expect(update.inputTranscript).toBe("Здравствуйте");
    expect(update.outputTranscript).toBe("Ассалому алейкум");
  });

  it("turnComplete и interrupted читаются как флаги", () => {
    expect(parseLiveVoiceServerMessage({ serverContent: { turnComplete: true } }).turnComplete).toBe(true);
    expect(parseLiveVoiceServerMessage({ serverContent: { interrupted: true } }).interrupted).toBe(true);
  });

  it("пустое/мусорное сообщение — безопасный пустой результат, не исключение", () => {
    expect(parseLiveVoiceServerMessage(null)).toMatchObject({ audioChunks: [], turnComplete: false, interrupted: false });
    expect(parseLiveVoiceServerMessage("строка вместо объекта")).toMatchObject({ audioChunks: [] });
    expect(parseLiveVoiceServerMessage({})).toMatchObject({ audioChunks: [], setupComplete: false });
  });

  it("toolCall — functionCalls разбирается в toolCalls с id/name/args", () => {
    const update = parseLiveVoiceServerMessage({
      toolCall: {
        functionCalls: [
          { id: "fc1", name: "save_contact", args: { name: "Далер", phone: "+992900000000" } },
          { id: "fc2", name: "end_call", args: { reason: "номер взят" } },
        ],
      },
    });
    expect(update.toolCalls).toEqual([
      { id: "fc1", name: "save_contact", args: { name: "Далер", phone: "+992900000000" } },
      { id: "fc2", name: "end_call", args: { reason: "номер взят" } },
    ]);
  });

  it("toolCall без id или name — отбрасывается, не ломает разбор остальных", () => {
    const update = parseLiveVoiceServerMessage({
      toolCall: { functionCalls: [{ name: "без id" }, { id: "fc3", name: "end_call", args: {} }] },
    });
    expect(update.toolCalls).toEqual([{ id: "fc3", name: "end_call", args: {} }]);
  });

  it("нет toolCall в сообщении — toolCalls не задаётся вовсе", () => {
    expect(parseLiveVoiceServerMessage({ serverContent: {} }).toolCalls).toBeUndefined();
  });

  it("toolCall без args — args пустой объект, а не undefined", () => {
    const update = parseLiveVoiceServerMessage({ toolCall: { functionCalls: [{ id: "fc4", name: "end_call" }] } });
    expect(update.toolCalls).toEqual([{ id: "fc4", name: "end_call", args: {} }]);
  });
});

describe("liveVoiceWsUrl", () => {
  it("без прокси — прямой адрес Google с ключом в query", () => {
    delete process.env.GEMINI_PROXY_URL;
    const url = liveVoiceWsUrl("SECRET_KEY");
    expect(url).toBe(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=SECRET_KEY"
    );
  });

  it("с прокси — https переписывается в wss и добавляется /gemini", () => {
    process.env.GEMINI_PROXY_URL = "https://proxy.example.com/";
    const url = liveVoiceWsUrl("KEY");
    expect(url).toBe(
      "wss://proxy.example.com/gemini/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=KEY"
    );
  });

  it("ключ кодируется как часть query-строки", () => {
    delete process.env.GEMINI_PROXY_URL;
    const url = liveVoiceWsUrl("a b&c");
    expect(url).toContain(`key=${encodeURIComponent("a b&c")}`);
  });
});

describe("правка 1 робозвонка (24.09.2026): продолжение сессии и сжатие", () => {
  it("resumeHandle null — sessionResumption пустым объектом (Google начнёт слать токены)", () => {
    const msg = buildLiveVoiceSetupMessage({ systemInstruction: "x", resumeHandle: null }) as { setup: Record<string, unknown> };
    expect(msg.setup.sessionResumption).toEqual({});
  });

  it("resumeHandle задан — уходит handle", () => {
    const msg = buildLiveVoiceSetupMessage({ systemInstruction: "x", resumeHandle: "abc" }) as { setup: Record<string, unknown> };
    expect(msg.setup.sessionResumption).toEqual({ handle: "abc" });
  });

  it("resumeHandle не указан вовсе — поля нет (прослушка голоса в Настройках)", () => {
    const msg = buildLiveVoiceSetupMessage({ systemInstruction: "x" }) as { setup: Record<string, unknown> };
    expect(msg.setup.sessionResumption).toBeUndefined();
    expect(msg.setup.contextWindowCompression).toBeUndefined();
  });

  it("сжатие контекста скользящим окном с порогом", () => {
    const msg = buildLiveVoiceSetupMessage({ systemInstruction: "x", compressionTriggerTokens: 24000 }) as {
      setup: Record<string, unknown>;
    };
    expect(msg.setup.contextWindowCompression).toEqual({ triggerTokens: 24000, slidingWindow: {} });
  });

  it("turnCoverage и определение речи — в одном realtimeInputConfig", () => {
    const msg = buildLiveVoiceSetupMessage({
      systemInstruction: "x",
      turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
      activityDetection: { silenceDurationMs: 700, prefixPaddingMs: 200 },
    }) as { setup: Record<string, unknown> };
    expect(msg.setup.realtimeInputConfig).toEqual({
      turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
      automaticActivityDetection: { silenceDurationMs: 700, prefixPaddingMs: 200 },
    });
  });

  it("goAway, токен продолжения и отмена функций разбираются", () => {
    expect(parseLiveVoiceServerMessage({ goAway: { timeLeft: "12.5s" } }).goAwayMs).toBe(12500);
    expect(parseLiveVoiceServerMessage({ goAway: {} }).goAwayMs).toBe(0);
    expect(parseLiveVoiceServerMessage({ sessionResumptionUpdate: { newHandle: "h", resumable: true } }).resumption).toEqual({
      handle: "h",
      resumable: true,
    });
    expect(parseLiveVoiceServerMessage({ sessionResumptionUpdate: { newHandle: "h" } }).resumption?.resumable).toBe(false);
    expect(parseLiveVoiceServerMessage({ sessionResumptionUpdate: {} }).resumption).toBeUndefined();
    expect(parseLiveVoiceServerMessage({ toolCallCancellation: { ids: ["a", 3, "b"] } }).cancelledToolCallIds).toEqual(["a", "b"]);
  });

  it("длительность Google строкой с суффиксом s", () => {
    expect(parseProtoDurationMs("10s")).toBe(10000);
    expect(parseProtoDurationMs("0.25s")).toBe(250);
    expect(parseProtoDurationMs("abc")).toBeUndefined();
    expect(parseProtoDurationMs(undefined)).toBeUndefined();
  });
});

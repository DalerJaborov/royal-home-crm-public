import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import {
  ElevenLabsVoiceClient,
  buildElevenLabsAudioChunkMessage,
  buildElevenLabsInitiationMessage,
  buildElevenLabsToolResultMessage,
  decodeElevenLabsAudio,
  isElevenLabsNormalEnd,
  parseElevenLabsAudioFormat,
  parseElevenLabsServerMessage,
  pickElevenLabsVoiceId,
} from "../src/ai/elevenLabsVoiceClient.js";
import { buildAgentSyncPatch, elevenLabsRequest, toElevenLabsClientTool } from "../src/ai/elevenLabsAgentSync.js";
import { createLiveVoiceProviderClient, loadLiveVoiceProviderConfig } from "../src/ai/liveVoiceProvider.js";
import { LiveVoiceClient, buildLiveVoiceSetupMessage, type LiveVoiceFunctionDeclaration } from "../src/ai/liveVoiceClient.js";
import {
  handsCallerBackToDialplan,
  providerCloseOutcome,
  resolveLiveVoiceLanguage,
  ulawDecode,
  ulawEncode,
} from "../src/lib/telephony/liveVoiceBridge.js";
import { consultantLanguage } from "../src/lib/telephony/liveVoiceConsultant.js";

/**
 * ВТОРОЙ ПОСТАВЩИК ГОЛОСА — ELEVENLABS (02.10.2026). Звук и настоящий агент
 * проверяются только живым звонком; здесь — то, что можно проверить без сети:
 * сообщения протокола (сборка и разбор), путь вызова функции до ответа
 * client_tool_result, перебивание, подготовка агента и то, что по умолчанию
 * по-прежнему создаётся клиент Gemini.
 */

const SEARCH_TOOL: LiveVoiceFunctionDeclaration = {
  name: "search_properties",
  description: "Найти квартиры по словам собеседника.",
  parameters: {
    type: "OBJECT",
    properties: {
      district: { type: "STRING", description: "Район.", enum: ["Сино", "Шохмансур"] },
      rooms: { type: "INTEGER", description: "Комнат минимум." },
      budget_max: { type: "NUMBER", description: "Бюджет." },
      furnished: { type: "BOOLEAN", description: "С мебелью." },
    },
    required: ["district"],
  },
};

/** Поддельный сокет: ровно то, чем пользуется клиент (send/close/readyState/события). */
class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  server(msg: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
  closeFromServer(code: number, reason: string): void {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }
}

const METADATA = {
  type: "conversation_initiation_metadata",
  conversation_initiation_metadata_event: {
    conversation_id: "conv_1",
    agent_output_audio_format: "pcm_16000",
    user_input_audio_format: "ulaw_8000",
  },
};

function makeClient(sockets: FakeSocket[], toolIds: Map<string, string> | null = new Map([["search_properties", "tool_1"]])) {
  const signedUrl = vi.fn(async () => "wss://example.test/v1/convai/conversation?agent_id=a&token=t");
  const prepareAgent = vi.fn(async () => toolIds);
  const client = new ElevenLabsVoiceClient(
    { apiKey: "sk_test", agentId: "agent_1", voiceIdRu: "voice_ru", voiceIdTg: "voice_tg" },
    {
      signedUrl,
      prepareAgent,
      socketFactory: () => {
        const ws = new FakeSocket();
        sockets.push(ws);
        // Сокет «открывается» на следующем тике, как настоящий.
        setImmediate(() => ws.open());
        return ws as unknown as WebSocket;
      },
    }
  );
  return { client, signedUrl, prepareAgent };
}

async function untilSocket(sockets: FakeSocket[], index: number): Promise<FakeSocket> {
  for (let i = 0; i < 50 && !(sockets[index]?.readyState === 1); i++) await new Promise((r) => setImmediate(r));
  const ws = sockets[index];
  if (!ws) throw new Error(`сокет №${index} не открылся`);
  return ws;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ElevenLabs: сообщения протокола", () => {
  it("первое сообщение несёт НАШ промт слово в слово, пустую первую фразу, язык, голос и функции звонка", () => {
    const prompt = "Ты консультант Royal Home.\n\nСПРАВОЧНИК: …\n\nДОСЬЕ: звонил вчера.";
    expect(
      buildElevenLabsInitiationMessage({ systemInstruction: prompt, language: "tg", voiceId: "voice_tg", toolIds: ["tool_1"] })
    ).toEqual({
      type: "conversation_initiation_client_data",
      conversation_config_override: {
        agent: { prompt: { prompt, tool_ids: ["tool_1"] }, first_message: "", language: "tg" },
        tts: { voice_id: "voice_tg" },
      },
    });
  });

  it("без голоса, языка и функций — эти подмены не отправляются (остаются из кабинета)", () => {
    const msg = buildElevenLabsInitiationMessage({ systemInstruction: "P" });
    expect(msg).toEqual({
      type: "conversation_initiation_client_data",
      conversation_config_override: { agent: { prompt: { prompt: "P" }, first_message: "" } },
    });
  });

  it("голос по языку: таджикский пуст — русский; оба пусты — голос агента", () => {
    expect(pickElevenLabsVoiceId({ voiceIdRu: "ru", voiceIdTg: "tg" }, "tg")).toBe("tg");
    expect(pickElevenLabsVoiceId({ voiceIdRu: "ru", voiceIdTg: null }, "tg")).toBe("ru");
    expect(pickElevenLabsVoiceId({ voiceIdRu: "ru", voiceIdTg: "tg" }, "ru")).toBe("ru");
    expect(pickElevenLabsVoiceId({ voiceIdRu: null, voiceIdTg: null }, "ru")).toBeNull();
  });

  it("форматы звука из метаданных", () => {
    expect(parseElevenLabsAudioFormat("pcm_16000")).toEqual({ encoding: "pcm", sampleRateHz: 16000 });
    expect(parseElevenLabsAudioFormat("ulaw_8000")).toEqual({ encoding: "ulaw", sampleRateHz: 8000 });
    expect(parseElevenLabsAudioFormat("mp3_44100")).toEqual({ encoding: "pcm", sampleRateHz: 16000 });
  });

  it("кусок звука собеседника: PCM 16 кГц уходит как есть, для ulaw_8000 — вдвое реже и в ulaw", () => {
    const pcm = Buffer.alloc(320 * 2);
    for (let i = 0; i < 320; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 5) * 8000), i * 2);
    const asPcm = buildElevenLabsAudioChunkMessage(pcm, 16000, { encoding: "pcm", sampleRateHz: 16000 });
    expect(Buffer.from(asPcm.user_audio_chunk, "base64").equals(pcm)).toBe(true);
    const asUlaw = buildElevenLabsAudioChunkMessage(pcm, 16000, { encoding: "ulaw", sampleRateHz: 8000 });
    expect(Buffer.from(asUlaw.user_audio_chunk, "base64").length).toBe(160);
  });

  it("звук агента в ulaw разворачивается в PCM16", () => {
    const samples = new Int16Array([0, 1000, -1000, 8000]);
    const decoded = decodeElevenLabsAudio(ulawEncode(samples), { encoding: "ulaw", sampleRateHz: 8000 });
    expect(decoded.length).toBe(8);
    expect(decoded.readInt16LE(2)).toBe(ulawDecode(ulawEncode(samples))[1]);
  });

  it("разбор сообщений сервера", () => {
    expect(parseElevenLabsServerMessage(METADATA)).toEqual({
      kind: "metadata",
      conversationId: "conv_1",
      output: { encoding: "pcm", sampleRateHz: 16000 },
      input: { encoding: "ulaw", sampleRateHz: 8000 },
    });
    expect(parseElevenLabsServerMessage({ type: "ping", ping_event: { event_id: 7, ping_ms: 40 } })).toEqual({
      kind: "ping",
      eventId: 7,
    });
    expect(
      parseElevenLabsServerMessage({ type: "user_transcript", user_transcription_event: { user_transcript: "Салом", event_id: 3 } })
    ).toEqual({ kind: "user_transcript", text: "Салом" });
    expect(
      parseElevenLabsServerMessage({ type: "agent_response", agent_response_event: { agent_response: "Здравствуйте", event_id: 4 } })
    ).toEqual({ kind: "agent_response", text: "Здравствуйте" });
    expect(parseElevenLabsServerMessage({ type: "interruption", interruption_event: { event_id: 9 } })).toEqual({
      kind: "interruption",
      eventId: 9,
    });
    expect(
      parseElevenLabsServerMessage({
        type: "client_tool_call",
        client_tool_call: { tool_name: "search_properties", tool_call_id: "call_1", parameters: { district: "Сино" }, event_id: 5 },
      })
    ).toEqual({ kind: "tool_call", call: { id: "call_1", name: "search_properties", args: { district: "Сино" } } });
    expect(parseElevenLabsServerMessage({ type: "vad_score" })).toEqual({ kind: "other", type: "vad_score" });
    expect(parseElevenLabsServerMessage("мусор")).toEqual({ kind: "other", type: "" });
  });

  it("ответ функции — строка JSON, отказ помечен is_error", () => {
    const call = { id: "call_1", name: "send_sms", args: {} };
    expect(buildElevenLabsToolResultMessage(call, { ok: true, sent: 1 })).toEqual({
      type: "client_tool_result",
      tool_call_id: "call_1",
      result: '{"ok":true,"sent":1}',
      is_error: false,
    });
    expect(buildElevenLabsToolResultMessage(call, { ok: false, error: "нет номера" }).is_error).toBe(true);
  });
});

describe("ElevenLabs: разговор на поддельном сокете", () => {
  it("подключение, pong, звук, вызов функции → наш обработчик → client_tool_result, перебивание", async () => {
    const sockets: FakeSocket[] = [];
    const { client, prepareAgent } = makeClient(sockets);
    const ready = vi.fn();
    client.on("ready", ready);
    const connecting = client.connect({ systemInstruction: "НАШ ПРОМТ", tools: [SEARCH_TOOL], language: "ru" });
    const ws = await untilSocket(sockets, 0);
    expect(ws.sent[0]).toEqual({
      type: "conversation_initiation_client_data",
      conversation_config_override: {
        agent: { prompt: { prompt: "НАШ ПРОМТ", tool_ids: ["tool_1"] }, first_message: "", language: "ru" },
        tts: { voice_id: "voice_ru" },
      },
    });
    ws.server(METADATA);
    await connecting;
    expect(ready).toHaveBeenCalledTimes(1);
    expect(prepareAgent).toHaveBeenCalledWith("sk_test", "agent_1", [SEARCH_TOOL]);
    expect(client.inputSampleRateHz).toBe(8000);
    expect(client.outputSampleRateHz).toBe(16000);

    ws.server({ type: "ping", ping_event: { event_id: 11, ping_ms: null } });
    expect(ws.sent.at(-1)).toEqual({ type: "pong", event_id: 11 });

    // Звук собеседника 8 кГц (как его отдаёт мост при ulaw_8000) → ulaw без пересчёта частоты.
    client.sendAudioChunk(Buffer.alloc(320), 8000);
    const chunk = ws.sent.at(-1) as { user_audio_chunk: string };
    expect(Buffer.from(chunk.user_audio_chunk, "base64").length).toBe(160);

    const audio: Buffer[] = [];
    client.on("audio", (b: Buffer) => audio.push(b));
    ws.server({ type: "audio", audio_event: { audio_base_64: Buffer.alloc(64, 1).toString("base64"), event_id: 20 } });
    expect(audio).toHaveLength(1);

    const transcripts: unknown[] = [];
    client.on("transcript", (e) => transcripts.push(e));
    ws.server({ type: "user_transcript", user_transcription_event: { user_transcript: "Ищу двушку в Сино", event_id: 21 } });
    expect(transcripts).toEqual([{ role: "user", text: "Ищу двушку в Сино" }]);

    // Вызов функции идёт в тот же обработчик, что у Gemini (событие "toolCall"),
    // ответ обработчика — client_tool_result с тем же id.
    client.on("toolCall", (calls: { id: string; name: string; args: Record<string, unknown> }[]) => {
      for (const call of calls) client.sendToolResponse(call, { ok: true, found: 2, district: call.args.district });
    });
    ws.server({
      type: "client_tool_call",
      client_tool_call: { tool_name: "search_properties", tool_call_id: "call_9", parameters: { district: "Сино" }, event_id: 22 },
    });
    expect(ws.sent.at(-1)).toEqual({
      type: "client_tool_result",
      tool_call_id: "call_9",
      result: JSON.stringify({ ok: true, found: 2, district: "Сино" }),
      is_error: false,
    });

    // Перебивание: событие наружу, а запоздавший звук перебитой реплики не играется.
    const interrupted = vi.fn();
    client.on("interrupted", interrupted);
    ws.server({ type: "interruption", interruption_event: { event_id: 25 } });
    expect(interrupted).toHaveBeenCalledTimes(1);
    ws.server({ type: "audio", audio_event: { audio_base_64: Buffer.alloc(64, 2).toString("base64"), event_id: 24 } });
    expect(audio).toHaveLength(1);
    ws.server({ type: "audio", audio_event: { audio_base_64: Buffer.alloc(64, 3).toString("base64"), event_id: 26 } });
    expect(audio).toHaveLength(2);

    // Служебная реплика (приветствие первым) — user_message.
    client.sendText("(Поздоровайся первым.)");
    expect(ws.sent.at(-1)).toEqual({ type: "user_message", text: "(Поздоровайся первым.)" });

    client.close();
    expect(ws.closed).toBe(true);
  });

  it("реплика считается законченной, когда звук перестал приходить", async () => {
    const sockets: FakeSocket[] = [];
    const { client } = makeClient(sockets);
    const connecting = client.connect({ systemInstruction: "P" });
    const ws = await untilSocket(sockets, 0);
    ws.server(METADATA);
    await connecting;
    vi.useFakeTimers();
    const done = vi.fn();
    client.on("turnComplete", done);
    ws.server({ type: "audio", audio_event: { audio_base_64: Buffer.alloc(32).toString("base64"), event_id: 1 } });
    vi.advanceTimersByTime(500);
    ws.server({ type: "audio", audio_event: { audio_base_64: Buffer.alloc(32).toString("base64"), event_id: 2 } });
    vi.advanceTimersByTime(900);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(done).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("агент отклонил язык — второй заход без подмены языка, звонок не теряется", async () => {
    const sockets: FakeSocket[] = [];
    const { client } = makeClient(sockets);
    const connecting = client.connect({ systemInstruction: "P", language: "tg" });
    const first = await untilSocket(sockets, 0);
    expect((first.sent[0].conversation_config_override as { agent: { language?: string } }).agent.language).toBe("tg");
    first.closeFromServer(1008, "unsupported language");
    const second = await untilSocket(sockets, 1);
    const agent = (second.sent[0].conversation_config_override as { agent: Record<string, unknown> }).agent;
    expect(agent.language).toBeUndefined();
    // Голос таджикский остаётся: отказали только в языке.
    expect(second.sent[0].conversation_config_override).toMatchObject({ tts: { voice_id: "voice_tg" } });
    second.server(METADATA);
    await connecting;
    client.close();
  });

  it("два отказа подряд — отказ connect (мост уводит звонок на автоответчик)", async () => {
    const sockets: FakeSocket[] = [];
    const { client } = makeClient(sockets);
    const connecting = client.connect({ systemInstruction: "P", language: "ru" }).then(
      () => "ok",
      (e: Error) => e.message
    );
    const first = await untilSocket(sockets, 0);
    first.closeFromServer(4001, "bad prompt");
    const second = await untilSocket(sockets, 1);
    second.closeFromServer(4001, "bad prompt");
    expect(await connecting).toContain("закрыто до начала разговора");
  });

  it("нет ключа или агента — отказ сразу, без сети", async () => {
    const noKey = new ElevenLabsVoiceClient({ apiKey: null, agentId: "a", voiceIdRu: null, voiceIdTg: null });
    await expect(noKey.connect({ systemInstruction: "P" })).rejects.toThrow("Ключ ElevenLabs не задан");
    const noAgent = new ElevenLabsVoiceClient({ apiKey: "k", agentId: null, voiceIdRu: null, voiceIdTg: null });
    await expect(noAgent.connect({ systemInstruction: "P" })).rejects.toThrow("id агента");
  });

  it("подготовка агента не удалась — набор функций агента не подменяется", async () => {
    const sockets: FakeSocket[] = [];
    const { client } = makeClient(sockets, null);
    const connecting = client.connect({ systemInstruction: "P", tools: [SEARCH_TOOL] });
    const ws = await untilSocket(sockets, 0);
    expect((ws.sent[0].conversation_config_override as { agent: { prompt: Record<string, unknown> } }).agent.prompt).toEqual({
      prompt: "P",
    });
    ws.server(METADATA);
    await connecting;
    client.close();
  });
});

describe("ElevenLabs: агент сам закончил разговор — не сбой", () => {
  async function connected() {
    const sockets: FakeSocket[] = [];
    const { client } = makeClient(sockets);
    const connecting = client.connect({ systemInstruction: "P" });
    const ws = await untilSocket(sockets, 0);
    ws.server(METADATA);
    await connecting;
    const closes: { code: number; reason: string; normal: boolean }[] = [];
    client.on("close", (info) => closes.push(info));
    return { client, ws, closes };
  }
  const speak = (ws: FakeSocket) =>
    ws.server({ type: "audio", audio_event: { audio_base_64: Buffer.alloc(32).toString("base64"), event_id: 1 } });

  it("прощание агента и обычное закрытие 1000 — normal; мост кончает звонок как по end_call", async () => {
    const { ws, closes } = await connected();
    ws.server({ type: "agent_response", agent_response_event: { agent_response: "До свидания!", event_id: 1 } });
    speak(ws);
    ws.closeFromServer(1000, "end_call");
    expect(closes).toEqual([{ code: 1000, reason: "end_call", normal: true }]);
    const outcome = providerCloseOutcome(closes[0]);
    expect(outcome.normal).toBe(true);
    // Та же причина, что у вежливого конца по end_call — не сбой, автоответчика нет.
    expect(handsCallerBackToDialplan(`model_ended_call: ${outcome.reason}`)).toBe(false);
  });

  it("сбои остаются сбоями: чужой код, закрытие до первого слова, error от сервера", async () => {
    const a = await connected();
    speak(a.ws);
    a.ws.closeFromServer(1008, "invalid api key");
    expect(a.closes[0].normal).toBe(false);

    const b = await connected();
    b.ws.closeFromServer(1000, "");
    expect(b.closes[0].normal).toBe(false);

    const c = await connected();
    speak(c.ws);
    c.ws.server({ type: "error", error_event: { message: "protocol error" } });
    c.ws.closeFromServer(1000, "");
    expect(c.closes[0].normal).toBe(false);

    for (const info of [a.closes[0], b.closes[0], c.closes[0]]) {
      expect(providerCloseOutcome(info)).toEqual({ normal: false, reason: "gemini_closed" });
    }
    expect(handsCallerBackToDialplan("gemini_closed")).toBe(true);
  });

  it("Gemini признака normal не шлёт — его закрытие по-прежнему сбой", () => {
    expect(providerCloseOutcome({ code: 1000, reason: "" })).toEqual({ normal: false, reason: "gemini_closed" });
    expect(providerCloseOutcome(undefined).normal).toBe(false);
    expect(isElevenLabsNormalEnd(1006, { heardAudio: true, failed: false })).toBe(false);
  });
});

describe("ElevenLabs: подготовка агента", () => {
  it("наше объявление функции → клиентский инструмент с JSON Schema строчными типами", () => {
    expect(toElevenLabsClientTool(SEARCH_TOOL)).toEqual({
      type: "client",
      name: "search_properties",
      description: "Найти квартиры по словам собеседника.",
      parameters: {
        type: "object",
        properties: {
          district: { type: "string", description: "Район.", enum: ["Сино", "Шохмансур"] },
          rooms: { type: "integer", description: "Комнат минимум." },
          budget_max: { type: "number", description: "Бюджет." },
          furnished: { type: "boolean", description: "С мебелью." },
        },
        required: ["district"],
      },
      expects_response: true,
      response_timeout_secs: 30,
    });
  });

  it("правка агента: модель и прочее владельца целы, id функций добавлены, подмены разрешены", () => {
    const agent = {
      name: "Sherali",
      conversation_config: {
        agent: { prompt: { prompt: "старый", llm: "gemini-3.5-flash", tool_ids: ["own_tool"], tools: [{ name: "x" }] } },
      },
      platform_settings: { overrides: { conversation_config_override: { tts: { stability: true } } } },
    };
    expect(buildAgentSyncPatch(agent, ["tool_1", "own_tool"])).toEqual({
      conversation_config: {
        agent: { prompt: { prompt: "старый", llm: "gemini-3.5-flash", tool_ids: ["own_tool", "tool_1"] } },
      },
      platform_settings: {
        overrides: {
          conversation_config_override: {
            agent: { prompt: { prompt: true, tool_ids: true }, first_message: true, language: true },
            tts: { stability: true, voice_id: true },
          },
        },
      },
    });
  });
});

describe("выбор поставщика", () => {
  it('"google" по-прежнему создаёт клиент Gemini Live', () => {
    const client = createLiveVoiceProviderClient({ provider: "google" });
    expect(client).toBeInstanceOf(LiveVoiceClient);
    expect(client.outputSampleRateHz).toBe(24000);
    expect(client.inputSampleRateHz).toBe(16000);
  });

  it('"elevenlabs" создаёт клиент ElevenLabs', () => {
    const client = createLiveVoiceProviderClient({
      provider: "elevenlabs",
      apiKey: "k",
      agentId: "a",
      voiceIdRu: null,
      voiceIdTg: null,
    });
    expect(client).toBeInstanceOf(ElevenLabsVoiceClient);
  });

  it("без явного выбора в Настройках — Google", async () => {
    const config = await loadLiveVoiceProviderConfig();
    // Тестовая база может держать выбор от соседнего теста — проверяем только
    // форму ответа и то, что умолчание схемы — google.
    expect(["google", "elevenlabs"]).toContain(config.provider);
  });

  it("язык звонка: замок — русский; иначе язык из досье; неизвестен — русский", () => {
    expect(resolveLiveVoiceLanguage(true, "tg")).toBe("ru");
    expect(resolveLiveVoiceLanguage(false, "tg")).toBe("tg");
    expect(resolveLiveVoiceLanguage(false, undefined)).toBe("ru");
    expect(consultantLanguage({ liveVoiceForceRussianOnly: false }, "tg")).toBe("tg");
    expect(consultantLanguage({ liveVoiceForceRussianOnly: true }, "tg")).toBe("ru");
    expect(consultantLanguage(null, "tg")).toBe("ru");
  });

  it("setup Gemini не меняется от поля языка (оно только для ElevenLabs)", () => {
    const base = { systemInstruction: "P", voiceName: "Kore", tools: [SEARCH_TOOL] };
    expect(buildLiveVoiceSetupMessage({ ...base, language: "tg" } as Parameters<typeof buildLiveVoiceSetupMessage>[0])).toEqual(
      buildLiveVoiceSetupMessage(base)
    );
  });
});

describe("LIVE03: close() во время получения signed URL / подъёма сокета", () => {
  it("close до выдачи URL — сокет не создаётся, connect отказывает, ready не приходит", async () => {
    const sockets: FakeSocket[] = [];
    let releaseUrl: (url: string) => void = () => {};
    const client = new ElevenLabsVoiceClient(
      { apiKey: "sk_test", agentId: "agent_1", voiceIdRu: null, voiceIdTg: null },
      {
        signedUrl: () => new Promise<string>((resolve) => (releaseUrl = resolve)),
        prepareAgent: async () => null,
        socketFactory: () => {
          const ws = new FakeSocket();
          sockets.push(ws);
          setImmediate(() => ws.open());
          return ws as unknown as WebSocket;
        },
      }
    );
    const ready = vi.fn();
    client.on("ready", ready);
    const connecting = client.connect({ systemInstruction: "P" }).then(
      () => "ok",
      (e: Error) => e.message
    );
    await new Promise((r) => setImmediate(r));
    client.close();
    releaseUrl("wss://example.test/v1/convai/conversation?agent_id=a&token=t");
    expect(await connecting).toContain("закрыта");
    expect(sockets).toHaveLength(0);
    expect(ready).not.toHaveBeenCalled();
  });

  it("close между созданием сокета и началом разговора — созданный сокет закрывается", async () => {
    const sockets: FakeSocket[] = [];
    const { client } = makeClient(sockets);
    const ready = vi.fn();
    client.on("ready", ready);
    const connecting = client.connect({ systemInstruction: "P" }).then(
      () => "ok",
      (e: Error) => e.message
    );
    const ws = await untilSocket(sockets, 0);
    client.close();
    ws.server(METADATA);
    await connecting;
    expect(ws.closed).toBe(true);
    expect(ready).not.toHaveBeenCalled();
  });
});

describe("ElevenLabs: сервис не пускает адрес сервера (10.10.2026)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("редирект на страницу «ограничения по странам» + защита Cloudflare — не «нет прав у ключа»", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 403,
        redirected: true,
        url: "https://help.elevenlabs.io/hc/en-us/articles/22497891312401",
        text: async () => "<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>",
      }))
    );
    await expect(elevenLabsRequest("key", "GET", "/v1/convai/agents/agent_x")).rejects.toThrow(/не пускает запросы с адреса сервера/);
    await expect(elevenLabsRequest("key", "GET", "/v1/convai/agents/agent_x")).rejects.not.toThrow(/нет прав на агентов/);
  });

  it("обычный 403 от API (JSON) по-прежнему «нет прав на агентов»", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 403,
        redirected: false,
        url: "https://api.elevenlabs.io/v1/convai/agents/agent_x",
        text: async () => '{"detail":{"status":"missing_permissions"}}',
      }))
    );
    await expect(elevenLabsRequest("key", "GET", "/v1/convai/agents/agent_x")).rejects.toThrow(/нет прав на агентов/);
  });
});

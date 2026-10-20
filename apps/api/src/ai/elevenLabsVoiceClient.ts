import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import { describeError } from "../lib/describeError.js";
import { logSystemError } from "../lib/systemError.js";
import { bufferToInt16LE, int16ToBufferLE, resamplePcm16, ulawDecode, ulawEncode } from "../lib/telephony/pcmCodec.js";
import { ensureElevenLabsAgentReady, elevenLabsRequest } from "./elevenLabsAgentSync.js";
import type { LiveVoiceToolCall, LiveVoiceTranscriptEvent } from "./liveVoiceClient.js";
import type { LiveVoiceConnectOptions, LiveVoiceLanguage } from "./liveVoiceProviderTypes.js";

/**
 * КЛИЕНТ АГЕНТА ELEVENLABS ПО WEBSOCKET (02.10.2026, владелец: сравнить
 * ElevenLabs с роботом Gemini Live по телефону, но с НАШИМ мозгом).
 *
 * ElevenLabs здесь — только слух (распознавание речи), голос и модель, которая
 * ведёт разговор. Всё остальное наше и то же, что у Gemini: системный промт
 * (персона + справочник + досье) уходит в разговор подменой
 * `conversation_config_override.agent.prompt.prompt` слово в слово; функции —
 * те же объявления, заведённые у агента клиентскими инструментами
 * (ai/elevenLabsAgentSync.ts), их вызовы приходят `client_tool_call` и уходят
 * в те же обработчики моста, ответ — `client_tool_result`.
 *
 * Мост (lib/telephony/liveVoiceBridge.ts) говорит с этим классом через
 * LiveVoiceProviderClient (ai/liveVoiceProviderTypes.ts) — теми же событиями,
 * что у Gemini.
 *
 * ПРОТОКОЛ — сверен 02.10.2026 по:
 *  - https://elevenlabs.io/docs/agents-platform/api-reference/agents-platform/websocket
 *  - https://elevenlabs.io/docs/agents-platform/libraries/web-sockets
 *  - контракт AsyncAPI из SDK: github.com/elevenlabs/packages,
 *    packages/types/schemas/agent.asyncapi.yaml
 *  - https://elevenlabs.io/docs/api-reference/conversations/get-signed-url
 *  - https://elevenlabs.io/docs/eleven-agents/customization/personalization/overrides
 *
 *  Адрес: wss://api.elevenlabs.io/v1/convai/conversation?agent_id=… — для
 *  закрытого агента ссылку с токеном выдаёт GET
 *  /v1/convai/conversation/get-signed-url?agent_id=… (заголовок xi-api-key),
 *  поле ответа `signed_url`.
 *  От нас:
 *   { type: "conversation_initiation_client_data",
 *     conversation_config_override: { agent: { prompt: { prompt, tool_ids? },
 *       first_message, language }, tts: { voice_id } } }
 *   { user_audio_chunk: "<base64>" }  — формат из user_input_audio_format;
 *   { type: "pong", event_id }         — ответ на каждый ping;
 *   { type: "user_message", text }     — служебная реплика (как sendText у Gemini);
 *   { type: "client_tool_result", tool_call_id, result: <строка>, is_error }.
 *  К нам:
 *   conversation_initiation_metadata → conversation_initiation_metadata_event
 *     { conversation_id, agent_output_audio_format, user_input_audio_format }
 *     (форматы: pcm_8000 … pcm_48000, ulaw_8000);
 *   audio → audio_event { audio_base_64, event_id };
 *   agent_response → agent_response_event { agent_response };
 *   user_transcript → user_transcription_event { user_transcript };
 *   interruption → interruption_event { event_id };
 *   ping → ping_event { event_id, ping_ms };
 *   client_tool_call → client_tool_call { tool_name, tool_call_id, parameters };
 *   error → error_event.
 *
 * ЧЕГО У ELEVENLABS НЕТ, А МОСТУ НУЖНО: события «реплика закончена». Мост по
 * нему кладёт трубку после прощания и снова играет вдох перед следующей
 * репликой. Поэтому turnComplete выдаётся здесь сам, когда звук ответа перестал
 * приходить на ELEVENLABS_TURN_IDLE_MS (звук генерируется быстрее реального
 * времени, так что пауза в потоке — конец реплики, а не пауза в речи).
 *
 * ⚠️ НЕ ПРОВЕРЕНО ЖИВЫМ ЗВОНКОМ: из облачной сессии api.elevenlabs.io закрыт,
 * сверено только с документацией и юнит-тестами на поддельном сокете.
 */

/** Сколько ждём рукопожатия WebSocket — как у Gemini. */
const ELEVENLABS_HANDSHAKE_TIMEOUT_MS = 15_000;
/** Сколько ждём conversation_initiation_metadata после отправки настроек. */
const ELEVENLABS_SETUP_TIMEOUT_MS = 10_000;
/** Тишина в потоке звука ответа, после которой реплика считается законченной. */
export const ELEVENLABS_TURN_IDLE_MS = 1_000;

/** Формат звука в одну сторону: кодировка и частота. */
export interface ElevenLabsAudioFormat {
  encoding: "pcm" | "ulaw";
  sampleRateHz: number;
}

/** "pcm_16000" → { pcm, 16000 }; "ulaw_8000" → { ulaw, 8000 }. Незнакомое — PCM 16 кГц
 *  (умолчание ElevenLabs, AudioFormat в контракте). */
export function parseElevenLabsAudioFormat(value: unknown): ElevenLabsAudioFormat {
  const m = typeof value === "string" ? /^(pcm|ulaw)_(\d+)$/.exec(value) : null;
  if (!m) return { encoding: "pcm", sampleRateHz: 16_000 };
  return { encoding: m[1] as "pcm" | "ulaw", sampleRateHz: Number(m[2]) };
}

/** Звук от агента → PCM16 LE (частота — та, что в формате). */
export function decodeElevenLabsAudio(data: Buffer, format: ElevenLabsAudioFormat): Buffer {
  return format.encoding === "ulaw" ? int16ToBufferLE(ulawDecode(data)) : data;
}

/** Звук собеседника (PCM16 LE с частотой fromRateHz) → сообщение user_audio_chunk
 *  в формате, который агент ждёт на входе. */
export function buildElevenLabsAudioChunkMessage(
  pcm16: Buffer,
  fromRateHz: number,
  format: ElevenLabsAudioFormat
): { user_audio_chunk: string } {
  const samples = resamplePcm16(bufferToInt16LE(pcm16), fromRateHz, format.sampleRateHz);
  const payload = format.encoding === "ulaw" ? ulawEncode(samples) : int16ToBufferLE(samples);
  return { user_audio_chunk: payload.toString("base64") };
}

export interface ElevenLabsInitiationOptions {
  /** Тот же текст, что у Gemini: персона + справочник + досье. */
  systemInstruction: string;
  /** Язык разговора; не задан — у агента остаётся язык из кабинета. */
  language?: LiveVoiceLanguage | null;
  /** Голос ElevenLabs; не задан — голос агента из кабинета. */
  voiceId?: string | null;
  /** id функций этого звонка (подготовленных ensureElevenLabsAgentReady); null —
   *  набор функций агента не подменяем. */
  toolIds?: string[] | null;
}

/** Первое сообщение разговора. Чистая функция — проверяется тестом. */
export function buildElevenLabsInitiationMessage(opts: ElevenLabsInitiationOptions): Record<string, unknown> {
  const prompt: Record<string, unknown> = { prompt: opts.systemInstruction };
  if (opts.toolIds && opts.toolIds.length > 0) prompt.tool_ids = opts.toolIds;
  const agent: Record<string, unknown> = {
    prompt,
    // Пустая первая фраза — агент молчит, пока не получит служебную реплику
    // моста (как у Gemini: приветствие рождается из нашей роли, а не из
    // заготовки в кабинете ElevenLabs).
    first_message: "",
  };
  if (opts.language) agent.language = opts.language;
  const override: Record<string, unknown> = { agent };
  if (opts.voiceId) override.tts = { voice_id: opts.voiceId };
  return { type: "conversation_initiation_client_data", conversation_config_override: override };
}

/** Ответ на вызов функции. Наш ответ — объект; ElevenLabs принимает строку. */
export function buildElevenLabsToolResultMessage(
  call: LiveVoiceToolCall,
  response: Record<string, unknown>
): Record<string, unknown> {
  return {
    type: "client_tool_result",
    tool_call_id: call.id,
    result: JSON.stringify(response),
    is_error: response.ok === false,
  };
}

export type ElevenLabsServerUpdate =
  | { kind: "metadata"; conversationId: string | null; output: ElevenLabsAudioFormat; input: ElevenLabsAudioFormat }
  | { kind: "audio"; data: Buffer; eventId: number | null }
  | { kind: "agent_response"; text: string }
  | { kind: "user_transcript"; text: string }
  | { kind: "interruption"; eventId: number | null }
  | { kind: "ping"; eventId: number | null }
  | { kind: "tool_call"; call: LiveVoiceToolCall }
  | { kind: "error"; message: string }
  | { kind: "other"; type: string };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Разбор одного сообщения сервера. Чистая функция — проверяется тестом. */
export function parseElevenLabsServerMessage(raw: unknown): ElevenLabsServerUpdate {
  const msg = obj(raw);
  const type = typeof msg.type === "string" ? msg.type : "";
  switch (type) {
    case "conversation_initiation_metadata": {
      const ev = obj(msg.conversation_initiation_metadata_event);
      return {
        kind: "metadata",
        conversationId: typeof ev.conversation_id === "string" ? ev.conversation_id : null,
        output: parseElevenLabsAudioFormat(ev.agent_output_audio_format),
        input: parseElevenLabsAudioFormat(ev.user_input_audio_format),
      };
    }
    case "audio": {
      const ev = obj(msg.audio_event);
      const b64 = typeof ev.audio_base_64 === "string" ? ev.audio_base_64 : "";
      return { kind: "audio", data: Buffer.from(b64, "base64"), eventId: num(ev.event_id) };
    }
    case "agent_response": {
      const ev = obj(msg.agent_response_event);
      return { kind: "agent_response", text: typeof ev.agent_response === "string" ? ev.agent_response : "" };
    }
    case "user_transcript": {
      const ev = obj(msg.user_transcription_event);
      return { kind: "user_transcript", text: typeof ev.user_transcript === "string" ? ev.user_transcript : "" };
    }
    case "interruption":
      return { kind: "interruption", eventId: num(obj(msg.interruption_event).event_id) };
    case "ping":
      return { kind: "ping", eventId: num(obj(msg.ping_event).event_id) };
    case "client_tool_call": {
      const ev = obj(msg.client_tool_call);
      const id = typeof ev.tool_call_id === "string" ? ev.tool_call_id : "";
      const name = typeof ev.tool_name === "string" ? ev.tool_name : "";
      if (!id || !name) return { kind: "other", type };
      return { kind: "tool_call", call: { id, name, args: obj(ev.parameters) } };
    }
    case "error": {
      const ev = obj(msg.error_event);
      const text = typeof ev.message === "string" ? ev.message : JSON.stringify(ev).slice(0, 300);
      return { kind: "error", message: text };
    }
    default:
      return { kind: "other", type };
  }
}

/**
 * ЗАКРЫТИЕ СО СТОРОНЫ ELEVENLABS — КОНЕЦ РАЗГОВОРА ИЛИ СБОЙ (02.10.2026).
 *
 * Агент сам кладёт трубку своим системным инструментом «End call» (или по
 * пределу длительности) — ElevenLabs закрывает сокет обычным кодом 1000. Это
 * такой же вежливый конец разговора, как end_call у Gemini, и мост обязан
 * закончить звонок как обычно, а не отдавать человека автоответчику. Сбоем
 * считается всё остальное: другой код (ключ, нарушение протокола, обрыв 1006),
 * сообщение error от сервера перед закрытием, сбой сокета, а также закрытие
 * до того, как агент сказал хоть слово (разговора не было).
 */
export function isElevenLabsNormalEnd(code: number, state: { heardAudio: boolean; failed: boolean }): boolean {
  return code === 1000 && state.heardAudio && !state.failed;
}

/** Что уходит наружу событием "close": normal — разговор закончил сам агент. */
export interface ElevenLabsCloseInfo {
  code: number;
  reason: string;
  normal: boolean;
}

/** Агент отказал в разговоре (закрыл соединение до метаданных или промолчал). */
export class ElevenLabsSetupRejectedError extends Error {}

export interface ElevenLabsVoiceClientConfig {
  apiKey: string | null;
  agentId: string | null;
  voiceIdRu: string | null;
  voiceIdTg: string | null;
}

/** Голос по языку: таджикский голос не задан — русский; оба пусты — голос агента. */
export function pickElevenLabsVoiceId(
  config: Pick<ElevenLabsVoiceClientConfig, "voiceIdRu" | "voiceIdTg">,
  language: LiveVoiceLanguage | undefined
): string | null {
  if (language === "tg") return config.voiceIdTg || config.voiceIdRu || null;
  return config.voiceIdRu || null;
}

/** Открыть сокет — отдельной функцией, чтобы тест подставил поддельный. */
export type ElevenLabsSocketFactory = (url: string) => WebSocket;

const defaultSocketFactory: ElevenLabsSocketFactory = (url) =>
  new WebSocket(url, { handshakeTimeout: ELEVENLABS_HANDSHAKE_TIMEOUT_MS });

/** Адрес разговора: ссылка с токеном (закрытый агент) по ключу. */
export async function fetchElevenLabsSignedUrl(apiKey: string, agentId: string): Promise<string> {
  const res = await elevenLabsRequest<{ signed_url?: string }>(
    apiKey,
    "GET",
    `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`
  );
  if (!res.signed_url) throw new Error("ElevenLabs не выдал ссылку на разговор (signed_url пуст)");
  return res.signed_url;
}

export class ElevenLabsVoiceClient extends EventEmitter {
  private ws: WebSocket | null = null;
  /** Сокет, который ещё ждёт начала разговора (this.ws пока null). */
  private connectingWs: WebSocket | null = null;
  private closed = false;
  private ready = false;
  /** Отправленные ответы на вызовы функций по id (см. resendToolResponse). */
  private readonly answeredTools = new Map<string, string>();
  private outputFormat: ElevenLabsAudioFormat = { encoding: "pcm", sampleRateHz: 16_000 };
  private inputFormat: ElevenLabsAudioFormat = { encoding: "pcm", sampleRateHz: 16_000 };
  /** Звук с event_id не больше этого — от перебитой реплики, его не играем. */
  private interruptedUpTo = -1;
  private modelSpeaking = false;
  private turnIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private conversationId: string | null = null;
  /** Агент уже говорил в этом разговоре (см. isElevenLabsNormalEnd). */
  private heardAudio = false;
  /** Сервер прислал error или сокет упал — закрытие после этого не «конец разговора». */
  private failed = false;

  constructor(
    private readonly config: ElevenLabsVoiceClientConfig,
    private readonly deps: {
      socketFactory?: ElevenLabsSocketFactory;
      signedUrl?: (apiKey: string, agentId: string) => Promise<string>;
      prepareAgent?: typeof ensureElevenLabsAgentReady;
    } = {}
  ) {
    super();
  }

  get activeModel(): string | null {
    return this.config.agentId ? `elevenlabs:${this.config.agentId}` : "elevenlabs";
  }

  /** Вызов функции у ElevenLabs держит разговор до ответа — асинхронных нет. */
  get asyncTools(): boolean {
    return false;
  }

  get outputSampleRateHz(): number {
    return this.outputFormat.sampleRateHz;
  }

  get inputSampleRateHz(): number {
    return this.inputFormat.sampleRateHz;
  }

  /** id разговора у ElevenLabs — для поиска в их кабинете. */
  get elevenLabsConversationId(): string | null {
    return this.conversationId;
  }

  async connect(opts: LiveVoiceConnectOptions): Promise<void> {
    const { apiKey, agentId } = this.config;
    if (!apiKey) throw new Error("Ключ ElevenLabs не задан — живой голос через ElevenLabs недоступен");
    if (!agentId) throw new Error("Не указан id агента ElevenLabs");

    const prepare = this.deps.prepareAgent ?? ensureElevenLabsAgentReady;
    const toolIdsByName = await prepare(apiKey, agentId, opts.tools ?? []);
    // Подменяем набор функций, только если все функции этого звонка заведены.
    const toolIds =
      toolIdsByName && (opts.tools ?? []).every((t) => toolIdsByName.has(t.name))
        ? (opts.tools ?? []).map((t) => toolIdsByName.get(t.name)!)
        : null;

    const base: ElevenLabsInitiationOptions = {
      systemInstruction: opts.systemInstruction,
      language: opts.language ?? null,
      voiceId: pickElevenLabsVoiceId(this.config, opts.language),
      toolIds,
    };
    try {
      this.ws = await this.openSocket(apiKey, agentId, base);
    } catch (err) {
      // Таджикского может не оказаться в списке языков агента/модели — тогда
      // ElevenLabs отклоняет разговор целиком. Второй заход без подмены языка
      // (язык остаётся из кабинета, говорить по-таджикски велит сам промт)
      // лучше, чем звонок, ушедший на автоответчик.
      if (!(err instanceof ElevenLabsSetupRejectedError) || !base.language || this.closed) throw err;
      void logSystemError(
        "telephony",
        `Живой голос (ElevenLabs): агент не принял язык «${base.language}» (${err.message}) — повторяю без подмены языка.`,
        { dedupKey: `elevenlabs-language-rejected-${base.language}` }
      );
      this.ws = await this.openSocket(apiKey, agentId, { ...base, language: null });
    }
    if (this.closed) {
      this.ws?.close();
      this.ws = null;
      throw new Error("Живой голос (ElevenLabs): сессия закрыта до подключения");
    }
    this.ready = true;
    this.emit("ready");
  }

  private async openSocket(apiKey: string, agentId: string, init: ElevenLabsInitiationOptions): Promise<WebSocket> {
    if (this.closed) throw new Error("Живой голос (ElevenLabs): сессия закрыта до подключения");
    const url = await (this.deps.signedUrl ?? fetchElevenLabsSignedUrl)(apiKey, agentId);
    // Звонок мог закончиться, пока шёл запрос signed URL: close() тогда видел ws=null
    // и сокет, созданный сейчас, остался бы жить без хозяина (LIVE03).
    if (this.closed) throw new Error("Живой голос (ElevenLabs): сессия закрыта до подключения");
    const ws = (this.deps.socketFactory ?? defaultSocketFactory)(url);
    // До начала разговора сокет известен только этому вызову: close() закрывает его по ссылке.
    this.connectingWs = ws;
    return new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      let setupTimer: ReturnType<typeof setTimeout> | null = null;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (this.connectingWs === ws) this.connectingWs = null;
        if (setupTimer) clearTimeout(setupTimer);
        fn();
      };
      ws.once("open", () => {
        ws.send(JSON.stringify(buildElevenLabsInitiationMessage(init)));
        setupTimer = setTimeout(() => {
          settle(() => reject(new ElevenLabsSetupRejectedError("нет conversation_initiation_metadata за 10 с")));
          ws.close();
        }, ELEVENLABS_SETUP_TIMEOUT_MS);
        setupTimer.unref?.();
      });
      ws.on("message", (raw: RawData) => {
        const metadataArrived = this.handleMessage(ws, raw);
        if (metadataArrived) settle(() => resolve(ws));
      });
      ws.on("close", (code: number, reason: Buffer) => {
        const text = reason?.toString() ?? "";
        console.log(`[живой голос] сокет ElevenLabs закрыт: код ${code} причина «${text}»`);
        if (!settled) {
          settle(() => reject(new ElevenLabsSetupRejectedError(`закрыто до начала разговора: код ${code} «${text}»`)));
          return;
        }
        if (ws !== this.ws) return;
        this.ws = null;
        this.clearTurnIdle();
        this.modelSpeaking = false;
        const normal = isElevenLabsNormalEnd(code, { heardAudio: this.heardAudio, failed: this.failed });
        this.emit("close", { code, reason: text, normal } satisfies ElevenLabsCloseInfo);
      });
      ws.on("error", (err: Error) => {
        if (!settled) {
          settle(() => reject(err instanceof Error ? err : new Error(String(err))));
          return;
        }
        this.failed = true;
        void logSystemError("telephony", `Живой голос: сокет ElevenLabs упал: ${describeError(err)}`);
        // Закрытие придёт следом событием "close" — мост закончит сессию по нему.
      });
    });
  }

  /** Возвращает true на conversation_initiation_metadata. */
  private handleMessage(ws: WebSocket, raw: RawData): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return false; // мусор в кадре — не повод рвать разговор
    }
    const update = parseElevenLabsServerMessage(parsed);
    switch (update.kind) {
      case "metadata":
        this.outputFormat = update.output;
        this.inputFormat = update.input;
        this.conversationId = update.conversationId;
        console.log(
          `[живой голос] ElevenLabs: разговор ${update.conversationId ?? "?"}, звук к нам ` +
            `${update.output.encoding}_${update.output.sampleRateHz}, от нас ${update.input.encoding}_${update.input.sampleRateHz}`
        );
        return true;
      case "ping":
        // Без pong ElevenLabs считает соединение мёртвым и закрывает его.
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pong", event_id: update.eventId }));
        return false;
      case "audio":
        if (update.eventId !== null && update.eventId <= this.interruptedUpTo) return false;
        if (update.data.length === 0) return false;
        this.modelSpeaking = true;
        this.heardAudio = true;
        this.emit("audio", decodeElevenLabsAudio(update.data, this.outputFormat));
        this.armTurnIdle();
        return false;
      case "agent_response":
        if (update.text) this.emit("transcript", { role: "model", text: update.text } satisfies LiveVoiceTranscriptEvent);
        return false;
      case "user_transcript":
        if (update.text) this.emit("transcript", { role: "user", text: update.text } satisfies LiveVoiceTranscriptEvent);
        return false;
      case "interruption":
        if (update.eventId !== null) this.interruptedUpTo = Math.max(this.interruptedUpTo, update.eventId);
        this.clearTurnIdle();
        this.modelSpeaking = false;
        this.emit("interrupted");
        return false;
      case "tool_call":
        this.emit("toolCall", [update.call]);
        return false;
      case "error":
        this.failed = true;
        void logSystemError("telephony", `Живой голос (ElevenLabs): ошибка разговора: ${update.message}`, {
          dedupKey: "elevenlabs-conversation-error",
        });
        return false;
      default:
        return false;
    }
  }

  private armTurnIdle(): void {
    this.clearTurnIdle();
    this.turnIdleTimer = setTimeout(() => {
      this.turnIdleTimer = null;
      if (!this.modelSpeaking) return;
      this.modelSpeaking = false;
      this.emit("turnComplete");
    }, ELEVENLABS_TURN_IDLE_MS);
    this.turnIdleTimer.unref?.();
  }

  private clearTurnIdle(): void {
    if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
    this.turnIdleTimer = null;
  }

  sendAudioChunk(pcm16: Buffer, sampleRateHz = 16_000): void {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(buildElevenLabsAudioChunkMessage(pcm16, sampleRateHz, this.inputFormat)));
  }

  /** Служебная реплика от лица собеседника — тот же приём, что у Gemini
   *  (приветствие первым, извинение на таджикском). */
  sendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "user_message", text }));
  }

  /** Ответ на вызов функции. scheduling — понятие Gemini, здесь не нужно:
   *  разговор и так ждёт ответа (expects_response у инструмента). */
  sendToolResponse(call: LiveVoiceToolCall, response: Record<string, unknown>): void {
    const msg = JSON.stringify(buildElevenLabsToolResultMessage(call, response));
    // Запоминаем ответ: если вызов придёт ещё раз, а ответ не дошёл, мост повторит
    // его отсюда (resendToolResponse), как у Gemini. Запас ограничен.
    this.answeredTools.set(call.id, msg);
    if (this.answeredTools.size > 50) this.answeredTools.delete(this.answeredTools.keys().next().value as string);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(msg);
  }

  /** Повторить ответ, который уже отправлялся на этот вызов. false — не отвечали. */
  resendToolResponse(call: LiveVoiceToolCall): boolean {
    const msg = this.answeredTools.get(call.id);
    if (!msg) return false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(msg);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTurnIdle();
    this.ws?.close();
    this.ws = null;
    this.connectingWs?.close();
    this.connectingWs = null;
  }
}

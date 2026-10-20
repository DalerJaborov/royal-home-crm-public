import { EventEmitter } from "node:events";
import { parseLiveVoiceTranscription, liveVoiceTranscriptionObservations, type LiveVoiceTranscriptionFragment } from "./liveVoiceTranscription.js";
import WebSocket, { type RawData } from "ws";
import { resolveGeminiKey, resolveGeminiKeys } from "./geminiClient.js";
import {
  GEMINI_LIVE_MODEL,
  geminiProxyHeaders,
  liveModelSupportsAsyncTools,
  liveVoiceModelChain,
} from "./geminiTransport.js";
import { logSystemError } from "../lib/systemError.js";
import { liveVoiceInputTranscriptionConfig } from "./liveVoiceTranscriptionHints.js";

/**
 * КЛИЕНТ GEMINI LIVE API (WebSocket BidiGenerateContent) — пункт 5 очереди ИИ,
 * 23.08.2026. Тонкий событийный клиент: мосту с ARI (lib/telephony/liveVoiceBridge.ts)
 * всё равно, откуда берётся звук, ему нужны только события audio/transcript/close/error.
 *
 * ⚠️ НЕ ПРОВЕРЕНО ЖИВЫМ ЗВОНКОМ (23.08.2026). Протокол сверен с документацией
 * (ai.google.dev/api/live, ai.google.dev/gemini-api/docs/live), но ни разу не
 * открывалось настоящее соединение — ни ключ, ни прокси, ни само наличие WS-апгрейда
 * через Cloudflare Worker (см. предупреждение в liveVoiceWsUrl ниже) не проверены.
 *
 * ЧТО НАЙДЕНО В ДОКУМЕНТАЦИИ (со ссылками — см. отчёт задачи):
 *  - Вход: raw 16-bit PCM, 16kHz, little-endian, в realtimeInput.audio как
 *    { data: base64, mimeType: "audio/pcm;rate=16000" }.
 *  - Выход: raw 16-bit PCM, 24kHz, little-endian — приходит в
 *    serverContent.modelTurn.parts[].inlineData.data (base64), mimeType "audio/pcm;rate=24000".
 *  - Транскрипция ОБЕИХ сторон разговора — поддерживается: в setup нужно включить
 *    inputAudioTranscription/outputAudioTranscription (пустые объекты), тогда в
 *    serverContent приходят inputTranscription.text (что сказал человек) и
 *    outputTranscription.text (что ответила модель). Ключевая цитата документации:
 *    «The transcription is sent independently of the other server messages and
 *    there is no guaranteed ordering» — то есть транскрипция и аудио одного и того
 *    же произнесённого куска могут прийти РАЗНЫМИ сообщениями не по порядку;
 *    liveVoiceBridge.ts копит текст по мере поступления, а не привязывает к аудио.
 *  - Function calling ВНУТРИ Live-сессии — поддерживается (BidiGenerateContentToolCall
 *    с functionCalls[] от сервера, BidiGenerateContentToolResponse с
 *    functionResponses[] от клиента, сопоставление по полю id). ПОДКЛЮЧЕНО
 *    12.09.2026 (второй живой звонок: бот терял имя/телефон, положенные на
 *    память модели в свободной речи, а не в структурированный вызов) — два
 *    инструмента объявлены в liveVoiceBridge.ts (save_contact, end_call),
 *    парсинг/ответ здесь — см. sendToolResponse и событие "toolCall".
 *  - Лимит длительности сессии (уточнено 24.09.2026 по странице
 *    ai.google.dev/gemini-api/docs/live-api/session-management): одно соединение
 *    живёт около 10 минут и перед закрытием присылает GoAway; аудио-сессия без
 *    сжатия контекста обрывается на 15-й минуте. Продолжение по токену
 *    (sessionResumption) и сжатие скользящим окном (contextWindowCompression)
 *    РЕАЛИЗОВАНЫ ниже — см. докстринг LiveVoiceClient.
 */

/** Одно объявление функции для function calling внутри Live-сессии (см.
 *  докстринг файла) — JSON Schema параметров в упрощённом виде, которого
 *  хватает нашим двум инструментам (строки, ничего вложенного). */
export interface LiveVoiceFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "OBJECT";
    /** STRING — как было; NUMBER/INTEGER/BOOLEAN добавлены 24.09.2026 для поиска
     *  квартир голосом (бюджет, комнаты). Вложенных объектов по-прежнему нет. */
    properties: Record<string, { type: "STRING" | "NUMBER" | "INTEGER" | "BOOLEAN"; description: string; enum?: string[] }>;
    required?: string[];
  };
}

/** realtimeInputConfig.automaticActivityDetection (документация: ai.google.dev/api/live) —
 *  чувствительность серверного определения речи. См. LIVE_VOICE_ACTIVITY_DETECTION
 *  в liveVoiceBridge.ts, где объясняется, зачем это нужно живому голосу. */
export interface LiveVoiceActivityDetection {
  startOfSpeechSensitivity?: "START_SENSITIVITY_LOW" | "START_SENSITIVITY_HIGH";
  endOfSpeechSensitivity?: "END_SENSITIVITY_LOW" | "END_SENSITIVITY_HIGH";
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
}

export interface LiveVoiceSetupOptions {
  /** Модель Live API. По умолчанию GEMINI_LIVE_MODEL (geminiTransport.ts). */
  model?: string;
  systemInstruction: string;
  /** Голос ответа (speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName в API) —
   *  оставлено настраиваемым на будущее, конкретное имя голоса не проверено. */
  voiceName?: string;
  /** Функции, которые модель может вызвать посреди разговора (см. liveVoiceBridge.ts:
   *  save_contact/end_call) — вместо того чтобы полагаться на то, что модель САМА
   *  не забудет сказанное клиентом и правильно поймёт, что разговор окончен. */
  tools?: LiveVoiceFunctionDeclaration[];
  /** Чувствительность определения речи — не задано, если хотите поведение Gemini
   *  по умолчанию (см. LiveVoiceActivityDetection выше). */
  activityDetection?: LiveVoiceActivityDetection;
  /** realtimeInputConfig.turnCoverage (24.09.2026). TURN_INCLUDES_ONLY_ACTIVITY —
   *  в ход модели попадает только звук, где собеседник говорил, а не вся тишина
   *  линии: так делает телефонный пример самого Google, и это прямо экономия —
   *  Live API перечитывает весь накопленный контекст на каждом ходе. */
  turnCoverage?: "TURN_INCLUDES_ONLY_ACTIVITY" | "TURN_INCLUDES_ALL_INPUT";
  /** Продолжение сессии (24.09.2026). Поле sessionResumption отправляется ВСЕГДА —
   *  без него Google не присылает SessionResumptionUpdate, и продлить разговор
   *  после GoAway нечем. handle — токен из прошлого соединения того же звонка. */
  resumeHandle?: string | null;
  /** Сжатие контекста скользящим окном (24.09.2026): без него аудио-сессия
   *  обрывается на 15-й минуте (ai.google.dev/gemini-api/docs/live-api/session-management).
   *  Число — порог в токенах, после которого старое начало разговора сжимается. */
  compressionTriggerTokens?: number;
  /** speechConfig.languageCode (BCP-47: "ru", "tg"). Документация Live API: модели с
   *  «родным» звуком язык ответа выбирают сами и явный код НЕ поддерживают — поэтому
   *  поле уходит в setup только по явному запросу (см. liveVoiceSpeechLanguageCode),
   *  а основная защита языка — системная инструкция и сторож на выходе моста
   *  (lib/telephony/liveVoiceGuards.ts). */
  speechLanguageCode?: string;
  /** Тело inputAudioTranscription (11.10.2026, ai/liveVoiceTranscriptionHints.ts). Не
   *  задано — подсказка по умолчанию (таджикский и русский); мост передаёт её под язык
   *  звонка, а клиент сам ставит `{}`, если модель отвергла setup с подсказкой. */
  inputTranscription?: Record<string, unknown>;
}

/**
 * Код языка речи для setup Gemini Live (08.10.2026). ПО УМОЛЧАНИЮ — НЕ ОТПРАВЛЯЕТСЯ:
 * по документации (ai.google.dev/gemini-api/docs/live-guide) модели с родным звуком
 * «don't support explicitly setting the language code», и неподдержанное поле могло бы
 * отвергнуть setup целиком — то есть уронить все звонки. Включается переменной
 * окружения LIVE_VOICE_SPEECH_LANGUAGE_CODE=1 после проверки живым звонком на
 * конкретной модели (GEMINI_LIVE_MODEL). В таблице языков документации русский — `ru`,
 * таджикский — `tg` (Tajik поддерживается).
 */
export function liveVoiceSpeechLanguageCode(language: "ru" | "tg" | undefined): string | undefined {
  if (!language) return undefined;
  return process.env.LIVE_VOICE_SPEECH_LANGUAGE_CODE === "1" ? language : undefined;
}

/**
 * Температура ответа живого голоса (10.10.2026, владелец: «слышно, что робот — слишком
 * ровно и чётко»). ПО УМОЛЧАНИЮ — НЕ ОТПРАВЛЯЕТСЯ: поведение модели как было.
 * Включается переменной окружения LIVE_VOICE_TEMPERATURE (число от 0 до 2, например
 * 1.1) для пробы на слух. generationConfig.temperature есть в справочнике Live API
 * (ai.google.dev/api/live), но влияет ли она на подачу голоса у gemini-3.8-live, в
 * документации не сказано — поэтому только проба, не настройка по умолчанию.
 *
 * Чего здесь НЕТ и почему (docs/robot-voice-options-2026-10-09.md): у gemini-3.8-live
 * `enableAffectiveDialog` убран, `proactivity` включён всегда и `proactiveAudio: false`
 * даёт ошибку, `thinkingConfig` не поддерживается — посылать их нельзя, setup отвергнут.
 */
export function liveVoiceTemperature(): number | undefined {
  const raw = process.env.LIVE_VOICE_TEMPERATURE?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 2 ? value : undefined;
}

/** JSON-сообщение `setup`, которым открывается Live-сессия. Чистая функция —
 *  проверяется юнит-тестом без сети (структура, а не сетевой эффект). */
export function buildLiveVoiceSetupMessage(opts: LiveVoiceSetupOptions): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    responseModalities: ["AUDIO"],
  };
  const temperature = liveVoiceTemperature();
  if (temperature !== undefined) generationConfig.temperature = temperature;
  if (opts.voiceName || opts.speechLanguageCode) {
    const speechConfig: Record<string, unknown> = {};
    if (opts.voiceName) speechConfig.voiceConfig = { prebuiltVoiceConfig: { voiceName: opts.voiceName } };
    if (opts.speechLanguageCode) speechConfig.languageCode = opts.speechLanguageCode;
    generationConfig.speechConfig = speechConfig;
  }
  const setup: Record<string, unknown> = {
    model: `models/${opts.model ?? GEMINI_LIVE_MODEL}`,
    systemInstruction: { parts: [{ text: opts.systemInstruction }] },
    generationConfig,
    // Пустой объект включает транскрипцию стороны
    // (BidiGenerateContentSetup.inputAudioTranscription/outputAudioTranscription,
    // тип AudioTranscriptionConfig — по документации у него нет обязательных полей).
    // Клиенту с 11.10.2026 — подсказка языка по умолчанию (замер на записях прода:
    // ai/liveVoiceTranscriptionHints.ts); LIVE_VOICE_TRANSCRIBE_HINTS=0 — прежний `{}`.
    inputAudioTranscription: opts.inputTranscription ?? liveVoiceInputTranscriptionConfig(),
    outputAudioTranscription: {},
  };
  if (opts.tools && opts.tools.length > 0) {
    setup.tools = [{ functionDeclarations: opts.tools }];
  }
  const realtimeInputConfig: Record<string, unknown> = {};
  if (opts.activityDetection) realtimeInputConfig.automaticActivityDetection = opts.activityDetection;
  if (opts.turnCoverage) realtimeInputConfig.turnCoverage = opts.turnCoverage;
  if (Object.keys(realtimeInputConfig).length > 0) setup.realtimeInputConfig = realtimeInputConfig;
  if (opts.resumeHandle !== undefined) {
    setup.sessionResumption = opts.resumeHandle ? { handle: opts.resumeHandle } : {};
  }
  if (opts.compressionTriggerTokens) {
    setup.contextWindowCompression = { triggerTokens: opts.compressionTriggerTokens, slidingWindow: {} };
  }
  return { setup };
}

/** Сообщение с одним куском входного аудио (то, что говорит клиент). `sampleRateHz`
 *  обязан совпадать с реальной частотой чанка — Live API читает её из mimeType, а
 *  не проверяет длину данных. */
export function buildRealtimeAudioMessage(pcm16: Buffer, sampleRateHz = 16000): Record<string, unknown> {
  return {
    realtimeInput: {
      audio: {
        data: pcm16.toString("base64"),
        mimeType: `audio/pcm;rate=${sampleRateHz}`,
      },
    },
  };
}

/** Сумма токенов одной модальности из списка `*TokensDetails` Google. */
export function modalityTokens(details: unknown, modality: string): number {
  if (!Array.isArray(details)) return 0;
  let sum = 0;
  for (const item of details) {
    const entry = item as { modality?: unknown; tokenCount?: unknown };
    if (entry?.modality === modality && typeof entry.tokenCount === "number") sum += entry.tokenCount;
  }
  return sum;
}

export interface LiveVoiceServerUpdate {
  /** Куски аудио-ответа модели (24kHz PCM), в порядке появления в parts. */
  audioChunks: Buffer[];
  /** Что сказал клиент — если пришло этим сообщением (см. докстринг файла про
   *  несовпадающий порядок с аудио). */
  inputTranscript?: string;
  /** Provider metadata observation only, separate from legacy transcript events. */
  inputTranscription?: LiveVoiceTranscriptionFragment;
  interimInputTranscription?: LiveVoiceTranscriptionFragment;
  /** Что ответила модель — тем же путём. */
  outputTranscript?: string;
  outputTranscription?: LiveVoiceTranscriptionFragment;
  /** Модель закончила реплику (serverContent.turnComplete). */
  turnComplete: boolean;
  /** Клиент перебил модель на середине ответа (serverContent.interrupted) — сигнал
   *  мосту немедленно остановить проигрывание уже отправленного клиенту аудио. */
  interrupted: boolean;
  /** Пришло BidiGenerateContentSetupComplete — до этого сообщения ничего, кроме
   *  setup, отправлять нельзя (см. документацию). */
  setupComplete: boolean;
  /** Модель вызвала одну или несколько функций из tools (BidiGenerateContentToolCall) —
   *  см. liveVoiceBridge.ts: save_contact/end_call. */
  toolCalls?: LiveVoiceToolCall[];
  /**
   * Расход токенов на сессию (13.09.2026, «стоимость звонка нигде не видна») —
   * из top-level `usageMetadata` серверного сообщения, той же формы, что у
   * обычного generateContent (см. callGemini в geminiClient.ts): promptTokenCount/
   * candidatesTokenCount/cachedContentTokenCount. По документации Live API это
   * поле НАКОПИТЕЛЬНОЕ (расход за всю сессию на момент сообщения), поэтому
   * потребитель (liveVoiceBridge.ts) должен ЗАМЕНЯТЬ прошлое значение новым, а
   * не прибавлять — так же, как это устроено у обычных ответов Gemini.
   * ⚠️ НЕ ПРОВЕРЕНО ЖИВЫМ ЗВОНКОМ — как и весь этот клиент (см. докстринг файла);
   * если Google это поле не шлёт, usage останется undefined и AiLog просто не
   * получит запись по этой сессии (честное «нет данных», не выдуманный ноль).
   */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    /** Сколько из inputTokens/outputTokens — звук: у Live API он стоит иначе текста
     *  (ai/pricing.ts). Не задано — Google разбивку по модальностям не прислал. */
    audioInputTokens?: number;
    audioOutputTokens?: number;
  };
  /** Сервер скоро закроет соединение (GoAway, 24.09.2026) — сколько миллисекунд
   *  осталось. Соединение живёт «около 10 минут», сессия при этом продолжается
   *  на новом соединении по токену продолжения (см. resumeHandle). */
  goAwayMs?: number;
  /** Новый токен продолжения сессии (SessionResumptionUpdate). Годится только
   *  если resumable — посреди генерации ответа Google присылает resumable:false. */
  resumption?: { handle: string; resumable: boolean };
  /** Модель отменила свои вызовы функций (toolCallCancellation) — обычно потому,
   *  что собеседник перебил её, пока функция выполнялась. */
  cancelledToolCallIds?: string[];
}

/** "12.5s" → 12500. Длительности в JSON Google передаёт строкой с суффиксом s. */
export function parseProtoDurationMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
  if (typeof value !== "string") return undefined;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

export interface LiveVoiceToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Разбор одного серверного сообщения. Чистая функция — проверяется на образцах
 *  JSON без реального сокета. */
export function parseLiveVoiceServerMessage(raw: unknown): LiveVoiceServerUpdate {
  const update: LiveVoiceServerUpdate = {
    audioChunks: [],
    turnComplete: false,
    interrupted: false,
    setupComplete: false,
  };
  if (!raw || typeof raw !== "object") return update;
  const msg = raw as Record<string, unknown>;
  if (msg.setupComplete) update.setupComplete = true;

  const toolCall = msg.toolCall as { functionCalls?: { id?: string; name?: string; args?: Record<string, unknown> }[] } | undefined;
  if (toolCall?.functionCalls && toolCall.functionCalls.length > 0) {
    update.toolCalls = toolCall.functionCalls
      .filter((c): c is { id: string; name: string; args?: Record<string, unknown> } => !!c.id && !!c.name)
      .map((c) => ({ id: c.id, name: c.name, args: c.args ?? {} }));
  }

  const serverContent = msg.serverContent as Record<string, unknown> | undefined;
  if (serverContent) {
    const modelTurn = serverContent.modelTurn as
      | { parts?: { inlineData?: { data?: string; mimeType?: string } }[] }
      | undefined;
    for (const part of modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data && (part.inlineData?.mimeType ?? "").startsWith("audio/")) {
        update.audioChunks.push(Buffer.from(data, "base64"));
      }
    }
    const inputT = serverContent.inputTranscription as { text?: string } | undefined;
    const outputT = serverContent.outputTranscription as { text?: string } | undefined;
    const inputMetadata = parseLiveVoiceTranscription(serverContent.inputTranscription);
    const interimMetadata = parseLiveVoiceTranscription(serverContent.interimInputTranscription);
    const outputMetadata = parseLiveVoiceTranscription(serverContent.outputTranscription);
    if (inputMetadata) update.inputTranscription = inputMetadata;
    if (interimMetadata) update.interimInputTranscription = interimMetadata;
    if (outputMetadata) update.outputTranscription = outputMetadata;
    if (inputT?.text) update.inputTranscript = inputT.text;
    if (outputT?.text) update.outputTranscript = outputT.text;
    if (serverContent.turnComplete) update.turnComplete = true;
    if (serverContent.interrupted) update.interrupted = true;
  }

  /*
   * У Live API выход называется responseTokenCount (а не candidatesTokenCount, как
   * у generateContent — до 03.10.2026 читалось только оно, и выход звонка был
   * нулём), а разбивка по модальностям лежит в promptTokensDetails /
   * responseTokensDetails / cacheTokensDetails: [{ modality, tokenCount }].
   */
  const usageMetadata = msg.usageMetadata as
    | {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        responseTokenCount?: number;
        cachedContentTokenCount?: number;
        promptTokensDetails?: unknown;
        responseTokensDetails?: unknown;
        candidatesTokensDetails?: unknown;
        cacheTokensDetails?: unknown;
      }
    | undefined;
  if (usageMetadata) {
    const cached = usageMetadata.cachedContentTokenCount ?? 0;
    const inputTokens = Math.max(0, (usageMetadata.promptTokenCount ?? 0) - cached);
    const outputTokens = usageMetadata.responseTokenCount ?? usageMetadata.candidatesTokenCount ?? 0;
    const audioIn =
      modalityTokens(usageMetadata.promptTokensDetails, "AUDIO") - modalityTokens(usageMetadata.cacheTokensDetails, "AUDIO");
    const audioOut = modalityTokens(usageMetadata.responseTokensDetails ?? usageMetadata.candidatesTokensDetails, "AUDIO");
    update.usage = {
      inputTokens,
      outputTokens,
      cacheReadTokens: cached,
      audioInputTokens: Math.min(inputTokens, Math.max(0, audioIn)),
      audioOutputTokens: Math.min(outputTokens, Math.max(0, audioOut)),
    };
  }

  const goAway = msg.goAway as { timeLeft?: unknown } | undefined;
  if (goAway && typeof goAway === "object") update.goAwayMs = parseProtoDurationMs(goAway.timeLeft) ?? 0;

  const resumption = msg.sessionResumptionUpdate as { newHandle?: unknown; resumable?: unknown } | undefined;
  if (resumption && typeof resumption.newHandle === "string" && resumption.newHandle) {
    update.resumption = { handle: resumption.newHandle, resumable: resumption.resumable === true };
  }

  const cancellation = msg.toolCallCancellation as { ids?: unknown } | undefined;
  if (cancellation && Array.isArray(cancellation.ids)) {
    update.cancelledToolCallIds = cancellation.ids.filter((id): id is string => typeof id === "string");
  }
  return update;
}

/**
 * Адрес WebSocket-сессии Live API.
 *
 * ⚠️ ПРОКСИ ЧЕРЕЗ WS — НЕ ПРОВЕРЕН. Регион VPS геоблокирован Gemini API напрямую
 * (см. докстринг geminiTransport.ts, «User location is not supported»), поэтому
 * обычные вызовы generateContent идут через Cloudflare Worker (GEMINI_PROXY_URL).
 * Тот же Worker проксирует HTTP fetch — умеет ли он ТАКЖЕ пропускать апгрейд
 * соединения до WebSocket, неизвестно: это отдельный код на стороне Worker,
 * который никто не проверял для WS-маршрута. Если не умеет — живой голос не
 * подключится вовсе, и это будет видно сразу по ошибке открытия сокета, а не
 * молча. Без прокси и без региона, где Gemini доступен напрямую, сокет тоже не
 * откроется — это тот же геоблок, что у остальных вызовов Gemini.
 */
export function liveVoiceWsUrl(apiKey: string): string {
  const path = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
  const proxyUrl = process.env.GEMINI_PROXY_URL;
  if (proxyUrl) {
    const wsBase = proxyUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:").replace(/\/+$/, "");
    return `${wsBase}/gemini${path}?key=${encodeURIComponent(apiKey)}`;
  }
  return `wss://generativelanguage.googleapis.com${path}?key=${encodeURIComponent(apiKey)}`;
}

export interface LiveVoiceTranscriptEvent {
  role: "user" | "model";
  text: string;
}

/**
 * Сколько ждём рукопожатия WebSocket до Gemini Live (13.09.2026).
 *
 * connect() раньше ждал только "open"/"error" без ограничения по времени — если
 * TCP-рукопожатие через прокси зависало (тот же ненадёжный туннель, что и у ARI),
 * промис висел вечно, а вызывающий код (liveVoiceBridge.ts, `await gemini.connect(...)`
 * внутри try/catch) не получал ни успеха, ни отказа: живой звонок замирал молча.
 * `ws` сам закрывает сокет по истечении и эмитит "error" — тот же обработчик,
 * что уже ловит обычный сбой рукопожатия, превращает это в отказ connect().
 */
const LIVE_VOICE_HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * Сколько ждём setupComplete после отправки setup (24.09.2026). Сокет открылся,
 * но Google молчит — считаем, что эта модель сессию не открыла, и пробуем
 * запасную (см. liveVoiceModelChain), а не держим звонящего в тишине.
 */
const LIVE_VOICE_SETUP_TIMEOUT_MS = 10_000;

/** Сколько раз подряд переподключаемся по токену продолжения, прежде чем
 *  признать сессию потерянной (24.09.2026). Счётчик сбрасывается каждым удачным
 *  переподключением — длинный разговор может переподключаться сколько угодно раз. */
const LIVE_VOICE_MAX_RESUME_ATTEMPTS = 3;

/** Паузы между попытками продолжить сессию после обрыва (02.10.2026, аудит В3):
 *  раньше три попытки шли подряд без паузы, каждая до 25 с — звонящий слышал
 *  только тишину до 75 с. */
const LIVE_VOICE_RESUME_BACKOFF_MS = [500, 1_500, 3_000];
/** Общий потолок «продолжить не вышло»: дольше человек не ждёт в тишине. */
const LIVE_VOICE_RESUME_DEADLINE_MS = 30_000;
/** Служебная реплика или ответ функции, которые не ушли из-за переподключения,
 *  ждут нового соединения не дольше этого — потом они уже не к месту. */
const LIVE_VOICE_PENDING_SEND_TTL_MS = 20_000;
const LIVE_VOICE_PENDING_SEND_MAX = 8;
/** Сколько последних ответов функций помнить для повтора (см. answeredTools). */
const LIVE_VOICE_ANSWERED_TOOLS_MAX = 64;
/**
 * Сроки одной попытки открыть соединение. Без `budgetMs` — полные (рукопожатие 15 с,
 * setup 10 с); с ним попытка укладывается в остаток общего потолка «связи нет»
 * (LIVE_VOICE_RESUME_DEADLINE_MS): рукопожатие — не дольше остатка, setup — не дольше
 * остатка за вычетом уже ушедшего на рукопожатие (но не меньше секунды).
 */
export function liveVoiceAttemptTimeouts(
  budgetMs: number | undefined,
  elapsedMs: number
): { handshakeMs: number; setupMs: number } {
  if (budgetMs === undefined) {
    return { handshakeMs: LIVE_VOICE_HANDSHAKE_TIMEOUT_MS, setupMs: LIVE_VOICE_SETUP_TIMEOUT_MS };
  }
  return {
    handshakeMs: Math.min(LIVE_VOICE_HANDSHAKE_TIMEOUT_MS, budgetMs),
    setupMs: Math.min(LIVE_VOICE_SETUP_TIMEOUT_MS, Math.max(1_000, budgetMs - elapsedMs)),
  };
}

/** Закрытие сокета в первые секунды после setupComplete, до первого звука модели,
 *  — отказ самой модели (02.10.2026, аудит В4): пробуем запасную, один раз за звонок. */
const LIVE_VOICE_EARLY_CLOSE_WINDOW_MS = 15_000;

/** Если сервер прислал GoAway, а модель посреди реплики, ждём её конца, но не
 *  дольше, чем за столько миллисекунд до обещанного закрытия. */
const LIVE_VOICE_GOAWAY_SAFETY_MS = 1_500;

/** Модель отклонила setup (закрыла соединение до setupComplete или промолчала) —
 *  повод попробовать следующую модель из цепочки, а не сорвать звонок. */
export class LiveVoiceSetupRejectedError extends Error {}

/**
 * РАЗБОР ОТКАЗОВ GOOGLE (09.10.2026, аудит линии робота, п.7). Раньше любой отказ на
 * старте сливался в один ключ журнала `live-voice-start-failed`: кончились деньги,
 * квота, ключ отозван — всё выглядело одинаково, а утром «1 ошибка». Текст — что
 * угодно от Google или прокси: код рукопожатия (`Unexpected server response: 429`),
 * причина закрытия сокета (`1008 «Quota exceeded…»`), тело `error` в сообщении.
 *  - "quota" — 429, RESOURCE_EXHAUSTED, квота, биллинг: денег или лимита нет;
 *  - "key"   — 401/403, PERMISSION_DENIED, ключ не принят (в том числе прокси без x-proxy-key);
 *  - null    — прочее (сеть, 1011, таймаут): прежний путь.
 * Чистая функция — ради теста.
 */
export type GeminiFailureKind = "quota" | "key";

export function classifyGeminiFailure(text: string): GeminiFailureKind | null {
  if (!text) return null;
  if (/\b429\b|RESOURCE_EXHAUSTED|quota|billing|exceeded|insufficient|prepay/i.test(text)) return "quota";
  if (/\b40[13]\b|PERMISSION_DENIED|UNAUTHENTICATED|API[_ ]?KEY|api key not valid|forbidden|unauthori[sz]ed/i.test(text)) return "key";
  return null;
}

/** Ключи журнала — постоянные: поток одинаковых отказов — одна проблема, а не сто. */
export const GEMINI_FAILURE_DEDUP_KEYS: Record<GeminiFailureKind, string> = {
  quota: "live-voice-gemini-quota",
  key: "live-voice-gemini-key",
};

function logGeminiFailure(kind: GeminiFailureKind, detail: string): void {
  void logSystemError(
    "ai",
    kind === "quota"
      ? `Живой голос: Google отказал по квоте или оплате (${detail}) — проверьте баланс и лимиты проекта Gemini. Робот пробует запасной ключ и модель.`
      : `Живой голос: Google не принял ключ (${detail}) — проверьте ключ Gemini в Настройках и доступ прокси. Робот пробует запасной ключ.`,
    { dedupKey: GEMINI_FAILURE_DEDUP_KEYS[kind] }
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Событийный клиент одной Live-сессии. Использование:
 *   const client = new LiveVoiceClient();
 *   client.on("audio", (chunk: Buffer) => ...);       // 24kHz PCM от модели
 *   client.on("transcript", (e) => ...);               // { role, text }
 *   client.on("interrupted", () => ...);                // клиент перебил модель
 *   client.on("resumed", () => ...);                    // сессия продолжилась на новом соединении
 *   client.on("close", (info) => ...);                  // сессия потеряна окончательно
 *   client.on("error", (err) => ...);
 *   await client.connect({ systemInstruction });
 *   client.sendAudioChunk(pcm16at16kHz);
 *   client.close();
 *
 * ПРОДОЛЖЕНИЕ СЕССИИ (24.09.2026). Одно соединение Live API живёт «около 10
 * минут» и перед закрытием присылает GoAway; без сжатия контекста аудио-сессия
 * к тому же обрывается на 15-й минуте. До этой правки любое закрытие сокета
 * значило конец звонка — потолок в 5 минут стоял именно поэтому. Теперь клиент
 * сам открывает новое соединение с последним токеном продолжения
 * (SessionResumptionUpdate, resumable:true) и подменяет им старое; мост об этом
 * узнаёт только событием "resumed". "close" наружу — лишь когда продолжить
 * нечем (токена нет, или три попытки подряд не удались).
 */
export class LiveVoiceClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private transcriptionEpoch = 0;
  private readonly transcriptionConnections = new WeakMap<WebSocket, { model: string; epoch: number; messageOrder: number }>();
  private closed = false;
  /** Сколько сообщений сервера уже показано в журнале (диагностика, см. handleMessage). */
  private diagSeen = 0;
  /** Сколько кусков звука ушло в модель (диагностика, см. sendAudioChunk). */
  private diagSent = 0;
  /** BidiGenerateContentSetupComplete уже пришло — "ready" наружу один раз за звонок,
   *  переподключения его не повторяют (иначе мост поздоровался бы второй раз). */
  private setupAcked = false;
  /** Настройки сессии — нужны, чтобы переподключиться с теми же. */
  private setupOpts: LiveVoiceSetupOptions | null = null;
  /** Модель, на которой сессия реально открылась (см. liveVoiceModelChain). */
  private model: string | null = null;
  /** Последний токен продолжения, пригодный для переподключения. */
  private resumeHandle: string | null = null;
  private resumeAttempts = 0;
  private resuming = false;
  /** GoAway пришёл — переключиться на новое соединение при первой возможности. */
  private goAwayPending = false;
  private goAwayTimer: ReturnType<typeof setTimeout> | null = null;
  /** Модель сейчас говорит: от первого куска звука до turnComplete/interrupted. */
  private modelSpeaking = false;
  /** Модель хоть раз прислала звук или закончила реплику — сессия «зажила»
   *  (граница между «модель отказала» и «обрыв посреди разговора», см. earlyFallback). */
  private modelResponded = false;
  /** Когда текущая модель приняла setup — для окна «ранней смерти». */
  private setupAt = 0;
  /** Запасная модель после ранней смерти уже пробовалась (один раз за звонок). */
  private earlyFallbackUsed = false;
  /** Когда началась текущая потеря связи (null — связь есть). */
  private outageSince: number | null = null;
  /** Реплики и ответы функций, не ушедшие во время переподключения. */
  private pendingSends: { at: number; label: string; msg: string }[] = [];
  /** Уже отправленные ответы функций (id → сообщение): ответ мог протухнуть в
   *  очереди переподключения или пропасть при ранней смерти модели, а сервер после
   *  продолжения шлёт тот же вызов снова — мост повторяет ответ из этого кэша, а не
   *  молчит «как на повтор» (аудит 02.10.2026, п.9). */
  private answeredTools = new Map<string, { label: string; msg: string }>();
  /** Ключ, на котором открылась сессия, если это не первый (запасной после отказа
   *  первого по квоте/ключу): переподключения и запасная модель идут на нём же. */
  private apiKey: string | null = null;
  /** Обрыв посреди разговора уже записан в журнал — раз на звонок. */
  private midcallCloseLogged = false;
  /** Подсказку распознаванию уже сняли после отказа setup (см. dropTranscriptionHints). */
  private transcriptionHintsDropped = false;

  /** Частоты звука для моста (02.10.2026, второй поставщик голоса — см.
   *  ai/liveVoiceProvider.ts): Gemini отдаёт 24 кГц и ждёт 16 кГц, как и раньше. */
  readonly outputSampleRateHz = 24_000;
  readonly inputSampleRateHz = 16_000;

  /** Модель, на которой открыта сессия (null до connect). */
  get activeModel(): string | null {
    return this.model;
  }

  /** Функции у этой модели асинхронные: разговор не замирает, пока идёт поиск. */
  get asyncTools(): boolean {
    return this.model ? liveModelSupportsAsyncTools(this.model) : false;
  }

  async connect(opts: LiveVoiceSetupOptions): Promise<void> {
    this.setupOpts = opts;
    const chain = liveVoiceModelChain(opts.model);
    let lastErr: unknown = null;
    /** Все ключи (основной и запасные) — читаются только после первого отказа по
     *  квоте/ключу: на обычном звонке лишнего запроса к базе нет. */
    let keys: string[] | null = null;
    for (const model of chain) {
      // ЗАПАСНОЙ КЛЮЧ И ЗАПАСНАЯ МОДЕЛЬ НА 429/403 (09.10.2026, аудит линии, п.7):
      // раньше отказ рукопожатия по квоте или ключу сразу ронял звонок, хотя второй
      // ключ (другой проект Google — другая квота) и запасная модель были под рукой.
      let keyIndex = 0;
      for (;;) {
        if (this.closed) throw new Error("Живой голос: сессия закрыта до подключения");
        const keyOverride = keyIndex > 0 && keys ? keys[keyIndex] : undefined;
        try {
          const ws = await this.openSocket(model, null, undefined, keyOverride);
          // Сессию закрыли, пока открывался сокет (звонящий положил трубку на
          // приветствии, 02.10.2026): close() этот сокет ещё не видел — закрываем
          // его сами, иначе он жил бы без хозяина и держал платное соединение.
          if (this.closed) {
            ws.close();
            throw new Error("Живой голос: сессия закрыта до подключения");
          }
          this.ws = ws;
          this.model = model;
          if (keyOverride) this.apiKey = keyOverride;
          this.setupAt = Date.now();
          // "ready" — после того как сокет стал действующим: мост на "ready"
          // сразу шлёт приветственную реплику через sendText.
          this.markReady();
          return;
        } catch (err) {
          lastErr = err;
          if (this.closed) throw err;
          const kind = classifyGeminiFailure(errorText(err));
          if (kind) {
            logGeminiFailure(kind, `модель ${model}${keyIndex > 0 ? `, запасной ключ №${keyIndex + 1}` : ""}: ${errorText(err)}`);
            keys ??= await resolveGeminiKeys().catch(() => []);
            if (keyIndex + 1 < keys.length) {
              keyIndex += 1;
              continue; // тот же звонок, та же модель, следующий ключ
            }
            break; // ключи кончились — следующая модель цепочки
          }
          if (!(err instanceof LiveVoiceSetupRejectedError)) throw err;
          if (this.dropTranscriptionHints(model, err)) continue; // та же модель и ключ, setup без подсказки
          void logSystemError(
            "ai",
            `Живой голос: модель ${model} не открыла сессию (${err.message})` +
              (model !== chain[chain.length - 1] ? " — пробую запасную." : "."),
            { dedupKey: `live-voice-model-rejected-${model}` }
          );
          break;
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Живой голос: ни одна модель не открыла сессию");
  }

  /**
   * ОТКАТ ПОДСКАЗКИ РАСПОЗНАВАНИЮ (11.10.2026). Подсказка языка теперь уходит в setup по
   * умолчанию (ai/liveVoiceTranscriptionHints.ts); gemini-3.8-live её принимает (замер на
   * записях прода), но запасная модель или будущая версия может отвергнуть поле — Google
   * закрывает сокет до setupComplete кодом 1007 (неверные данные) или 1008 с текстом про
   * неверный аргумент.
   * Тогда та же модель повторяется один раз с прежним пустым `{}`, а не уходит дальше по
   * цепочке с тем же полем и не роняет звонок. Квота/ключ (тоже бывают 1008) сюда не
   * доходят — их разбирает classifyGeminiFailure раньше. Возвращает true, если повтор уместен.
   */
  private dropTranscriptionHints(model: string, err: Error): boolean {
    if (this.transcriptionHintsDropped || !this.setupOpts) return false;
    // 1007 — «неверные данные» в setup; 1008 — только с текстом про неверный аргумент/поле:
    // «model not found» (тоже 1008) должен сразу идти к запасной модели, без лишнего круга.
    const fieldRejected =
      /код 1007\b/.test(err.message) ||
      (/код 1008\b/.test(err.message) && /invalid|unknown name|argument|payload|language|vocabulary|transcription/i.test(err.message));
    if (!fieldRejected) return false;
    const current = this.setupOpts.inputTranscription ?? liveVoiceInputTranscriptionConfig();
    if (Object.keys(current).length === 0) return false;
    this.transcriptionHintsDropped = true;
    this.setupOpts = { ...this.setupOpts, inputTranscription: {} };
    void logSystemError(
      "ai",
      `Живой голос: модель ${model} отвергла setup с подсказкой языка распознаванию (${err.message}) — ` +
        "повторяю без подсказки. Если повторяется — LIVE_VOICE_TRANSCRIBE_HINTS=0.",
      { dedupKey: "live-voice-transcribe-hints-rejected" }
    );
    return true;
  }

  /**
   * Открыть одно соединение и дождаться setupComplete. Сокет, закрывшийся раньше
   * setupComplete, — LiveVoiceSetupRejectedError (повод для запасной модели или
   * новой попытки продолжения); ошибка рукопожатия — обычная ошибка.
   */
  private async openSocket(model: string, handle: string | null, budgetMs?: number, keyOverride?: string): Promise<WebSocket> {
    const apiKey = keyOverride ?? this.apiKey ?? (await resolveGeminiKey());
    if (!apiKey) throw new Error("Ключ Gemini не настроен — живой голос недоступен");
    const opts = this.setupOpts!;
    const url = liveVoiceWsUrl(apiKey);
    // ЗАГОЛОВОК ДОСТУПА К ПРОКСИ НУЖЕН И ЗДЕСЬ (найдено первым живым звонком,
    // 12.09.2026): без x-proxy-key Cloudflare Worker отвечал 403 на рукопожатие.
    // Потолок «связи нет» (LIVE_VOICE_RESUME_DEADLINE_MS) проверялся только МЕЖДУ
    // попытками, а одна попытка тянется до 25 с (рукопожатие 15 + setup 10): человек
    // слышал тишину до ~55 с. `budgetMs` — сколько осталось до потолка: рукопожатие и
    // setup укладываются в него (аудит 02.10.2026, п.14).
    const startedAt = Date.now();
    const handshakeMs = liveVoiceAttemptTimeouts(budgetMs, 0).handshakeMs;
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: geminiProxyHeaders(),
        handshakeTimeout: handshakeMs,
      });
      this.transcriptionConnections.set(ws, { model, epoch: ++this.transcriptionEpoch, messageOrder: 0 });
      let settled = false;
      let setupTimer: ReturnType<typeof setTimeout> | null = null;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (setupTimer) clearTimeout(setupTimer);
        fn();
      };

      ws.once("open", () => {
        ws.send(
          JSON.stringify(
            buildLiveVoiceSetupMessage({ ...opts, model, resumeHandle: handle ?? opts.resumeHandle ?? null })
          )
        );
        const setupMs = liveVoiceAttemptTimeouts(budgetMs, Date.now() - startedAt).setupMs;
        setupTimer = setTimeout(() => {
          settle(() => reject(new LiveVoiceSetupRejectedError(`нет setupComplete за ${Math.round(setupMs / 1000)} с`)));
          ws.close();
        }, setupMs);
        setupTimer.unref?.();
      });
      ws.on("message", (raw) => {
        const setupDone = this.handleMessage(ws, raw);
        if (setupDone) settle(() => resolve(ws));
      });
      ws.on("close", (code, reason) => {
        const text = reason?.toString() ?? "";
        // Диагностика: код и причина закрытия — единственный способ отличить
        // «модель не ответила» от «сервер нас выгнал».
        console.log(`[живой голос] сокет Gemini закрыт: код ${code} причина «${text}»`);
        if (!settled) {
          settle(() => reject(new LiveVoiceSetupRejectedError(`закрыто до setupComplete: код ${code} «${text}»`)));
          return;
        }
        this.onSocketClosed(ws, code, text);
      });
      ws.on("error", (err) => {
        if (!settled) {
          settle(() => reject(err instanceof Error ? err : new Error(String(err))));
          return;
        }
        void logSystemError(
          "ai",
          `Живой голос: сокет Gemini Live упал: ${err instanceof Error ? err.message : String(err)}`
        );
        // Закрытие придёт следом событием "close" — там и решается, продолжать ли.
      });
    });
  }

  /** Соединение закрылось после того, как сессия уже шла. */
  private onSocketClosed(ws: WebSocket, code: number, reason: string): void {
    // Старое соединение, которое мы сами заменили новым, — не событие.
    if (ws !== this.ws) return;
    this.ws = null;
    if (this.closed) {
      this.safeEmit("close", { code, reason });
      return;
    }
    // Квота/ключ посреди разговора — отдельной строкой журнала (п.7 аудита 09.10).
    const kind = classifyGeminiFailure(`${code} ${reason}`);
    if (kind) logGeminiFailure(kind, `соединение закрыто посреди разговора: код ${code} «${reason}»`);
    if (this.nextFallbackModel()) {
      void this.earlyFallback(code, reason);
      return;
    }
    void this.resume(`соединение закрыто: код ${code} «${reason}»`);
  }

  /**
   * ОБРЫВ ПОСРЕДИ РАЗГОВОРА БЕЗ ПРОДОЛЖЕНИЯ — В ЖУРНАЛ (09.10.2026, аудит линии, п.9).
   * Раньше след оставался только в `endedReason` сессии: бот замолкал на полуслове,
   * человек уходил на автоответчик, а в «Здоровье системы» — ничего. Один раз на
   * звонок, ключ постоянный.
   */
  private reportMidcallClose(detail: string): void {
    if (this.midcallCloseLogged || this.closed) return;
    this.midcallCloseLogged = true;
    void logSystemError(
      "ai",
      `Живой голос: связь с Gemini оборвалась посреди разговора и не восстановилась (${detail}) — ` +
        "звонок отдан станции (автоответчик).",
      { dedupKey: "live-voice-gemini-closed-midcall" }
    );
  }

  /** Событие наружу так, чтобы исключение в чужом слушателе не вылетело из
   *  `ws.on("message")` и не стало uncaughtException (а с ним — process.exit(1)
   *  всего API со всеми звонками, 02.10.2026, аудит В7). */
  private safeEmit(event: string, ...args: unknown[]): void {
    try {
      this.emit(event, ...args);
    } catch (err) {
      void logSystemError(
        "ai",
        `Живой голос: обработчик события «${event}» бросил исключение: ${err instanceof Error ? err.message : String(err)}`,
        { dedupKey: `live-voice-listener-${event}` }
      );
    }
  }

  /**
   * ЗАПАСНАЯ МОДЕЛЬ ПОСЛЕ РАННЕЙ СМЕРТИ (02.10.2026, аудит В4). Модель приняла
   * setup, а потом закрыла сокет (1007/1008/1011) — например, на первой служебной
   * реплике или на описании функций, — не успев сказать ни слова. Продолжать
   * нечем (токена нет или он от той же модели), и звонок оборвался бы на второй
   * секунде. Следующая модель цепочки открывается заново; один раз за звонок.
   * Возвращает её имя, если попытка уместна.
   */
  private nextFallbackModel(): string | null {
    if (this.earlyFallbackUsed || this.modelResponded || !this.model || !this.setupOpts) return null;
    // Есть годный токен продолжения — сессия уже шла, сначала пробуем продолжить её
    // на той же модели (resume ограничен по числу попыток), а не начинать заново.
    if (this.resumeHandle) return null;
    if (Date.now() - this.setupAt > LIVE_VOICE_EARLY_CLOSE_WINDOW_MS) return null;
    const chain = liveVoiceModelChain(this.setupOpts.model);
    const idx = chain.indexOf(this.model);
    return idx >= 0 && idx + 1 < chain.length ? chain[idx + 1] : null;
  }

  private async earlyFallback(code: number, reason: string): Promise<void> {
    const next = this.nextFallbackModel();
    if (!next || this.resuming || this.closed) return;
    this.earlyFallbackUsed = true;
    this.resuming = true;
    this.outageSince ??= Date.now();
    this.safeEmit("reconnecting");
    try {
      void logSystemError(
        "ai",
        `Живой голос: модель ${this.model} закрыла сокет сразу после setup (код ${code} «${reason}») — пробую запасную ${next}.`,
        { dedupKey: `live-voice-early-close-${this.model}` }
      );
      const fresh = await this.openSocket(next, null);
      if (this.closed) {
        fresh.close();
        return;
      }
      this.ws = fresh;
      this.model = next;
      this.setupAt = Date.now();
      this.resumeHandle = null;
      this.outageSince = null;
      // Прежние реплики адресованы умершей сессии: приветствие мост пошлёт заново сам.
      this.pendingSends = [];
      console.log(`[живой голос] ранняя смерть модели — сессия открыта на запасной ${next}`);
      this.safeEmit("fallback", { model: next });
    } catch (err) {
      void logSystemError(
        "ai",
        `Живой голос: запасная модель ${next} тоже не открылась: ${err instanceof Error ? err.message : String(err)}`,
        { dedupKey: "live-voice-early-fallback-failed" }
      );
      if (!this.ws && !this.closed) this.safeEmit("close", { code, reason: `ранняя смерть модели, запасная не открылась (${reason})` });
    } finally {
      this.resuming = false;
    }
  }

  /**
   * Продолжить сессию на новом соединении по токену продолжения. Вызывается и
   * заранее (GoAway — старое соединение ещё живо, звук идёт по нему до подмены),
   * и после неожиданного закрытия. Не удалось или токена нет — "close" наружу.
   *
   * После обрыва (старого соединения уже нет) наружу идёт "reconnecting" и, в
   * конце, "resumed": мост на них сбрасывает «бот говорит» и пауза сторожа
   * тишины (02.10.2026, аудит В3). Между неудачными попытками — пауза, а общий
   * потолок LIVE_VOICE_RESUME_DEADLINE_MS не даёт держать человека в тишине дольше.
   */
  private async resume(why: string): Promise<void> {
    if (this.resuming || this.closed) return;
    const handle = this.resumeHandle;
    if (!handle || !this.model || this.resumeAttempts >= LIVE_VOICE_MAX_RESUME_ATTEMPTS) {
      if (!this.ws) {
        this.reportMidcallClose(`продолжить нечем: ${why}`);
        this.safeEmit("close", { code: 0, reason: `продолжить нечем (${why})` });
      }
      return;
    }
    this.resuming = true;
    this.resumeAttempts += 1;
    if (!this.ws) {
      if (this.outageSince === null) {
        this.outageSince = Date.now();
        this.safeEmit("reconnecting");
      }
    }
    try {
      // Связи нет (старого соединения нет) — попытка не вправе съесть больше, чем
      // осталось до потолка; при живом старом (GoAway) срок не нужен.
      const budget = this.ws ? undefined : Math.max(2_000, LIVE_VOICE_RESUME_DEADLINE_MS - (Date.now() - (this.outageSince ?? Date.now())));
      const fresh = await this.openSocket(this.model, handle, budget);
      if (this.closed) {
        fresh.close();
        return;
      }
      const old = this.ws;
      this.ws = fresh;
      this.goAwayPending = false;
      if (this.goAwayTimer) clearTimeout(this.goAwayTimer);
      this.goAwayTimer = null;
      this.resumeAttempts = 0;
      this.outageSince = null;
      old?.close();
      console.log(`[живой голос] сессия продолжена на новом соединении (${why})`);
      this.flushPendingSends();
      this.safeEmit("resumed");
    } catch (err) {
      void logSystemError(
        "ai",
        `Живой голос: продолжение сессии не удалось (${why}): ${err instanceof Error ? err.message : String(err)}`,
        { dedupKey: "live-voice-resume-failed" }
      );
      // Старое соединение ещё живо (GoAway) — попробуем ещё раз ближе к закрытию;
      // уже мертво — следующая попытка после паузы, пока не кончатся попытки и срок.
      if (!this.ws && !this.closed) {
        const outageMs = Date.now() - (this.outageSince ?? Date.now());
        if (this.resumeAttempts >= LIVE_VOICE_MAX_RESUME_ATTEMPTS || outageMs > LIVE_VOICE_RESUME_DEADLINE_MS) {
          this.resuming = false;
          this.reportMidcallClose(`продолжить не вышло: ${why}`);
          this.safeEmit("close", { code: 0, reason: `продолжить не вышло (${why})` });
          return;
        }
        const pause = LIVE_VOICE_RESUME_BACKOFF_MS[Math.min(this.resumeAttempts - 1, LIVE_VOICE_RESUME_BACKOFF_MS.length - 1)];
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, pause);
          timer.unref?.();
        });
        this.resuming = false;
        return this.resume(why);
      }
      this.resuming = false;
      return;
    }
    this.resuming = false;
  }

  /** Служебная реплика или ответ функции, пока соединения нет: ждёт нового
   *  соединения (а не пропадает молча, как раньше), но недолго. */
  private sendOrQueue(label: string, msg: string): void {
    if (this.closed) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
      return;
    }
    if (!this.setupAcked) return; // соединение ещё не открывалось вовсе — слать нечего и не к чему
    if (this.pendingSends.length >= LIVE_VOICE_PENDING_SEND_MAX) {
      const dropped = this.pendingSends.shift();
      console.log(`[живой голос] очередь на время переподключения переполнена — «${dropped?.label}» выброшено`);
    }
    this.pendingSends.push({ at: Date.now(), label, msg });
    console.log(`[живой голос] соединения нет — «${label}» отложено до переподключения`);
  }

  private flushPendingSends(): void {
    const queued = this.pendingSends;
    this.pendingSends = [];
    for (const item of queued) {
      if (Date.now() - item.at > LIVE_VOICE_PENDING_SEND_TTL_MS) {
        console.log(`[живой голос] «${item.label}» устарело за время переподключения — не отправлено`);
        continue;
      }
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(item.msg);
    }
  }

  /** Переключиться на новое соединение, если GoAway ждёт и модель не посреди фразы. */
  private maybeSwapAfterGoAway(): void {
    if (this.goAwayPending && !this.modelSpeaking) void this.resume("GoAway");
  }

  /** Возвращает true на setupComplete ЭТОГО соединения. */
  private handleMessage(ws: WebSocket, raw: RawData): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return false; // мусор в кадре — не повод рвать сессию
    }
    // Диагностика первого запуска (12.09.2026): что именно присылает сервер.
    if (this.diagSeen < 10) {
      this.diagSeen += 1;
      const keys = parsed && typeof parsed === "object" ? Object.keys(parsed as object).join(",") : typeof parsed;
      const err = (parsed as { error?: unknown })?.error;
      console.log(
        `[живой голос] от Gemini #${this.diagSeen}: ${keys}` + (err ? ` ОШИБКА: ${JSON.stringify(err).slice(0, 300)}` : "")
      );
    }
    // Тело `error` от Google (квота, ключ) — отдельной строкой журнала (п.7 аудита 09.10).
    const serverError = (parsed as { error?: unknown } | null)?.error;
    if (serverError) {
      const text = typeof serverError === "string" ? serverError : JSON.stringify(serverError);
      const kind = classifyGeminiFailure(text);
      if (kind) logGeminiFailure(kind, `ответ сервера: ${text.slice(0, 200)}`);
    }
    const update = parseLiveVoiceServerMessage(parsed);
    // Токен продолжения берём с любого соединения — он про сессию, а не про сокет.
    if (update.resumption?.resumable) this.resumeHandle = update.resumption.handle;
    // Остальное — только от действующего соединения (или от того, что ещё
    // открывается: его setupComplete нужен вызывающему).
    if (ws !== this.ws) return update.setupComplete;

    if (update.audioChunks.length > 0) {
      this.modelSpeaking = true;
      this.modelResponded = true;
    }
    for (const chunk of update.audioChunks) this.safeEmit("audio", chunk);
    if (update.inputTranscript) {
      this.safeEmit("transcript", { role: "user", text: update.inputTranscript } satisfies LiveVoiceTranscriptEvent);
    }
    if (update.outputTranscript) {
      this.safeEmit("transcript", { role: "model", text: update.outputTranscript } satisfies LiveVoiceTranscriptEvent);
    }
    const transcriptionConnection = this.transcriptionConnections.get(ws);
    if (transcriptionConnection) {
      transcriptionConnection.messageOrder += 1;
      for (const observation of liveVoiceTranscriptionObservations(update, {
        model: transcriptionConnection.model, connectionEpoch: transcriptionConnection.epoch,
        messageOrder: transcriptionConnection.messageOrder,
      })) this.safeEmit("transcription", observation);
    }
    if (update.interrupted) {
      this.modelSpeaking = false;
      this.safeEmit("interrupted");
    }
    if (update.usage) this.safeEmit("usage", update.usage);
    if (update.cancelledToolCallIds && update.cancelledToolCallIds.length > 0) {
      this.safeEmit("toolCallCancellation", update.cancelledToolCallIds);
    }
    if (update.toolCalls && update.toolCalls.length > 0) this.safeEmit("toolCall", update.toolCalls);
    if (update.turnComplete) {
      this.modelSpeaking = false;
      this.modelResponded = true;
      this.safeEmit("turnComplete");
    }
    if (update.goAwayMs !== undefined && !this.goAwayPending) {
      this.goAwayPending = true;
      console.log(`[живой голос] GoAway: соединение закроется через ${update.goAwayMs} мс`);
      // Страховка: модель так и не договорила — переключаемся незадолго до закрытия.
      this.goAwayTimer = setTimeout(
        () => void this.resume("GoAway, срок на исходе"),
        Math.max(0, update.goAwayMs - LIVE_VOICE_GOAWAY_SAFETY_MS)
      );
      this.goAwayTimer.unref?.();
    }
    if (update.interrupted || update.turnComplete || update.goAwayMs !== undefined) this.maybeSwapAfterGoAway();
    return false;
  }

  /** Отдельно от handleMessage: setupComplete открывающегося соединения — это
   *  "ready" наружу только в первый раз за звонок. */
  private markReady(): void {
    if (this.setupAcked) return;
    this.setupAcked = true;
    this.safeEmit("ready");
  }

  /** Кусок аудио клиента (16-bit PCM, 16kHz LE). Молча не отправляет, если
   *  соединения нет (открывается, переподключается или уже закрыто). */
  sendAudioChunk(pcm16: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.diagSent === 0) {
        this.diagSent = -1;
        console.log("[живой голос] звук пришёл, но сокет Gemini ещё/уже не открыт — кусок потерян");
      }
      return;
    }
    this.ws.send(JSON.stringify(buildRealtimeAudioMessage(pcm16, 16000)));
    this.diagSent += 1;
    if (this.diagSent === 1 || this.diagSent % 250 === 0) {
      console.log(`[живой голос] в Gemini ушло кусков звука: ${this.diagSent}`);
    }
  }

  /**
   * Текстовая реплика от лица собеседника — единственный официальный способ
   * заставить Live API заговорить ПЕРВЫМ (12.09.2026). Документация Google прямо
   * называет этот приём: «to have Live API initiate the conversation, include a
   * prompt asking it to greet the user». Роль "user" здесь — служебная
   * реплика-триггер, а не слова собеседника.
   */
  sendText(text: string): void {
    this.sendOrQueue(
      "служебная реплика",
      JSON.stringify({
        clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true },
      })
    );
  }

  /**
   * Ответ на вызов функции (BidiGenerateContentToolResponse) — ОБЯЗАТЕЛЕН.
   *
   * `scheduling` (24.09.2026) — только для моделей с асинхронными функциями
   * (asyncTools): WHEN_IDLE — договорить начатое («секунду, смотрю…») и потом
   * рассказать результат; SILENT — просто принять к сведению (сохранили контакт);
   * INTERRUPT — сказать сразу. Прежней модели поле не отправляем: у неё вызов и
   * так блокирует разговор до ответа.
   */
  sendToolResponse(
    call: LiveVoiceToolCall,
    response: Record<string, unknown>,
    scheduling?: "INTERRUPT" | "WHEN_IDLE" | "SILENT"
  ): void {
    const body = scheduling && this.asyncTools ? { ...response, scheduling } : response;
    const msg = JSON.stringify({
      toolResponse: { functionResponses: [{ id: call.id, name: call.name, response: body }] },
    });
    const label = `ответ функции ${call.name}`;
    this.answeredTools.set(call.id, { label, msg });
    if (this.answeredTools.size > LIVE_VOICE_ANSWERED_TOOLS_MAX) {
      this.answeredTools.delete(this.answeredTools.keys().next().value as string);
    }
    this.sendOrQueue(label, msg);
  }

  /** Повторить ответ, который уже отправлялся на этот вызов (см. answeredTools).
   *  false — отвечать на этот id ещё не приходилось. */
  resendToolResponse(call: LiveVoiceToolCall): boolean {
    const answered = this.answeredTools.get(call.id);
    if (!answered) return false;
    this.sendOrQueue(answered.label, answered.msg);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.goAwayTimer) clearTimeout(this.goAwayTimer);
    this.goAwayTimer = null;
    this.pendingSends = [];
    this.ws?.close();
    this.ws = null;
  }
}

/**
 * ОЗВУЧКА ОДНОЙ РЕПЛИКИ ЧЕРЕЗ LIVE API (14.09.2026, настройки → «наш бот» →
 * прослушка голоса). ДО ЭТОГО кнопка «Прослушать» дёргала обычный
 * generateContent TTS (ai/tts.ts) — другую модель с другим, более коротким
 * списком языков, в который таджикский не входит вовсе (проверено вживую по
 * документации Google). Из-за этого прослушка на таджикском падала с ошибкой
 * ВСЕГДА, независимо от ключа, а сама прослушка по-русски звучала не тем
 * голосом/движком, что настоящий звонок, — подпись «звучит ровно тем же
 * приветствием» была неточной.
 *
 * Здесь — та же самая связка, что и в реальном звонке (liveVoiceBridge.ts):
 * тот же LiveVoiceClient, тот же приём "поздоровайся первым" через служебную
 * текстовую реплику (см. sendText), та же системная инструкция
 * (buildLiveVoiceSystemPrompt), тот же выбор голоса. Разница только в том,
 * что здесь нет ни ARI, ни RTP моста — просто открыть сессию, дождаться
 * ответа, закрыть.
 *
 * НЕ ПРОВЕРЕНО ЖИВЫМ ПРОСЛУШИВАНИЕМ (14.09.2026) — механизм теперь бьёт в
 * правильный движок и правильный список языков, но насколько чисто звучит
 * акцент, можно узнать только на слух, не сборкой.
 */
export async function previewLiveVoiceGreeting(
  opts: { systemInstruction: string; voiceName?: string; greetingTrigger: string },
  timeoutMs = 15_000
): Promise<{ audioBase64: string; sampleRateHz: number; transcript: string } | null> {
  const client = new LiveVoiceClient();
  const audioChunks: Buffer[] = [];
  let transcript = "";

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(null), timeoutMs);
    // unref — таймер не должен держать процесс живым, если что-то другое его завершает раньше.
    timer.unref?.();

    function finish(result: { audioBase64: string; sampleRateHz: number; transcript: string } | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.close();
      resolve(result);
    }

    client.on("audio", (chunk: Buffer) => audioChunks.push(chunk));
    client.on("transcript", (e: LiveVoiceTranscriptEvent) => {
      if (e.role === "model") transcript += e.text;
    });
    client.on("turnComplete", () => {
      if (audioChunks.length === 0) return finish(null);
      finish({ audioBase64: Buffer.concat(audioChunks).toString("base64"), sampleRateHz: 24000, transcript });
    });
    client.on("error", () => finish(null));
    client.on("close", () => {
      if (settled) return;
      finish(audioChunks.length > 0 ? { audioBase64: Buffer.concat(audioChunks).toString("base64"), sampleRateHz: 24000, transcript } : null);
    });
    client.once("ready", () => client.sendText(opts.greetingTrigger));

    client
      .connect({ systemInstruction: opts.systemInstruction, voiceName: opts.voiceName })
      .catch(() => finish(null));
  });
}

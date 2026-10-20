import type { EventEmitter } from "node:events";
import type { LiveVoiceSetupOptions, LiveVoiceToolCall } from "./liveVoiceClient.js";

/**
 * КТО СЛЫШИТ И ГОВОРИТ ЗА РОБОТА НА ТЕЛЕФОНЕ (02.10.2026, владелец: «сравнить
 * ElevenLabs с нашим роботом по телефону, но с НАШИМ мозгом»).
 *
 * Мост со станцией (lib/telephony/liveVoiceBridge.ts) говорит только с этим
 * интерфейсом. Роль, справочник, досье, функции (поиск квартир, СМС, перевод
 * агенту, итог звонка) остаются нашими и одинаковыми для обоих поставщиков —
 * меняются только слух, голос и модель, которая ведёт разговор.
 *
 *  - "google"     — Gemini Live (ai/liveVoiceClient.ts), как было до 02.10.2026.
 *                   Поведение байт-в-байт прежнее; это значение по умолчанию.
 *  - "elevenlabs" — агент ElevenLabs (ai/elevenLabsVoiceClient.ts) по WebSocket.
 *
 * События, которые мост слушает у любого поставщика:
 *   "ready"            — можно говорить (мост шлёт служебную реплику-приветствие);
 *   "audio" (Buffer)   — PCM16 LE с частотой outputSampleRateHz;
 *   "transcript"       — { role: "user" | "model", text }, legacy compatibility;
 *   "transcription"    — optional Google metadata observation (liveVoiceTranscription.ts),
 *                        separate input/interim/output; never human FINAL or consent;
 *   "interrupted"      — собеседник перебил, недоигранное выбросить;
 *   "turnComplete"     — реплика закончена;
 *   "toolCall"         — LiveVoiceToolCall[]; ответ — sendToolResponse;
 *   "usage", "toolCallCancellation", "resumed" — только у Google;
 *   "close" / "error"  — сессия потеряна.
 */
export interface LiveVoiceProviderClient extends EventEmitter {
  /** Модель, на которой идёт разговор (для журнала стоимости); null — неизвестно. */
  readonly activeModel: string | null;
  /** Функции асинхронные (Google gemini-3.8-live); ElevenLabs — всегда false. */
  readonly asyncTools: boolean;
  /** Частота звука, который поставщик отдаёт событием "audio". */
  readonly outputSampleRateHz: number;
  /** Частота, в которой поставщику удобнее всего получать звук собеседника. */
  readonly inputSampleRateHz: number;
  connect(opts: LiveVoiceConnectOptions): Promise<void>;
  /** Кусок звука собеседника, PCM16 LE с частотой sampleRateHz (по умолчанию 16 кГц). */
  sendAudioChunk(pcm16: Buffer, sampleRateHz?: number): void;
  /** Служебная реплика от лица собеседника (приветствие, извинение на таджикском). */
  sendText(text: string): void;
  sendToolResponse(
    call: LiveVoiceToolCall,
    response: Record<string, unknown>,
    scheduling?: "INTERRUPT" | "WHEN_IDLE" | "SILENT"
  ): void;
  /** Повторить ответ, который уже отправлялся на этот вызов (вызов пришёл снова, а
   *  ответ потерялся). false — на этот id не отвечали. */
  resendToolResponse(call: LiveVoiceToolCall): boolean;
  close(): void;
}

/** Язык звонка, как его выбрала наша логика (замок «только русский», досье). */
export type LiveVoiceLanguage = "ru" | "tg";

/** Настройки сессии: прежние гугловские плюс язык — его читает только ElevenLabs
 *  (у Gemini язык определяет сама модель, поле в setup не уходит). */
export interface LiveVoiceConnectOptions extends LiveVoiceSetupOptions {
  language?: LiveVoiceLanguage;
}

export type LiveVoiceProviderName = "google" | "elevenlabs";

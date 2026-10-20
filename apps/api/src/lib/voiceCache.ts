import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { synthesizeSpeech } from "../ai/tts.js";
import { logSystemError } from "./systemError.js";

/**
 * Общий дисковый кеш озвучки: PCM от Gemini TTS → WAV-файл с детерминированным
 * именем, атомарная запись, склейка одновременных запросов.
 *
 * Раньше вся эта механика лежала внутри lib/greetingVoice.ts. Утренний брифинг
 * директору (lib/morningBriefing.ts) кеширует WAV ровно так же, и второй копии
 * заголовка RIFF, таймаута и tmp+rename в репозитории быть не должно: правка в
 * одной копии (например увеличить таймаут) молча не доехала бы до второй.
 */

/** Приватный каталог кеша — ВНЕ публичного `uploads`, раздавать статикой нельзя. */
export const privateVoiceRoot = path.join(
  path.resolve(process.env.PRIVATE_UPLOADS_DIR ?? "./uploads-private"),
  "voice"
);

/** Первые 10 hex sha1 — короткое имя файла, меняется вместе с любым входом. */
export function voiceCacheKey(...parts: string[]): string {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 10);
}

/**
 * WAV = 44-байтный RIFF-заголовок + сырой PCM16 моно. Gemini TTS отдаёт PCM без
 * заголовка (см. ai/tts.ts) — фронт для ответов ассистента дописывает его сам в
 * браузере (lib/pcmToWav.ts), но кешируемая озвучка пишется файлом на сервере, и
 * значит заголовок нужен здесь же, один раз при генерации, а не при каждой отдаче.
 */
export function pcmToWav(pcm: Buffer, sampleRateHz: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRateHz * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // размер подблока fmt
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Внешний вызов без явного предела висит до таймаута сокета — здесь он явный. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export const VOICE_TTS_TIMEOUT_MS = 15_000;

/** Одновременные запросы одного и того же файла не должны звать TTS дважды. */
const inFlight = new Map<string, Promise<string | null>>();

export interface EnsureCachedWavParams {
  /** Каталог кеша, создаётся при необходимости. */
  dir: string;
  /** Полный путь итогового .wav внутри `dir`. */
  filePath: string;
  /** Текст (или инструкция + текст) для TTS. */
  speechInput: string;
  voice: string;
  /** Для записи в журнал при таймауте: «Озвучка <label> не удалась». */
  label: string;
  timeoutMs?: number;
}

/**
 * Путь к WAV: из кеша, либо синтезирует и кладёт в кеш. `null` — озвучка
 * недоступна (нет ключа/квота/ошибка/таймаут); вызывающий обязан пережить null,
 * звук нигде не является обязательной частью ответа.
 */
export async function ensureCachedWav(params: EnsureCachedWavParams): Promise<string | null> {
  const { dir, filePath, speechInput, voice, label } = params;
  const timeoutMs = params.timeoutMs ?? VOICE_TTS_TIMEOUT_MS;

  if (fs.existsSync(filePath)) return filePath;

  const existing = inFlight.get(filePath);
  if (existing) return existing;

  const task = (async (): Promise<string | null> => {
    try {
      const result = await withTimeout(synthesizeSpeech(speechInput, { voice }), timeoutMs);
      if (!result) return null;

      const wav = pcmToWav(Buffer.from(result.audioBase64, "base64"), result.sampleRateHz);
      fs.mkdirSync(dir, { recursive: true });
      // Атомарная запись: пишем во временный файл и переименовываем — конкурентный
      // читатель никогда не увидит частично записанный WAV.
      const tmpPath = path.join(dir, `.tmp-${crypto.randomUUID()}.wav`);
      fs.writeFileSync(tmpPath, wav);
      fs.renameSync(tmpPath, filePath);
      return filePath;
    } catch (err) {
      // synthesizeSpeech сам логирует отказы сети/квоты через logSystemError;
      // здесь ловим только таймаут, у которого своей записи в tts.ts нет.
      if (err instanceof Error && err.message === "timeout") {
        void logSystemError("ai", `Озвучка ${label} не удалась: таймаут ${timeoutMs} мс`);
      }
      return null;
    } finally {
      inFlight.delete(filePath);
    }
  })();

  inFlight.set(filePath, task);
  return task;
}

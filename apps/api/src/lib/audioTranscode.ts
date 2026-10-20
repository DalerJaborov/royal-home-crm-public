import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logSystemError } from "./systemError.js";

/**
 * Перекодировка голосового агента в формат, который примет Meta.
 *
 * Браузер пишет запись через MediaRecorder в webm/opus (см. useVoiceRecorder.ts) —
 * это единственный формат, который надёжно поддерживают И Chrome, И Firefox без
 * плясок с полифиллами. WhatsApp Cloud API webm не принимает вовсе: голосовое
 * сообщение (`type: "audio"`) обязано быть в `audio/ogg` с кодеком opus — любой
 * другой контейнер Meta отклоняет уже на приёме, и агент получил бы «файл не
 * отправлен» на каждой записи.
 *
 * INSTAGRAM/MESSENGER OGG НЕ ПРИНИМАЮТ (17.08.2026, найдено по живой ошибке в
 * журнале: «This attachment format is not supported», IGApiException code 100).
 * Прежний комментарий утверждал, что ogg/opus «терпимее» принимают и эти каналы —
 * неверно: Graph API для Instagram Direct ждёт `audio/mp4` (AAC в контейнере MP4,
 * расширение `.m4a`), ровно как для видео и файлов там свои требования к
 * контейнеру. Поэтому WhatsApp получает ogg/opus, а Instagram/Messenger — m4a/aac:
 * два вызова ffmpeg с разными кодеками, а не один на все три канала.
 *
 * ffmpeg — внешний процесс (apps/api/Dockerfile ставит его в оба образа), а не
 * npm-библиотека: транскодирование звука — не то, что стоит тащить чистым JS.
 */

const TIMEOUT_MS = 30_000;
/** Больше минуты голосового в переписке никто слушать не станет, а лимит защищает
 *  и от случайно забытой запущенной записи (см. также лимит recorder на фронте). */
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

/** Общий прогон ffmpeg: своя раскладка args и расширение выходного файла на
 *  каждый формат, остальное (временные файлы, таймаут, лог отказа) одинаково. */
async function runFfmpegTranscode(buffer: Buffer, ext: string, args: (inputPath: string, outputPath: string) => string[]): Promise<Buffer | null> {
  if (buffer.length === 0 || buffer.length > MAX_INPUT_BYTES) return null;

  const tmpDir = os.tmpdir();
  const id = randomUUID();
  const inputPath = path.join(tmpDir, `voice-in-${id}`);
  const outputPath = path.join(tmpDir, `voice-out-${id}.${ext}`);

  try {
    await fs.writeFile(inputPath, buffer);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", args(inputPath, outputPath));
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("ffmpeg не уложился в таймаут"));
      }, TIMEOUT_MS);
      let stderr = "";
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg завершился с кодом ${code}: ${stderr.slice(-500)}`));
      });
    });

    return await fs.readFile(outputPath);
  } catch (err) {
    void logSystemError(
      "ai",
      `Голосовое агента не перекодировано: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  } finally {
    await fs.rm(inputPath, { force: true });
    await fs.rm(outputPath, { force: true });
  }
}

/**
 * Перекодирует буфер аудио в moно ogg/opus — формат для WhatsApp Cloud API.
 * `null` — ffmpeg недоступен, упал или не уложился в таймаут; вызывающий обязан
 * в этом случае не отправлять голосовое, а не тихо проглотить ошибку (агент
 * должен узнать, что запись не ушла).
 */
export async function transcodeToOggOpus(buffer: Buffer): Promise<Buffer | null> {
  // -vn: во входном файле иногда есть пустой видеотрек (некоторые сборки
  // MediaRecorder кладут его в контейнер даже для чистого аудио) — без этого
  // флага ffmpeg пытается транскодировать и его, и падает на кодеке.
  return runFfmpegTranscode(buffer, "ogg", (inputPath, outputPath) => [
    "-y",
    "-i", inputPath,
    "-vn",
    "-ac", "1",
    "-c:a", "libopus",
    "-b:a", "32k",
    outputPath,
  ]);
}

/**
 * Перекодирует буфер аудио в moно m4a/aac — формат, который принимает Instagram
 * Direct и Messenger (Graph API отклоняет ogg/opus для этих каналов, см. разбор
 * выше). `-movflags +faststart` кладёт moov-атом в начало файла: Meta забирает
 * вложение по ссылке, а не потоково, но без этого флага некоторые сборки ffmpeg
 * пишут его в конец, и часть ридеров отказывается проигрывать файл целиком.
 */
export async function transcodeToM4a(buffer: Buffer): Promise<Buffer | null> {
  return runFfmpegTranscode(buffer, "m4a", (inputPath, outputPath) => [
    "-y",
    "-i", inputPath,
    "-vn",
    "-ac", "1",
    "-c:a", "aac",
    "-b:a", "64k",
    "-movflags", "+faststart",
    outputPath,
  ]);
}

/** Порог тишины и минимальная длина паузы, которую считаем «тишиной», а не долгой
 *  гласной. Значение проверено на боевой записи 16.08.2026 (см. ниже) — ровно
 *  ловит полную тишину и не задевает обычную речь с недолгими паузами. */
const SILENCE_NOISE_DB = "-30dB";
const SILENCE_MIN_GAP_S = 0.3;
/** Запись короче этого — вообще не может быть словом (нажали и сразу отпустили). */
const TOO_SHORT_TO_SPEAK_S = 0.5;
/** Тишина покрывает почти всю запись (не всю: конец файла у opus иногда режется
 *  на кадр раньше конца звука) — остаток на хвост, а не на настоящую речь. */
const SILENT_COVERAGE_RATIO = 0.92;

/**
 * Вся запись — тишина или шум без речи (16.08.2026, найдено по жалобе владельца:
 * агент прислал голосовое, а в переписке легла фраза, которую он не говорил).
 *
 * ПРИЧИНА. Запись оказалась тишиной 3.186 секунды от начала до конца (проверено
 * `ffmpeg silencedetect` на самом файле), а Gemini вместо пустой строки — как
 * прямо велит промт при неразборчивой речи — СОЧИНИЛ правдоподобную фразу. Промт
 * это просьба, а не гарантия (тот же урок, что и у бота), а расшифровка ложится
 * в историю переписки как будто агент это сказал.
 *
 * ПОЧЕМУ ФИЛЬТР ЗДЕСЬ, А НЕ ТОЛЬКО В ПРОМТЕ. Так же, как looksLikeModelRefusal в
 * ai/transcribe.ts: обнаруженная тишина не зависит от того, послушалась ли модель
 * сегодня. В отличие от отказа модели, выдуманную РЕЧЬ по тексту не отличить —
 * она читается как настоящая. Единственный надёжный признак — сама запись.
 *
 * Молчащая запись до Gemini вообще не доходит: тишине нечего расшифровывать, а
 * платный запрос на неё — чистый убыток.
 *
 * Отказ ffmpeg (недоступен, упал, не распарсился) — не тишина, а неизвестность:
 * возвращаем false и пропускаем запись как обычно. Ложный пропуск редкой
 * выдумки безопаснее, чем пометка «тишина» на настоящем голосовом.
 */
export async function isSilentAudio(oggBuffer: Buffer): Promise<boolean> {
  const tmpPath = path.join(os.tmpdir(), `voice-silence-${randomUUID()}.ogg`);
  try {
    await fs.writeFile(tmpPath, oggBuffer);
    const stderr = await new Promise<string>((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-i", tmpPath,
        "-af", `silencedetect=noise=${SILENCE_NOISE_DB}:d=${SILENCE_MIN_GAP_S}`,
        "-f", "null",
        "-",
      ]);
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("ffmpeg (silencedetect) не уложился в таймаут"));
      }, TIMEOUT_MS);
      let out = "";
      proc.stderr.on("data", (chunk) => (out += chunk.toString()));
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on("close", () => {
        clearTimeout(timer);
        resolve(out);
      });
    });

    const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!durationMatch) return false;
    const duration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
    if (duration <= 0) return false;
    if (duration < TOO_SHORT_TO_SPEAK_S) return true;

    const silentSeconds = [...stderr.matchAll(/silence_duration:\s*(\d+(?:\.\d+)?)/g)].reduce(
      (sum, m) => sum + Number(m[1]),
      0
    );
    return silentSeconds >= duration * SILENT_COVERAGE_RATIO;
  } catch (err) {
    console.warn("[audio] проверка на тишину не выполнена:", err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}

import { spawn } from "node:child_process";

/**
 * Короткий ролик карточки объекта (docs/plan-18-08-private-listings-and-video.md §3).
 *
 * ffmpeg/ffprobe вызываются как внешний процесс через spawn — тот же подход, что
 * lib/audioTranscode.ts (голосовые агента): бинарник уже стоит в обоих Docker-образах
 * (apps/api/Dockerfile), добавлять npm-обёртку (fluent-ffmpeg/ffmpeg-static) поверх
 * не нужно — она не поставляет сам бинарник для Linux-контейнера прода, только для
 * той платформы, где npm install запускали, а второй процесс (spawn) codebase уже
 * умеет готовить сам. Здесь ffmpeg локально не установлен (проверено — команда не
 * найдена), поэтому фактическое сжатие в этой песочнице не прогонялось; проверено
 * только то, что не требует бинарника (см. отчёт).
 */

const PROBE_TIMEOUT_MS = 15_000;
const COMPRESS_TIMEOUT_MS = 5 * 60_000;

/**
 * Максимальная длительность ролика — 5 минут (владелец 19.08.2026, поднято с 3 минут).
 * Сжатие держит битрейт фиксированным (~700 кбит/с), поэтому итоговый вес растёт
 * линейно от длительности — ограничивать длительность и ограничивать вес файла
 * клиента это одно и то же; при 5 минутах сжатый ролик выходит ~26 МБ, всё ещё
 * тянется на слабом интернете за счёт Range-раздачи и Cloudflare-кэша.
 */
export const MAX_CLIP_VIDEO_DURATION_SEC = 300;

/** Длительность входного файла в секундах через ffprobe, или null если бинарник
 *  недоступен/файл не распознан — вызывающий обязан отличать "не удалось проверить"
 *  от "длительность в норме" и не пропускать непроверенный файл молча. */
export async function probeDurationSec(inputPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ]);
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(null);
    }, PROBE_TIMEOUT_MS);
    let out = "";
    proc.stdout.on("data", (chunk) => (out += chunk.toString()));
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const seconds = Number(out.trim());
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
    });
  });
}

/**
 * Сжимает видео в H.264/480p/~700кбит/с (план §3: под слабый интернет Душанбе,
 * не 1080p) и пишет результат в outputPath. Бросает исключение при отказе —
 * вызывающий (фоновая задача) ловит её сам и пишет в logSystemError.
 */
export async function compressClipVideo(inputPath: string, outputPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-vf", "scale=-2:480",
      "-c:v", "libx264",
      "-preset", "medium",
      "-b:v", "700k",
      "-maxrate", "800k",
      "-bufsize", "1400k",
      "-c:a", "aac",
      "-b:a", "96k",
      // moov-атом в начало — файл проигрывается по мере скачивания/по Range,
      // а не только после закачки целиком (та же причина, что и faststart
      // в transcodeToM4a).
      "-movflags", "+faststart",
      outputPath,
    ]);
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("ffmpeg (сжатие видео) не уложился в таймаут"));
    }, COMPRESS_TIMEOUT_MS);
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
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
}

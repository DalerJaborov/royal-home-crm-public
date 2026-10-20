import { spawn } from "node:child_process";

/**
 * Общая обёртка над ffmpeg/ffprobe — вместо шести независимых копий шаблона
 * spawn → таймаут → SIGKILL → сбор stderr → разбор кода возврата, разбросанных
 * по lib/propertyClipVideo.ts, lib/audioTranscode.ts, lib/telephony/*.
 *
 * Не переписывает существующие места — они переводятся на неё по одному,
 * начиная с тех, где есть тесты (см. docs/video-pipeline). Форма текста ошибки
 * сохранена намеренно: `ffmpeg (<label>) завершился с кодом <code>: <хвост
 * stderr>` — этот текст уже показывается монтажёру в Property.autoMontageError
 * и попадает в journal (logSystemError), менять его — ломать читаемость
 * существующих отчётов об ошибках.
 *
 * SIGKILL, а не SIGTERM: ffmpeg на SIGTERM может успеть дописать файл — тогда
 * "истёк таймаут" перестаёт означать "результата нет", а вызывающий код везде
 * в репозитории считает таймаут равносильным полному отказу.
 */

const DEFAULT_STDERR_TAIL_CHARS = 800;

export type FfmpegBin = "ffmpeg" | "ffprobe";

export interface FfmpegRunOptions {
  /** По умолчанию "ffmpeg". */
  bin?: FfmpegBin;
  args: string[];
  timeoutMs: number;
  /** Человеческое имя для текста ошибки: "автомонтаж", "сжатие видео". */
  label: string;
  cwd?: string;
  /** Нужен ли stdout вызывающему (ffprobe, -progress pipe:1). По умолчанию
   *  false — как в lib/telephony/whisperClips.ts, там stdio полностью ignore. */
  captureStdout?: boolean;
  /** Сколько последних символов stderr класть в текст ошибки. */
  stderrTailChars?: number;
  /** Внешняя отмена — например, снятие объекта с монтажа во время рендера. */
  signal?: AbortSignal;
  /** Детекторы (scdet/blackdetect/freezedetect/silencedetect в detectors.ts)
   *  печатают события построчно в stderr на протяжении всего разбора клипа —
   *  `stderrTail` (800 символов по умолчанию, для текста ошибки) обрежет
   *  почти все события. Нужен полный текст — не только на отказ. */
  captureFullStderr?: boolean;
}

export interface FfmpegResult {
  stdout: string;
  stderrTail: string;
  /** Заполнено только если captureFullStderr: true. */
  stderr?: string;
  durationMs: number;
}

export class FfmpegError extends Error {
  readonly label: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly stderrTail: string;

  constructor(message: string, info: { label: string; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; aborted: boolean; stderrTail: string }) {
    super(message);
    this.name = "FfmpegError";
    this.label = info.label;
    this.code = info.code;
    this.signal = info.signal;
    this.timedOut = info.timedOut;
    this.aborted = info.aborted;
    this.stderrTail = info.stderrTail;
  }
}

/** FFMPEG_BIN/FFPROBE_BIN из окружения — иначе имя бинарника ищется в PATH.
 *  Прод (node:24-slim) ставит ffmpeg через apt, там это и так первое, что
 *  находится; переменные окружения существуют ради разработки на Windows,
 *  где сборка из node_modules может отличаться версией от свежей. */
export function resolveFfmpegBin(bin: FfmpegBin): string {
  const envName = bin === "ffmpeg" ? "FFMPEG_BIN" : "FFPROBE_BIN";
  return process.env[envName] || bin;
}

/** Бросает FfmpegError при коде ≠ 0, таймауте, отмене или невозможности
 *  запустить сам процесс (бинарник не найден и т.п.). */
export function runFfmpeg(options: FfmpegRunOptions): Promise<FfmpegResult> {
  const bin = resolveFfmpegBin(options.bin ?? "ffmpeg");
  const stderrTailChars = options.stderrTailChars ?? DEFAULT_STDERR_TAIL_CHARS;
  const startedAt = Date.now();

  return new Promise<FfmpegResult>((resolve, reject) => {
    const proc = spawn(bin, options.args, {
      cwd: options.cwd,
      stdio: ["ignore", options.captureStdout ? "pipe" : "ignore", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, options.timeoutMs);

    const onAbort = () => {
      aborted = true;
      proc.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort);

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    if (options.captureStdout) {
      proc.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    }
    proc.stderr?.on("data", (chunk) => (stderr += chunk.toString()));

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new FfmpegError(`ffmpeg (${options.label}) не удалось запустить: ${err.message}`, {
          label: options.label,
          code: null,
          signal: null,
          timedOut: false,
          aborted,
          stderrTail: stderr.slice(-stderrTailChars),
        })
      );
    });

    proc.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const durationMs = Date.now() - startedAt;
      const stderrTail = stderr.slice(-stderrTailChars);

      if (code === 0 && !timedOut && !aborted) {
        resolve({ stdout, stderrTail, stderr: options.captureFullStderr ? stderr : undefined, durationMs });
        return;
      }

      const reason = timedOut ? "не уложился в таймаут" : aborted ? "отменён" : `завершился с кодом ${code}`;
      reject(
        new FfmpegError(`ffmpeg (${options.label}) ${reason}: ${stderrTail}`, {
          label: options.label,
          code,
          signal,
          timedOut,
          aborted,
          stderrTail,
        })
      );
    });
  });
}

/** Никогда не бросает — для мест, где "не удалось проверить" сам по себе
 *  нормальный ответ (пример: probeDurationSec сегодня возвращает null и на
 *  отсутствие бинарника, и на битый файл — вызывающий код одинаково
 *  реагирует на оба случая). */
export async function tryRunFfmpeg(options: FfmpegRunOptions): Promise<FfmpegResult | null> {
  try {
    return await runFfmpeg(options);
  } catch {
    return null;
  }
}

/** Общая замена дублю в propertyClipVideo.ts: длительность файла в секундах,
 *  или null если ffprobe недоступен либо файл не читается. */
export async function probeDurationSec(inputPath: string, timeoutMs = 15_000): Promise<number | null> {
  const result = await tryRunFfmpeg({
    bin: "ffprobe",
    label: "определение длительности",
    timeoutMs,
    captureStdout: true,
    args: ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputPath],
  });
  if (!result) return null;
  const value = Number.parseFloat(result.stdout.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface VideoDimensions {
  width: number;
  height: number;
  durationSec: number;
}

/**
 * Полная проверка файла от монтажёра одним вызовом ffprobe (23.09.2026, объект
 * №127: монтажёр вернул боту НЕ смонтированный ролик — тот же исходник агента
 * побайтно, — а `finishReceivingVideo` приняла его без единой проверки: video-
 * поток есть, аудио нет, и ролик без звука ушёл в четыре сети сразу). Один
 * запрос вместо нескольких — `probeVideoDimensions` ниже теперь тоже строится
 * поверх этой функции, а не держит свой отдельный вызов ffprobe.
 *
 * width/height — ЭКРАННЫЕ, не «сырые» из потока: iPhone пишет портретное видео
 * контейнером 3840×2160 и side_data rotation=-90 (или тег rotate=-90 у старых
 * файлов) — ффмпег ничего не разворачивает сам, это обязан сделать читающий
 * код. Не учли это в `publishTelegramVideo` (socialPublish.ts) — тот же объект
 * №127 лёг в Telegram «ландшафтом» при портретном файле.
 *
 * null — ffprobe недоступен либо stdout не парсится как JSON (битый файл):
 * тот же принцип, что у остальных probe*-функций этого модуля — «не смогли
 * проверить» не равно «файл плохой», вызывающий код решает сам, что делать
 * с недоступностью инструмента.
 */
export interface MediaInfo {
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  /** Экранные (после разворота по rotation), не сырые из потока. */
  width: number | null;
  height: number | null;
  /** Из side_data rotation или тега rotate первого видеопотока, 0 если нет ни того, ни другого. */
  rotation: number;
  durationSec: number;
  sizeBytes: number | null;
}

interface FfprobeJsonStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  side_data_list?: { rotation?: number }[];
  tags?: { rotate?: string };
}

interface FfprobeJsonOutput {
  streams?: FfprobeJsonStream[];
  format?: { duration?: string; size?: string };
}

export async function probeMediaInfo(inputPath: string, timeoutMs = 15_000): Promise<MediaInfo | null> {
  const result = await tryRunFfmpeg({
    bin: "ffprobe",
    label: "проверка ролика от монтажёра",
    timeoutMs,
    captureStdout: true,
    args: [
      "-v", "error",
      "-show_entries", "stream=index,codec_type,codec_name,width,height:stream_side_data=rotation:stream_tags=rotate:format=duration,size",
      "-of", "json",
      inputPath,
    ],
  });
  if (!result) return null;
  let parsed: FfprobeJsonOutput;
  try {
    parsed = JSON.parse(result.stdout) as FfprobeJsonOutput;
  } catch {
    return null;
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStream = streams.find((s) => s.codec_type === "audio");

  let width: number | null = null;
  let height: number | null = null;
  let rotation = 0;
  if (videoStream) {
    const rawWidth = Number.parseInt(String(videoStream.width ?? ""), 10);
    const rawHeight = Number.parseInt(String(videoStream.height ?? ""), 10);
    width = Number.isFinite(rawWidth) && rawWidth > 0 ? rawWidth : null;
    height = Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : null;
    const sideDataRotation = videoStream.side_data_list?.find((sd) => typeof sd.rotation === "number")?.rotation;
    const tagRotation = videoStream.tags?.rotate !== undefined ? Number.parseInt(videoStream.tags.rotate, 10) : undefined;
    const rawRotation = sideDataRotation ?? tagRotation;
    rotation = Number.isFinite(rawRotation) ? Number(rawRotation) : 0;
    // Экран: |90|/|270| меняют местами то, что ffprobe отдал как ширину/высоту
    // потока — пример из докстринга выше, iPhone 3840×2160 rotation=-90 → 2160×3840.
    const normalized = Math.abs(rotation) % 360;
    if ((normalized === 90 || normalized === 270) && width !== null && height !== null) {
      [width, height] = [height, width];
    }
  }

  const durationRaw = Number.parseFloat(parsed.format?.duration ?? "");
  const sizeRaw = Number.parseInt(parsed.format?.size ?? "", 10);
  return {
    hasVideo: !!videoStream,
    hasAudio: !!audioStream,
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    width,
    height,
    rotation,
    durationSec: Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : 0,
    sizeBytes: Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : null,
  };
}

/**
 * Ширина/высота первого видеопотока + длительность контейнера — одним вызовом
 * ffprobe (20.09.2026, регрессия PR #586: sendVideo телом запроса без width/
 * height/duration заставляла Telegram рисовать вертикальный Reels квадратом,
 * потому что раньше эти размеры Telegram определял сам, скачивая файл по
 * ссылке). null — ffprobe недоступен либо файл не читается; вызывающий обязан
 * отправлять без этих полей и записать причину в журнал, а не молчать и не
 * отменять публикацию.
 *
 * 23.09.2026: переведена на probeMediaInfo — width/height теперь тоже
 * ЭКРАННЫЕ (см. докстринг там), это и чинит искажение в Telegram у портретных
 * .mov с side_data rotation (объект №127).
 */
export async function probeVideoDimensions(inputPath: string, timeoutMs = 15_000): Promise<VideoDimensions | null> {
  const info = await probeMediaInfo(inputPath, timeoutMs);
  if (!info || !info.hasVideo || info.width === null || info.height === null) return null;
  return { width: info.width, height: info.height, durationSec: info.durationSec };
}

/**
 * Вырезает один непрерывный отрезок видео в новый файл — нужен только Историям
 * Instagram (21.09.2026, lib/instagramStories.ts): Meta принимает в историю
 * ролик не длиннее 60 секунд, а наши готовые Reels бывают длиннее (замер на
 * проде дал 67.5 с) — обрезать молча нельзя, поэтому длинный ролик режется на
 * последовательные части.
 *
 * `-ss` ПОСЛЕ `-i`, не до: с копированием потоков (`-c copy`) быстрый seek до
 * `-i` режет по ближайшему опорному кадру и может съехать на секунды — здесь
 * это ошибка на границе, которую зритель видит как дёрганый переход между
 * частями истории. Перекодируем (`libx264`/`aac`) ради точной границы; расход
 * времени на это не критичен — модерация уже одобрила ролик, режем один раз
 * перед публикацией, а не в реальном времени.
 */
export async function cutVideoSegment(
  inputPath: string,
  outputPath: string,
  startSec: number,
  durationSec: number,
  timeoutMs = 120_000
): Promise<boolean> {
  const result = await tryRunFfmpeg({
    label: "нарезка ролика на часть истории",
    timeoutMs,
    args: [
      "-y",
      "-i", inputPath,
      "-ss", startSec.toFixed(2),
      "-t", durationSec.toFixed(2),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-c:a", "aac",
      "-movflags", "+faststart",
      outputPath,
    ],
  });
  return result !== null;
}

/** Ширина/высота неподвижной картинки (обложка) — тот же ffprobe, без секции
 *  format=duration (у изображения её нет). Используется только для сверки
 *  пропорций обложки с роликом (publishTelegramVideo) — не бросает и не
 *  блокирует публикацию, если файл не читается. */
export async function probeImageDimensions(inputPath: string, timeoutMs = 15_000): Promise<{ width: number; height: number } | null> {
  const result = await tryRunFfmpeg({
    bin: "ffprobe",
    label: "определение размеров обложки",
    timeoutMs,
    captureStdout: true,
    args: [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=s=,:p=0",
      inputPath,
    ],
  });
  if (!result) return null;
  const [widthRaw, heightRaw] = result.stdout.trim().split(",");
  const width = Number.parseInt(widthRaw, 10);
  const height = Number.parseInt(heightRaw, 10);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null;
  return { width, height };
}

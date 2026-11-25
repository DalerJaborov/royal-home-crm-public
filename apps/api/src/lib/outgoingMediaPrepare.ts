import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  META_OUTGOING_MEDIA_LIMITS,
  OUTGOING_VIDEO_MIN_HEIGHT,
  OUTGOING_VIDEO_MIN_KBPS,
  OUTGOING_VIDEO_SIZE_MARGIN,
  TELEGRAM_OUTGOING_IMAGE_LIMIT,
  type MetaOutgoingChannel,
} from "@royal-home/shared";
import { runFfmpeg, FfmpegError } from "./ffmpeg.js";
import { sharpFromUpload } from "./heicInput.js";
import { TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES } from "../telegram/api.js";

/**
 * ФАЙЛ ПОД КАНАЛ КЛИЕНТА, КАК ЭТО ДЕЛАЕТ САМ WHATSAPP (25.11.2026).
 *
 * Владелец: «если агент отправляет через телефон, из медиатеки, пусть наш сервер
 * быстренько сожмёт и отправит. Прямо как сам WhatsApp или Telegram». Это решение
 * ОТМЕНЯЕТ прежнее (18.08.2026: «перекодирование ради лимита Meta отклонено — теряет
 * качество»): видео больше 16 МБ раньше уходило клиенту ТЕКСТОМ со ссылкой, а фото
 * больше 5 МБ — отказом.
 *
 * Пределы платформ (packages/shared/src/outgoingMediaLimits.ts) снять нельзя, поэтому:
 *  - ВИДЕО в WhatsApp/Instagram/Messenger: подходит как есть (H.264 + AAC, без HDR,
 *    влезает) — только перекладка в MP4 без перекодирования (секунды, качество то же,
 *    геометка iPhone вырезается). Иначе x264 Main + AAC, +faststart, 720p и ниже,
 *    битрейт считан по длительности под потолок канала с запасом 8%. HDR с iPhone
 *    (HEVC 10 бит, HLG/PQ) переводится в обычный цвет (tonemap) — иначе на телефоне
 *    клиента «выцветшая» картинка. Не помещается даже при нижнем пределе качества
 *    (OUTGOING_VIDEO_MIN_*) — честно уходит ссылка на просмотр, а не «каша».
 *  - ВИДЕО в Telegram: оригинал (свой Bot API принимает до 2 ГБ), только перекладка в
 *    MP4 с +faststart, чтобы играл сразу; не перекладывается (WebM VP9) — перекодирование
 *    без потолка размера.
 *  - ФОТО везде: HEIC → JPEG, поворот по EXIF, EXIF и GPS удаляются (приватность
 *    агента: геометка снимка — это его квартира или маршрут), сжатие до потолка
 *    подбором качества и размера вместо отказа. PNG с прозрачностью остаётся PNG, если
 *    влезает.
 *
 * Модуль только ГОТОВИТ файл: не шлёт, не пишет в базу. Очередь — lib/outgoingMediaJobs.ts,
 * доставка — lib/conversationDelivery.ts::deliverMediaToConversation.
 */

export type OutgoingMediaChannel = MetaOutgoingChannel | "TELEGRAM";

export interface MediaProbe {
  formatName: string;
  /** major_brand контейнера: «qt  » — MOV с iPhone, «isom»/«mp42» — MP4. */
  majorBrand: string | null;
  durationSec: number;
  video: {
    codec: string;
    profile: string | null;
    pixFmt: string | null;
    /** Ширина/высота НА ЭКРАНЕ — с учётом поворота (iPhone пишет 1920×1080 + rotation 90). */
    width: number;
    height: number;
    fps: number | null;
    hdr: boolean;
    bitDepth10: boolean;
  } | null;
  audio: { codec: string; count: number } | null;
}

export type VideoPlan =
  | { kind: "remux" }
  | {
      kind: "transcode";
      width: number;
      height: number;
      fps: number;
      videoKbps: number;
      audioKbps: number;
      /** Без потолка размера (Telegram): качество задаёт CRF, а не битрейт. */
      crf?: number;
    }
  | {
      kind: "link";
      reason: "too_long";
      /** Копия «для просмотра по ссылке»: 720p, играет в любом браузере сразу. null — отдать оригинал. */
      viewingCopy: { kind: "remux" } | { kind: "transcode"; width: number; height: number; fps: number; crf: number } | null;
    };

export interface PreparedMedia {
  path: string;
  mimetype: string;
  size: number;
  /** Что сделали: для журнала и подписи сотруднику. */
  action: "remuxed" | "transcoded" | "image" | "link-copy" | "original";
  /** Видео не помещается в канал — уйдёт ссылкой. */
  sendAsLink: boolean;
  /** Своё временное (удалить после отправки); у «original» — false. */
  owned: boolean;
  /** Подготовить не удалось (сбой или срок ffmpeg) — ушёл исходник, как до сжатия. */
  fallback?: boolean;
  ms: number;
}

/** Потолок канала для подготовленного файла. */
export function channelMediaLimit(channel: OutgoingMediaChannel, kind: "image" | "video"): number {
  if (channel === "TELEGRAM") return kind === "image" ? TELEGRAM_OUTGOING_IMAGE_LIMIT : TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES;
  return META_OUTGOING_MEDIA_LIMITS[channel][kind];
}

// ---------------------------------------------------------------------------
// Разбор файла
// ---------------------------------------------------------------------------

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  color_transfer?: string;
  color_primaries?: string;
  bits_per_raw_sample?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{ rotation?: number }>;
  disposition?: { attached_pic?: number };
}

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d] = rate.split("/").map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n <= 0) return null;
  return n / d;
}

/** Чистый разбор вывода ffprobe -show_format -show_streams (вынесен ради тестов). */
export function parseProbe(json: unknown): MediaProbe {
  const data = (json ?? {}) as { format?: { format_name?: string; duration?: string; tags?: Record<string, string> }; streams?: FfprobeStream[] };
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audios = streams.filter((s) => s.codec_type === "audio");
  let video: MediaProbe["video"] = null;
  if (v && v.width && v.height) {
    const rotation = Number(v.side_data_list?.find((d) => typeof d.rotation === "number")?.rotation ?? v.tags?.rotate ?? 0);
    const quarter = Math.abs(Math.round(rotation / 90)) % 2 === 1;
    const transfer = (v.color_transfer ?? "").toLowerCase();
    const pixFmt = v.pix_fmt ?? null;
    video = {
      codec: (v.codec_name ?? "").toLowerCase(),
      profile: v.profile ?? null,
      pixFmt,
      width: quarter ? v.height : v.width,
      height: quarter ? v.width : v.height,
      fps: parseRate(v.avg_frame_rate) ?? parseRate(v.r_frame_rate),
      hdr: transfer === "smpte2084" || transfer === "arib-std-b67",
      bitDepth10: Boolean(pixFmt && /10|12/.test(pixFmt)) || v.bits_per_raw_sample === "10",
    };
  }
  return {
    formatName: data.format?.format_name ?? "",
    majorBrand: data.format?.tags?.major_brand?.trim() || null,
    durationSec: Number.parseFloat(data.format?.duration ?? "") || 0,
    video,
    audio: audios.length ? { codec: (audios[0].codec_name ?? "").toLowerCase(), count: audios.length } : null,
  };
}

/**
 * ТОЛЬКО ЛОКАЛЬНЫЕ ФАЙЛЫ (ревью 25.11.2026). Файл присылает человек, и «видео .mp4» может
 * оказаться плейлистом HLS со ссылками на чужие адреса: ffmpeg пошёл бы за ними из worker —
 * во внутреннюю сеть сервера (SSRF) или куда угодно наружу. Белый список протоколов перед
 * каждым `-i` и у ffprobe: только файлы на диске.
 */
export const LOCAL_FILES_ONLY = ["-protocol_whitelist", "file"] as const;

export function probeArgs(inputPath: string): string[] {
  return ["-v", "error", ...LOCAL_FILES_ONLY, "-print_format", "json", "-show_format", "-show_streams", inputPath];
}

export async function probeMedia(inputPath: string, signal?: AbortSignal): Promise<MediaProbe> {
  const result = await runFfmpeg({
    bin: "ffprobe",
    label: "разбор файла переписки",
    timeoutMs: 30_000,
    captureStdout: true,
    signal,
    args: probeArgs(inputPath),
  });
  return parseProbe(JSON.parse(result.stdout || "{}"));
}

// ---------------------------------------------------------------------------
// План для видео — чистая функция (её и проверяют тесты)
// ---------------------------------------------------------------------------

/** Ступени качества: короткая сторона и битрейт картинки, с которого её берём / выше которого не тратим. */
const VIDEO_LADDER = [
  { short: 720, minKbps: 1000, maxKbps: 2500 },
  { short: 540, minKbps: 650, maxKbps: 1600 },
  { short: 480, minKbps: 450, maxKbps: 1200 },
  { short: OUTGOING_VIDEO_MIN_HEIGHT, minKbps: OUTGOING_VIDEO_MIN_KBPS, maxKbps: 800 },
] as const;

/** Больше 30 кадров/с канал всё равно не покажет: WhatsApp пережимает до 30, а 60 кадров съедают половину битрейта. */
const MAX_FPS = 30;
/** Длиннее этого копию «для просмотра по ссылке» не перекодируем — дольше десяти минут работы ffmpeg. */
const VIEWING_COPY_MAX_SEC = 15 * 60;
/** Доля «накладных» MP4 поверх потоков. */
const CONTAINER_OVERHEAD = 0.015;

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** Размер кадра с короткой стороной не больше `short` (не увеличиваем). */
export function scaledSize(width: number, height: number, short: number): { width: number; height: number } {
  const current = Math.min(width, height);
  if (current <= short) return { width: even(width), height: even(height) };
  const k = short / current;
  return { width: even(width * k), height: even(height * k) };
}

function targetFps(fps: number | null): number {
  if (!fps || !Number.isFinite(fps)) return MAX_FPS;
  return Math.max(1, Math.min(MAX_FPS, Math.round(fps)));
}

/** Годится ли видео для канала Meta без перекодирования (только перекладка в MP4). */
export function metaCompatible(probe: MediaProbe, channel: MetaOutgoingChannel): boolean {
  const v = probe.video;
  if (!v) return false;
  if (v.codec !== "h264" || v.hdr || v.bitDepth10) return false;
  if (v.pixFmt && v.pixFmt !== "yuv420p" && v.pixFmt !== "yuvj420p") return false;
  // WhatsApp: «High с B-кадрами не играет на Android» — только Baseline/Main.
  if (channel === "WHATSAPP" && v.profile && !/baseline|main/i.test(v.profile)) return false;
  if (probe.audio && (probe.audio.count > 1 || probe.audio.codec !== "aac")) return false;
  return true;
}

/** Перекладывается ли видео в MP4 без перекодирования (для Telegram и копии по ссылке). */
function mp4Copyable(probe: MediaProbe): boolean {
  const v = probe.video;
  if (!v || !["h264", "hevc", "av1"].includes(v.codec)) return false;
  return !probe.audio || ["aac", "mp3"].includes(probe.audio.codec);
}

export function planVideo(probe: MediaProbe, channel: OutgoingMediaChannel, sizeBytes: number): VideoPlan {
  const v = probe.video;
  if (!v) throw new PrepareError("В файле нет видео", "no_video");
  const fps = targetFps(v.fps);

  const limit = channelMediaLimit(channel, "video");
  if (channel === "TELEGRAM" && sizeBytes <= limit) {
    // Свой Bot API (`--local`) берёт до 2 ГБ: оригинал, только перекладка в MP4.
    if (mp4Copyable(probe)) return { kind: "remux" };
    const { width, height } = scaledSize(v.width, v.height, 1080);
    return { kind: "transcode", width, height, fps, videoKbps: 0, audioKbps: probe.audio ? 128 : 0, crf: 23 };
  }
  // Дальше — сжатие под потолок: каналы Meta и Telegram без своего сервера (облачный Bot API, 20 МБ).
  if (channel !== "TELEGRAM" && sizeBytes <= limit && metaCompatible(probe, channel)) return { kind: "remux" };

  const duration = Math.max(1, probe.durationSec);
  const totalKbps = (limit * (1 - OUTGOING_VIDEO_SIZE_MARGIN) * (1 - CONTAINER_OVERHEAD) * 8) / duration / 1000;
  const audioKbps = probe.audio ? (totalKbps >= 1200 ? 96 : 64) : 0;
  const videoBudget = totalKbps - audioKbps;
  const step = VIDEO_LADDER.find((s) => videoBudget >= s.minKbps);
  if (!step) {
    const viewingCopy =
      duration > VIEWING_COPY_MAX_SEC
        ? null
        : metaCompatible(probe, "INSTAGRAM")
          ? ({ kind: "remux" } as const)
          : { kind: "transcode" as const, ...scaledSize(v.width, v.height, 720), fps, crf: 26 };
    return { kind: "link", reason: "too_long", viewingCopy };
  }
  const { width, height } = scaledSize(v.width, v.height, step.short);
  return { kind: "transcode", width, height, fps, videoKbps: Math.floor(Math.min(videoBudget, step.maxKbps)), audioKbps };
}

// ---------------------------------------------------------------------------
// Исполнение
// ---------------------------------------------------------------------------

export class PrepareError extends Error {
  constructor(
    message: string,
    readonly code: "no_video" | "unreadable" | "too_big" | "ffmpeg" | "aborted"
  ) {
    super(message);
  }
}

export interface PrepareOptions {
  /** Каталог для временных файлов (общий том api и worker). */
  workDir: string;
  signal?: AbortSignal;
  /** 0–100 по ходу сжатия видео. */
  onProgress?: (percent: number) => void;
  /** Крайний срок всей подготовки (мс с эпохи): каждое перекодирование укладывается в остаток. */
  deadlineAt?: number;
}

/**
 * Потоки ffmpeg: 4 по умолчанию. На VPS 12 ядер и нагрузка ~0,3 (замер 25.11, только
 * чтение), worker без потолка процессора; процесс идёт с nice 10 и уступает остальным.
 * Очередь одна (одно сжатие за раз), так что больше четырёх ядер сжатие не займёт никогда.
 */
function ffmpegThreads(): string {
  const n = Number(process.env.OUTGOING_MEDIA_FFMPEG_THREADS);
  return String(Number.isInteger(n) && n > 0 ? n : 4);
}

/** Срок одного перекодирования: втрое дольше самого ролика плюс минута, от 2 до 10 минут. */
function encodeTimeoutMs(durationSec: number): number {
  return Math.min(10 * 60_000, Math.max(2 * 60_000, Math.round(durationSec * 3_000) + 60_000));
}

/**
 * Цепочка HDR → SDR (BT.709). zscale есть и в ffmpeg образа (Debian 12, 5.1), и в сборке
 * для Windows. Уменьшение кадра — в ПЕРВОМ zscale, до перевода в плавающую точку: замер
 * 25.11 — тональное отображение на полном 1080p60 стоило 2,1 с на секунду ролика, а на
 * уже уменьшенном 720p30 — в разы меньше (4K с iPhone без этого шёл бы минуты).
 */
function tonemapChain(width: number, height: number): string {
  return `zscale=w=${width}:h=${height}:filter=bicubic:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv`;
}

export function transcodeArgs(
  input: string,
  output: string,
  probe: MediaProbe,
  plan: { width: number; height: number; fps: number; videoKbps: number; audioKbps: number; crf?: number }
): string[] {
  const filters = [
    // Сначала прореживаем кадры (60 → 30): всё дальше работает вдвое меньше.
    `fps=${plan.fps}`,
    probe.video?.hdr ? tonemapChain(plan.width, plan.height) : `scale=${plan.width}:${plan.height}:flags=bicubic`,
    "setsar=1",
    "format=yuv420p",
  ].join(",");
  const rate =
    plan.crf !== undefined
      ? ["-crf", String(plan.crf), "-maxrate", "8M", "-bufsize", "16M"]
      : ["-b:v", `${plan.videoKbps}k`, "-maxrate", `${Math.round(plan.videoKbps * 1.5)}k`, "-bufsize", `${plan.videoKbps * 2}k`];
  const level = Math.min(plan.width, plan.height) <= 720 ? "3.1" : "4.0";
  const audio = probe.audio
    ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", `${plan.audioKbps || 96}k`, "-ac", "2", "-ar", "44100"]
    : ["-an"];
  return [
    "-hide_banner", "-nostdin", "-y",
    "-threads", ffmpegThreads(),
    ...LOCAL_FILES_ONLY,
    "-i", input,
    "-map", "0:v:0",
    ...audio,
    "-vf", filters,
    "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main", "-level:v", level,
    ...rate,
    "-threads", ffmpegThreads(),
    // Метаданные целиком прочь: у iPhone в них геометка съёмки (com.apple.quicktime.location).
    "-map_metadata", "-1", "-map_chapters", "-1",
    "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats",
    "-f", "mp4", output,
  ];
}

export function remuxArgs(input: string, output: string, probe: MediaProbe): string[] {
  return [
    "-hide_banner", "-nostdin", "-y",
    ...LOCAL_FILES_ONLY,
    "-i", input,
    "-map", "0:v:0", ...(probe.audio ? ["-map", "0:a:0"] : []),
    "-c", "copy",
    // hvc1 — тег, с которым HEVC играет на iPhone/Safari (с hev1 видно только звук).
    ...(probe.video?.codec === "hevc" ? ["-tag:v", "hvc1"] : []),
    // Общие метаданные файла прочь (там геометка iPhone), а метаданные потока картинки
    // оставляем: ffmpeg 5.1 (образ прода) держит поворот и в них — без этого
    // вертикальное видео без перекодирования легло бы «на бок».
    "-map_metadata", "-1", "-map_metadata:s:v", "0:s:v", "-map_chapters", "-1",
    "-movflags", "+faststart",
    "-f", "mp4", output,
  ];
}

function progressReporter(durationSec: number, onProgress?: (percent: number) => void) {
  if (!onProgress || durationSec <= 0) return undefined;
  let last = -1;
  return (chunk: string) => {
    const match = /out_time_(?:us|ms)=(\d+)/.exec(chunk.split("\n").reverse().join("\n"));
    if (!match) return;
    const percent = Math.max(0, Math.min(99, Math.floor((Number(match[1]) / 1e6 / durationSec) * 100)));
    if (percent !== last) {
      last = percent;
      onProgress(percent);
    }
  };
}

async function fileSize(p: string): Promise<number> {
  return (await fs.stat(p)).size;
}

function wrapFfmpeg(err: unknown): never {
  if (err instanceof FfmpegError && err.aborted) throw new PrepareError("Отменено", "aborted");
  if (err instanceof FfmpegError) throw new PrepareError(err.message, "ffmpeg");
  throw err;
}

/** Срок шага не дальше общего крайнего срока подготовки; срок вышел — сбой ffmpeg, не отмена. */
function boundedTimeout(ms: number, options: PrepareOptions): number {
  if (options.deadlineAt === undefined) return ms;
  const left = options.deadlineAt - Date.now();
  if (left <= 1_000) throw new PrepareError("Сжатие не уложилось в срок", "ffmpeg");
  return Math.min(ms, left);
}

async function runTranscode(
  input: string,
  output: string,
  probe: MediaProbe,
  plan: Parameters<typeof transcodeArgs>[3],
  options: PrepareOptions
): Promise<void> {
  await runFfmpeg({
    label: "сжатие видео для клиента",
    timeoutMs: boundedTimeout(encodeTimeoutMs(probe.durationSec), options),
    lowPriority: true,
    signal: options.signal,
    onStdoutChunk: progressReporter(probe.durationSec, options.onProgress),
    args: transcodeArgs(input, output, probe, plan),
  }).catch(wrapFfmpeg);
}

async function runRemux(input: string, output: string, probe: MediaProbe, options: PrepareOptions): Promise<void> {
  await runFfmpeg({
    label: "перекладка видео в MP4",
    timeoutMs: boundedTimeout(3 * 60_000, options),
    lowPriority: true,
    signal: options.signal,
    args: remuxArgs(input, output, probe),
  }).catch(wrapFfmpeg);
}

export interface PrepareInput {
  path: string;
  mimetype: string;
  size: number;
}

export async function prepareOutgoingVideo(
  input: PrepareInput,
  channel: OutgoingMediaChannel,
  options: PrepareOptions
): Promise<PreparedMedia> {
  const started = Date.now();
  /**
   * НЕ СМОГЛИ ПОДГОТОВИТЬ — ОТПРАВЛЯЕМ КАК РАНЬШЕ, А НЕ ОТКАЗ (ревью 25.11.2026). До очереди
   * сжатия видео уходило всегда: файлом, если влезает, иначе ссылкой. Сбой ffmpeg, срок,
   * нечитаемый для ffprobe файл не должны делать хуже прежнего: исходник уходит той же
   * доставкой, она сама решит «файл или ссылка», агенту — честная пометка. Отказ — только
   * на отмену (сотрудник или выкат).
   */
  const asBefore = (): PreparedMedia => ({
    path: input.path, mimetype: input.mimetype, size: input.size, action: "original",
    sendAsLink: input.size > channelMediaLimit(channel, "video"), owned: false, ms: Date.now() - started, fallback: true,
  });
  let probe: MediaProbe;
  try {
    probe = await probeMedia(input.path, options.signal);
  } catch (err) {
    if (err instanceof FfmpegError && err.aborted) throw new PrepareError("Отменено", "aborted");
    return asBefore();
  }
  if (!probe.video) return asBefore();
  const plan = planVideo(probe, channel, input.size);
  const out = path.join(options.workDir, `${randomUUID()}.mp4`);
  const done = async (action: PreparedMedia["action"], sendAsLink: boolean): Promise<PreparedMedia> => ({
    path: out, mimetype: "video/mp4", size: await fileSize(out), action, sendAsLink, owned: true, ms: Date.now() - started,
  });
  try {
    if (plan.kind === "remux") {
      await runRemux(input.path, out, probe, options);
      return await done("remuxed", false);
    }
    if (plan.kind === "link") {
      if (!plan.viewingCopy) {
        return { path: input.path, mimetype: input.mimetype, size: input.size, action: "original", sendAsLink: true, owned: false, ms: Date.now() - started };
      }
      if (plan.viewingCopy.kind === "remux") await runRemux(input.path, out, probe, options);
      else await runTranscode(input.path, out, probe, { ...plan.viewingCopy, videoKbps: 0, audioKbps: 96 }, options);
      return await done("link-copy", true);
    }
    await runTranscode(input.path, out, probe, plan, options);
    if (plan.crf !== undefined) return await done("transcoded", false);
    // x264 держит СРЕДНИЙ битрейт — изредка файл вылезает за потолок. Второй заход
    // с поправкой на промах; не помогло — честная ссылка, а не отказ Meta.
    const limit = channelMediaLimit(channel, "video");
    let size = await fileSize(out);
    if (size > limit) {
      const k = (limit * (1 - OUTGOING_VIDEO_SIZE_MARGIN)) / size;
      const videoKbps = Math.floor(plan.videoKbps * k);
      if (videoKbps >= OUTGOING_VIDEO_MIN_KBPS) {
        await runTranscode(input.path, out, probe, { ...plan, videoKbps }, options);
        size = await fileSize(out);
      }
    }
    if (size > limit) {
      await fs.rm(out, { force: true });
      return { path: input.path, mimetype: input.mimetype, size: input.size, action: "original", sendAsLink: true, owned: false, ms: Date.now() - started };
    }
    return await done("transcoded", false);
  } catch (err) {
    await fs.rm(out, { force: true }).catch(() => {});
    if (err instanceof PrepareError && err.code === "aborted") throw err;
    if (options.signal?.aborted) throw new PrepareError("Отменено", "aborted");
    return asBefore();
  }
}

// ---------------------------------------------------------------------------
// Фото
// ---------------------------------------------------------------------------

/** Длинная сторона фото: WhatsApp в «HD» показывает до 4096, но 2560 неотличимы на телефоне и в 3–4 раза легче. */
const IMAGE_MAX_SIDE = 2560;
const MIN_SIDE_AFTER_SHRINK = 1080;
export const MAX_IMAGE_PIXELS = 100_000_000;

export async function prepareOutgoingImage(
  input: PrepareInput,
  channel: OutgoingMediaChannel,
  options: PrepareOptions
): Promise<PreparedMedia> {
  const started = Date.now();
  const limit = channelMediaLimit(channel, "image");
  const buf = await fs.readFile(input.path);
  let base;
  try {
    // sharpFromUpload: HEIC через libheif (у sharp декодера HEVC нет), остальное — sharp.
    // .rotate() без аргумента = поворот по EXIF; метаданные sharp по умолчанию НЕ переносит,
    // то есть EXIF вместе с GPS из выходного файла пропадает.
    base = (await sharpFromUpload(buf)).rotate();
  } catch {
    throw new PrepareError("Фото не читается — возможно, файл повреждён", "unreadable");
  }
  let meta;
  try {
    meta = await base.clone().metadata();
  } catch {
    throw new PrepareError("Фото не читается — возможно, файл повреждён", "unreadable");
  }
  // Предел пикселей до любой работы с картинкой: 100 Мп — с запасом больше 48 Мп iPhone,
  // а «бомба» в заголовке (крошечный файл, 30000×30000) не раскладывается в память worker.
  if ((meta.width ?? 0) * (meta.height ?? 0) > MAX_IMAGE_PIXELS) {
    throw new PrepareError("Фото слишком большое по размеру кадра — отправьте снимок с телефона", "too_big");
  }
  // .metadata() показывает размер ДО поворота: для 5-8 (повёрнутых) сторон меняем местами.
  const swap = (meta.orientation ?? 1) >= 5;
  const w0 = (swap ? meta.height : meta.width) ?? IMAGE_MAX_SIDE;
  const h0 = (swap ? meta.width : meta.height) ?? IMAGE_MAX_SIDE;
  const out = (ext: string) => path.join(options.workDir, `${randomUUID()}.${ext}`);

  const finish = async (data: Buffer, ext: "jpg" | "png", mimetype: string): Promise<PreparedMedia> => {
    const p = out(ext);
    await fs.writeFile(p, data);
    return { path: p, mimetype, size: data.length, action: "image", sendAsLink: false, owned: true, ms: Date.now() - started };
  };

  let side = Math.min(IMAGE_MAX_SIDE, Math.max(w0, h0));
  const resized = (maxSide: number) =>
    base.clone().resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true });

  // Прозрачность (логотип, схема планировки) — PNG, если влезает: JPEG залил бы фон белым.
  // HEIC после libheif всегда RGBA, но непрозрачный — для него канал альфы ничего не значит.
  if (meta.hasAlpha && meta.format !== "jpeg" && !(await base.clone().stats()).isOpaque) {
    const png = await resized(side).png({ compressionLevel: 9 }).toBuffer();
    if (png.length <= limit) return finish(png, "png", "image/png");
  }
  // Подбор: качество 86 → 76 на том же размере; не влезло — размер уменьшается сразу на
  // нужную долю (вес JPEG примерно пропорционален площади), а не шагами по 20%: на тяжёлом
  // снимке это 3–4 кодирования вместо двадцати.
  let quality = 86;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (options.signal?.aborted) throw new PrepareError("Отменено", "aborted");
    const jpeg = await resized(side).flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true }).toBuffer();
    if (jpeg.length <= limit) return finish(jpeg, "jpg", "image/jpeg");
    if (quality > 76) {
      quality = 76;
      continue;
    }
    if (side <= MIN_SIDE_AFTER_SHRINK) {
      if (quality <= 60) break;
      quality = 60;
      continue;
    }
    const k = Math.sqrt((limit * 0.9) / jpeg.length);
    side = Math.max(MIN_SIDE_AFTER_SHRINK, Math.round(side * Math.min(0.85, k)));
  }
  throw new PrepareError("Фото не удалось сжать до предела канала", "too_big");
}

/** Готовит файл под канал. Не фото и не видео — PrepareError. */
export async function prepareOutgoingMedia(
  input: PrepareInput,
  channel: OutgoingMediaChannel,
  options: PrepareOptions
): Promise<PreparedMedia> {
  if (input.mimetype.startsWith("image/")) return prepareOutgoingImage(input, channel, options);
  if (input.mimetype.startsWith("video/")) return prepareOutgoingVideo(input, channel, options);
  throw new PrepareError("Допустимы только фото и видео", "unreadable");
}

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { runFfmpeg } from "./ffmpeg.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { privateDirRoot, privateFilePath, privateMimeType } from "./privateFiles.js";

/**
 * ПРОИЗВОДНЫЕ КОПИИ ВЛОЖЕНИЙ ПЕРЕПИСКИ (25.11.2026): уменьшенное фото для ленты
 * и версия голосового/видео, которую играет любой браузер.
 *
 * Делаются ЛЕНИВО — по первому запросу, ровно один раз, и кладутся в подкаталог
 * `derived/` закрытого хранилища. Фоновых перекодировок «на всякий случай» нет:
 * копия появляется только тогда, когда её реально попросил браузер.
 *
 * Оригинал не трогается никогда. Подкаталог ночная уборка верхнего уровня
 * (cleanupPrivateFiles) не видит — она обходит только файлы самой папки, — поэтому
 * у копий своя уборка `cleanupDerivedChatMedia`: копия живёт, пока жив оригинал.
 *
 * Имя копии: `<имя оригинала>.<вид>.<расширение>` (`…uuid….ogg.p.m4a`) — по нему
 * уборка восстанавливает имя оригинала, не заглядывая в базу.
 *
 * ОЧЕРЕДИ (ревью #428). Миниатюры (sharp, миллисекунды) и перекодировка
 * (ffmpeg, до минут) идут РАЗНЫМИ очередями: долгое видео не держит фото ленты.
 * ffmpeg — строго по одному. Запрос не ждёт перекодировку дольше
 * prepareWaitMs(): дальше маршрут отвечает 503 + Retry-After, а работа идёт в
 * фоне (nginx и Cloudflare рвут запрос через 100–130 с). Неудача помечается
 * файлом `.fail` на сутки: битый ролик не перекодируется при каждом открытии.
 */

export type DerivedVariant = "thumb" | "play";
export type MediaKindHint = "audio" | "video";

const DERIVED_SUBDIR = "derived";
/** Ширина миниатюры: плитка в переписке 180–240 px, ×2 на экранах высокой чёткости. */
const THUMB_WIDTH = 480;
/** Больше этого оригинал не перекодируется: на входе потолок 16 МБ (messengers/attachments.ts). */
const MAX_TRANSCODE_SOURCE_BYTES = 20 * 1024 * 1024;
const AUDIO_TIMEOUT_MS = 60_000;
const VIDEO_TIMEOUT_MS = 240_000;
/** Предел пикселей для sharp — та же защита от «бомбы» в заголовке, что в heicInput.ts. */
const MAX_INPUT_PIXELS = 50_000_000;
/** Сколько помним неудачу перекодировки. */
const FAIL_TTL_MS = 24 * 60 * 60 * 1000;

/** Сколько запрос ждёт готовую копию, прежде чем ответить «готовится». Голос успевает. */
let prepareWaitOverrideMs: number | null = null;
/** Только для тестов: сколько ждать готовую копию (null — вернуть 8 с). Не окружение: имя из env не доходит до контейнера. */
export function setPrepareWaitMsForTests(ms: number | null): void {
  prepareWaitOverrideMs = ms;
}
function prepareWaitMs(): number {
  return prepareWaitOverrideMs ?? 8_000;
}

function derivedDir(): string {
  return path.join(privateDirRoot(), DERIVED_SUBDIR);
}

const DERIVED_NAME_RE = /^([0-9a-f-]{36}\.[a-z0-9]{2,4})\.(t|p)\.(webp|m4a|mp4)(\.fail)?$/i;

export function derivedName(source: string, variant: DerivedVariant, kind: "image" | MediaKindHint): string {
  if (variant === "thumb") return `${source}.t.webp`;
  return `${source}.p.${kind === "audio" ? "m4a" : "mp4"}`;
}

export function derivedMime(name: string): string {
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".m4a")) return "audio/mp4";
  return "video/mp4";
}

/**
 * Вид оригинала. По расширению — кроме webm: им бывает и голосовое, и видео
 * (privateMimeType отдаёт для .webm audio/webm). Для него решает подсказка из
 * самого вложения (`m=a|v` в ссылке, её кладёт сервер по kind реплики).
 */
function kindOfSource(source: string, hint?: MediaKindHint): "image" | "audio" | "video" | "file" {
  if (source.toLowerCase().endsWith(".webm") && hint) return hint;
  const mime = privateMimeType(source);
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

/** Простая очередь с потолком одновременных задач. */
function makeQueue(concurrency: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(job: () => Promise<T>): Promise<T> {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await job();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

const thumbQueue = makeQueue(2);
// Голос и видео — разные очереди (повторное ревью #428): голосовое перекодируется
// за секунды и не должно ждать видео, которое идёт до 4 минут.
const audioQueue = makeQueue(1);
const videoQueue = makeQueue(1);
const inFlight = new Map<string, Promise<string | null>>();

function existingDerived(name: string): string | null {
  const full = path.join(derivedDir(), name);
  return fs.existsSync(full) ? full : null;
}

/** Отметка неудачи — своя у каждой копии: у webm голосом (.p.m4a) и видео (.p.mp4) разные. */
export function derivedFailMarker(name: string): string {
  return path.join(derivedDir(), `${name}.fail`);
}

function recentlyFailed(name: string): boolean {
  try {
    return Date.now() - fs.statSync(derivedFailMarker(name)).mtimeMs < FAIL_TTL_MS;
  } catch {
    return false;
  }
}

export class DerivedMediaUnavailable extends Error {
  constructor(readonly reason: "disabled" | "unsupported" | "too_big" | "failed" | "preparing") {
    super(reason);
  }
}

async function build(sourcePath: string, name: string, variant: DerivedVariant, kind: "image" | MediaKindHint): Promise<string | null> {
  const again = existingDerived(name);
  if (again) return again;
  await fs.promises.mkdir(derivedDir(), { recursive: true });
  const target = path.join(derivedDir(), name);
  // Пишем во временный файл и переименовываем: обрыв на середине не оставит
  // полупустую копию, которую следующий запрос принял бы за готовую.
  const tmp = path.join(derivedDir(), `.tmp-${randomUUID()}${path.extname(name)}`);
  try {
    if (variant === "thumb") {
      await sharp(sourcePath, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
        .rotate()
        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
        .webp({ quality: 72 })
        .toFile(tmp);
    } else if (kind === "audio") {
      await runFfmpeg({
        label: "голосовое для браузера",
        timeoutMs: AUDIO_TIMEOUT_MS,
        args: ["-hide_banner", "-loglevel", "error", "-y", "-threads", "1", "-i", sourcePath,
          "-vn", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", "-f", "mp4", tmp],
      });
    } else {
      await runFfmpeg({
        label: "видео для браузера",
        timeoutMs: VIDEO_TIMEOUT_MS,
        args: ["-hide_banner", "-loglevel", "error", "-y", "-threads", "1", "-i", sourcePath,
          "-map", "0:v:0", "-map", "0:a:0?",
          "-vf", "scale='min(1280,iw)':-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
          "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-f", "mp4", tmp],
      });
    }
    await fs.promises.rename(tmp, target);
    return target;
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    if (variant === "play") await fs.promises.writeFile(derivedFailMarker(name), "").catch(() => {});
    // Имя файла — наш uuid, не данные клиента; подписанной ссылки здесь нет.
    void logSystemError("api", `Копия вложения переписки не сделана (${variant}, ${kind}): ${describeError(err)}`, {
      dedupKey: `chat-media-derived:${variant}:${kind}`,
    });
    return null;
  }
}

/**
 * Путь к производной копии; ставит её в работу, если ещё нет. Бросает
 * DerivedMediaUnavailable, когда отдать нечего: выключено, не тот вид файла,
 * слишком большой, не вышло (помечено на сутки) или ещё готовится (`preparing` —
 * маршрут отвечает 503 + Retry-After, работа идёт дальше в фоне).
 */
export async function ensureDerived(source: string, variant: DerivedVariant, hint?: MediaKindHint): Promise<string> {
  const sourcePath = privateFilePath(source);
  if (!sourcePath) throw new DerivedMediaUnavailable("unsupported");
  const kind = kindOfSource(source, hint);
  if (variant === "thumb" ? kind !== "image" : kind !== "audio" && kind !== "video") {
    throw new DerivedMediaUnavailable("unsupported");
  }
  const name = derivedName(source, variant, kind as "image" | MediaKindHint);
  const ready = existingDerived(name);
  if (ready) return ready;

  if (variant === "play") {
    if (recentlyFailed(name)) throw new DerivedMediaUnavailable("failed");
    if (!(await automationSwitchOn("chatMediaTranscodeEnabled"))) throw new DerivedMediaUnavailable("disabled");
    const size = (await fs.promises.stat(sourcePath)).size;
    if (size > MAX_TRANSCODE_SOURCE_BYTES) throw new DerivedMediaUnavailable("too_big");
  }

  let job = inFlight.get(name);
  if (!job) {
    const queue = variant === "thumb" ? thumbQueue : kind === "audio" ? audioQueue : videoQueue;
    job = queue(() => build(sourcePath, name, variant, kind as "image" | MediaKindHint)).finally(() => inFlight.delete(name));
    inFlight.set(name, job);
  }
  if (variant === "thumb") {
    const made = await job;
    if (!made) throw new DerivedMediaUnavailable("failed");
    return made;
  }
  const waitMs = prepareWaitMs();
  let timer: NodeJS.Timeout | undefined;
  const made = await Promise.race([
    job,
    new Promise<"waiting">((r) => {
      timer = setTimeout(() => r("waiting"), waitMs);
    }),
  ]).finally(() => clearTimeout(timer));
  if (made === "waiting") throw new DerivedMediaUnavailable("preparing");
  if (!made) throw new DerivedMediaUnavailable("failed");
  return made;
}

export interface DerivedCleanupResult {
  deleted: number;
  kept: number;
}

/**
 * Уборка копий: копия и отметка неудачи удаляются, когда оригинала больше нет;
 * отметки неудачи и брошенные временные файлы — ещё и через сутки.
 * Только подкаталог `derived/`, только обычные файлы, только наши имена.
 */
export function cleanupDerivedChatMedia(options?: { maxDeletions?: number }): DerivedCleanupResult {
  const result: DerivedCleanupResult = { deleted: 0, kept: 0 };
  const cap = Math.max(0, Math.min(options?.maxDeletions ?? 2000, 2000));
  const dir = derivedDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result; // каталога ещё нет — убирать нечего
  }
  const dayAgo = Date.now() - FAIL_TTL_MS;
  const olderThanDay = (full: string) => {
    try {
      return fs.lstatSync(full).mtimeMs < dayAgo;
    } catch {
      return false;
    }
  };
  for (const entry of entries) {
    if (result.deleted >= cap) break;
    if (!entry.isFile()) {
      result.kept++;
      continue;
    }
    const full = path.join(dir, entry.name);
    if (path.dirname(path.resolve(full)) !== path.resolve(dir)) {
      result.kept++;
      continue;
    }
    let remove = false;
    if (entry.name.startsWith(".tmp-")) {
      remove = olderThanDay(full);
    } else {
      const m = DERIVED_NAME_RE.exec(entry.name);
      if (!m) {
        result.kept++;
        continue;
      }
      remove = !privateFilePath(m[1]) || (!!m[4] && olderThanDay(full));
    }
    if (!remove) {
      result.kept++;
      continue;
    }
    try {
      fs.unlinkSync(full);
      result.deleted++;
    } catch {
      result.kept++;
    }
  }
  return result;
}

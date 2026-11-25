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
 */

export type DerivedVariant = "thumb" | "play";

const DERIVED_SUBDIR = "derived";
/** Ширина миниатюры: плитка в переписке 180–240 px, ×2 на экранах высокой чёткости. */
const THUMB_WIDTH = 480;
/** Больше этого оригинал не перекодируется: на входе потолок 16 МБ (messengers/attachments.ts). */
const MAX_TRANSCODE_SOURCE_BYTES = 20 * 1024 * 1024;
const AUDIO_TIMEOUT_MS = 60_000;
const VIDEO_TIMEOUT_MS = 240_000;
/** Предел пикселей для sharp — та же защита от «бомбы» в заголовке, что в heicInput.ts. */
const MAX_INPUT_PIXELS = 50_000_000;

function derivedDir(): string {
  return path.join(privateDirRoot(), DERIVED_SUBDIR);
}

const DERIVED_NAME_RE = /^([0-9a-f-]{36}\.[a-z0-9]{2,4})\.(t|p)\.(webp|m4a|mp4)$/i;

export function derivedName(source: string, variant: DerivedVariant, kind: "image" | "audio" | "video"): string {
  if (variant === "thumb") return `${source}.t.webp`;
  return `${source}.p.${kind === "audio" ? "m4a" : "mp4"}`;
}

export function derivedMime(name: string): string {
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".m4a")) return "audio/mp4";
  return "video/mp4";
}

function kindOfSource(source: string): "image" | "audio" | "video" | "file" {
  const mime = privateMimeType(source);
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

/**
 * Очередь тяжёлой работы — по одной за раз. API живёт в одном процессе с
 * переписками, телефонией и живыми событиями; две перекодировки видео разом на
 * сервере с несколькими ядрами заметно тормозили бы всех. Одинаковые запросы
 * (браузер на iPhone шлёт по видео два-три запроса подряд) ждут одно и то же
 * задание, а не ставят своё.
 */
let chain: Promise<unknown> = Promise.resolve();
const inFlight = new Map<string, Promise<string | null>>();

function enqueue(key: string, job: () => Promise<string | null>): Promise<string | null> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = chain.then(job, job);
  const tracked = run.finally(() => inFlight.delete(key));
  inFlight.set(key, tracked);
  chain = run.catch(() => undefined);
  return tracked;
}

/** Готовая копия на диске или null, если её ещё нет. */
function existingDerived(name: string): string | null {
  const full = path.join(derivedDir(), name);
  return fs.existsSync(full) ? full : null;
}

export class DerivedMediaUnavailable extends Error {
  constructor(readonly reason: "disabled" | "unsupported" | "too_big" | "failed") {
    super(reason);
  }
}

/**
 * Путь к производной копии; делает её, если ещё нет. Бросает
 * DerivedMediaUnavailable, когда копии не будет (выключено, не тот вид файла,
 * слишком большой, ffmpeg/sharp не справились) — маршрут отвечает понятным
 * кодом, а интерфейс показывает пометку и кнопку «Скачать».
 */
export async function ensureDerived(source: string, variant: DerivedVariant): Promise<string> {
  const sourcePath = privateFilePath(source);
  if (!sourcePath) throw new DerivedMediaUnavailable("unsupported");
  const kind = kindOfSource(source);
  if (variant === "thumb" ? kind !== "image" : kind !== "audio" && kind !== "video") {
    throw new DerivedMediaUnavailable("unsupported");
  }
  const name = derivedName(source, variant, kind as "image" | "audio" | "video");
  const ready = existingDerived(name);
  if (ready) return ready;

  if (variant === "play" && !(await automationSwitchOn("chatMediaTranscodeEnabled"))) {
    throw new DerivedMediaUnavailable("disabled");
  }
  const size = (await fs.promises.stat(sourcePath)).size;
  if (variant === "play" && size > MAX_TRANSCODE_SOURCE_BYTES) throw new DerivedMediaUnavailable("too_big");

  const made = await enqueue(name, async () => {
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
      // Имя файла — наш uuid, не данные клиента; подписанной ссылки здесь нет.
      void logSystemError("api", `Копия вложения переписки не сделана (${variant}, ${kind}): ${describeError(err)}`, {
        dedupKey: `chat-media-derived:${variant}:${kind}`,
      });
      return null;
    }
  });
  if (!made) throw new DerivedMediaUnavailable("failed");
  return made;
}

export interface DerivedCleanupResult {
  deleted: number;
  kept: number;
}

/**
 * Уборка копий: копия удаляется, когда оригинала больше нет (его стёрла уборка
 * по сроку или удалили руками), и брошенные временные файлы старше суток.
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
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
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
      try {
        remove = fs.lstatSync(full).mtimeMs < dayAgo;
      } catch {
        remove = false;
      }
    } else {
      const m = DERIVED_NAME_RE.exec(entry.name);
      if (!m) {
        result.kept++;
        continue;
      }
      remove = !privateFilePath(m[1]);
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

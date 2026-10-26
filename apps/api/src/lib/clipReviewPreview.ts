/**
 * РОЛИК НА ПРОВЕРКУ — В ВИДЕ, КОТОРЫЙ TELEGRAM ПОКАЖЕТ ПРАВИЛЬНО (26.10.2026,
 * владелец: «иногда в телеграме ролики, которые надо одобрить, ужасно выглядят —
 * или перевёрнутые, или ещё с какой-то ошибкой»; и следом: «а если просто
 * оригинал отправлять?»).
 *
 * Модератору ролик уходил как есть — без размеров, длительности и обложки
 * (telegram/clipReviewBot.ts → sendVideoFromDisk). Telegram в таком случае
 * гадает сам: чёрный кадр с «00:00», портретный ролик с телефона (контейнер
 * 3840×2160 + rotation=-90, см. ffmpeg.ts::MediaInfo) ложится боком, HEVC не
 * играет в превью на части клиентов.
 *
 * Поэтому два пути:
 *  - обычный ролик (H.264, без поворота, в пределах размера) — уходит ОРИГИНАЛ,
 *    только с честными width/height/duration и кадром-обложкой: перекодировка
 *    ему не нужна и сервер ею не грузим;
 *  - проблемный (другой кодек, поворот в метаданных, больше предела бота) —
 *    копия ТОЛЬКО для просмотра: поворот применён (autorotate ffmpeg), H.264/AAC,
 *    короткая сторона 720, moov в начале.
 * В сети и на сервер в обоих случаях уходит оригинал — эту копию никто не публикует.
 *
 * Копию собрать не вышло (нет ffmpeg, битый файл, таймаут) — оригинал с теми
 * размерами, что известны. Временные файлы убирает `cleanup()`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { probeMediaInfo, runFfmpeg, type MediaInfo } from "./ffmpeg.js";

/** Короткая сторона копии: в окне Telegram больше не видно, а вес в разы меньше. */
export const CLIP_PREVIEW_SHORT_SIDE = 720;
const TRANSCODE_TIMEOUT_MS = 5 * 60_000;
const THUMB_TIMEOUT_MS = 30_000;

export interface ClipForTelegram {
  videoPath: string;
  /** Кадр-обложка (Telegram: JPEG, не больше 320 по стороне); null — кадр не вынули. */
  thumbnailPath: string | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  sizeBytes: number;
  /** true — отправляется копия для просмотра, а не оригинал. */
  transcoded: boolean;
  cleanup: () => Promise<void>;
}

/** Почему оригинал нельзя показать как есть; null — можно. */
export function clipPreviewReason(media: MediaInfo | null, sizeBytes: number, sendLimitBytes: number): string | null {
  if (!media) return null; // ffprobe не ответил — нечего решать, шлём оригинал
  if (media.videoCodec && media.videoCodec !== "h264") return `кодек ${media.videoCodec}`;
  if (media.rotation % 360 !== 0) return `поворот ${media.rotation}°`;
  if (sizeBytes > sendLimitBytes) return "больше предела бота";
  return null;
}

/** Фильтр масштаба: короткая сторона 720 (меньше — не растягиваем), обе стороны чётные. */
export function clipPreviewScaleFilter(): string {
  const s = CLIP_PREVIEW_SHORT_SIDE;
  return `scale='if(gte(iw,ih),-2,min(${s},trunc(iw/2)*2))':'if(gte(iw,ih),min(${s},trunc(ih/2)*2),-2)'`;
}

async function extractThumbnail(videoPath: string, durationSec: number | null, outPath: string): Promise<string | null> {
  try {
    await runFfmpeg({
      label: "обложка ролика для проверки в Telegram",
      timeoutMs: THUMB_TIMEOUT_MS,
      args: [
        "-y", "-hide_banner", "-v", "error",
        "-ss", durationSec != null && durationSec > 2 ? "1" : "0",
        "-i", videoPath,
        "-frames:v", "1",
        "-vf", "scale=320:320:force_original_aspect_ratio=decrease",
        "-q:v", "5",
        outPath,
      ],
    });
    return outPath;
  } catch {
    return null; // без обложки видео всё равно правильное
  }
}

async function transcodePreview(srcPath: string, outPath: string): Promise<MediaInfo | null> {
  try {
    await runFfmpeg({
      label: "копия ролика для проверки в Telegram",
      timeoutMs: TRANSCODE_TIMEOUT_MS,
      args: [
        "-y", "-hide_banner", "-v", "error",
        "-i", srcPath,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", clipPreviewScaleFilter(),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        // Поворот уже применён к кадрам — тег rotate в копию не переносим.
        "-metadata:s:v:0", "rotate=0",
        "-movflags", "+faststart",
        "-threads", "2",
        outPath,
      ],
    });
    const info = await probeMediaInfo(outPath);
    return info?.hasVideo && info.width && info.height ? info : null;
  } catch {
    return null;
  }
}

export async function prepareClipForTelegram(
  srcPath: string,
  media: MediaInfo | null,
  sizeBytes: number,
  sendLimitBytes: number
): Promise<ClipForTelegram> {
  const dir = path.join(os.tmpdir(), `clip-review-${randomUUID()}`);
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }).then(() => {});
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const thumbOut = path.join(dir, "thumb.jpg");

  if (clipPreviewReason(media, sizeBytes, sendLimitBytes)) {
    const previewPath = path.join(dir, "preview.mp4");
    const info = await transcodePreview(srcPath, previewPath);
    if (info) {
      const stat = await fs.stat(previewPath);
      return {
        videoPath: previewPath,
        thumbnailPath: await extractThumbnail(previewPath, info.durationSec, thumbOut),
        width: info.width,
        height: info.height,
        durationSec: info.durationSec,
        sizeBytes: stat.size,
        transcoded: true,
        cleanup,
      };
    }
  }

  return {
    videoPath: srcPath,
    thumbnailPath: media ? await extractThumbnail(srcPath, media.durationSec, thumbOut) : null,
    width: media?.width ?? null,
    height: media?.height ?? null,
    durationSec: media?.durationSec ?? null,
    sizeBytes,
    transcoded: false,
    cleanup,
  };
}

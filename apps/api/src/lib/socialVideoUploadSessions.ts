import path from "node:path";
import { SOCIAL_VIDEO_ALLOWED_EXTENSIONS, SOCIAL_VIDEO_UPLOAD_MAX_BYTES } from "@royal-home/shared";
import {
  assembleChunkedUpload,
  startChunkedUpload,
  writeChunkedUploadPart,
} from "./chunkedUploadSessions.js";
import { SocialVideoError } from "./socialVideoPosts.js";

/**
 * ЗАГРУЗКА СВОБОДНОГО РОЛИКА ЧАСТЯМИ (17.11.2026). Раньше ролик шёл одним запросом, и
 * файл 87 МБ получал 413 «Файл слишком большой» ещё до API: Cloudflare перед сервером
 * не пропускает тело больше 100 МБ, а прокси на сервере — и меньше. Механика сессии —
 * общая (lib/chunkedUploadSessions.ts); здесь только правила свободного ролика: тип файла,
 * предел и ошибки в виде SocialVideoError, которые понимают маршруты раздела.
 */

const KIND = "social";

/** Ошибки ядра (ChunkedUploadError) идут как есть: маршруты раздела отвечают на них тем же
 *  телом с машинным кодом (PARTS_MISSING, ASSEMBLING), что и общие сессии, — по нему экран докачивает. */
async function asSocialError<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

export async function startSocialVideoUpload(input: {
  agentId: string;
  filename: string;
  sizeBytes: number;
}): Promise<{ sessionId: string; partSize: number; totalParts: number }> {
  const ext = path.extname(input.filename).toLowerCase();
  if (!(SOCIAL_VIDEO_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new SocialVideoError(`Файл «${input.filename}» не подходит: нужен ролик MP4 или MOV`, 422);
  }
  return asSocialError(() =>
    startChunkedUpload({
      kind: KIND,
      agentId: input.agentId,
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      maxBytes: SOCIAL_VIDEO_UPLOAD_MAX_BYTES,
      tooLargeMessage: "Файл больше 2 ГБ — сожмите ролик и загрузите снова",
    })
  );
}

export async function writeSocialVideoPart(input: {
  sessionId: string;
  agentId: string;
  partNumber: number;
  body: Buffer;
}): Promise<void> {
  await asSocialError(() => writeChunkedUploadPart({ kind: KIND, ...input }));
}

/** Склеивает части во временный файл и отдаёт его путь и исходное имя. */
export async function assembleSocialVideoUpload(
  sessionId: string,
  agentId: string
): Promise<{ tmpPath: string; originalName: string }> {
  const assembled = await asSocialError(() => assembleChunkedUpload({ kind: KIND, sessionId, agentId }));
  return { tmpPath: assembled.tmpPath, originalName: assembled.originalName };
}

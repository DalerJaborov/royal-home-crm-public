import express, { Router } from "express";
import { z } from "zod";
import {
  CHUNKED_UPLOAD_PURPOSES,
  UPLOAD_PART_MAX_BYTES,
  UPLOAD_PART_MIN_BYTES,
  formatUploadLimit,
  type ChunkedUploadPurpose,
} from "@royal-home/shared";
import { requireAuth } from "../auth/middleware.js";
import { chunkedUploadKind, chunkedUploadStatus, startChunkedUpload, writeChunkedUploadPart } from "../lib/chunkedUploadSessions.js";
import { UploadError } from "../lib/uploadErrors.js";
import { logUploadPart, partBodySource, sendUploadError } from "../lib/uploadHttp.js";

/**
 * ОБЩИЕ СЕССИИ ЗАГРУЗКИ ЧАСТЯМИ (17.11.2026, класс «большой файл одним запросом → 413»).
 *
 *   POST /api/v1/upload-sessions                         { purpose, filename, sizeBytes, contentType }
 *   PUT  /api/v1/upload-sessions/:sessionId/parts/:n     сырые байты части (не больше UPLOAD_PART_MAX_BYTES,
 *                                                        пишутся на диск потоком, без копии в памяти)
 *   GET  /api/v1/upload-sessions/:sessionId              план, принятые части и байты, состояние сборки
 *                                                        (`state`, итог `result`) — для докачки после обрыва
 *                                                        и для асинхронной сборки (X-Upload-Async: 1)
 *
 * Сборку делает маршрут назначения — он же проверяет права на объект или переписку:
 *   POST /api/v1/properties/:id/clip-video/upload-sessions/:sessionId/complete
 *   POST /api/v1/conversations/:id/reply-media/upload-sessions/complete   { sessionId, caption }
 * Предел и допустимый тип назначения — packages/shared (CHUNKED_UPLOAD_PURPOSES): экран
 * проверяет тем же числом до отправки. Свободные ролики в соцсети идут своими адресами
 * (/social-videos/upload-sessions) поверх того же ядра (lib/chunkedUploadSessions.ts).
 */
export const uploadSessionsRouter = Router();

uploadSessionsRouter.use(requireAuth);

const purposes = Object.keys(CHUNKED_UPLOAD_PURPOSES) as [ChunkedUploadPurpose, ...ChunkedUploadPurpose[]];

const startSchema = z.object({
  purpose: z.enum(purposes),
  filename: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  contentType: z.string().trim().max(100).optional().default(""),
  /** Необязательно: размер части, который удобен клиенту (медленный канал — меньше). */
  partSize: z.number().int().min(UPLOAD_PART_MIN_BYTES).max(UPLOAD_PART_MAX_BYTES).optional(),
});

function acceptsType(purpose: ChunkedUploadPurpose, contentType: string): boolean {
  const accepts = CHUNKED_UPLOAD_PURPOSES[purpose].accepts;
  if (contentType.startsWith("video/")) return true;
  return accepts === "image-or-video" && contentType.startsWith("image/");
}

function sendError(res: express.Response, err: unknown, next: express.NextFunction) {
  if (sendUploadError(res, err, "общая загрузка частями")) return;
  next(err);
}

uploadSessionsRouter.post("/", async (req, res, next) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Неверные данные файла" });
    return;
  }
  const { purpose, filename, sizeBytes, contentType, partSize } = parsed.data;
  if (!acceptsType(purpose, contentType)) {
    const what = CHUNKED_UPLOAD_PURPOSES[purpose].accepts === "video" ? "видео" : "фото или видео";
    res.status(400).json({ error: `Допустимо только ${what}` });
    return;
  }
  const maxBytes = CHUNKED_UPLOAD_PURPOSES[purpose].maxBytes;
  try {
    const session = await startChunkedUpload({
      kind: purpose,
      agentId: req.agent!.id,
      filename,
      sizeBytes,
      contentType,
      maxBytes,
      partSize,
      // Ролик карточки после склейки ещё сжимается — копия на диске.
      extraCopy: purpose === "clip-video",
      tooLargeMessage: `Файл «${filename}» больше предела ${formatUploadLimit(maxBytes)} — сожмите его и отправьте снова`,
    });
    res.status(201).json(session);
  } catch (err) {
    sendError(res, err, next);
  }
});

uploadSessionsRouter.put("/:sessionId/parts/:partNumber", async (req, res, next) => {
  const sessionId = String(req.params.sessionId);
  const partNumber = Number(req.params.partNumber);
  const startedAt = Date.now();
  try {
    const kind = await chunkedUploadKind(sessionId);
    // Свободные ролики идут своими адресами: здесь только назначения из общего реестра.
    if (!kind || !(kind in CHUNKED_UPLOAD_PURPOSES)) throw new UploadError("SESSION_NOT_FOUND");
    const bytes = await writeChunkedUploadPart({ kind, sessionId, agentId: req.agent!.id, partNumber, body: partBodySource(req) });
    logUploadPart(req, { kind, sessionId, partNumber, bytes, startedAt });
    res.json({ ok: true, partNumber });
  } catch (err) {
    if (err instanceof UploadError) logUploadPart(req, { kind: "chunked", sessionId, partNumber, startedAt, code: err.code });
    sendError(res, err, next);
  }
});

/** Докачка и асинхронная сборка: принятые части и байты, состояние. Своя сессия любого назначения, чужая — 404. */
uploadSessionsRouter.get("/:sessionId", async (req, res, next) => {
  try {
    res.json(await chunkedUploadStatus(String(req.params.sessionId), req.agent!.id));
  } catch (err) {
    sendError(res, err, next);
  }
});

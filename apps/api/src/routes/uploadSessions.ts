import express, { Router } from "express";
import { z } from "zod";
import { CHUNKED_UPLOAD_PURPOSES, formatUploadLimit, type ChunkedUploadPurpose } from "@royal-home/shared";
import { requireAuth } from "../auth/middleware.js";
import {
  ChunkedUploadError,
  chunkedUploadErrorBody,
  chunkedUploadKind,
  chunkedUploadStatus,
  startChunkedUpload,
  writeChunkedUploadPart,
} from "../lib/chunkedUploadSessions.js";

/**
 * ОБЩИЕ СЕССИИ ЗАГРУЗКИ ЧАСТЯМИ (17.11.2026, класс «большой файл одним запросом → 413»).
 *
 *   POST /api/v1/upload-sessions                         { purpose, filename, sizeBytes, contentType }
 *   PUT  /api/v1/upload-sessions/:sessionId/parts/:n     сырые байты части (не больше 32 МБ)
 *   GET  /api/v1/upload-sessions/:sessionId              план и принятые части — для докачки
 *                                                        после обрыва (любая своя сессия, и соцролика)
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
});

function acceptsType(purpose: ChunkedUploadPurpose, contentType: string): boolean {
  const accepts = CHUNKED_UPLOAD_PURPOSES[purpose].accepts;
  if (contentType.startsWith("video/")) return true;
  return accepts === "image-or-video" && contentType.startsWith("image/");
}

function sendError(res: express.Response, err: unknown, next: express.NextFunction) {
  if (err instanceof ChunkedUploadError) {
    res.status(err.status).json(chunkedUploadErrorBody(err));
    return;
  }
  next(err);
}

uploadSessionsRouter.post("/", async (req, res, next) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Неверные данные файла" });
    return;
  }
  const { purpose, filename, sizeBytes, contentType } = parsed.data;
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
      tooLargeMessage: `Файл «${filename}» больше предела ${formatUploadLimit(maxBytes)} — сожмите его и отправьте снова`,
    });
    res.status(201).json(session);
  } catch (err) {
    sendError(res, err, next);
  }
});

uploadSessionsRouter.put(
  "/:sessionId/parts/:partNumber",
  express.raw({ type: () => true, limit: "32mb" }),
  async (req, res, next) => {
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body)) {
      res.status(400).json({ error: "Пустая часть" });
      return;
    }
    const sessionId = String(req.params.sessionId);
    try {
      const kind = await chunkedUploadKind(sessionId);
      // Свободные ролики идут своими адресами: здесь только назначения из общего реестра.
      if (!kind || !(kind in CHUNKED_UPLOAD_PURPOSES)) {
        res.status(404).json({ error: "Загрузка не найдена — выберите файл ещё раз" });
        return;
      }
      await writeChunkedUploadPart({
        kind,
        sessionId,
        agentId: req.agent!.id,
        partNumber: Number(req.params.partNumber),
        body,
      });
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, next);
    }
  }
);

/** Докачка: какие части уже на сервере. Своя сессия любого назначения, чужая — 404. */
uploadSessionsRouter.get("/:sessionId", async (req, res, next) => {
  try {
    res.json(await chunkedUploadStatus(String(req.params.sessionId), req.agent!.id));
  } catch (err) {
    sendError(res, err, next);
  }
});

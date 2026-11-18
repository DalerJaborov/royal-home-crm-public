import { Router } from "express";
import { NARRATION_MUSIC_LIMITS, narrationMusicIdSchema, narrationMusicTitleFromFile, narrationMusicUploadSchema, type NarrationMusicLibraryView } from "@royal-home/shared";
import { requireAuth } from "../../auth/middleware.js";
import { logAgentAudit } from "../../lib/audit.js";
import { localVideoFilePath } from "../../lib/localVideoStorage.js";
import { addNarrationMusicTrack, deleteNarrationMusicTrack, narrationMusicTracks } from "../../lib/narrationMusic.js";
import { prisma } from "../../db.js";
import { narrationMusicUpload } from "../../upload.js";
import { hasMarketingRole } from "../marketing.js";

/**
 * БИБЛИОТЕКА МУЗЫКИ ОЗВУЧКИ (18.11.2026, lib/narrationMusic.ts). Права — как у настроек озвучки
 * (routes/properties/narration.ts): видит и слушает маркетинг и руководство, загружает и удаляет
 * директор или администратор. Статический путь — до /properties/:id (подключается вместе с narrationRouter).
 */
export const narrationMusicRouter = Router();
narrationMusicRouter.use("/narration-music", requireAuth);
const canConfigure = (role: string) => ["ADMIN", "DIRECTOR"].includes(role);

narrationMusicRouter.get("/narration-music", async (req, res) => {
  if (!hasMarketingRole(req.agent)) return res.status(403).json({ error: "Музыка доступна маркетингу и руководству" });
  const tracks = await narrationMusicTracks();
  const view: NarrationMusicLibraryView = {
    tracks: tracks.map((t) => ({ id: t.id, title: t.title, durationSec: t.durationSec, sizeBytes: t.sizeBytes, format: t.format === "m4a" ? "m4a" : "mp3", createdAt: t.createdAt.toISOString() })),
    canConfigure: canConfigure(req.agent!.role), limits: NARRATION_MUSIC_LIMITS,
  };
  res.json(view);
});

narrationMusicRouter.get("/narration-music/:id/file", async (req, res) => {
  if (!hasMarketingRole(req.agent)) return res.status(403).json({ error: "Музыка доступна маркетингу и руководству" });
  const id = narrationMusicIdSchema.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "Некорректный трек" });
  const row = await prisma.narrationMusicTrack.findUnique({ where: { id: id.data }, select: { storageKey: true, format: true } });
  const file = row ? localVideoFilePath(row.storageKey) : null;
  if (!row || !file) return res.status(404).json({ error: "Трек не найден" });
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.type(row.format === "m4a" ? "audio/mp4" : "audio/mpeg").sendFile(file, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Файл трека не найден на сервере" });
  });
});

// Права проверяются после приёма тела: ответ до чтения 15 МБ браузер видит как обрыв связи, а не как отказ.
narrationMusicRouter.post("/narration-music", narrationMusicUpload.single("file"), async (req, res) => {
  if (!canConfigure(req.agent!.role)) return res.status(403).json({ error: "Музыку загружает руководство" });
  const fields = narrationMusicUploadSchema.safeParse({ ...(typeof req.body?.title === "string" ? { title: req.body.title } : {}) });
  if (!fields.success) return res.status(400).json({ error: "Название трека — до 80 знаков" });
  if (!req.file) return res.status(400).json({ error: "Выберите файл mp3 или m4a" });
  if (await prisma.narrationMusicTrack.count() >= NARRATION_MUSIC_LIMITS.maxTracks) return res.status(409).json({ error: `В библиотеке уже ${NARRATION_MUSIC_LIMITS.maxTracks} треков: удалите лишние` });
  const title = fields.data.title || narrationMusicTitleFromFile(Buffer.from(req.file.originalname, "latin1").toString("utf8"));
  const added = await addNarrationMusicTrack({ buffer: req.file.buffer, title, createdById: req.agent!.id });
  if (!added.ok) return res.status(added.status).json({ error: added.error });
  logAgentAudit(req.agent!.id, "NARRATION_MUSIC_ADDED", "NarrationMusicTrack", added.id, { title });
  res.status(201).json({ id: added.id });
});

narrationMusicRouter.delete("/narration-music/:id", async (req, res) => {
  if (!canConfigure(req.agent!.role)) return res.status(403).json({ error: "Музыку удаляет руководство" });
  const id = narrationMusicIdSchema.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "Некорректный трек" });
  if (!(await deleteNarrationMusicTrack(id.data))) return res.status(404).json({ error: "Трек не найден" });
  logAgentAudit(req.agent!.id, "NARRATION_MUSIC_DELETED", "NarrationMusicTrack", id.data, {});
  res.json({ ok: true });
});

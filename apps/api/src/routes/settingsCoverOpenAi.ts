/**
 * ОБЛОЖКИ CHATGPT — подмаршруты Настроек (25.09.2026, решение владельца).
 *
 *   GET  /settings/cover-templates/openai       — состояние: ключ (маска и источник),
 *        вкл/выкл, качество, лимит, израсходовано сегодня, последние генерации
 *   PUT  /settings/cover-templates/openai       — сохранить (step-up, как все ключи)
 *   POST /settings/cover-templates/openai-test  — пробная обложка по объекту без
 *        записи в объект: квадрат и вертикаль base64 + секунды и центы
 *
 * Ключ наружу не уходит никогда — только маска. Пустая строка ключа = очистить
 * (вернуться на OPENAI_API_KEY из .env), как у ключей Gemini.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Router, type Request } from "express";
import sharp from "sharp";
import { z } from "zod";
import { COVER_PROVIDERS } from "@royal-home/shared";
import { prisma } from "../db.js";
import { can, requireAuth, requirePermission } from "../auth/middleware.js";
import { requireElevation } from "../lib/stepUp.js";
import { encryptSecret, decryptSecretSafe } from "../crypto.js";
import { logAudit } from "../lib/audit.js";
import { maskKey } from "../lib/maskSecret.js";
import { upload, uploadsDir } from "../upload.js";
import {
  COVER_CHECK_ENDPOINT,
  COVER_IMAGE_ENDPOINT,
  LOGO_MIN_SOURCE_PX,
  companyLogoWidth,
  coverImagesUsedToday,
  createPropertyCover,
  loadCoverRuntimeSettings,
  MODEL_REFERENCE_PATHS,
} from "../lib/video/coverOpenAi.js";

export const coverOpenAiRouter = Router();

const RECENT_LIMIT = 15;

/**
 * СТОИМОСТЬ ГЕНЕРАЦИИ — ДЕНЬГИ КОМПАНИИ (аудит Codex 04.10.2026, ACCESS-05).
 * settings.manage настраивает обложки, но не видит финансов: рядом цена звонка
 * робота (routes/settings.ts) закрыта finance.view, и стоимость обложки не должна
 * быть дырой в той же стене. Без права отдаём null — интерфейс его уже умеет.
 */
const costFor = (req: Request, value: number | null): number | null =>
  can(req, "finance.view") ? value : null;

coverOpenAiRouter.get("/openai", requireAuth, requirePermission("settings.manage"), async (req, res) => {
  const [row, runtime, usedToday, recent] = await Promise.all([
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { openaiApiKey: true } }),
    loadCoverRuntimeSettings(),
    coverImagesUsedToday(),
    prisma.aiLog.findMany({
      where: { endpoint: { in: [COVER_IMAGE_ENDPOINT, COVER_CHECK_ENDPOINT] } },
      orderBy: { createdAt: "desc" },
      take: RECENT_LIMIT,
      select: { id: true, endpoint: true, model: true, ok: true, ms: true, costUsd: true, createdAt: true },
    }),
  ]);
  // Логотип меньше 400 px на обложке расплывается — раздел Настроек предупреждает.
  const logoWidth = await companyLogoWidth(runtime.companyLogoUrl);
  const fromSettings = decryptSecretSafe(row?.openaiApiKey ?? null);
  const envKey = process.env.OPENAI_API_KEY?.trim() || null;
  res.json({
    keyConfigured: !!fromSettings || !!envKey,
    keyMasked: fromSettings ? maskKey(fromSettings) : envKey ? maskKey(envKey) : null,
    keySource: fromSettings ? "settings" : envKey ? "env" : null,
    enabled: runtime.coverGenerationEnabled,
    provider: runtime.coverProvider,
    referenceSquareUrl: runtime.coverReferenceSquareUrl,
    referenceStoryUrl: runtime.coverReferenceStoryUrl,
    photoRedraw: runtime.coverPhotoRedraw,
    quality: runtime.openaiImageQuality,
    dailyLimit: runtime.openaiCoverDailyLimit,
    candidates: runtime.openaiCandidates,
    textMode: runtime.openaiTextMode,
    photoSource: runtime.openaiPhotoSource,
    imageModel: runtime.openaiImageModel,
    logoWidth,
    logoMinWidth: LOGO_MIN_SOURCE_PX,
    usedToday,
    recent: recent.map((r) => ({
      id: r.id,
      kind: r.endpoint === COVER_IMAGE_ENDPOINT ? "image" : "check",
      model: r.model,
      ok: r.ok,
      ms: r.ms,
      costUsd: costFor(req, r.costUsd != null ? Number(r.costUsd) : null),
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

const updateSchema = z.object({
  /** Пустая строка — очистить ключ в Настройках (вернуться на .env). */
  apiKey: z.string().trim().max(400).optional(),
  enabled: z.boolean().optional(),
  /** Кто рисует: TEMPLATE — наш шаблон, OPENAI — ChatGPT (28.09.2026). */
  provider: z.enum(COVER_PROVIDERS).optional(),
  /** Фото под наш шаблон перерисовывает ChatGPT «как для журнала» (29.09.2026). */
  photoRedraw: z.boolean().optional(),
  dailyLimit: z.number().int().min(0).max(1000).optional(),
  // Качество, кандидаты, режим текста, фон и модель — константы с 01.11.2026
  // (lib/settingsConstants.ts): здесь их больше не принимают.
});

coverOpenAiRouter.put("/openai", requireAuth, requirePermission("settings.manage"), requireElevation, async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Проверьте поля", details: parsed.error.flatten() });
  const { apiKey, enabled, provider, photoRedraw, dailyLimit } = parsed.data;
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      ...(apiKey !== undefined ? { openaiApiKey: apiKey ? encryptSecret(apiKey) : null } : {}),
      ...(enabled !== undefined ? { coverGenerationEnabled: enabled } : {}),
      ...(provider !== undefined ? { coverProvider: provider } : {}),
      ...(photoRedraw !== undefined ? { coverPhotoRedraw: photoRedraw } : {}),
      ...(dailyLimit !== undefined ? { openaiCoverDailyLimit: dailyLimit } : {}),
    },
  });
  logAudit(req, "COVER_OPENAI_SETTINGS", "Settings", "singleton", {
    keyChanged: apiKey !== undefined,
    ...(enabled !== undefined ? { enabled } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(photoRedraw !== undefined ? { photoRedraw } : {}),
    ...(dailyLimit !== undefined ? { dailyLimit } : {}),
  });
  res.json({ ok: true });
});

const testSchema = z.object({ propertyId: z.string().min(1).max(64).optional() });

/**
 * Пробная обложка: объект по id или первый опубликованный с фото. Картинки не
 * пишутся в объект (dryRun), но деньги и лимит дня тратятся честно.
 */
coverOpenAiRouter.post("/openai-test", requireAuth, requirePermission("settings.manage"), async (req, res) => {
  const parsed = testSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Неверный id объекта" });
  const propertyId =
    parsed.data.propertyId ??
    (
      await prisma.property.findFirst({
        where: { deletedAt: null, photos: { some: {} } },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      })
    )?.id;
  if (!propertyId) return res.status(404).json({ error: "Нет ни одного объекта с фото" });

  const attempt = await createPropertyCover(propertyId, { dryRun: true });
  if (!attempt.ok || !attempt.story || !attempt.square) {
    return res.status(422).json({ error: attempt.reason ?? "Обложка не создана", seconds: Math.round(attempt.ms / 100) / 10, costUsd: costFor(req, attempt.costUsd) });
  }
  res.json({
    propertyId,
    squareDataUrl: `data:image/jpeg;base64,${attempt.square.toString("base64")}`,
    storyDataUrl: `data:image/jpeg;base64,${attempt.story.toString("base64")}`,
    seconds: Math.round(attempt.ms / 100) / 10,
    costUsd: costFor(req, Math.round(attempt.costUsd * 10000) / 10000),
  });
});

/**
 * СВОЙ ЭТАЛОН ОБЛОЖКИ ДЛЯ CHATGPT (владелец, 29.09.2026: «поставили референс в
 * Настройках — ChatGPT делает именно такие, с нашими надписями»).
 *   POST   /settings/cover-templates/openai-reference/:format  (поле image) — загрузить
 *   DELETE /settings/cover-templates/openai-reference/:format  — вернуть встроенный
 * Картинка приводится к размеру формата (1080² / 1080×1920) и хранится в
 * `uploads/cover-references/`. Старый файл не удаляем: по нему ещё может идти генерация.
 */
const referenceFormat = z.enum(["square", "story"]);
const REFERENCE_SIZE = { square: { width: 1080, height: 1080 }, story: { width: 1080, height: 1920 } } as const;

coverOpenAiRouter.post(
  "/openai-reference/:format",
  requireAuth,
  requirePermission("settings.manage"),
  requireElevation,
  upload.single("image"),
  async (req, res) => {
    const format = referenceFormat.safeParse(req.params.format);
    if (!format.success) return res.status(400).json({ error: "Формат — square или story" });
    if (!req.file) return res.status(400).json({ error: "Картинка не передана" });
    const dir = path.join(uploadsDir, "cover-references");
    const filename = `ref-${format.data}-${Date.now().toString(36)}.png`;
    try {
      const size = REFERENCE_SIZE[format.data];
      await fs.mkdir(dir, { recursive: true });
      await sharp(req.file.buffer).rotate().resize(size.width, size.height, { fit: "cover" }).png().toFile(path.join(dir, filename));
    } catch {
      return res.status(400).json({ error: "Не получилось открыть картинку — нужен png, jpg или webp" });
    }
    const url = `/uploads/cover-references/${filename}`;
    await prisma.settings.update({
      where: { id: "singleton" },
      data: format.data === "square" ? { coverReferenceSquareUrl: url } : { coverReferenceStoryUrl: url },
    });
    logAudit(req, "COVER_OPENAI_SETTINGS", "Settings", "singleton", { reference: format.data, url });
    res.json({ ok: true, url });
  }
);

coverOpenAiRouter.delete("/openai-reference/:format", requireAuth, requirePermission("settings.manage"), requireElevation, async (req, res) => {
  const format = referenceFormat.safeParse(req.params.format);
  if (!format.success) return res.status(400).json({ error: "Формат — square или story" });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: format.data === "square" ? { coverReferenceSquareUrl: null } : { coverReferenceStoryUrl: null },
  });
  logAudit(req, "COVER_OPENAI_SETTINGS", "Settings", "singleton", { reference: format.data, url: null });
  res.json({ ok: true });
});

/** Действующий эталон (свой или встроенный) — картинкой для превью в Настройках. */
coverOpenAiRouter.get("/openai-reference/:format/image", requireAuth, requirePermission("settings.manage"), async (req, res) => {
  const format = referenceFormat.safeParse(req.params.format);
  if (!format.success) return res.status(400).json({ error: "Формат — square или story" });
  const runtime = await loadCoverRuntimeSettings();
  const own = format.data === "square" ? runtime.coverReferenceSquareUrl : runtime.coverReferenceStoryUrl;
  const file = own ? path.join(uploadsDir, "cover-references", path.basename(own)) : MODEL_REFERENCE_PATHS[format.data];
  const preview = await sharp(file).resize({ width: 360 }).jpeg({ quality: 80 }).toBuffer().catch(() => null);
  if (!preview) return res.status(404).json({ error: "Эталон не найден" });
  res.type("image/jpeg").setHeader("Cache-Control", "private, no-store").send(preview);
});

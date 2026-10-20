/**
 * ШАБЛОНЫ ОБЛОЖЕК ДЛЯ СОЦСЕТЕЙ — подмаршруты Настроек (владелец, 23.09.2026).
 *
 * Список, предпросмотр, загрузка своего шаблона (SVG + spec.json + необязательные
 * листья/знак) и удаление своего. Встроенный «Royal Gold» живёт кодом и не
 * удаляется — тот же принцип, что у встроенных шаблонов подписи Reels.
 *
 * Границы проверяются схемами `@royal-home/shared` (`coverTemplateSpecSchema`,
 * `coverTemplateUploadSchema`), SVG чистится `sanitizeTemplateSvg` до записи на
 * диск: файл шаблона потом попадает в рендер на сервере, и внешние ссылки или
 * скрипты внутри него — это не «некрасиво», а дыра.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import sharp from "sharp";
import {
  BUILTIN_COVER_TEMPLATE_ID,
  coverTemplateSpecSchema,
  coverTemplateUploadSchema,
  type CoverFormat,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { requireElevation } from "../lib/stepUp.js";
import { coverTemplatesUpload, uploadsDir } from "../upload.js";
import { logAudit } from "../lib/audit.js";
import { logSystemError } from "../lib/systemError.js";
import {
  coverFormatSize,
  coverTemplateFilename,
  listCoverTemplates,
  sanitizeTemplateSvg,
  toCoverTemplateSummary,
  type CoverTemplateSettings,
} from "../lib/video/coverRegistry.js";
import { buildCoverPosterValues, renderCoverPosterImage } from "../lib/video/coverPoster.js";

export const coverTemplatesRouter = Router();

const COVER_TEMPLATE_SETTINGS_SELECT = {
  coverTemplateMode: true,
  coverTemplateId: true,
  coverTemplateEnabledIds: true,
} as const;

async function loadCoverSettings(): Promise<CoverTemplateSettings> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: COVER_TEMPLATE_SETTINGS_SELECT });
  return {
    coverTemplateMode: settings?.coverTemplateMode ?? "FIXED",
    coverTemplateId: settings?.coverTemplateId ?? null,
    coverTemplateEnabledIds: settings?.coverTemplateEnabledIds ?? [],
  };
}

/** Список шаблонов для Настроек: встроенный + свои, с признаком «участвует». */
coverTemplatesRouter.get("/", requireAuth, requirePermission("settings.manage"), async (_req, res) => {
  const [templates, settings] = await Promise.all([listCoverTemplates(), loadCoverSettings()]);
  res.json({
    mode: settings.coverTemplateMode,
    selectedId: settings.coverTemplateId ?? BUILTIN_COVER_TEMPLATE_ID,
    templates: templates.map((t) => toCoverTemplateSummary(t, settings)),
  });
});

/**
 * Предпросмотр шаблона — та же отрисовка, что на публикации, но по выдуманному
 * объекту и на ровной подложке вместо фото: список в Настройках должен
 * показывать сам шаблон, а не случайную квартиру.
 */
coverTemplatesRouter.get("/:id/preview.jpg", requireAuth, requirePermission("settings.manage"), async (req, res) => {
  const format: CoverFormat = req.query.format === "story" ? "story" : "square";
  const { width, height } = coverFormatSize(format);
  const templates = await listCoverTemplates();
  const template = templates.find((t) => t.id === req.params.id);
  if (!template) return res.status(404).json({ error: "Шаблон не найден" });

  const values = buildCoverPosterValues(
    { rooms: 2, areaSqm: 90, floor: 15, price: 890000, currency: "TJS", districtName: "Сино", address: "Парк Победы" },
    { usdToTjs: 10.9 }
  );
  try {
    const backdrop = await sharp({
      create: { width, height, channels: 3, background: { r: 38, g: 48, b: 42 } },
    })
      .jpeg()
      .toBuffer();
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { companyLogoUrl: true } });
    const logoPath = settings?.companyLogoUrl ? path.join(uploadsDir, path.basename(settings.companyLogoUrl)) : null;
    const image = await renderCoverPosterImage(backdrop, values, format, logoPath, true, template);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.send(image);
  } catch (err) {
    const message = err instanceof Error ? err.message : "неизвестный сбой";
    void logSystemError("storage", `Предпросмотр шаблона обложки ${template.id} не нарисовался — ${message}`, {
      dedupKey: `cover-template-preview-fail:${template.id}`,
    });
    return res.status(500).json({ error: "Не удалось нарисовать предпросмотр" });
  }
});

/** Загрузка своего шаблона: SVG + spec.json, необязательные листья и знак. */
coverTemplatesRouter.post(
  "/",
  requireAuth,
  requirePermission("settings.manage"),
  requireElevation,
  coverTemplatesUpload.fields([
    { name: "svg", maxCount: 1 },
    { name: "spec", maxCount: 1 },
    { name: "leaves", maxCount: 1 },
    { name: "logo", maxCount: 1 },
  ]),
  async (req, res) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const svgFile = files?.svg?.[0];
    const specFile = files?.spec?.[0];
    if (!svgFile || !specFile) return res.status(400).json({ error: "Нужны оба файла: SVG-слой и spec.json" });

    const name = coverTemplateUploadSchema.safeParse({ name: req.body?.name });
    if (!name.success) return res.status(400).json({ error: name.error.issues[0]?.message ?? "Название не подходит" });

    let specJson: unknown;
    try {
      specJson = JSON.parse(specFile.buffer.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "spec.json не читается как JSON" });
    }
    const spec = coverTemplateSpecSchema.safeParse(specJson);
    if (!spec.success) {
      const issue = spec.error.issues[0];
      return res.status(400).json({ error: `spec.json не подходит: ${issue?.path.join(".")} — ${issue?.message}` });
    }

    const clean = sanitizeTemplateSvg(svgFile.buffer.toString("utf8"));
    if (!clean.ok) return res.status(400).json({ error: clean.error });

    const dir = path.join(uploadsDir, "cover-templates");
    await fs.mkdir(dir, { recursive: true });
    const svgName = coverTemplateFilename("svg");
    await fs.writeFile(path.join(dir, svgName), clean.svg, "utf8");

    const writeImage = async (file: Express.Multer.File | undefined): Promise<string | null> => {
      if (!file) return null;
      const pngName = coverTemplateFilename("png");
      await sharp(file.buffer).png().toFile(path.join(dir, pngName));
      return `/uploads/cover-templates/${pngName}`;
    };

    try {
      const [leavesUrl, logoUrl] = await Promise.all([writeImage(files?.leaves?.[0]), writeImage(files?.logo?.[0])]);
      // Строка шаблона и его включение в выбор — одной транзакцией: шаблон,
      // которого нет в списке «участвует», владелец считает не загрузившимся.
      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.coverTemplate.create({
          data: {
            name: name.data.name,
            svgUrl: `/uploads/cover-templates/${svgName}`,
            spec: spec.data as object,
            leavesUrl,
            logoUrl,
            createdBy: req.agent?.id ?? null,
          },
        });
        const current = await tx.settings.findUnique({ where: { id: "singleton" }, select: COVER_TEMPLATE_SETTINGS_SELECT });
        const enabled = new Set(current?.coverTemplateEnabledIds ?? []);
        if (enabled.size === 0) enabled.add(BUILTIN_COVER_TEMPLATE_ID);
        enabled.add(row.id);
        await tx.settings.update({ where: { id: "singleton" }, data: { coverTemplateEnabledIds: [...enabled] } });
        return row;
      });
      logAudit(req, "COVER_TEMPLATE_CREATE", "CoverTemplate", created.id, { name: created.name });
      const settings = await loadCoverSettings();
      const templates = await listCoverTemplates();
      const summary = templates.find((t) => t.id === created.id);
      return res.status(201).json(summary ? toCoverTemplateSummary(summary, settings) : { id: created.id, name: created.name });
    } catch (err) {
      // SVG уже лежит на диске — без строки в базе он сирота, убираем.
      await fs.rm(path.join(dir, svgName), { force: true }).catch(() => {});
      const message = err instanceof Error ? err.message : "неизвестный сбой";
      void logSystemError("storage", `Шаблон обложки не сохранился — ${message}`, { dedupKey: "cover-template-create-fail" });
      return res.status(500).json({ error: "Не удалось сохранить шаблон" });
    }
  }
);

/** Удаление своего шаблона. Встроенный не удаляется. */
coverTemplatesRouter.delete("/:id", requireAuth, requirePermission("settings.manage"), requireElevation, async (req, res) => {
  const id = req.params.id;
  if (id === BUILTIN_COVER_TEMPLATE_ID) return res.status(400).json({ error: "Встроенный шаблон удалить нельзя" });
  const row = await prisma.coverTemplate.findUnique({ where: { id } });
  if (!row) return res.status(404).json({ error: "Шаблон не найден" });

  // Удаление строки и вычистка её из настроек — одной транзакцией, иначе в
  // Настройках останется выбранным шаблон, которого больше нет, и публикация
  // будет молча падать на встроенный вместо явного «выбран встроенный».
  await prisma.$transaction(async (tx) => {
    await tx.coverTemplate.delete({ where: { id } });
    const current = await tx.settings.findUnique({ where: { id: "singleton" }, select: COVER_TEMPLATE_SETTINGS_SELECT });
    const enabled = (current?.coverTemplateEnabledIds ?? []).filter((x) => x !== id);
    await tx.settings.update({
      where: { id: "singleton" },
      data: {
        coverTemplateEnabledIds: enabled,
        coverTemplateId: current?.coverTemplateId === id ? BUILTIN_COVER_TEMPLATE_ID : current?.coverTemplateId ?? null,
      },
    });
  });

  for (const url of [row.svgUrl, row.leavesUrl, row.logoUrl]) {
    if (!url) continue;
    await fs.rm(path.join(uploadsDir, "cover-templates", path.basename(url)), { force: true }).catch(() => {});
  }
  logAudit(req, "COVER_TEMPLATE_DELETE", "CoverTemplate", id, { name: row.name });
  return res.json({ ok: true });
});

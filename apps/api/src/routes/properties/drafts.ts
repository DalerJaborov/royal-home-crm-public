/**
 * ЧЕРНОВИК НОВОГО ОБЪЕКТА (11.09.2026, просьба владельца «черновик сделай» +
 * «прогресс фото и видео чтобы сразу всё было видно»).
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ СУЩНОСТЬ, А НЕ «ОБЪЕКТ В СТАТУСЕ ЧЕРНОВИК». Статуса «черновик»
 * в системе нет: PropertyStatus начинается с PENDING_REVIEW — это уже конвейер
 * подготовки с проверкой Маркетингом. Колонки districtId/address/areaSqm/price у
 * Property NOT NULL, так что «минимальный объект» физически не создаётся. А
 * брошенный на середине черновик, будь он объектом, повис бы настоящей карточкой
 * в конвейере — ровно тот класс «осиротевших спутников», за которым в этом
 * репозитории уже охотились отдельной сессией. Поэтому черновик — своя таблица,
 * невидимая ни каталогу, ни конвейеру, ни лимиту активных объектов агента.
 *
 * ЗАЧЕМ ФАЙЛЫ УХОДЯТ СРАЗУ, А НЕ ПОСЛЕ «СОХРАНИТЬ». Агент снимает двадцать-тридцать
 * кадров и обход квартиры — это десятки мегабайт по мобильному интернету. Пока он
 * заполняет оставшиеся четыре шага, канал простаивал впустую, а вся отдача
 * начиналась в момент, когда он уже собрался уходить. Теперь снимок уходит в тот
 * же миг, когда его выбрали, и агент видит полосу прогресса по каждому файлу.
 *
 * ПОЧЕМУ «ПЕРЕЕЗД» В КАРТОЧКУ НЕ ДВИГАЕТ НИ ОДНОГО БАЙТА. Снимок обрабатывается
 * тем же конвейером sharp и ложится в ту же папку uploads под тем же именем
 * `<uuid>.webp`, что и фото карточки; ролик пишется в то же закрытое хранилище
 * (lib/localVideoStorage.ts) ключом `<id черновика>/<uuid>.<ext>` — формат ключа
 * тот же двухуровневый. При сохранении объекта создаются строки PropertyPhoto и
 * PropertyVideo с уже готовыми путями, а строки черновика удаляются.
 */
import express, { Router } from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma, PropertyDraftMedia } from "../../generated/prisma/client.js";
import {
  PROPERTY_DRAFT_TTL_DAYS,
  propertyDraftSaveSchema,
  propertyDraftVideoSessionSchema,
  UPLOAD_VIDEO_MAX_BYTES,
  VIDEO_TOO_LARGE_CODE,
  videoTooLargeMessage,
  type PropertyDraftMediaView,
  type PropertyDraftView,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import { requireAuth, canAccessAssignedAgent, scopeToOwnAgent } from "../../auth/middleware.js";
import { draftPhotoUpload, uploadsDir, thumbsDir } from "../../upload.js";
import {
  abortLocalUploadSession,
  completeLocalUploadSession,
  createLocalUploadSession,
  localVideoDelete,
  writeLocalUploadPart,
} from "../../lib/localVideoStorage.js";
import { logSystemError } from "../../lib/systemError.js";
import { matchesUniqueConstraint } from "../../lib/prismaUniqueConflict.js";
import { DRAFT_MEDIA_ORDER, parseUploadKeys } from "./shared.js";
import { UNSUPPORTED_VIDEO_MESSAGE, videoExtensionOf } from "../../lib/videoFileExtension.js";
import { discardDraft, removePhotoFiles } from "./draftAttach.js";
import { isHeic, sharpFromUpload } from "../../lib/heicInput.js";
import { copySellerAttachmentsToDraft, listSellerAttachments, sellerCardToDraftValues, sellerFactsToDraftValues } from "../../lib/sellerMedia.js";
// Настоящая функция агента ФАКТОВ — появилась в дереве в ходе этой же сессии
// (см. отчёт агента МЕДИА о временной заглушке, которая жила здесь до этого).
import { getSellerObjectFacts } from "../../lib/sellerFacts.js";
import { memoryUploadBudget } from "../../lib/memoryUploadBudget.js";

export const draftsRouter = Router();

/** Тот же план частей, что у видео объекта (routes/properties/videos.ts): 8 МБ —
 *  компромисс между числом запросов и ценой повтора одной части при обрыве. */
const VIDEO_PART_SIZE = 8 * 1024 * 1024;
const MAX_UPLOAD_PARTS = 10_000;
/** Потолок на файлы одного черновика — чтобы брошенный черновик не мог съесть диск.
 *  Числа те же, что действуют у карточки объекта (30 фото за запрос, до 30 видео). */
const MAX_DRAFT_PHOTOS = 60;
const MAX_DRAFT_VIDEOS = 10;
/**
 * ПРЕДЕЛ РОЛИКА — ЕДИНЫЙ, `UPLOAD_VIDEO_MAX_BYTES` из packages/shared (07.10.2026,
 * решение владельца «лимит до максимума»; до этого здесь было 700 МБ, а подсказка
 * мастера обещала другое — агент с роликом в 746 МБ получил отказ до первого
 * байта). Мастер грузит ролик НЕ целиком в память: части по 8 МБ ложатся на диск
 * (memoryStorage здесь нет), поэтому потолок — тот же, что у сессий карточки
 * объекта, а не ёмкость оперативной памяти. Эта проверка — последняя линия
 * обороны: экран выбора файла отсеивает тяжёлые ролики раньше (media.ts).
 */

function computePartPlan(sizeBytes: number): { partSize: number; totalParts: number } {
  let partSize = VIDEO_PART_SIZE;
  let totalParts = Math.max(1, Math.ceil(sizeBytes / partSize));
  if (totalParts > MAX_UPLOAD_PARTS) {
    partSize = Math.ceil(sizeBytes / MAX_UPLOAD_PARTS);
    totalParts = Math.ceil(sizeBytes / partSize);
  }
  return { partSize, totalParts };
}

function uploadedParts(parts: Prisma.JsonValue): number[] {
  if (!Array.isArray(parts)) return [];
  return parts
    .map((p) =>
      p && typeof p === "object" && "partNumber" in p ? Number((p as { partNumber: unknown }).partNumber) : null
    )
    .filter((n): n is number => n !== null && Number.isInteger(n))
    .sort((a, b) => a - b);
}

export function presentDraftMedia(m: PropertyDraftMedia): PropertyDraftMediaView {
  return {
    id: m.id,
    kind: m.kind,
    status: m.status,
    uploadKey: m.uploadKey,
    filename: m.filename,
    contentType: m.contentType,
    sizeBytes: m.sizeBytes,
    order: m.order,
    url: m.url,
    thumbUrl: m.thumbUrl,
  };
}

function presentDraft(draft: {
  id: string;
  values: Prisma.JsonValue;
  step: number;
  updatedAt: Date;
  expiresAt: Date;
  media: PropertyDraftMedia[];
}): PropertyDraftView {
  return {
    id: draft.id,
    // Значения читаются из JSONB: то, что туда клали, уже прошло Zod на записи, но
    // черновик мог быть записан прошлой сборкой — отдаём как есть, вкладка
    // раскладывает знакомые поля поверх пустого набора.
    values: (draft.values && typeof draft.values === "object" && !Array.isArray(draft.values)
      ? draft.values
      : {}) as PropertyDraftView["values"],
    step: draft.step,
    updatedAt: draft.updatedAt.toISOString(),
    expiresAt: draft.expiresAt.toISOString(),
    media: draft.media.map(presentDraftMedia),
  };
}

function expiryFromNow(): Date {
  return new Date(Date.now() + PROPERTY_DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Черновик текущего агента. Просроченный не отдаём и удаляем на месте: ждать
 * ночной уборки, чтобы перестать предлагать неделю назад брошенную квартиру,
 * незачем — та же логика, что у срока жизни черновика формы в браузере.
 */
async function loadOwnDraft(agentId: string) {
  const draft = await prisma.propertyDraft.findUnique({
    where: { agentId },
    include: { media: { orderBy: DRAFT_MEDIA_ORDER } },
  });
  if (!draft) return null;
  if (draft.expiresAt.getTime() <= Date.now()) {
    await discardDraft(draft.id);
    return null;
  }
  return draft;
}

draftsRouter.get("/drafts/current", requireAuth, async (req, res) => {
  const draft = await loadOwnDraft(req.agent!.id);
  res.json({ draft: draft ? presentDraft(draft) : null });
});

/**
 * Автосохранение полей. Вкладка шлёт это каждые несколько секунд, поэтому запрос
 * обязан быть дешёвым и безусловно идемпотентным: один черновик на агента,
 * upsert по agentId, срок жизни отсчитывается заново от последней правки.
 */
draftsRouter.put("/drafts/current", requireAuth, async (req, res) => {
  const parsed = propertyDraftSaveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const { values, step } = parsed.data;
  const draft = await upsertOwnDraft(req.agent!.id, values as Prisma.InputJsonValue, step);
  res.json({ draft: presentDraft(draft) });
});

/**
 * Upsert черновика с одним повтором на гонку (13.09.2026, жалобы Умед 21.09 11:08 UTC,
 * Ноза 17.09 — 500 на POST /drafts/current/photos сразу после автосохранения).
 *
 * `upsert` у Prisma с адаптером `@prisma/adapter-pg` (db.ts) — НЕ атомарный
 * `INSERT ... ON CONFLICT DO UPDATE` одной командой, а `create`, и при конфликте
 * уникального индекса — `update`; между попыткой create и проверкой конфликта есть
 * окно. Вкладка шлёт автосохранение каждые несколько секунд, а первый файл черновика
 * может уйти в ту же секунду — два одновременных запроса от одной вкладки (или от
 * второй открытой вкладки) оба не находят строку и оба идут в create: один
 * выигрывает, второй получает P2002 по `PropertyDraft_agentId_key`. Строка уже
 * существует — второй раз upsert гарантированно попадёт в ветку update, повтор без
 * задержки и без ретрай-цикла: гонка разрешается за один лишний круг.
 */
async function upsertOwnDraft(agentId: string, values: Prisma.InputJsonValue, step: number) {
  const run = () =>
    prisma.propertyDraft.upsert({
      where: { agentId },
      create: { agentId, values, step, expiresAt: expiryFromNow() },
      update: { values, step, expiresAt: expiryFromNow() },
      include: { media: { orderBy: DRAFT_MEDIA_ORDER } },
    });
  try {
    return await run();
  } catch (err) {
    if (!matchesUniqueConstraint(err, "agentId")) throw err;
    return run();
  }
}

draftsRouter.delete("/drafts/current", requireAuth, async (req, res) => {
  const draft = await prisma.propertyDraft.findUnique({ where: { agentId: req.agent!.id } });
  if (draft) await discardDraft(draft.id);
  res.status(204).end();
});

/**
 * Черновик заводится сам при первой загрузке файла: агент мог начать со съёмки, не
 * тронув ни одного поля (первый шаг мастера — именно фото), и требовать от вкладки
 * лишний запрос «сначала создай черновик» значило бы уронить загрузку на пустом
 * месте при гонке двух параллельных отправок.
 */
async function ensureDraft(agentId: string) {
  const existing = await loadOwnDraft(agentId);
  if (existing) return existing;
  try {
    return await prisma.propertyDraft.create({
      data: { agentId, values: {}, step: 0, expiresAt: expiryFromNow() },
      include: { media: { orderBy: DRAFT_MEDIA_ORDER } },
    });
  } catch (err) {
    /**
     * ГОНКА ПЕРВОГО ФАЙЛА (13.09.2026, прод: Умед 21.09 11:08 UTC, Ноза 17.09).
     *
     * Черновик заводится сам при первом файле (см. докстринг выше), а вкладка
     * параллельно автосохраняет поля через PUT /drafts/current — при пустом
     * черновике оба запроса читают "нет строки" и оба идут в create. Проигравший
     * получает P2002 по `PropertyDraft_agentId_key`, а не 500: строку уже создал
     * выигравший, её и отдаём.
     */
    if (!matchesUniqueConstraint(err, "agentId")) throw err;
    const draft = await loadOwnDraft(agentId);
    if (draft) return draft;
    // Крайне маловероятно (строка создана долей секунды назад и уже успела
    // просрочиться/удалиться) — пробрасываем исходную ошибку, а не проглатываем её.
    throw err;
  }
}

/**
 * СНИМКИ В ЧЕРНОВИК. Тот же конвейер sharp и та же защита ключом повторной
 * отправки, что и у фото карточки (routes/properties/photos.ts): обрыв связи
 * ПОСЛЕ записи, но ДО того, как ответ дошёл до телефона, не должен задваивать
 * пачку.
 */
draftsRouter.post("/drafts/current/photos", requireAuth, memoryUploadBudget, draftPhotoUpload.array("photos", 5), async (req, res) => {
  const draft = await ensureDraft(req.agent!.id);
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (files.length === 0) return res.status(400).json({ error: "Не пришло ни одного файла" });

  const parsedKeys = parseUploadKeys(req.body?.uploadKeys, files.length);
  if (!parsedKeys.ok) return res.status(400).json({ error: parsedKeys.error });
  const uploadKeys = parsedKeys.keys;

  const alreadyStored = uploadKeys?.length
    ? await prisma.propertyDraftMedia.findMany({ where: { uploadKey: { in: uploadKeys } } })
    : [];
  const foreign = alreadyStored.find((m) => m.draftId !== draft.id);
  if (foreign) return res.status(409).json({ error: "Ключ загрузки уже использован" });
  const storedByKey = new Map(alreadyStored.map((m) => [m.uploadKey, m]));

  const currentCount = await prisma.propertyDraftMedia.count({
    where: { draftId: draft.id, kind: "PHOTO" },
  });
  const toCreate = files.length - alreadyStored.filter((m) => m.kind === "PHOTO").length;
  if (currentCount + toCreate > MAX_DRAFT_PHOTOS) {
    return res.status(400).json({ error: `В черновик помещается ${MAX_DRAFT_PHOTOS} снимков, сейчас уже ${currentCount}` });
  }

  const stored: PropertyDraftMedia[] = [];
  let created = 0;
  for (let i = 0; i < files.length; i++) {
    const uploadKey = uploadKeys?.[i] ?? randomUUID();
    const known = storedByKey.get(uploadKey);
    if (known) {
      stored.push(known);
      continue;
    }
    const file = files[i];
    const filename = `${randomUUID()}.webp`;
    try {
      // Один декод на полную версию и миниатюру — тот же приём и тот же довод,
      // что и у фото карточки объекта (routes/properties/photos.ts, тот же аудит
      // памяти 21.09.2026): sharp(buf).clone() decode один раз, .rotate() — по
      // EXIF-ориентации (webp-вывод не хранит метаданные сам). 2560px по длинной
      // стороне — тот же потолок, что у карточки, на случай формата (HEIC и
      // т.п.), который клиентское сжатие не берёт и шлёт оригиналом.
      // HEIC с iPhone sharp сам не читает — разбор в lib/heicInput.ts.
      const pipeline = (await sharpFromUpload(file.buffer)).rotate();
      await pipeline
        .clone()
        .resize(2560, 2560, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(path.join(uploadsDir, filename));
      await pipeline
        .clone()
        .resize(800, undefined, { withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(path.join(thumbsDir, filename));
    } catch (err) {
      void logSystemError(
        "storage",
        `Не удалось обработать снимок черновика: ${err instanceof Error ? err.message : String(err)}`
      );
      return res.status(502).json({ error: "Не удалось сохранить снимок — попробуйте ещё раз" });
    }
    const media = await prisma.propertyDraftMedia.create({
      data: {
        draftId: draft.id,
        kind: "PHOTO",
        status: "READY",
        uploadKey,
        filename: file.originalname.slice(0, 255) || filename,
        contentType: file.mimetype || (isHeic(file.buffer) ? "image/heic" : "application/octet-stream"),
        sizeBytes: file.size,
        // По числу СОЗДАННЫХ, а не по индексу файла: при повторе часть пачки уже
        // лежит в базе, и индекс оставлял бы дыры в порядке.
        order: currentCount + created,
        url: `/uploads/${filename}`,
        thumbUrl: `/uploads/thumbs/${filename}`,
      },
    });
    created++;
    stored.push(media);
  }

  await touchDraft(draft.id);
  res.status(201).json(stored.map(presentDraftMedia));
});

/**
 * РОЛИК В ЧЕРНОВИК — тремя шагами, тем же протоколом докачки частями, что и у
 * видео объекта: сессия → части → сборка. Ролик обхода квартиры весит сотни
 * мегабайт, и на мобильном интернете «начать заново после обрыва» означает не
 * отправить его никогда. Состояние докачки хранится в самой строке
 * PropertyDraftMedia — заводить второй VideoUploadSession ради черновика значило
 * бы делать колонку propertyId необязательной у таблицы, где она смысловая.
 */
draftsRouter.post("/drafts/current/videos/sessions", requireAuth, async (req, res) => {
  const parsed = propertyDraftVideoSessionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  const { uploadKey, filename, sizeBytes, contentType } = parsed.data;
  if (!contentType.startsWith("video/")) return res.status(400).json({ error: "Допустимо только видео" });
  // Расширение — из белого списка, до начала загрузки (D15, 02.10.2026): раньше
  // брали из имени файла как есть, и «.html»/«.svg» ложился в хранилище и
  // переезжал в карточку объекта.
  const ext = videoExtensionOf(filename);
  if (!ext) return res.status(400).json({ error: `Файл «${filename}»: ${UNSUPPORTED_VIDEO_MESSAGE}` });
  if (sizeBytes > UPLOAD_VIDEO_MAX_BYTES) {
    return res.status(400).json({
      error: videoTooLargeMessage(filename),
      code: VIDEO_TOO_LARGE_CODE,
      limitBytes: UPLOAD_VIDEO_MAX_BYTES,
    });
  }

  const draft = await ensureDraft(req.agent!.id);

  const existing = await prisma.propertyDraftMedia.findUnique({ where: { uploadKey } });
  if (existing) {
    if (existing.draftId !== draft.id) return res.status(409).json({ error: "Ключ загрузки уже использован" });
    if (existing.status === "READY") {
      return res.json({ status: "done", media: presentDraftMedia(existing) });
    }
    return res.json({
      status: "in-progress",
      mediaId: existing.id,
      partSize: existing.partSize,
      totalParts: existing.totalParts,
      uploadedPartNumbers: uploadedParts(existing.parts),
    });
  }

  /**
   * ТОТ ЖЕ ФАЙЛ ВТОРОЙ РАЗ — НЕ ВТОРОЙ РОЛИК (19.09.2026).
   *
   * uploadKey придумывает клиент, и при повторном выборе того же файла в
   * мастере он НОВЫЙ — значит проверка выше его не ловит. Объект №111 уехал
   * монтажёру как «Ролик 1 из 2» и «Ролик 2 из 2», где обоими роликами был один
   * и тот же IMG_8354.mov: две строки, две копии на диске, и монтажёр ищет
   * разницу между одинаковыми файлами там, где её нет. Имя плюс размер байт в
   * байт внутри ОДНОГО черновика — это один и тот же файл: два разных ролика
   * обхода квартиры не совпадают по размеру до байта.
   */
  const sameFile = await prisma.propertyDraftMedia.findFirst({
    where: { draftId: draft.id, kind: "VIDEO", filename: filename.slice(0, 255), sizeBytes },
    orderBy: { createdAt: "asc" },
  });
  if (sameFile) {
    if (sameFile.status === "READY") return res.json({ status: "done", media: presentDraftMedia(sameFile) });
    // Недокачанный — продолжаем В ТУ ЖЕ строку, а не заводим соседнюю: это как
    // раз обычный повтор после обрыва связи, ради которого докачка и сделана.
    return res.json({
      status: "in-progress",
      mediaId: sameFile.id,
      partSize: sameFile.partSize,
      totalParts: sameFile.totalParts,
      uploadedPartNumbers: uploadedParts(sameFile.parts),
    });
  }

  const videoCount = await prisma.propertyDraftMedia.count({ where: { draftId: draft.id, kind: "VIDEO" } });
  if (videoCount >= MAX_DRAFT_VIDEOS) {
    return res.status(400).json({ error: `В черновик помещается ${MAX_DRAFT_VIDEOS} роликов` });
  }

  const { partSize, totalParts } = computePartPlan(sizeBytes);
  const storageKey = `${draft.id}/${randomUUID()}${ext}`;
  // Свой id заранее: папка частей на диске заводится ДО записи в базу. Упади сервер
  // между двумя шагами — останется пустая папка без записи (её подберёт уборка по
  // возрасту), а не запись без папки для частей.
  const mediaId = randomUUID();
  try {
    await createLocalUploadSession(mediaId);
  } catch (err) {
    void logSystemError(
      "storage",
      `Не удалось открыть загрузку видео черновика: ${err instanceof Error ? err.message : String(err)}`
    );
    return res.status(502).json({ error: "Не удалось начать загрузку видео — попробуйте ещё раз" });
  }

  const media = await prisma.propertyDraftMedia.create({
    data: {
      id: mediaId,
      draftId: draft.id,
      kind: "VIDEO",
      status: "UPLOADING",
      uploadKey,
      filename: filename.slice(0, 255),
      contentType,
      sizeBytes,
      order: videoCount,
      storageKey,
      partSize,
      totalParts,
      parts: [],
    },
  });
  await touchDraft(draft.id);
  res.status(201).json({ status: "started", mediaId: media.id, partSize, totalParts, uploadedPartNumbers: [] });
});

const partParamsSchema = z.object({
  mediaId: z.guid(),
  partNumber: z.coerce.number().int().min(1).max(MAX_UPLOAD_PARTS),
});

draftsRouter.put(
  "/drafts/current/videos/:mediaId/parts/:partNumber",
  requireAuth,
  // Часть приходит сырыми байтами, а не формой: multipart вокруг восьми мегабайт —
  // лишняя обёртка и лишняя копия в памяти. Тот же приём, что у видео объекта.
  (req, res, next) => {
    req.headers["content-type"] = "application/octet-stream";
    next();
  },
  express.raw({ type: () => true, limit: "32mb" }),
  async (req, res) => {
    const parsedParams = partParamsSchema.safeParse(req.params);
    if (!parsedParams.success) return res.status(400).json({ error: "Неверные данные" });
    const { mediaId, partNumber } = parsedParams.data;

    const media = await prisma.propertyDraftMedia.findUnique({
      where: { id: mediaId },
      include: { draft: { select: { agentId: true } } },
    });
    if (!media || media.kind !== "VIDEO") return res.status(404).json({ error: "Загрузка не найдена" });
    if (media.draft.agentId !== req.agent!.id) return res.status(403).json({ error: "Недостаточно прав" });
    if (media.status === "READY") return res.status(409).json({ error: "Файл уже собран" });
    if (!media.totalParts || partNumber > media.totalParts) {
      return res.status(400).json({ error: "Номер части вне плана загрузки" });
    }

    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: "Пустая часть" });

    try {
      await writeLocalUploadPart(mediaId, partNumber, body);
    } catch (err) {
      void logSystemError(
        "storage",
        `Не удалось записать часть видео черновика: ${err instanceof Error ? err.message : String(err)}`
      );
      return res.status(502).json({ error: "Часть не записалась — попробуйте ещё раз" });
    }

    // Повтор той же части перезаписывает файл и не должен плодить дубли в списке.
    const known = new Set(uploadedParts(media.parts));
    known.add(partNumber);
    const next = [...known].sort((a, b) => a - b).map((partNumber) => ({ partNumber }));
    await prisma.propertyDraftMedia.update({ where: { id: mediaId }, data: { parts: next } });
    await touchDraft(media.draftId);
    res.json({ uploadedPartNumbers: [...known].sort((a, b) => a - b) });
  }
);

draftsRouter.post("/drafts/current/videos/:mediaId/complete", requireAuth, async (req, res) => {
  const parsedId = z.guid().safeParse(req.params.mediaId);
  if (!parsedId.success) return res.status(400).json({ error: "Неверные данные" });

  const media = await prisma.propertyDraftMedia.findUnique({
    where: { id: parsedId.data },
    include: { draft: { select: { agentId: true } } },
  });
  if (!media || media.kind !== "VIDEO") return res.status(404).json({ error: "Загрузка не найдена" });
  if (media.draft.agentId !== req.agent!.id) return res.status(403).json({ error: "Недостаточно прав" });
  if (media.status === "READY") return res.json({ media: presentDraftMedia(media) });
  if (!media.storageKey || !media.totalParts) return res.status(409).json({ error: "Загрузка повреждена" });

  const have = uploadedParts(media.parts);
  if (have.length !== media.totalParts) {
    // 409, а не 400: части действительно не все, и клиенту надо дослать недостающие,
    // а не считать файл испорченным. Очередь на вкладке повторяет круг.
    return res.status(409).json({
      error: "Пришли не все части",
      uploadedPartNumbers: have,
      totalParts: media.totalParts,
    });
  }

  try {
    await completeLocalUploadSession(media.id, media.storageKey, media.totalParts);
  } catch (err) {
    void logSystemError(
      "storage",
      `Не удалось собрать видео черновика: ${err instanceof Error ? err.message : String(err)}`
    );
    return res.status(502).json({ error: "Не удалось собрать видео — попробуйте ещё раз" });
  }

  const ready = await prisma.propertyDraftMedia.update({
    where: { id: media.id },
    data: { status: "READY" },
  });
  await touchDraft(media.draftId);
  res.json({ media: presentDraftMedia(ready) });
});

/** Отмена загрузки и удаление файла черновика — одной кнопкой на плитке. */
draftsRouter.delete("/drafts/current/media/:mediaId", requireAuth, async (req, res) => {
  const parsedId = z.guid().safeParse(req.params.mediaId);
  if (!parsedId.success) return res.status(400).json({ error: "Неверные данные" });

  const media = await prisma.propertyDraftMedia.findUnique({
    where: { id: parsedId.data },
    include: { draft: { select: { agentId: true } } },
  });
  // Уже удалён — отвечаем успехом: вкладка повторяет отмену после обрыва связи, и
  // 404 на второй попытке выглядел бы как «не удалось убрать», хотя файла уже нет.
  if (!media) return res.status(204).end();
  if (media.draft.agentId !== req.agent!.id) return res.status(403).json({ error: "Недостаточно прав" });

  await prisma.propertyDraftMedia.delete({ where: { id: media.id } });
  if (media.kind === "PHOTO") {
    await removePhotoFiles(media.url, media.thumbUrl);
  } else {
    // Недособранная сессия оставляет за собой папку частей — её убираем отдельно,
    // готовый файл (если сборка уже прошла) удаляем из хранилища.
    await abortLocalUploadSession(media.id).catch(() => undefined);
    if (media.storageKey && media.status === "READY") await localVideoDelete(media.storageKey);
  }
  await touchDraft(media.draftId);
  res.status(204).end();
});

/** Любое движение по файлам продлевает срок жизни черновика — агент им пользуется. */
async function touchDraft(draftId: string): Promise<void> {
  await prisma.propertyDraft
    .update({ where: { id: draftId }, data: { expiresAt: expiryFromNow() } })
    .catch(() => undefined);
}

/**
 * ЧЕРНОВИК ИЗ ПЕРЕПИСКИ ПРОДАВЦА (21.09.2026, «Объект продавца заполняется сам» —
 * agent-brief.md, задание МЕДИА).
 *
 * Кнопка «Добавить объект» в карточке чата продавца: одним нажатием заводит (или
 * ПЕРЕЗАПИСЫВАЕТ, если у агента уже был свой черновик) черновик мастера значениями,
 * которые ИИ уже накопил по переписке и звонкам (SellerObjectFacts, фоновый разбор
 * агента ФАКТОВ), и копиями фото/видео, которые продавец прислал в чат.
 *
 * ИИ ЗДЕСЬ НЕ ЗОВЁТСЯ ВООБЩЕ (agent-brief.md §1: «ИИ не вызывается при открытии
 * мастера, чата или полосы»). Факты читаются готовыми из БД (getSellerObjectFacts),
 * оценка фото — из кэша ChatPhotoInsight, если фоновое задание уже успело его
 * посчитать; если нет — снимки просто идут в хронологическом порядке, обложка
 * появится на следующий клик, когда оценка досчитается.
 *
 * ФАЙЛЫ АГЕНТА БЕЗ СПРОСА НЕ ЗАМЕНЯЮТСЯ (решение владельца 02.10.2026, «да, по
 * советам», глубокая проверка D14). У агента один черновик на всю CRM (agentId
 * уникален, см. докстринг модели PropertyDraft). Если в нём уже лежат фото/видео,
 * а черновик собирался по ДРУГОМУ продавцу или вовсе без продавца (набран руками,
 * в т.ч. сборкой до появления sellerClientId), — раньше файлы другого продавца
 * удалялись молча, а набранные руками смешивались с фото из переписки. Теперь
 * сервер ничего не трогает и отвечает 409 с кодом DRAFT_MEDIA_REPLACE_CONFIRM и
 * числом файлов — экран спрашивает агента «Заменить N загруженных фото на фото из
 * переписки?», и мастер повторяет запрос с ответом в теле:
 *   - `media: "replace"` — старые файлы удаляются, копируются файлы из переписки;
 *   - `media: "keep"` — файлы агента остаются как есть, фото из переписки НЕ
 *     добавляются (не смешиваем два объекта); поля заполняются как обычно.
 * В переписке файлов нет — заменять нечем: файлы агента остаются, вопроса нет.
 * Повторный вызов на ТОМ ЖЕ продавце (продавец дослал фото уже после первого
 * клика) ничего не удаляет и не спрашивает — copySellerAttachmentsToDraft
 * находит уже скопированное по ключу `chat:<sha256>` и добавляет только новое.
 */
const DRAFT_MEDIA_REPLACE_CONFIRM_CODE = "DRAFT_MEDIA_REPLACE_CONFIRM";
const fromClientBodySchema = z.object({ media: z.enum(["replace", "keep"]).optional() });

draftsRouter.post("/drafts/from-client/:clientId", requireAuth, async (req, res) => {
  const parsedId = z.guid().safeParse(req.params.clientId);
  if (!parsedId.success) return res.status(400).json({ error: "Неверный идентификатор клиента" });
  const parsedBody = fromClientBodySchema.safeParse(req.body ?? {});
  if (!parsedBody.success) return res.status(400).json({ error: "Неверные данные", details: parsedBody.error.flatten() });
  const mediaDecision = parsedBody.data.media;

  const client = await prisma.client.findUnique({
    where: { id: parsedId.data },
    select: {
      id: true,
      kind: true,
      dualIntent: true,
      assignedAgentId: true,
      acceptedAt: true,
      deletedAt: true,
      desiredType: true,
      desiredRooms: true,
      desiredAreaMin: true,
      desiredFloorMin: true,
      desiredFloorMax: true,
      desiredTotalFloors: true,
      desiredDistrictId: true,
      budgetMin: true,
      budgetMax: true,
      currency: true,
      address: true,
    },
  });
  if (!client || client.deletedAt) return res.status(404).json({ error: "Клиент не найден" });
  // Черновик собирается из переписки о ЕГО объекте на продажу — у чистого покупателя
  // этих данных нет и быть не может (тот же довод, что и у POST /ai/property-draft).
  if (client.kind !== "SELLER" && !client.dualIntent) {
    return res.status(400).json({ error: "Черновик из переписки доступен только для продавца" });
  }
  if (!canAccessAssignedAgent(req, client.assignedAgentId)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  // До принятия лида карточка агенту закрыта — тот же гейт, что у card-fill и
  // /ai/property-draft: предлагать заполнение того, что он всё равно не сохранит,
  // смысла нет.
  if (scopeToOwnAgent(req) && !client.acceptedAt) {
    return res.status(403).json({ error: "Сначала примите лид — до принятия карточка закрыта" });
  }

  const agentId = req.agent!.id;
  let draft = await ensureDraft(agentId);

  const [facts, attachments] = await Promise.all([
    getSellerObjectFacts(client.id).catch(() => null),
    listSellerAttachments(client.id).catch((err) => {
      void logSystemError(
        "storage",
        `Не удалось прочитать вложения продавца ${client.id} для черновика: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }),
  ]);

  // Файлы, уже лежащие в черновике, — не этого продавца (другой или никакой).
  // Заменять их можно только с согласия агента, см. шапку маршрута.
  const previousSellerClientId = draftSellerClientId(draft.values);
  const foreignMedia = draft.media.length > 0 && previousSellerClientId !== client.id;
  let copyChatMedia = true;
  if (foreignMedia && attachments.length > 0) {
    if (!mediaDecision) {
      const draftPhotoCount = draft.media.filter((m) => m.kind === "PHOTO").length;
      return res.status(409).json({
        error: "В черновике уже есть ваши фото — заменить их фото из переписки?",
        code: DRAFT_MEDIA_REPLACE_CONFIRM_CODE,
        draftPhotoCount,
        draftVideoCount: draft.media.length - draftPhotoCount,
      });
    }
    if (mediaDecision === "replace") {
      await wipeDraftMedia(draft.media);
      draft = await ensureDraft(agentId);
    } else {
      copyChatMedia = false;
    }
  }

  if (copyChatMedia) {
    await copySellerAttachmentsToDraft(draft.id, attachments, {
      maxPhotos: MAX_DRAFT_PHOTOS,
      maxVideos: MAX_DRAFT_VIDEOS,
    });
  }

  const updated = await prisma.propertyDraft.update({
    where: { id: draft.id },
    data: {
      // Переписка точнее карточки и побеждает; карточка закрывает то, о чём
      // продавец не писал (или у заведённого руками переписки нет вовсе).
      values: {
        ...sellerCardToDraftValues(client),
        ...(sellerFactsToDraftValues(facts, client.id) as Record<string, unknown>),
      } as Prisma.InputJsonValue,
      step: 0,
      expiresAt: expiryFromNow(),
    },
    include: { media: { orderBy: DRAFT_MEDIA_ORDER } },
  });

  res.json({ draft: presentDraft(updated) });
});

/** `values.sellerClientId`, записанный прошлым вызовом этого маршрута или самим
 *  агентом на шаге «Продавец» — null у пустого черновика и у значений, записанных
 *  сборкой до появления этого поля. */
function draftSellerClientId(values: Prisma.JsonValue): string | null {
  if (!values || typeof values !== "object" || Array.isArray(values)) return null;
  const raw = (values as Record<string, unknown>).sellerClientId;
  return typeof raw === "string" && raw ? raw : null;
}

/** Удаляет строки медиа черновика вместе с файлами на диске, саму строку
 *  PropertyDraft не трогает — в отличие от discardDraft (draftAttach.ts), которая
 *  удаляет весь черновик целиком. Здесь черновик остаётся (агент продолжает вести
 *  ЕГО, просто по-другому продавцу), уходят только файлы прежнего объекта. */
async function wipeDraftMedia(media: PropertyDraftMedia[]): Promise<void> {
  if (media.length === 0) return;
  await prisma.propertyDraftMedia.deleteMany({ where: { id: { in: media.map((m) => m.id) } } });
  for (const m of media) {
    if (m.kind === "PHOTO") {
      await removePhotoFiles(m.url, m.thumbUrl);
    } else {
      await abortLocalUploadSession(m.id).catch(() => undefined);
      if (m.storageKey && m.status === "READY") await localVideoDelete(m.storageKey);
    }
  }
}

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
import express, { Router, type ErrorRequestHandler, type Response } from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma, PropertyDraftMedia } from "../../generated/prisma/client.js";
import {
  PROPERTY_DRAFT_TTL_DAYS,
  propertyDraftSaveSchema,
  propertyDraftStartSchema,
  propertyDraftDeleteSchema,
  propertyDraftVideoSessionSchema,
  UPLOAD_VIDEO_MAX_BYTES,
  VIDEO_TOO_LARGE_CODE,
  videoTooLargeMessage,
  type PropertyDraftMediaView,
  type PropertyDraftView,
} from "@royal-home/shared";
import { prisma, type TxClient } from "../../db.js";
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
import { DRAFT_MEDIA_ORDER, parseUploadKeys } from "./shared.js";
import { UNSUPPORTED_VIDEO_MESSAGE, videoExtensionOf } from "../../lib/videoFileExtension.js";
import { discardDraft, removePhotoFiles } from "./draftAttach.js";
import { isHeic, sharpFromUpload } from "../../lib/heicInput.js";
import { copySellerAttachmentsToDraft, listSellerAttachments, sellerCardToDraftValues, sellerFactsToDraftValues } from "../../lib/sellerMedia.js";
// Настоящая функция агента ФАКТОВ — появилась в дереве в ходе этой же сессии
// (см. отчёт агента МЕДИА о временной заглушке, которая жила здесь до этого).
import { getSellerObjectFacts } from "../../lib/sellerFacts.js";
import { memoryUploadBudget } from "../../lib/memoryUploadBudget.js";
import { DRAFT_INCLUDE, DraftConflictError, assertActiveDraft, checkDraftReference, closeDraftRows, presentDraftSnapshot, withDraftLock } from "./draftLifecycle.js";

export const draftsRouter = Router();

/** Never acknowledge durable media writes before the transaction has committed. */
function deferredDraftReply(response: Response) {
  let status = 200;
  let body: unknown;
  return {
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
    flush() { response.status(status).json(body); },
  };
}

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
  revision: number;
  values: Prisma.JsonValue;
  step: number;
  updatedAt: Date;
  expiresAt: Date;
  media: PropertyDraftMedia[];
}): PropertyDraftView {
  return {
    id: draft.id,
    revision: draft.revision,
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
  if (!draft || draft.closedAt) return null;
  if (draft.expiresAt.getTime() <= Date.now()) {
    await discardDraft(draft.id, { expiredAt: new Date() });
    const current = await prisma.propertyDraft.findUnique({ where: { agentId }, include: DRAFT_INCLUDE });
    return current && !current.closedAt ? current : null;
  }
  return draft;
}

draftsRouter.get("/drafts/current", requireAuth, async (req, res) => {
  const draft = await loadOwnDraft(req.agent!.id);
  const revision = draft?.revision ?? (await prisma.propertyDraft.findUnique({ where: { agentId: req.agent!.id }, select: { revision: true } }))?.revision ?? 0;
  res.json({ draft: draft ? presentDraft(draft) : null, revision });
});

draftsRouter.post("/drafts/current/start", requireAuth, async (req, res) => {
  const parsed = propertyDraftStartSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  const { sessionId, revision } = parsed.data;
  const draft = await withDraftLock(req.agent!.id, async (tx) => {
    const current = await tx.propertyDraft.findUnique({ where: { agentId: req.agent!.id }, include: DRAFT_INCLUDE });
    if (current && !current.closedAt && current.id === sessionId) return current;
    if ((current && !current.closedAt) || current?.id === sessionId || (current?.revision ?? 0) !== revision) throw new DraftConflictError(current);
    const data = { id: sessionId, values: {}, step: 0, closedAt: null, expiresAt: expiryFromNow(), revision: revision + 1 };
    return current ? tx.propertyDraft.update({ where: { id: current.id }, data, include: DRAFT_INCLUDE }) :
      tx.propertyDraft.create({ data: { ...data, agentId: req.agent!.id }, include: DRAFT_INCLUDE });
  });
  res.json({ draft: presentDraft(draft), revision: draft.revision });
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
  const { values, step, draftId, revision } = parsed.data;
  const draft = await withDraftLock(req.agent!.id, async (tx) => {
    const current = await tx.propertyDraft.findUnique({ where: { agentId: req.agent!.id }, include: DRAFT_INCLUDE });
    // Old clients may create their first draft; a closed generation can only be opened by START.
    if (!current && !draftId && revision === undefined) return tx.propertyDraft.create({
      data: { agentId: req.agent!.id, values: values as Prisma.InputJsonValue, step, expiresAt: expiryFromNow(), revision: 0 }, include: DRAFT_INCLUDE,
    });
    checkDraftReference(current, { draftId, revision }, !current || current.revision === 0);
    return tx.propertyDraft.update({ where: { id: current.id }, data: { values: values as Prisma.InputJsonValue, step, expiresAt: expiryFromNow(), ...(draftId ? { revision: { increment: 1 } } : {}) }, include: DRAFT_INCLUDE });
  });
  res.json({ draft: presentDraft(draft), revision: draft.revision });
});

/** Close the generation and remove files only after the database commit succeeds. */
draftsRouter.delete("/drafts/current", requireAuth, async (req, res) => {
  const parsed = propertyDraftDeleteSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });
  let removedMedia: PropertyDraftMedia[] = [];
  const revision = await withDraftLock(req.agent!.id, async (tx) => {
    const draft = await tx.propertyDraft.findUnique({ where: { agentId: req.agent!.id }, include: DRAFT_INCLUDE });
    if (!draft || draft.closedAt) {
      if (parsed.data.draftId && draft?.id !== parsed.data.draftId) throw new DraftConflictError(draft);
      // An empty DELETE still closes the generation: a first legacy PUT may already be in flight.
      if (!draft) return (await tx.propertyDraft.create({ data: { agentId: req.agent!.id, values: {}, step: 0, closedAt: new Date(), revision: 1, expiresAt: expiryFromNow() } })).revision;
      return draft?.revision ?? 0;
    }
    checkDraftReference(draft, parsed.data, draft.revision === 0);
    removedMedia = draft.media;
    return (await closeDraftRows(tx, draft)).revision;
  });
  await wipeDraftMediaFiles(removedMedia);
  if (!parsed.data.draftId && parsed.data.revision === undefined) return res.status(204).end();
  res.json({ draft: null, revision });
});

/**
 * Черновик заводится сам при первой загрузке файла: агент мог начать со съёмки, не
 * тронув ни одного поля (первый шаг мастера — именно фото), и требовать от вкладки
 * лишний запрос «сначала создай черновик» значило бы уронить загрузку на пустом
 * месте при гонке двух параллельных отправок.
 */
async function ensureDraft(agentId: string, draftId?: string) {
  if (draftId && !z.guid().safeParse(draftId).success) throw new DraftConflictError(null);
  return withDraftLock(agentId, async (tx) => {
    const current = await tx.propertyDraft.findUnique({ where: { agentId }, include: DRAFT_INCLUDE });
    if (current || draftId) { checkDraftReference(current, { draftId }); return current; }
    return tx.propertyDraft.create({ data: { agentId, values: {}, step: 0, expiresAt: expiryFromNow(), revision: 0 }, include: DRAFT_INCLUDE });
  });
}

/**
 * СНИМКИ В ЧЕРНОВИК. Тот же конвейер sharp и та же защита ключом повторной
 * отправки, что и у фото карточки (routes/properties/photos.ts): обрыв связи
 * ПОСЛЕ записи, но ДО того, как ответ дошёл до телефона, не должен задваивать
 * пачку.
 */
draftsRouter.post("/drafts/current/photos", requireAuth, memoryUploadBudget, draftPhotoUpload.array("photos", 5), async (req, res) => {
  const draft = await ensureDraft(req.agent!.id, req.get("X-Property-Draft-Id"));
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (files.length === 0) return res.status(400).json({ error: "Не пришло ни одного файла" });

  const parsedKeys = parseUploadKeys(req.body?.uploadKeys, files.length);
  if (!parsedKeys.ok) return res.status(400).json({ error: parsedKeys.error });
  const uploadKeys = parsedKeys.keys;

  const alreadyStored = uploadKeys?.length
    ? await prisma.propertyDraftMedia.findMany({ where: { uploadKey: { in: uploadKeys } } })
    : [];
  const foreign = alreadyStored.find((m) => m.draftId !== draft.id || m.kind !== "PHOTO");
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
    let media: PropertyDraftMedia;
    try {
      media = await withDraftLock(req.agent!.id, async (tx) => {
        await assertActiveDraft(tx, req.agent!.id, { draftId: draft.id });
        const duplicate = await tx.propertyDraftMedia.findUnique({ where: { uploadKey } });
        if (duplicate) {
          if (duplicate.draftId !== draft.id || duplicate.kind !== "PHOTO") throw new DraftConflictError(null, "Ключ загрузки уже использован");
          await removePhotoFiles(`/uploads/${filename}`, `/uploads/thumbs/${filename}`);
          return duplicate;
        }
        const count = await tx.propertyDraftMedia.count({ where: { draftId: draft.id, kind: "PHOTO" } });
        if (count >= MAX_DRAFT_PHOTOS) throw new DraftConflictError(null, `В черновик помещается ${MAX_DRAFT_PHOTOS} снимков`);
        return tx.propertyDraftMedia.create({
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
        order: count,
        url: `/uploads/${filename}`,
        thumbUrl: `/uploads/thumbs/${filename}`,
      },
        });
      });
    } catch (err) {
      await removePhotoFiles(`/uploads/${filename}`, `/uploads/thumbs/${filename}`);
      throw err;
    }
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

  const draft = await ensureDraft(req.agent!.id, req.get("X-Property-Draft-Id"));

  const reply = deferredDraftReply(res);
  await withDraftLock(req.agent!.id, async (tx) => {
  const res = reply;
  await assertActiveDraft(tx, req.agent!.id, { draftId: draft.id });
  const existing = await tx.propertyDraftMedia.findUnique({ where: { uploadKey } });
  if (existing) {
    if (existing.draftId !== draft.id || existing.kind !== "VIDEO") return res.status(409).json({ error: "Ключ загрузки уже использован" });
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
  const sameFile = await tx.propertyDraftMedia.findFirst({
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

  const videoCount = await tx.propertyDraftMedia.count({ where: { draftId: draft.id, kind: "VIDEO" } });
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

  const media = await tx.propertyDraftMedia.create({
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
  await tx.propertyDraft.update({ where: { id: draft.id }, data: { expiresAt: expiryFromNow() } });
  res.status(201).json({ status: "started", mediaId: media.id, partSize, totalParts, uploadedPartNumbers: [] });
  });
  reply.flush();
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

    const reply = deferredDraftReply(res);
    await withDraftLock(req.agent!.id, async (tx) => {
    const res = reply;
    const media = await tx.propertyDraftMedia.findUnique({
      where: { id: mediaId },
      include: { draft: { select: { agentId: true } } },
    });
    if (!media || media.kind !== "VIDEO") return res.status(404).json({ error: "Загрузка не найдена" });
    if (media.draft.agentId !== req.agent!.id) return res.status(403).json({ error: "Недостаточно прав" });
    await assertMediaDraft(tx, req.agent!.id, media.draftId, req.get("X-Property-Draft-Id"));
    if (media.status === "READY") return res.status(409).json({ error: "Файл уже собран" });
    if (!media.totalParts || partNumber > media.totalParts) {
      return res.status(400).json({ error: "Номер части вне плана загрузки" });
    }

    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: "Пустая часть" });
    const expectedSize = partNumber === media.totalParts ? media.sizeBytes - (media.totalParts - 1) * media.partSize! : media.partSize!;
    if (body.length !== expectedSize) return res.status(400).json({ error: "Размер части не совпадает с планом загрузки" });

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
    await tx.propertyDraftMedia.update({ where: { id: mediaId }, data: { parts: next } });
    await tx.propertyDraft.update({ where: { id: media.draftId }, data: { expiresAt: expiryFromNow() } });
    res.json({ uploadedPartNumbers: [...known].sort((a, b) => a - b) });
    });
    reply.flush();
  }
);

draftsRouter.post("/drafts/current/videos/:mediaId/complete", requireAuth, async (req, res) => {
  const parsedId = z.guid().safeParse(req.params.mediaId);
  if (!parsedId.success) return res.status(400).json({ error: "Неверные данные" });

  const reply = deferredDraftReply(res);
  await withDraftLock(req.agent!.id, async (tx) => {
  const res = reply;
  const media = await tx.propertyDraftMedia.findUnique({
    where: { id: parsedId.data },
    include: { draft: { select: { agentId: true } } },
  });
  if (!media || media.kind !== "VIDEO") return res.status(404).json({ error: "Загрузка не найдена" });
  if (media.draft.agentId !== req.agent!.id) return res.status(403).json({ error: "Недостаточно прав" });
  await assertMediaDraft(tx, req.agent!.id, media.draftId, req.get("X-Property-Draft-Id"));
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

  const ready = await tx.propertyDraftMedia.update({
    where: { id: media.id },
    data: { status: "READY" },
  });
  await tx.propertyDraft.update({ where: { id: media.draftId }, data: { expiresAt: expiryFromNow() } });
  res.json({ media: presentDraftMedia(ready) });
  }, 120_000);
  reply.flush();
});

/** Отмена загрузки и удаление файла черновика — одной кнопкой на плитке. */
draftsRouter.delete("/drafts/current/media/:mediaId", requireAuth, async (req, res) => {
  const parsedId = z.guid().safeParse(req.params.mediaId);
  if (!parsedId.success) return res.status(400).json({ error: "Неверные данные" });

  const result = await withDraftLock(req.agent!.id, async (tx) => {
  const media = await tx.propertyDraftMedia.findUnique({
    where: { id: parsedId.data },
    include: { draft: { select: { agentId: true } } },
  });
  // Уже удалён — отвечаем успехом: вкладка повторяет отмену после обрыва связи, и
  // 404 на второй попытке выглядел бы как «не удалось убрать», хотя файла уже нет.
  if (!media) return null;
  if (media.draft.agentId !== req.agent!.id) return "forbidden" as const;
  await assertMediaDraft(tx, req.agent!.id, media.draftId, req.get("X-Property-Draft-Id"));

  await tx.propertyDraftMedia.delete({ where: { id: media.id } });
  await tx.propertyDraft.update({ where: { id: media.draftId }, data: { expiresAt: expiryFromNow() } });
  return media;
  });
  if (result === "forbidden") return res.status(403).json({ error: "Недостаточно прав" });
  if (!result) return res.status(204).end();
  const media = result;
  if (media.kind === "PHOTO") {
    await removePhotoFiles(media.url, media.thumbUrl);
  } else {
    // Недособранная сессия оставляет за собой папку частей — её убираем отдельно,
    // готовый файл (если сборка уже прошла) удаляем из хранилища.
    await abortLocalUploadSession(media.id).catch(() => undefined);
    if (media.storageKey && media.status === "READY") await localVideoDelete(media.storageKey);
  }
  res.status(204).end();
});

async function assertMediaDraft(tx: TxClient, agentId: string, mediaDraftId: string, headerId?: string): Promise<void> {
  if (headerId && headerId !== mediaDraftId) throw new DraftConflictError(null);
  const current = await assertActiveDraft(tx, agentId, { draftId: mediaDraftId });
  if (!headerId && current.revision > 0) throw new DraftConflictError(current, "Обновите мастер перед загрузкой файлов");
}

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
const fromClientBodySchema = z.object({ media: z.enum(["replace", "keep"]).optional(), mode: z.enum(["merge", "replace"]).optional(), draftId: z.guid().optional(), revision: z.number().int().nonnegative().optional() });
class DraftImportConflictError extends Error {
  constructor(readonly response: Record<string, unknown>) { super(String(response.error)); }
}

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
  const draft = await ensureDraft(agentId, parsedBody.data.draftId ?? req.get("X-Property-Draft-Id"));

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

  let mediaToRemove: PropertyDraftMedia[] = [];
  const imported = await withDraftLock(agentId, async (tx) => {
    const current = await assertActiveDraft(tx, agentId, { draftId: parsedBody.data.draftId, revision: parsedBody.data.revision });
    checkDraftReference(current, { draftId: parsedBody.data.draftId, revision: parsedBody.data.revision }, current.revision === 0);
    const oldValues = current.values && typeof current.values === "object" && !Array.isArray(current.values) ? current.values as Record<string, unknown> : {};
    const otherSeller = draftSellerClientId(current.values) !== client.id;
    const meaningful = Object.entries(oldValues).some(([key, value]) => !["type", "currency", "offSite"].includes(key) && value !== null && value !== false && (typeof value === "string" ? value.trim() !== "" : typeof value === "object" ? Object.keys(value as object).length > 0 : true));
    if (!parsedBody.data.mode && otherSeller && meaningful) throw new DraftImportConflictError({
      error: "У вас уже есть заполненный черновик. Сохраните его или подтвердите замену", code: "DRAFT_REPLACE_CONFIRM", draft: presentDraftSnapshot(current), currentRevision: current.revision,
    });
    const foreignMedia = current.media.length > 0 && otherSeller;
    if (foreignMedia && attachments.length > 0 && !mediaDecision) {
      const draftPhotoCount = current.media.filter((m) => m.kind === "PHOTO").length;
      throw new DraftImportConflictError({ error: "В черновике уже есть ваши фото — заменить их фото из переписки?", code: DRAFT_MEDIA_REPLACE_CONFIRM_CODE, draftPhotoCount, draftVideoCount: current.media.length - draftPhotoCount, draft: presentDraftSnapshot(current), currentRevision: current.revision });
    }
    if (foreignMedia && (mediaDecision === "replace" || (parsedBody.data.mode === "replace" && attachments.length === 0 && mediaDecision !== "keep"))) {
      mediaToRemove = current.media;
      await tx.propertyDraftMedia.deleteMany({ where: { draftId: current.id } });
    }
    const values = { ...sellerCardToDraftValues(client), ...(sellerFactsToDraftValues(facts, client.id) as Record<string, unknown>) } as Record<string, unknown>;
    if (parsedBody.data.mode !== "replace") {
      for (const [key, value] of Object.entries(oldValues)) {
        if (value !== null && value !== "" && (typeof value !== "object" || Object.keys(value as object).length > 0)) values[key] = value;
      }
    }
    values.sellerClientId = client.id;
    const updated = await tx.propertyDraft.update({ where: { id: current.id }, data: { values: values as Prisma.InputJsonValue, step: parsedBody.data.mode === "replace" ? 0 : current.step, expiresAt: expiryFromNow(), ...(parsedBody.data.draftId ? { revision: { increment: 1 } } : {}) }, include: DRAFT_INCLUDE });
    return { updated, copyChatMedia: !(foreignMedia && mediaDecision === "keep") };
  });
  await wipeDraftMediaFiles(mediaToRemove);
  if (imported.copyChatMedia) {
    await copySellerAttachmentsToDraft(draft.id, attachments, {
      maxPhotos: MAX_DRAFT_PHOTOS,
      maxVideos: MAX_DRAFT_VIDEOS,
      agentId,
      sellerClientId: client.id,
    });
  }
  const updated = await prisma.propertyDraft.findUnique({ where: { agentId }, include: DRAFT_INCLUDE });
  checkDraftReference(updated, { draftId: draft.id });
  res.json({ draft: presentDraft(updated), revision: updated.revision });
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
async function wipeDraftMediaFiles(media: PropertyDraftMedia[]): Promise<void> {
  if (media.length === 0) return;
  for (const m of media) {
    if (m.kind === "PHOTO") {
      await removePhotoFiles(m.url, m.thumbUrl);
    } else {
      await abortLocalUploadSession(m.id).catch(() => undefined);
      if (m.storageKey) await localVideoDelete(m.storageKey);
    }
  }
}

const draftErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof DraftConflictError) { res.status(409).json(err.response()); return; }
  if (err instanceof DraftImportConflictError) { res.status(409).json(err.response); return; }
  next(err);
};
draftsRouter.use(draftErrorHandler);

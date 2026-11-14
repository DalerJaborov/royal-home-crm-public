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
import express, { Router, type ErrorRequestHandler } from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma, PropertyDraftMedia } from "../../generated/prisma/client.js";
import {
  propertyDraftSaveSchema,
  propertyDraftStartSchema,
  propertyDraftDeleteSchema,
  propertyDraftVideoSessionSchema,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import { requireAuth } from "../../auth/middleware.js";
import { draftPhotoUpload, uploadsDir, thumbsDir } from "../../upload.js";
import { logSystemError } from "../../lib/systemError.js";
import { DRAFT_MEDIA_ORDER, parseUploadKeys } from "./shared.js";
import { discardDraft, removePhotoFiles } from "./draftAttach.js";
import { isHeic, sharpFromUpload } from "../../lib/heicInput.js";
import { memoryUploadBudget } from "../../lib/memoryUploadBudget.js";
import { DRAFT_INCLUDE, DraftConflictError, assertActiveDraft, checkDraftReference, closeDraftRows, draftExpiry, withDraftLock } from "./draftLifecycle.js";
// Ролики черновика и черновик из карточки продавца — одна дверь для мастера CRM
// и мастера в Telegram (lib/propertyDraftMedia.ts, 10.11.2026).
import {
  MAX_DRAFT_PHOTOS,
  MAX_UPLOAD_PARTS,
  completeDraftVideo,
  deleteDraftMedia,
  draftFromClientBodySchema,
  ensureDraft,
  importClientIntoDraft,
  presentDraft,
  presentDraftMedia,
  startDraftVideoSession,
  wipeDraftMediaFiles,
  writeDraftVideoPart,
} from "../../lib/propertyDraftMedia.js";

export { presentDraftMedia };

export const draftsRouter = Router();

function expiryFromNow(): Date {
  return draftExpiry();
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

  const result = await savePropertyDraftPhotos(req.agent!.id, draft.id, files, uploadKeys ?? undefined);
  return res.status(result.status).json(result.body);
});

const photoResult = <T>(status: number, body: T) => ({ status, body });

/** Reused by the wizard upload and the employee Telegram draft. */
export async function savePropertyDraftPhotos(agentId: string, draftId: string, files: readonly Pick<Express.Multer.File, "buffer" | "mimetype" | "size" | "originalname">[], uploadKeys?: readonly string[]) {
  const alreadyStored = uploadKeys?.length
    ? await prisma.propertyDraftMedia.findMany({ where: { uploadKey: { in: [...uploadKeys] } } })
    : [];
  const foreign = alreadyStored.find((m) => m.draftId !== draftId || m.kind !== "PHOTO");
  if (foreign) return photoResult(409, { error: "Ключ загрузки уже использован" });
  const storedByKey = new Map(alreadyStored.map((m) => [m.uploadKey, m]));

  const currentCount = await prisma.propertyDraftMedia.count({
    where: { draftId: draftId, kind: "PHOTO" },
  });
  const toCreate = files.length - alreadyStored.filter((m) => m.kind === "PHOTO").length;
  if (currentCount + toCreate > MAX_DRAFT_PHOTOS) {
    return photoResult(400, { error: `В черновик помещается ${MAX_DRAFT_PHOTOS} снимков, сейчас уже ${currentCount}` });
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
      return photoResult(502, { error: "Не удалось сохранить снимок — попробуйте ещё раз" });
    }
    let media: PropertyDraftMedia;
    try {
      media = await withDraftLock(agentId, async (tx) => {
        await assertActiveDraft(tx, agentId, { draftId: draftId });
        const duplicate = await tx.propertyDraftMedia.findUnique({ where: { uploadKey } });
        if (duplicate) {
          if (duplicate.draftId !== draftId || duplicate.kind !== "PHOTO") throw new DraftConflictError(null, "Ключ загрузки уже использован");
          await removePhotoFiles(`/uploads/${filename}`, `/uploads/thumbs/${filename}`);
          return duplicate;
        }
        const count = await tx.propertyDraftMedia.count({ where: { draftId: draftId, kind: "PHOTO" } });
        if (count >= MAX_DRAFT_PHOTOS) throw new DraftConflictError(null, `В черновик помещается ${MAX_DRAFT_PHOTOS} снимков`);
        return tx.propertyDraftMedia.create({
      data: {
        draftId: draftId,
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

  await touchDraft(draftId);
  return photoResult(201, stored.map(presentDraftMedia));
}

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
  const started = await startDraftVideoSession(req.agent!.id, req.get("X-Property-Draft-Id"), parsed.data);
  res.status(started.status).json(started.body);
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
    const written = await writeDraftVideoPart(req.agent!.id, req.get("X-Property-Draft-Id"), mediaId, partNumber, req.body as Buffer);
    res.status(written.status).json(written.body);
  }
);

draftsRouter.post("/drafts/current/videos/:mediaId/complete", requireAuth, async (req, res) => {
  const parsedId = z.guid().safeParse(req.params.mediaId);
  if (!parsedId.success) return res.status(400).json({ error: "Неверные данные" });
  const completed = await completeDraftVideo(req.agent!.id, req.get("X-Property-Draft-Id"), parsedId.data);
  res.status(completed.status).json(completed.body);
});

/** Отмена загрузки и удаление файла черновика — одной кнопкой на плитке. */
draftsRouter.delete("/drafts/current/media/:mediaId", requireAuth, async (req, res) => {
  const parsedId = z.guid().safeParse(req.params.mediaId);
  if (!parsedId.success) return res.status(400).json({ error: "Неверные данные" });
  const deleted = await deleteDraftMedia(req.agent!.id, req.get("X-Property-Draft-Id"), parsedId.data);
  if (deleted.status === 204) return res.status(204).end();
  res.status(deleted.status).json(deleted.body);
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
draftsRouter.post("/drafts/from-client/:clientId", requireAuth, async (req, res) => {
  const parsedId = z.guid().safeParse(req.params.clientId);
  if (!parsedId.success) return res.status(400).json({ error: "Неверный идентификатор клиента" });
  const parsedBody = draftFromClientBodySchema.safeParse(req.body ?? {});
  if (!parsedBody.success) return res.status(400).json({ error: "Неверные данные", details: parsedBody.error.flatten() });
  const imported = await importClientIntoDraft(req, parsedId.data, parsedBody.data, req.get("X-Property-Draft-Id"));
  res.status(imported.status).json(imported.body);
});

const draftErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof DraftConflictError) { res.status(409).json(err.response()); return; }
  next(err);
};
draftsRouter.use(draftErrorHandler);

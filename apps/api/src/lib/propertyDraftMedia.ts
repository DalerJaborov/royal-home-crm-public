/**
 * ЧЕРНОВИК ОБЪЕКТА: РОЛИКИ И ЧЕРНОВИК ИЗ КАРТОЧКИ ПРОДАВЦА — тела маршрутов
 * `routes/properties/drafts.ts`, вынесенные 10.11.2026, чтобы мастер в Telegram
 * («Шабнам») звал ровно те же функции, что мастер CRM: одна дверь на загрузку
 * ролика (сессия → части → сборка) и на импорт продавца с теми же правами.
 *
 * Поведение REST не менялось: маршрут разбирает запрос и отдаёт `{ status, body }`
 * отсюда как есть. Устройство и доводы — в шапке routes/properties/drafts.ts.
 *
 * Ответ отдаётся только после коммита транзакции (раньше это делал
 * `deferredDraftReply`): функции возвращают результат из-под withDraftLock, а не
 * пишут в ответ изнутри неё.
 */
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { z } from "zod";
import type { Prisma, PropertyDraftMedia } from "../generated/prisma/client.js";
import {
  UPLOAD_VIDEO_MAX_BYTES,
  VIDEO_TOO_LARGE_CODE,
  videoTooLargeMessage,
  type PropertyDraftMediaView,
  type PropertyDraftView,
} from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { canAccessAssignedAgent, scopeToOwnAgent } from "../auth/middleware.js";
import {
  abortLocalUploadSession,
  completeLocalUploadSession,
  createLocalUploadSession,
  localVideoDelete,
  writeLocalUploadPart,
} from "./localVideoStorage.js";
import { logSystemError } from "./systemError.js";
import { UNSUPPORTED_VIDEO_MESSAGE, videoExtensionOf } from "./videoFileExtension.js";
import { copySellerAttachmentsToDraft, listSellerAttachments, sellerCardToDraftValues, sellerFactsToDraftValues } from "./sellerMedia.js";
import { getSellerObjectFacts } from "./sellerFacts.js";
import { DRAFT_INCLUDE, DraftConflictError, assertActiveDraft, checkDraftReference, draftExpiry, presentDraftSnapshot, withDraftLock } from "../routes/properties/draftLifecycle.js";
import { removePhotoFiles } from "../routes/properties/draftAttach.js";

export type DraftResult<T = unknown> = { status: number; body: T };
const result = <T>(status: number, body: T): DraftResult<T> => ({ status, body });

/** Тот же план частей, что у видео объекта (routes/properties/videos.ts): 8 МБ —
 *  компромисс между числом запросов и ценой повтора одной части при обрыве. */
export const VIDEO_PART_SIZE = 8 * 1024 * 1024;
export const MAX_UPLOAD_PARTS = 10_000;
/** Потолок на файлы одного черновика — чтобы брошенный черновик не мог съесть диск.
 *  Числа те же, что действуют у карточки объекта (30 фото за запрос, до 30 видео). */
export const MAX_DRAFT_PHOTOS = 60;
export const MAX_DRAFT_VIDEOS = 10;

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

export function presentDraft(draft: {
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

/**
 * Черновик заводится сам при первой загрузке файла: агент мог начать со съёмки, не
 * тронув ни одного поля (первый шаг мастера — именно фото), и требовать от вкладки
 * лишний запрос «сначала создай черновик» значило бы уронить загрузку на пустом
 * месте при гонке двух параллельных отправок.
 */
export async function ensureDraft(agentId: string, draftId?: string) {
  if (draftId && !z.guid().safeParse(draftId).success) throw new DraftConflictError(null);
  return withDraftLock(agentId, async (tx) => {
    const current = await tx.propertyDraft.findUnique({ where: { agentId }, include: DRAFT_INCLUDE });
    if (current || draftId) { checkDraftReference(current, { draftId }); return current; }
    return tx.propertyDraft.create({ data: { agentId, values: {}, step: 0, expiresAt: draftExpiry(), revision: 0 }, include: DRAFT_INCLUDE });
  });
}

async function assertMediaDraft(tx: TxClient, agentId: string, mediaDraftId: string, headerId?: string): Promise<void> {
  if (headerId && headerId !== mediaDraftId) throw new DraftConflictError(null);
  const current = await assertActiveDraft(tx, agentId, { draftId: mediaDraftId });
  if (!headerId && current.revision > 0) throw new DraftConflictError(current, "Обновите мастер перед загрузкой файлов");
}

export interface DraftVideoSessionInput {
  uploadKey: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
}

/**
 * Сессия загрузки ролика черновика (POST /drafts/current/videos/sessions).
 * `draftHeaderId` — то же, что заголовок X-Property-Draft-Id у вкладки.
 */
export async function startDraftVideoSession(agentId: string, draftHeaderId: string | undefined, input: DraftVideoSessionInput): Promise<DraftResult> {
  const { uploadKey, filename, sizeBytes, contentType } = input;
  if (!contentType.startsWith("video/")) return result(400, { error: "Допустимо только видео" });
  // Расширение — из белого списка, до начала загрузки (D15, 02.10.2026): раньше
  // брали из имени файла как есть, и «.html»/«.svg» ложился в хранилище и
  // переезжал в карточку объекта.
  const ext = videoExtensionOf(filename);
  if (!ext) return result(400, { error: `Файл «${filename}»: ${UNSUPPORTED_VIDEO_MESSAGE}` });
  if (sizeBytes > UPLOAD_VIDEO_MAX_BYTES) {
    return result(400, {
      error: videoTooLargeMessage(filename),
      code: VIDEO_TOO_LARGE_CODE,
      limitBytes: UPLOAD_VIDEO_MAX_BYTES,
    });
  }

  const draft = await ensureDraft(agentId, draftHeaderId);

  return withDraftLock(agentId, async (tx) => {
    await assertActiveDraft(tx, agentId, { draftId: draft.id });
    const existing = await tx.propertyDraftMedia.findUnique({ where: { uploadKey } });
    if (existing) {
      if (existing.draftId !== draft.id || existing.kind !== "VIDEO") return result(409, { error: "Ключ загрузки уже использован" });
      if (existing.status === "READY") {
        return result(200, { status: "done", media: presentDraftMedia(existing) });
      }
      return result(200, {
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
     * и тот же IMG_8354.mov: две строки, две копии на диске. Имя плюс размер байт
     * в байт внутри ОДНОГО черновика — это один и тот же файл.
     */
    const sameFile = await tx.propertyDraftMedia.findFirst({
      where: { draftId: draft.id, kind: "VIDEO", filename: filename.slice(0, 255), sizeBytes },
      orderBy: { createdAt: "asc" },
    });
    if (sameFile) {
      if (sameFile.status === "READY") return result(200, { status: "done", media: presentDraftMedia(sameFile) });
      // Недокачанный — продолжаем В ТУ ЖЕ строку: это обычный повтор после обрыва.
      return result(200, {
        status: "in-progress",
        mediaId: sameFile.id,
        partSize: sameFile.partSize,
        totalParts: sameFile.totalParts,
        uploadedPartNumbers: uploadedParts(sameFile.parts),
      });
    }

    const videoCount = await tx.propertyDraftMedia.count({ where: { draftId: draft.id, kind: "VIDEO" } });
    if (videoCount >= MAX_DRAFT_VIDEOS) {
      return result(400, { error: `В черновик помещается ${MAX_DRAFT_VIDEOS} роликов` });
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
      return result(502, { error: "Не удалось начать загрузку видео — попробуйте ещё раз" });
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
    await tx.propertyDraft.update({ where: { id: draft.id }, data: { expiresAt: draftExpiry() } });
    return result(201, { status: "started", mediaId: media.id, partSize, totalParts, uploadedPartNumbers: [] });
  });
}

/** Часть ролика (PUT /drafts/current/videos/:mediaId/parts/:partNumber). */
export async function writeDraftVideoPart(agentId: string, draftHeaderId: string | undefined, mediaId: string, partNumber: number, body: Buffer): Promise<DraftResult> {
  return withDraftLock(agentId, async (tx) => {
    const media = await tx.propertyDraftMedia.findUnique({
      where: { id: mediaId },
      include: { draft: { select: { agentId: true } } },
    });
    if (!media || media.kind !== "VIDEO") return result(404, { error: "Загрузка не найдена" });
    if (media.draft.agentId !== agentId) return result(403, { error: "Недостаточно прав" });
    await assertMediaDraft(tx, agentId, media.draftId, draftHeaderId);
    if (media.status === "READY") return result(409, { error: "Файл уже собран" });
    if (!media.totalParts || partNumber > media.totalParts) {
      return result(400, { error: "Номер части вне плана загрузки" });
    }

    if (!Buffer.isBuffer(body) || body.length === 0) return result(400, { error: "Пустая часть" });
    const expectedSize = partNumber === media.totalParts ? media.sizeBytes - (media.totalParts - 1) * media.partSize! : media.partSize!;
    if (body.length !== expectedSize) return result(400, { error: "Размер части не совпадает с планом загрузки" });

    try {
      await writeLocalUploadPart(mediaId, partNumber, body);
    } catch (err) {
      void logSystemError(
        "storage",
        `Не удалось записать часть видео черновика: ${err instanceof Error ? err.message : String(err)}`
      );
      return result(502, { error: "Часть не записалась — попробуйте ещё раз" });
    }

    // Повтор той же части перезаписывает файл и не должен плодить дубли в списке.
    const known = new Set(uploadedParts(media.parts));
    known.add(partNumber);
    const next = [...known].sort((a, b) => a - b).map((n) => ({ partNumber: n }));
    await tx.propertyDraftMedia.update({ where: { id: mediaId }, data: { parts: next } });
    await tx.propertyDraft.update({ where: { id: media.draftId }, data: { expiresAt: draftExpiry() } });
    return result(200, { uploadedPartNumbers: [...known].sort((a, b) => a - b) });
  });
}

/** Сборка ролика (POST /drafts/current/videos/:mediaId/complete). */
export async function completeDraftVideo(agentId: string, draftHeaderId: string | undefined, mediaId: string): Promise<DraftResult> {
  return withDraftLock(agentId, async (tx) => {
    const media = await tx.propertyDraftMedia.findUnique({
      where: { id: mediaId },
      include: { draft: { select: { agentId: true } } },
    });
    if (!media || media.kind !== "VIDEO") return result(404, { error: "Загрузка не найдена" });
    if (media.draft.agentId !== agentId) return result(403, { error: "Недостаточно прав" });
    await assertMediaDraft(tx, agentId, media.draftId, draftHeaderId);
    if (media.status === "READY") return result(200, { media: presentDraftMedia(media) });
    if (!media.storageKey || !media.totalParts) return result(409, { error: "Загрузка повреждена" });

    const have = uploadedParts(media.parts);
    if (have.length !== media.totalParts) {
      // 409, а не 400: части действительно не все, и клиенту надо дослать недостающие.
      return result(409, {
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
      return result(502, { error: "Не удалось собрать видео — попробуйте ещё раз" });
    }

    const ready = await tx.propertyDraftMedia.update({
      where: { id: media.id },
      data: { status: "READY" },
    });
    await tx.propertyDraft.update({ where: { id: media.draftId }, data: { expiresAt: draftExpiry() } });
    return result(200, { media: presentDraftMedia(ready) });
  }, 120_000);
}

/** Отмена загрузки и удаление файла черновика (DELETE /drafts/current/media/:mediaId). */
export async function deleteDraftMedia(agentId: string, draftHeaderId: string | undefined, mediaId: string): Promise<DraftResult<null | { error: string }>> {
  const removed = await withDraftLock(agentId, async (tx) => {
    const media = await tx.propertyDraftMedia.findUnique({
      where: { id: mediaId },
      include: { draft: { select: { agentId: true } } },
    });
    // Уже удалён — отвечаем успехом: вкладка повторяет отмену после обрыва связи.
    if (!media) return null;
    if (media.draft.agentId !== agentId) return "forbidden" as const;
    await assertMediaDraft(tx, agentId, media.draftId, draftHeaderId);

    await tx.propertyDraftMedia.delete({ where: { id: media.id } });
    await tx.propertyDraft.update({ where: { id: media.draftId }, data: { expiresAt: draftExpiry() } });
    return media;
  });
  if (removed === "forbidden") return result(403, { error: "Недостаточно прав" });
  if (!removed) return result(204, null);
  if (removed.kind === "PHOTO") {
    await removePhotoFiles(removed.url, removed.thumbUrl);
  } else {
    // Недособранная сессия оставляет за собой папку частей — её убираем отдельно,
    // готовый файл (если сборка уже прошла) удаляем из хранилища.
    await abortLocalUploadSession(removed.id).catch(() => undefined);
    if (removed.storageKey && removed.status === "READY") await localVideoDelete(removed.storageKey);
  }
  return result(204, null);
}

/** Удаляет файлы строк медиа черновика с диска (сами строки уже удалены), саму
 *  строку PropertyDraft не трогает — в отличие от discardDraft (draftAttach.ts). */
export async function wipeDraftMediaFiles(media: PropertyDraftMedia[]): Promise<void> {
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

/**
 * ЧЕРНОВИК ИЗ КАРТОЧКИ ПРОДАВЦА (POST /drafts/from-client/:clientId) — доводы в
 * шапке маршрута. Права те же, что у REST: продавец (или двойное намерение),
 * своя карточка либо «видеть всех», до принятия лида — закрыто.
 */
export const DRAFT_MEDIA_REPLACE_CONFIRM_CODE = "DRAFT_MEDIA_REPLACE_CONFIRM";
export const draftFromClientBodySchema = z.object({ media: z.enum(["replace", "keep"]).optional(), mode: z.enum(["merge", "replace"]).optional(), draftId: z.guid().optional(), revision: z.number().int().nonnegative().optional() });
export type DraftFromClientBody = z.infer<typeof draftFromClientBodySchema>;
class DraftImportConflictError extends Error {
  constructor(readonly response: Record<string, unknown>) { super(String(response.error)); }
}

export async function importClientIntoDraft(
  req: Pick<Request, "agent">,
  clientId: string,
  body: DraftFromClientBody,
  draftHeaderId?: string,
): Promise<DraftResult> {
  const agentId = req.agent?.id;
  if (!agentId) return result(401, { error: "Требуется вход" });
  const mediaDecision = body.media;

  const client = await prisma.client.findUnique({
    where: { id: clientId },
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
  if (!client || client.deletedAt) return result(404, { error: "Клиент не найден" });
  // Черновик собирается из переписки о ЕГО объекте на продажу — у чистого покупателя
  // этих данных нет и быть не может (тот же довод, что и у POST /ai/property-draft).
  if (client.kind !== "SELLER" && !client.dualIntent) {
    return result(400, { error: "Черновик из переписки доступен только для продавца" });
  }
  if (!canAccessAssignedAgent(req, client.assignedAgentId)) {
    return result(403, { error: "Недостаточно прав" });
  }
  // До принятия лида карточка агенту закрыта — тот же гейт, что у card-fill и
  // /ai/property-draft.
  if (scopeToOwnAgent(req) && !client.acceptedAt) {
    return result(403, { error: "Сначала примите лид — до принятия карточка закрыта" });
  }

  const draft = await ensureDraft(agentId, body.draftId ?? draftHeaderId);

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
  let imported: { copyChatMedia: boolean };
  try {
    imported = await withDraftLock(agentId, async (tx) => {
      const current = await assertActiveDraft(tx, agentId, { draftId: body.draftId, revision: body.revision });
      checkDraftReference(current, { draftId: body.draftId, revision: body.revision }, current.revision === 0);
      const oldValues = current.values && typeof current.values === "object" && !Array.isArray(current.values) ? current.values as Record<string, unknown> : {};
      const otherSeller = draftSellerClientId(current.values) !== client.id;
      const meaningful = Object.entries(oldValues).some(([key, value]) => !["type", "currency", "offSite"].includes(key) && value !== null && value !== false && (typeof value === "string" ? value.trim() !== "" : typeof value === "object" ? Object.keys(value as object).length > 0 : true));
      if (!body.mode && otherSeller && meaningful) throw new DraftImportConflictError({
        error: "У вас уже есть заполненный черновик. Сохраните его или подтвердите замену", code: "DRAFT_REPLACE_CONFIRM", draft: presentDraftSnapshot(current), currentRevision: current.revision,
      });
      const foreignMedia = current.media.length > 0 && otherSeller;
      if (foreignMedia && attachments.length > 0 && !mediaDecision) {
        const draftPhotoCount = current.media.filter((m) => m.kind === "PHOTO").length;
        throw new DraftImportConflictError({ error: "В черновике уже есть ваши фото — заменить их фото из переписки?", code: DRAFT_MEDIA_REPLACE_CONFIRM_CODE, draftPhotoCount, draftVideoCount: current.media.length - draftPhotoCount, draft: presentDraftSnapshot(current), currentRevision: current.revision });
      }
      if (foreignMedia && (mediaDecision === "replace" || (body.mode === "replace" && attachments.length === 0 && mediaDecision !== "keep"))) {
        mediaToRemove = current.media;
        await tx.propertyDraftMedia.deleteMany({ where: { draftId: current.id } });
      }
      const values = { ...sellerCardToDraftValues(client), ...(sellerFactsToDraftValues(facts, client.id) as Record<string, unknown>) } as Record<string, unknown>;
      if (body.mode !== "replace") {
        for (const [key, value] of Object.entries(oldValues)) {
          if (value !== null && value !== "" && (typeof value !== "object" || Object.keys(value as object).length > 0)) values[key] = value;
        }
      }
      values.sellerClientId = client.id;
      await tx.propertyDraft.update({ where: { id: current.id }, data: { values: values as Prisma.InputJsonValue, step: body.mode === "replace" ? 0 : current.step, expiresAt: draftExpiry(), ...(body.draftId ? { revision: { increment: 1 } } : {}) }, include: DRAFT_INCLUDE });
      return { copyChatMedia: !(foreignMedia && mediaDecision === "keep") };
    });
  } catch (err) {
    if (err instanceof DraftImportConflictError) return result(409, err.response);
    throw err;
  }
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
  return result(200, { draft: presentDraft(updated), revision: updated.revision });
}

/** `values.sellerClientId`, записанный прошлым вызовом импорта или самим агентом
 *  на шаге «Продавец» — null у пустого черновика. */
function draftSellerClientId(values: Prisma.JsonValue): string | null {
  if (!values || typeof values !== "object" || Array.isArray(values)) return null;
  const raw = (values as Record<string, unknown>).sellerClientId;
  return typeof raw === "string" && raw ? raw : null;
}

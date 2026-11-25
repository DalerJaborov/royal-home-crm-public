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
import type { Readable } from "node:stream";
import type { Request } from "express";
import { z } from "zod";
import type { Prisma, PropertyDraftMedia } from "../generated/prisma/client.js";
import {
  MAX_DRAFT_PHOTOS,
  MAX_DRAFT_VIDEOS,
  UPLOAD_MAX_PARTS,
  UPLOAD_VIDEO_MAX_BYTES,
  VIDEO_TOO_LARGE_CODE,
  computeUploadPartPlan,
  expectedUploadPartBytes,
  uploadErrorBody,
  videoTooLargeMessage,
  type PropertyDraftMediaView,
  type PropertyDraftView,
  type UploadSessionStatusView,
} from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { canAccessAssignedAgent, scopeToOwnAgent } from "../auth/middleware.js";
import {
  abortLocalUploadSession,
  assertUploadDiskSpace,
  uploadStartDiskBytes,
  completeLocalUploadSession,
  createLocalUploadSession,
  finishLocalUploadSession,
  listLocalUploadParts,
  localUploadPartSizes,
  localVideoDelete,
  lockLocalUploadAssembly,
  writeLocalUploadPart,
} from "./localVideoStorage.js";
import { UploadError, toStorageError } from "./uploadErrors.js";
import { reportUploadError } from "./uploadHttp.js";
import { readUploadState } from "./uploadCompletion.js";
import { logSystemError } from "./systemError.js";
import { UNSUPPORTED_VIDEO_MESSAGE, videoExtensionOf } from "./videoFileExtension.js";
import { copySellerAttachmentsToDraft, listSellerAttachments, sellerCardToDraftValues, sellerFactsToDraftValues } from "./sellerMedia.js";
import { getSellerObjectFacts } from "./sellerFacts.js";
import { DRAFT_INCLUDE, DraftConflictError, assertActiveDraft, checkDraftReference, draftExpiry, presentDraftSnapshot, withDraftLock } from "../routes/properties/draftLifecycle.js";
import { removePhotoFiles } from "../routes/properties/draftAttach.js";

export type DraftResult<T = unknown> = { status: number; body: T };
const result = <T>(status: number, body: T): DraftResult<T> => ({ status, body });

/** План частей — общий на все виды загрузки частями (packages/shared::computeUploadPartPlan). */
export const MAX_UPLOAD_PARTS = UPLOAD_MAX_PARTS;
/** Потолок файлов черновика — общий с экраном мастера (packages/shared). */
export { MAX_DRAFT_PHOTOS, MAX_DRAFT_VIDEOS };

/** Владелец итога сборки ролика черновика (lib/uploadCompletion.ts). */
export function draftVideoOwner(agentId: string): string {
  return `agent:${agentId}`;
}

/** Отказ слоя хранения → ответ маршрута/бота того же вида, что и у остальных загрузок. */
function uploadFailure(err: unknown, what: string): DraftResult {
  if (err instanceof UploadError) {
    reportUploadError(err, what);
    return result(err.status, err.body());
  }
  throw err;
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
  /** Необязательно: размер части, удобный клиенту (UPLOAD_PART_MIN_BYTES…UPLOAD_PART_MAX_BYTES). */
  partSize?: number;
}

/**
 * Сессия загрузки ролика черновика (POST /drafts/current/videos/sessions).
 * `draftHeaderId` — то же, что заголовок X-Property-Draft-Id у вкладки.
 */
export async function startDraftVideoSession(agentId: string, draftHeaderId: string | undefined, input: DraftVideoSessionInput): Promise<DraftResult> {
  const { uploadKey, filename, sizeBytes, contentType } = input;
  const plan = computeUploadPartPlan(sizeBytes, input.partSize);
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
  if (!plan) return result(400, uploadErrorBody("PART_SIZE_INVALID"));

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
        uploadedPartNumbers: await listLocalUploadParts(existing.id),
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
        uploadedPartNumbers: await listLocalUploadParts(sameFile.id),
      });
    }

    const videoCount = await tx.propertyDraftMedia.count({ where: { draftId: draft.id, kind: "VIDEO" } });
    if (videoCount >= MAX_DRAFT_VIDEOS) {
      return result(400, { error: `В черновик помещается ${MAX_DRAFT_VIDEOS} роликов` });
    }

    const { partSize, totalParts } = plan;
    const storageKey = `${draft.id}/${randomUUID()}${ext}`;
    // Свой id заранее: папка частей на диске заводится ДО записи в базу. Упади сервер
    // между двумя шагами — останется пустая папка без записи (её подберёт уборка сирот
    // по возрасту, lib/videoUploadCleanup.ts), а не запись без папки для частей.
    // Место на диске — до папки: нет места — 507 DISK_FULL, а не 500 посреди записи.
    const mediaId = randomUUID();
    try {
      await assertUploadDiskSpace(uploadStartDiskBytes(sizeBytes));
      await createLocalUploadSession(mediaId);
    } catch (err) {
      return uploadFailure(err, "ролик черновика: старт");
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

/**
 * Часть ролика (PUT /drafts/current/videos/:mediaId/parts/:partNumber).
 *
 * Байты пишутся на диск ВНЕ транзакции (25.11.2026): раньше запись восьми мегабайт шла
 * внутри withDraftLock — на медленном канале это минуты с занятым соединением пула и
 * замком черновика. Теперь: короткая проверка под замком → запись части на диск (поток,
 * без копии в памяти) → короткая запись списка частей (по диску — правда о принятом).
 */
export async function writeDraftVideoPart(
  agentId: string,
  draftHeaderId: string | undefined,
  mediaId: string,
  partNumber: number,
  body: Buffer | Readable
): Promise<DraftResult> {
  const checked = await withDraftLock(agentId, async (tx) => {
    const media = await tx.propertyDraftMedia.findUnique({
      where: { id: mediaId },
      include: { draft: { select: { agentId: true } } },
    });
    if (!media || media.kind !== "VIDEO") return result(404, uploadErrorBody("SESSION_NOT_FOUND", { message: "Загрузка не найдена" }));
    if (media.draft.agentId !== agentId) return result(403, { error: "Недостаточно прав" });
    await assertMediaDraft(tx, agentId, media.draftId, draftHeaderId);
    if (media.status === "READY") return result(409, uploadErrorBody("ALREADY_ASSEMBLED"));
    if (!media.totalParts || !media.partSize || partNumber > media.totalParts) {
      return result(400, uploadErrorBody("PART_OUT_OF_RANGE", { message: "Номер части вне плана загрузки" }));
    }
    return { media: { id: media.id, draftId: media.draftId, partSize: media.partSize, totalParts: media.totalParts, sizeBytes: media.sizeBytes } };
  });
  if ("status" in checked) return checked;
  const { media } = checked;

  const expectedBytes = expectedUploadPartBytes(media, partNumber);
  try {
    await assertUploadDiskSpace(expectedBytes);
    await writeLocalUploadPart(mediaId, partNumber, body, { expectedBytes });
  } catch (err) {
    return uploadFailure(err, "ролик черновика: часть");
  }

  return withDraftLock(agentId, async (tx) => {
    // Пока байты шли, ролик могли удалить — тогда список писать некуда (папку частей
    // уже убрал deleteDraftMedia), отвечаем как на удалённую загрузку.
    const still = await tx.propertyDraftMedia.findUnique({ where: { id: mediaId }, select: { id: true } });
    if (!still) return result(404, uploadErrorBody("SESSION_NOT_FOUND", { message: "Загрузка не найдена" }));
    // Диск читается ПОД замком черновика: последняя из параллельных частей видит все уже
    // записанные — номера в списке не теряются.
    const uploaded = await listLocalUploadParts(mediaId);
    await tx.propertyDraftMedia.update({ where: { id: mediaId }, data: { parts: uploaded.map((n) => ({ partNumber: n })) } });
    await tx.propertyDraft.update({ where: { id: media.draftId }, data: { expiresAt: draftExpiry() } });
    return result(200, { uploadedPartNumbers: uploaded });
  });
}

/** Состояние загрузки ролика черновика (GET /drafts/current/videos/:mediaId) — для докачки
 *  и асинхронной сборки: принятые части и байты по диску, состояние и итог. */
export async function draftVideoStatus(agentId: string, mediaId: string): Promise<DraftResult> {
  const media = await prisma.propertyDraftMedia.findUnique({
    where: { id: mediaId },
    include: { draft: { select: { agentId: true } } },
  });
  if (!media || media.kind !== "VIDEO") return result(404, uploadErrorBody("SESSION_NOT_FOUND"));
  if (media.draft.agentId !== agentId) return result(403, { error: "Недостаточно прав" });
  const sizes = await localUploadPartSizes(mediaId);
  const stored = await readUploadState(mediaId, draftVideoOwner(agentId));
  const ready = media.status === "READY";
  const receiving = !ready && (!stored || (stored.state === "failed" && stored.error?.code === "PARTS_MISSING"));
  const view: UploadSessionStatusView = {
    sessionId: mediaId,
    state: ready ? "done" : receiving || !stored ? "receiving" : stored.state,
    partSize: media.partSize ?? 0,
    totalParts: media.totalParts ?? 0,
    sizeBytes: media.sizeBytes,
    uploadedPartNumbers: [...sizes.keys()],
    receivedBytes: ready ? media.sizeBytes : [...sizes.values()].reduce((a, b) => a + b, 0),
    ...(ready ? { result: { status: 200, body: { media: presentDraftMedia(media) } } } : {}),
    ...(!ready && !receiving && stored?.error ? { error: stored.error } : {}),
    updatedAt: (stored?.updatedAt ? new Date(stored.updatedAt) : media.updatedAt).toISOString(),
  };
  return result(200, view);
}

/**
 * Сборка ролика (бот Telegram; HTTP-маршрут берёт замок сам через lib/uploadCompletion.ts и
 * зовёт completeDraftVideoLocked). Под замком сборки (lockLocalUploadAssembly): две вкладки или
 * повтор не склеивают один файл вдвоём. Части убираются только после того, как ролик помечен
 * готовым в базе.
 */
export async function completeDraftVideo(agentId: string, draftHeaderId: string | undefined, mediaId: string): Promise<DraftResult> {
  let lock;
  try {
    lock = await lockLocalUploadAssembly(mediaId);
  } catch (err) {
    // Папки частей нет: либо уже собрано (READY), либо загрузки нет — ответит проверка ниже.
    if (!(err instanceof UploadError && err.code === "SESSION_NOT_FOUND")) return uploadFailure(err, "ролик черновика: сборка");
    lock = undefined;
  }
  if (lock === null) return result(409, uploadErrorBody("ASSEMBLING", { extra: { uploadedPartNumbers: await listLocalUploadParts(mediaId) } }));
  try {
    const outcome = await completeDraftVideoLocked(agentId, draftHeaderId, mediaId);
    if (outcome.status === 200) await finishLocalUploadSession(mediaId);
    return outcome;
  } finally {
    await lock?.release();
  }
}

/**
 * Сборка без своего замка — вызывающий его уже держит. Склейка идёт ВНЕ транзакции
 * (раньше — внутри withDraftLock с пределом 120 с: ролик 2 ГБ дольше, транзакция
 * откатывалась, файл склеен, части стёрты, статус UPLOADING — и дальше 502 навсегда).
 * Части здесь НЕ удаляются: их убирает вызывающий после ответа 200.
 */
export async function completeDraftVideoLocked(agentId: string, draftHeaderId: string | undefined, mediaId: string): Promise<DraftResult> {
  const checked = await withDraftLock(agentId, async (tx) => {
    const media = await tx.propertyDraftMedia.findUnique({
      where: { id: mediaId },
      include: { draft: { select: { agentId: true } } },
    });
    if (!media || media.kind !== "VIDEO") return result(404, uploadErrorBody("SESSION_NOT_FOUND", { message: "Загрузка не найдена" }));
    if (media.draft.agentId !== agentId) return result(403, { error: "Недостаточно прав" });
    await assertMediaDraft(tx, agentId, media.draftId, draftHeaderId);
    if (media.status === "READY") return result(200, { media: presentDraftMedia(media) });
    if (!media.storageKey || !media.totalParts || !media.partSize) return result(409, { error: "Загрузка повреждена" });
    return {
      media: {
        id: media.id,
        draftId: media.draftId,
        storageKey: media.storageKey,
        totalParts: media.totalParts,
        partSize: media.partSize,
        sizeBytes: media.sizeBytes,
      },
    };
  });
  if ("status" in checked) return checked;
  const { media } = checked;

  const have = await listLocalUploadParts(media.id);
  if (have.length !== media.totalParts) {
    // 409, а не 400: части действительно не все, и клиенту надо дослать недостающие.
    return result(
      409,
      uploadErrorBody("PARTS_MISSING", { message: "Пришли не все части", extra: { uploadedPartNumbers: have, totalParts: media.totalParts } })
    );
  }

  try {
    await completeLocalUploadSession(media.id, media.storageKey, media);
  } catch (err) {
    return uploadFailure(toStorageError(err, "сборка ролика черновика"), "ролик черновика: сборка");
  }

  return withDraftLock(agentId, async (tx) => {
    const current = await tx.propertyDraftMedia.findUnique({ where: { id: media.id } });
    if (!current) {
      // Пока склеивали, ролик удалили — собранный файл никому не нужен.
      await localVideoDelete(media.storageKey);
      return result(404, uploadErrorBody("SESSION_NOT_FOUND", { message: "Загрузка не найдена" }));
    }
    if (current.status === "READY") return result(200, { media: presentDraftMedia(current) });
    const ready = await tx.propertyDraftMedia.update({ where: { id: media.id }, data: { status: "READY" } });
    await tx.propertyDraft.update({ where: { id: media.draftId }, data: { expiresAt: draftExpiry() } });
    return result(200, { media: presentDraftMedia(ready) });
  });
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
    return result(403, { error: "Сначала примите заявку — до принятия карточка закрыта" });
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

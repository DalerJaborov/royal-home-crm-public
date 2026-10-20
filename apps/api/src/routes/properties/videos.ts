/** Видео объекта: короткий ролик карточки (POST /:id/clip-video), сырое видео
 * PropertyVideo (POST/GET/DELETE /:id/videos...), докачка с середины
 * (upload-sessions), выдача/скачивание и архив (Г3, §1.3). Перенос verbatim.
 * В исходном файле между clip-video и остальными видео-маршрутами стояли
 * share-links — их группа подключается в index.ts после этой; пересечений
 * путей у групп нет (см. комментарий там). */
import express, { Router, type Request } from "express";
import path from "node:path";
import { makePropertyCover, storeManualCover } from "../../lib/video/coverOpenAi.js";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import multer from "multer";
import { ZipArchive } from "archiver";
import type { Prisma, PropertyVideo } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { requireAuth } from "../../auth/middleware.js";
import { upload, clipVideoUpload, clipVideoDir, videoHandoffUpload, videoTmpDir, moveUploadedFile, propertyCoversDir, UploadRejectedError } from "../../upload.js";
import { probeDurationSec, MAX_CLIP_VIDEO_DURATION_SEC } from "../../lib/propertyClipVideo.js";
import { probeRawVideoFacts } from "../../lib/rawVideoFacts.js";
import { revertToReviewAfterVideoUpload } from "../../lib/propertyPipeline.js";
import { autoApproveIfRawReviewOff } from "../../lib/propertyReview.js";
import { afterClipRejected } from "../../lib/clipReview.js";
import {
  receiveEditedVideo,
  requeueVideoHandoff,
  receiveEditedVideoFromFile,
  notifyMontajerFinalUploadedManually,
  buildMontajerMessageText,
  withPropertyLock,
  publishHandoffNow,
  rescheduleHandoffPublish,
  closeManualFinalVideoWait,
  applySucceededPublishResults,
  handoffStatusBlockReason,
  CLIP_REVIEW_PENDING_ERROR,
  isHandoffPublishRunning,
  discardReceivedFinalVideo,
} from "../../lib/videoHandoff.js";
import { logSystemError } from "../../lib/systemError.js";
import { describeError } from "../../lib/describeError.js";
import { logAudit } from "../../lib/audit.js";
import { enqueueBackgroundJob } from "../../jobs/enqueue.js";
import {
  TIKTOK_PUBLISH_RETRY_JOB_TYPE,
  TIKTOK_PUBLISH_RETRY_MAX_ATTEMPTS,
  TIKTOK_PUBLISH_RETRY_FIRST_DELAY_MS,
  tiktokPublishRetryDedupeKey,
} from "../../jobs/tiktokPublishRetryPolicy.js";
import { CLIP_COMPRESS_MAX_ATTEMPTS } from "../../jobs/clipCompress.js";
import { publishApprovedPost, type PublishChannel } from "../../lib/socialPublish.js";
import {
  publishPropertyCardStory,
  publishPropertyInstagramStories,
  publishPropertySoldStory,
} from "../../lib/instagramStories.js";
import { requireMarketingRole, hasMarketingRole } from "../marketing.js";
import { publishPropertyPhotoPost, removePropertyPhotoPosts } from "../../lib/photoPosts.js";
import { countRemovableSocialExtras, removeSocialExtras } from "../../lib/socialExtrasRemoval.js";
import { publishPropertyRepost, removePropertySocialReposts } from "../../lib/socialReposts.js";
import {
  removeFromSocial,
  sendBackToMontajer,
  openForManualFinalVideo,
  refreshPublishedCaptions,
  markRemovedByHand,
} from "../../lib/publishedVideoFix.js";
import {
  abortLocalUploadSession,
  completeLocalUploadSession,
  completeLocalUploadSessionToPath,
  createLocalUploadSession,
  localVideoDelete,
  localVideoExists,
  localVideoFilePath,
  localVideoUpload,
  writeLocalUploadPart,
} from "../../lib/localVideoStorage.js";
import { signVideoDownloadToken, verifyVideoDownloadToken } from "../../auth/jwt.js";
import { notifySourceFilesChanged } from "../../lib/propertyEditNotify.js";
import { canManageProperty, parseUploadKeys, presentVideo, propertyEditLockBody, publishedActionDeniedReason } from "./shared.js";
import { UNSUPPORTED_VIDEO_MESSAGE, videoExtensionOf } from "../../lib/videoFileExtension.js";
import { anyParams } from "../../lib/routeParams.js";
import {
  completeVideoSessionSchema,
  markRemovedByHandSchema,
  publishAtSchema,
  sendBackToMontajerSchema,
  VIDEO_REMAKE_REASONS,
  montajerMayUploadFinal,
  MONTAJER_FINAL_UPLOAD_CLOSED_MESSAGE,
  UPLOAD_VIDEO_MAX_BYTES,
  VIDEO_TOO_LARGE_CODE,
  videoTooLargeMessage,
} from "@royal-home/shared";
import { generateStoryCard } from "../../lib/video/storyCard.js";
import { resyncPhotosIfPublished } from "../../lib/siteSync.js";

/** Текст отказа, когда объекта нет или он в Корзине — один на все загрузки видео. */
const PROPERTY_GONE_MESSAGE = "Объект не найден или удалён";

/**
 * Объект жив или 404 (находка №188). Раньше сырое видео, сессии докачки и готовый
 * ролик писались в объект из Корзины: файлы ложились на диск, а карточка в
 * Корзине их никому не показывает. У роутов с файлом multer уже положил его во
 * временную папку — убираем, иначе он осиротеет.
 */
function isGone<T extends { deletedAt: Date | null }>(property: T | null): property is null {
  return !property || property.deletedAt !== null;
}

async function replyGone(req: Request, res: { status: (code: number) => { json: (body: unknown) => unknown } }): Promise<void> {
  const tmp = (req as Request & { file?: { path?: string } }).file?.path;
  if (tmp) await fs.rm(tmp, { force: true }).catch(() => {});
  res.status(404).json({ error: PROPERTY_GONE_MESSAGE });
}

// Белый список расширений видео (находка №189) — общий с черновиком мастера и
// роликами продавца из переписки: lib/videoFileExtension.ts (D15, 02.10.2026).

/** Потолок размера загрузки по частям — ЕДИНЫЙ предел видео (packages/shared,
 *  07.10.2026): тот же у мастера, у сессий карточки (любая цель, находка №163) и
 *  у одиночного приёма готового ролика (upload.ts::videoHandoffUpload). */
const MAX_VIDEO_SESSION_BYTES = UPLOAD_VIDEO_MAX_BYTES;

export const videosRouter = Router();

/**
 * Факты сырого файла — В ФОНЕ, ПОСЛЕ того как строка PropertyVideo уже создана
 * и ответ агенту ушёл (23.09.2026, задание C). ffprobe на 4K-ролике — не
 * доли секунды, а загрузка с площадки и так идёт минутами; ждать ещё и разбор
 * файла означало бы держать агента дольше без всякой пользы для него самого.
 * Одна функция на обе точки создания записи (одиночная загрузка и докачка по
 * частям) — не дублируем then/catch дважды. Отказ ffprobe — не ошибка загрузки:
 * поля остаются null, причина уходит в журнал, а не в ответ агенту.
 */
function scheduleRawVideoFactsProbe(video: PropertyVideo): void {
  const filePath = localVideoFilePath(video.storageKey);
  if (!filePath) return;
  void probeRawVideoFacts(filePath)
    .then((facts) => {
      if (!facts) return;
      return prisma.propertyVideo.update({
        where: { id: video.id },
        data: {
          hasAudio: facts.hasAudio,
          durationSec: facts.durationSec,
          width: facts.width,
          height: facts.height,
          videoCodec: facts.videoCodec,
        },
      });
    })
    .catch((err) =>
      // "storage" — тот же источник, что и у остальных отказов хранилища сырого
      // видео в этом файле (localVideoUpload/localVideoDelete выше); заводить
      // отдельный SystemErrorSource ради одной фоновой пробы незачем.
      logSystemError("storage", `Объект ${video.propertyId}: не удалось разобрать факты видео ${video.filename}: ${err instanceof Error ? err.message : String(err)}`)
    );
}

/**
 * Право работать с приёмом готового ролика от монтажёра — ОДНА проверка на все
 * точки входа (одиночная загрузка ниже, докачка с середины purpose=HANDOFF):
 * canManageProperty ИЛИ ровно назначенный в Настройках монтажёр
 * (Settings.videoMontajerAgentId), см. докстринг у /:id/video-handoff/upload.
 * До 23.09.2026 это было зашито в одном обработчике — вынесено, когда докачка
 * с середины завела вторую точку входа с тем же правилом.
 */
async function canManageOrIsHandoffMontajer(req: Request, property: { status: string; offSite?: boolean | null; assignedAgentId?: string | null; intakeAgentId?: string | null; createdById?: string | null }): Promise<boolean> {
  // После публикации агент-владелец готовый ролик не загружает (07.10.2026) —
  // это делает руководство или назначенный монтажёр; агент просит заявкой.
  if (canManageProperty(req, property) && !publishedActionDeniedReason(req, property)) return true;
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
  return !!(req.agent && settings?.videoMontajerAgentId === req.agent.id);
}

/**
 * Кто может ОТКРЫТЬ приём готового ролика у объекта, который его сейчас не
 * ждёт (`videoHandoffStatus !== "SENT_TO_EDITOR"`) — одна проверка вместо
 * двух копий (25.09.2026, панель монтажёра, В1 спецификации). Ведущий объект
 * (canManageProperty) — всегда, КРОМЕ роли EDITOR: у неё есть
 * `properties.editForeign` с 08.09.2026, и без этой оговорки монтажёр мог бы
 * реоткрыть приём у ЛЮБОГО чужого объекта в любом состоянии — а не только у
 * своего, в окне после приёма (montajerMayUploadFinal). Монтажёр (EDITOR или
 * назначенный в Настройках `Settings.videoMontajerAgentId` без прав на объект)
 * — только в этом окне. Возвращает текст отказа или null (можно открывать).
 */
function finalReopenDeniedReason(
  req: Request,
  property: {
    videoHandoffStatus: string | null;
    videoHandoffReceivedAt: Date | null;
    publishedChannels: string[];
    assignedAgentId?: string | null;
    intakeAgentId?: string | null;
    createdById?: string | null;
  }
): string | null {
  const isMontajerCaller = req.agent?.role === "EDITOR" || !canManageProperty(req, property);
  if (!isMontajerCaller) return null;
  const allowed = montajerMayUploadFinal(
    {
      videoHandoffStatus: property.videoHandoffStatus,
      receivedAt: property.videoHandoffReceivedAt,
      publishedChannels: property.publishedChannels,
    },
    Date.now()
  );
  return allowed ? null : MONTAJER_FINAL_UPLOAD_CLOSED_MESSAGE;
}

/** Ответ на принятый готовый ролик — один для одиночной загрузки и докачки.
 *  `notPublishingReason` — файл принят, но в сети сам не уйдёт (см.
 *  lib/videoHandoff.ts::handoffNotPublishingReason); карточка показывает его
 *  вместо часа выхода. */
function handoffReceivedBody(result: Extract<Awaited<ReturnType<typeof receiveEditedVideo>>, { ok: true }>) {
  return {
    videoHandoffStatus: "RECEIVED",
    publishSummary: result.summary,
    scheduledPublishAt: result.scheduledPublishAt ?? null,
    notPublishingReason: result.notPublishingReason ?? null,
    /** Ролик встал на проверку модератора (Settings.clipReviewEnabled) — «Загрузить и
     *  выпустить сразу» сам одобряет его тем, у кого есть право (05.10.2026). */
    clipReviewPending: result.clipReviewPending ?? false,
    /** Сети, где остался СТАРЫЙ ролик (Б4, 25.09.2026) — карточка говорит это
     *  словами, чтобы замена не считалась сделанной везде. */
    oldVideoLeftIn: result.oldVideoLeftIn ?? [],
  };
}

/**
 * Общий хвост приёма готового ролика от монтажёра — вынесен из одиночной
 * загрузки (23.09.2026, докачка с середины покрытой тем же кодом): ЗАМЕНА
 * РОЛИКА ВРУЧНУЮ, проверка «объект правда ждёт файл» с реоткрытием
 * (openForManualFinalVideo), сам приём (receiveEditedVideo/receiveEditedVideoFromFile
 * — передаёт вызывающий код) и форма ответа. Права уже проверены вызывающим
 * кодом (canManageOrIsHandoffMontajer) — здесь их не повторяем.
 *
 * `receive` — то, чем закончить приём: буфером (одиночная загрузка) или уже
 * собранным на диске файлом (докачка с середины) — единственное, чем
 * различаются два маршрута, оборачивать в отдельные копии этого блока незачем.
 */
async function finishHandoffAfterStateCheck(
  req: Request,
  property: NonNullable<Awaited<ReturnType<typeof prisma.property.findUnique>>>,
  receive: () => Promise<Awaited<ReturnType<typeof receiveEditedVideo>>>
): Promise<{ status: number; body: Record<string, unknown> }> {
  /**
   * ЗАМЕНА РОЛИКА ВРУЧНУЮ (19.09.2026, владелец: «чтобы можно было добавить
   * файл через CRM, и оно само разошлось по соцсетям»).
   *
   * Раньше здесь стоял глухой отказ: объект обязан был прямо сейчас ждать файл.
   * Готовый ролик, пришедший мимо бота — в WhatsApp, на флешке, от другого
   * монтажёра, — принять было нельзя вообще. Теперь тот, кто ведёт объект,
   * может открыть приём сам; монтажёру (EDITOR или назначенный в Настройках) —
   * только в окне montajerMayUploadFinal (В1, 25.09.2026: раньше комментарий
   * здесь говорил «монтажёру это по-прежнему недоступно», но проверка стояла
   * ровно canManageProperty — а у EDITOR есть properties.editForeign с
   * 08.09.2026, так что монтажёр реоткрывал приём у ЛЮБОГО чужого объекта в
   * любом состоянии; finalReopenDeniedReason закрывает эту дыру одной проверкой).
   */
  const reopenDenied = finalReopenDeniedReason(req, property);
  if (property.videoHandoffStatus !== "SENT_TO_EDITOR") {
    if (reopenDenied) {
      return { status: 409, body: { error: reopenDenied } };
    }
    const opened = await openForManualFinalVideo(property.id);
    if (!opened.ok) return { status: 409, body: { error: opened.error } };
    logAudit(req, "PROPERTY_FINAL_VIDEO_MANUAL", "Property", property.id, { shortId: property.shortId });
  }

  // Объект действительно держал монтажёр (не ручное ожидание) — запомним до приёма.
  const heldByMontajer = property.videoHandoffStatus === "SENT_TO_EDITOR" && !property.videoHandoffManualSince;
  const result = await receive();
  if (!result.ok) {
    // Отказ приёма не отменяет уже принятый прежний ролик (24.09.2026).
    await closeManualFinalVideoWait(property.id);
    return { status: 409, body: { error: result.error } };
  }
  // Загрузил сотрудник, а не сам монтажёр: монтажёр получает «готов, доделывать не
  // нужно», следующий из очереди уже ушёл вслед за приёмом (05.10.2026).
  if (heldByMontajer && req.agent?.role !== "EDITOR") {
    void notifyMontajerFinalUploadedManually(property.id, property.shortId).catch((err) =>
      console.error("[video-handoff] уведомление монтажёру о ручной загрузке:", err)
    );
  }
  return { status: 200, body: handoffReceivedBody(result) };
}

/**
 * Короткий сжатый ролик карточки объекта (docs/plan-18-08-private-listings-and-video.md
 * §3) — НЕ то же самое, что "сырое видео" ниже (videoUpload/PropertyVideo: исходники
 * монтажёру на диске сервера, десятки роликов в 4K) и не Instagram Reels (instagramUrl). Один
 * ролик на объект: повторная загрузка заменяет предыдущий файл. Задуман в первую
 * очередь для несайтовых (offSite) объектов — они не проходят конвейер фото/видео
 * Маркетинга и Reels-монтаж вовсе, — но не ограничен только ими: обычный объект
 * тоже может получить короткий обзорный ролик прямо на карточке.
 *
 * Отвечаем сразу после проверки длительности, не дожидаясь сжатия: задание
 * clip-compress (jobs/clipCompress.ts, worker-контейнер) само обновит
 * clipVideoStatus/clipVideoUrl, когда ffmpeg закончит. «Компромисс v1» —
 * потеря задачи при падении процесса и вечный PROCESSING — закрыт очередью
 * 27.08.2026 (чертёж Б4). Исходник ждёт сжатия в ОБЩЕМ томе (clipVideoDir,
 * префикс incoming-): /tmp у контейнеров разный, /app/uploads — один.
 */
videosRouter.post("/:id/clip-video", requireAuth, anyParams(clipVideoUpload.single("video")), async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (isGone(property)) return replyGone(req, res);
  if (!canManageProperty(req, property)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  const lock = propertyEditLockBody(req, property);
  if (lock) return res.status(409).json(lock);

  const file = req.file;
  if (!file) return res.status(400).json({ error: "Файл не получен" });

  // К9 (11.09.2026): multer теперь на diskStorage (upload.ts) — файл уже лежит
  // во временном каталоге, здесь переносим его в рабочую папку клипов.
  const inputFilename = `incoming-${randomUUID()}`;
  const inputPath = path.join(clipVideoDir, inputFilename);
  await moveUploadedFile(file.path, inputPath);

  const durationSec = await probeDurationSec(inputPath);
  if (durationSec === null) {
    await fs.rm(inputPath, { force: true });
    return res.status(400).json({ error: "Не удалось определить длительность видео" });
  }
  if (durationSec > MAX_CLIP_VIDEO_DURATION_SEC) {
    await fs.rm(inputPath, { force: true });
    return res.status(400).json({
      error: `Видео длиннее ${MAX_CLIP_VIDEO_DURATION_SEC} секунд (${Math.round(durationSec)}с) — обхода квартиры должно хватать короче`,
    });
  }

  // clipVideoPendingInput — «побеждает последний файл» (Б9, lib/diskCleanup.ts
  // не отвечает за это поле, только jobs/clipCompress.ts и этот роут): задание,
  // чьё имя входа с ним разойдётся к моменту завершения сжатия, устарело и
  // выходит без записи, а не переписывает карточку старым результатом.
  await prisma.property.update({
    where: { id: property.id },
    data: { clipVideoStatus: "PROCESSING", clipVideoPendingInput: inputFilename },
  });

  // Дедуп-ключа НАРОЧНО нет: повторная загрузка при ждущем задании обязана
  // ставить НОВОЕ (свежий файл важнее) — раньше это тихо теряло свежую
  // загрузку (см. clipVideoPendingInput выше), теперь побеждает.
  const queued = await enqueueBackgroundJob({
    type: "clip-compress",
    payload: {
      propertyId: property.id,
      inputFilename,
      outputFilename: `${randomUUID()}.mp4`,
      previousUrl: property.clipVideoUrl,
      sizeBytes: file.size,
      durationSec: Math.round(durationSec),
    },
    maxAttempts: CLIP_COMPRESS_MAX_ATTEMPTS,
  });
  if (!queued.enqueued) {
    // Задание не встало в очередь (07.10.2026): оставить «PROCESSING» значило бы
    // навсегда показывать «обрабатывается» там, где обрабатывать некому.
    // Возвращаем прежнее состояние карточки и честно говорим агенту.
    await prisma.property.update({
      where: { id: property.id },
      data: { clipVideoStatus: property.clipVideoStatus, clipVideoPendingInput: property.clipVideoPendingInput },
    });
    await fs.rm(inputPath, { force: true });
    return res.status(503).json({ error: "Не удалось поставить видео в обработку — попробуйте ещё раз" });
  }

  res.status(202).json({ clipVideoStatus: "PROCESSING" });
});

/**
 * Приём готового ролика от монтажёра через CRM-панель (01.09.2026,
 * lib/videoHandoff.ts) — второй путь рядом с ответом монтажёра в Telegram, для
 * файлов больше 20 МБ (потолок Telegram Bot API) или пока монтажёр не привязал
 * бота. Доступ — canManageProperty ИЛИ ровно назначенный в Настройках монтажёр
 * (Settings.videoMontajerAgentId): у него самого объект обычно не в assignedAgentId.
 * Публикация без второй модерации — та же логика, что и у ответа боту.
 */
videosRouter.post("/:id/video-handoff/upload", requireAuth, anyParams(videoHandoffUpload.single("video")), async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (isGone(property)) return replyGone(req, res);

  if (!(await canManageOrIsHandoffMontajer(req, property))) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }

  const file = req.file;
  if (!file) return res.status(400).json({ error: "Файл не получен" });

  // К9 (11.09.2026): файл принят на диск (multer diskStorage), а не в память.
  // Временный файл убираем в любом случае, включая падение приёма.
  /**
   * ОТВЕТ УХОДИТ ПОСЛЕ УБОРКИ, А НЕ ДО НЕЁ (20.09.2026).
   *
   * Раньше `res.json(...)` стоял внутри try, а `fs.rm` — в finally, то есть
   * ПОСЛЕ ответа. Снаружи это выглядит как выполненное обещание «временный файл
   * убран сразу после обработки», хотя на деле вызывающий может увидеть 200
   * раньше, чем файл исчез. Проверка в tests/video-handoff.test.ts на это и
   * ловилась: под нагрузкой прогона она считала каталог быстрее, чем finally
   * успевал отработать, и падала случайно — «плавающий тест», из-за которого
   * заворачивало чужие правки. Причина была не в проверке: обещание кода просто
   * не выполнялось к моменту ответа.
   *
   * Теперь итог складывается в переменную, finally убирает файл, и только потом
   * уходит ответ — обещание становится правдой для того, кто его читает.
   * Исключение по-прежнему летит наверх через тот же finally.
   */
  let outcome: { status: number; body: Record<string, unknown> };
  try {
    // ПЕРЕНОС ФАЙЛА, А НЕ ЧТЕНИЕ В ПАМЯТЬ (аудит 23.09.2026, круг 3, №74).
    // Ролик до 2 ГБ целиком читался в буфер при контейнере в 768 МБ: одна
    // загрузка большого ролика роняла API. Файл уже на диске — переносим его
    // тем же путём, что и докачку частями; finally ниже уберёт остаток, если
    // перенос не состоялся.
    outcome = await finishHandoffAfterStateCheck(req, property, () =>
      receiveEditedVideoFromFile(property.id, file.path, file.originalname)
    );
  } finally {
    await fs.rm(file.path, { force: true });
  }
  res.status(outcome.status).json(outcome.body);
});

/**
 * Объекты, по которым ручная кнопка TikTok публикует прямо сейчас. Второе
 * нажатие (две вкладки, два человека, карточка не успела обновиться) до
 * ответа первого видело бы TikTok ещё не вышедшим и выложило бы тот же ролик
 * второй раз. Хватает памяти процесса: кнопку обслуживает один процесс API,
 * а фоновые задания отсекаются по своему статусу RUNNING ниже.
 */
const tiktokManualInFlight = new Set<string>();

/**
 * Ручная публикация готового ролика в TikTok (17.09.2026) — для демо-видео на
 * ревью приложения TikTok (нужен реальный клик в интерфейсе, автопубликация
 * этого не даёт) и для повторной отправки, когда объект уже опубликован в
 * остальных каналах, а TikTok — ещё нет. Права — как у кабинета маркетинга
 * (requireMarketingRole, общий helper с routes/marketing.ts и routes/tiktok.ts,
 * не вторая копия проверки роли).
 *
 * skipChannels исключает ВСЕ каналы, кроме TIKTOK — publishApprovedPost умеет
 * публиковать в один канал ровно этим приёмом (тот же параметр, что у повтора
 * после частичного отказа), второй функции заводить не пришлось.
 *
 * Успех записывается applySucceededPublishResults (lib/videoHandoff.ts) — той же
 * функцией, что у автопубликации монтажёра и отложенного повтора, не копией.
 */
videosRouter.post("/:id/tiktok-publish", requireAuth, requireMarketingRole, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден или удалён" });
  if (!property.videoHandoffFinalPath) {
    return res.status(409).json({ error: "У объекта нет готового ролика от монтажёра — публиковать нечего" });
  }
  // Проданный/снятый/забронированный объект не рекламируем (25.09.2026, Б1) —
  // тот же предикат, что у задания публикации.
  const statusBlock = handoffStatusBlockReason(property.status);
  if (statusBlock) return res.status(409).json({ error: statusBlock });
  // Ролик ждёт проверки модератора (25.09.2026, lib/clipReview.ts) — ручная
  // кнопка TikTok не должна обходить её так же, как «Опубликовать сейчас».
  if (property.clipReviewStatus === "PENDING") return res.status(409).json({ error: CLIP_REVIEW_PENDING_ERROR });

  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { tiktokRefreshToken: true, tiktokPrivacyLevel: true },
  });
  if (!settings?.tiktokRefreshToken) {
    return res.status(409).json({ error: "TikTok не подключён — Настройки → Каналы связи → TikTok" });
  }
  if (!settings.tiktokPrivacyLevel) {
    return res.status(409).json({ error: "Не выбран уровень приватности TikTok — Настройки → Каналы связи → TikTok" });
  }

  /**
   * БЕЗ ДУБЛЯ В TIKTOK (24.09.2026, владелец: «чтобы не было дубликата… со
   * всех сторон надо все функции смотреть»). Карточка прячет кнопку у
   * вышедшего ролика, но карточка бывает устаревшей, а TikTok не даёт удалять
   * вышедшее — лишний ролик остался бы там навсегда. Поэтому сервер
   * отказывает сам: TikTok уже в publishedChannels; идёт публикация по
   * расписанию или отложенный повтор TikTok (их задания в статусе RUNNING);
   * по этому объекту ещё не ответило прошлое нажатие. Ждущее своего часа
   * задание (PENDING) не мешает: оно пропустит TikTok, раз канал уже записан
   * (skipChannels от publishedChannels в publishHandoffResult и проверка в
   * jobs/tiktokPublishRetry.ts).
   */
  if ((property.publishedChannels ?? []).includes("TIKTOK")) {
    return res.status(409).json({ error: "Ролик уже вышел в TikTok — второй раз не публикуем, чтобы не было дубля" });
  }
  if ((await isHandoffPublishRunning(property.id)) || tiktokManualInFlight.has(property.id)) {
    return res.status(409).json({ error: "Публикация уже идёт — через минуту-две ролик выйдет" });
  }

  const ALL_CHANNELS_EXCEPT_TIKTOK: PublishChannel[] = ["INSTAGRAM", "FACEBOOK", "TELEGRAM", "YOUTUBE", "THREADS"];
  tiktokManualInFlight.add(property.id);
  let result: Awaited<ReturnType<typeof publishApprovedPost>>[number] | undefined;
  try {
    [result] = await publishApprovedPost({
      propertyId: property.id,
      localVideoPath: property.videoHandoffFinalPath,
      localCoverPath: null,
      caption: property.reelsCaption ?? "",
      skipChannels: ALL_CHANNELS_EXCEPT_TIKTOK,
    });

    // Та же запись, что у отложенного повтора (jobs/tiktokPublishRetry.ts):
    // канал плюс id поста — без id карточка не находила ссылку на ролик в
    // TikTok. finalize: false — ручная кнопка, как и раньше, только отмечает
    // канал и не переводит объект в «Продаётся».
    if (result?.ok) {
      await applySucceededPublishResults(property.id, [{ channel: "TIKTOK", postId: result.postId }], null, {
        finalize: false,
      });
    }
  } finally {
    tiktokManualInFlight.delete(property.id);
  }

  /**
   * «СЕЙЧАС НЕЛЬЗЯ, ПОЗЖЕ МОЖНО» (23.09.2026) — ставим тот же отложенный повтор,
   * что и автопубликация (lib/videoHandoff.ts): нажавший кнопку человек не
   * должен сторожить лимит TikTok и жать её снова через час. Ключ на объект,
   * так что второе нажатие второго задания не заведёт.
   */
  if (result && !result.ok && result.retriable) {
    await enqueueBackgroundJob({
      type: TIKTOK_PUBLISH_RETRY_JOB_TYPE,
      payload: { propertyId: property.id },
      dedupeKey: tiktokPublishRetryDedupeKey(property.id),
      maxAttempts: TIKTOK_PUBLISH_RETRY_MAX_ATTEMPTS,
      runAt: new Date(Date.now() + TIKTOK_PUBLISH_RETRY_FIRST_DELAY_MS),
    });
  }

  logAudit(req, "PROPERTY_TIKTOK_PUBLISHED", "Property", property.id, {
    ok: result?.ok ?? false,
    error: result?.error ?? null,
    note: result?.note ?? null,
    retryScheduled: Boolean(result && !result.ok && result.retriable),
  });

  res.status(200).json({
    ok: result?.ok ?? false,
    note: result?.note,
    error: result?.error,
    /** Отказа нет, есть ожидание: карточка показывает это словами, а не красным. */
    retryScheduled: Boolean(result && !result.ok && result.retriable),
  });
});

/**
 * ИСТОРИИ INSTAGRAM (21.09.2026, владелец: «сделай нам истории, чтобы были») —
 * ручная публикация готового ролика в истории, кнопка «Выложить в истории» в
 * PropertyVideoFixCard.tsx. Не спрашивает Settings.instagramStoriesEnabled
 * (`force: true`) — ровно как ручной /tiktok-publish выше не спрашивает
 * autoPublishEnabled: это явное действие человека, а не автомат. Права — как у
 * кабинета маркетинга, тот же requireMarketingRole.
 *
 * publishedChannels/publishedPostIds НЕ трогает — история не публикация в
 * ленту, см. докстринг lib/instagramStories.ts.
 */
videosRouter.post("/:id/instagram-stories-publish", requireAuth, requireMarketingRole, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден или удалён" });
  if (!property.videoHandoffFinalPath) {
    return res.status(409).json({ error: "У объекта нет готового ролика от монтажёра — публиковать нечего" });
  }
  // Ролик проданного/снятого объекта в истории не выкладываем (25.09.2026, Б1).
  // Печать «Продано» — отдельная кнопка (/instagram-story-sold), её это не касается.
  const statusBlock = handoffStatusBlockReason(property.status);
  if (statusBlock) return res.status(409).json({ error: statusBlock });
  // Ролик ждёт проверки модератора (lib/clipReview.ts): «без Одобрить в сети не
  // выйдет», а force ниже обходит только рубильник автопубликации, не проверку
  // (аудит 04.10.2026, PUB09). Тот же гейт, что у /tiktok-publish выше.
  if (property.clipReviewStatus === "PENDING") return res.status(409).json({ error: CLIP_REVIEW_PENDING_ERROR });

  const summary = await publishPropertyInstagramStories(property.id, property.videoHandoffFinalPath, { force: true });

  logAudit(req, "PROPERTY_INSTAGRAM_STORIES_PUBLISHED", "Property", property.id, {
    publishedParts: summary.publishedParts,
    totalParts: summary.totalParts,
    error: summary.error ?? null,
  });

  const ok = summary.publishedParts > 0 && summary.publishedParts === summary.totalParts;
  res.status(200).json({ ok, publishedParts: summary.publishedParts, totalParts: summary.totalParts, error: summary.error });
});

/**
 * КАРТОЧКА ОБЪЕКТА В ИСТОРИИ — кнопка «Карточку в истории» (21.09.2026).
 * Работает у любого объекта с фотографией, ролик монтажёра не требуется:
 * предпросмотр той же картинки отдаёт GET /:id/story-card.jpg ниже.
 */
videosRouter.post("/:id/instagram-story-card", requireAuth, requireMarketingRole, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден или удалён" });

  const summary = await publishPropertyCardStory(property.id, { force: true });

  logAudit(req, "PROPERTY_INSTAGRAM_STORY_CARD_PUBLISHED", "Property", property.id, {
    published: summary.publishedParts,
    error: summary.error ?? null,
  });

  res.status(200).json({ ok: summary.publishedParts === 1, error: summary.error ?? null });
});

/**
 * ИСТОРИЯ «ПРОДАНО» — кнопка «Печать «Продано» в историю» в карточке объекта
 * (21.09.2026, владелец: «типа печать поставить типа продано, как в других
 * компаниях делают»). Ролик монтажёра не нужен: карточка рисуется по главному
 * фото, поэтому объект без ролика тоже закрывается печатью.
 *
 * Статус объекта проверяется здесь, а не в публикации: печать «продано» на
 * объекте, который ещё продаётся, — это не сбой кода, а ошибка человека, и
 * отвечать на неё надо понятным 409, а не молчаливым отказом.
 *
 * publishedChannels/publishedPostIds НЕ трогает — история не публикация в
 * ленту, см. докстринг lib/instagramStories.ts.
 */
videosRouter.post("/:id/instagram-story-sold", requireAuth, requireMarketingRole, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден или удалён" });
  if (property.status !== "SOLD") {
    return res.status(409).json({ error: "Объект не в статусе «продан» — печать ставить рано" });
  }

  const summary = await publishPropertySoldStory(property.id, { force: true });

  logAudit(req, "PROPERTY_INSTAGRAM_STORY_SOLD_PUBLISHED", "Property", property.id, {
    published: summary.publishedParts,
    error: summary.error ?? null,
  });

  res.status(200).json({ ok: summary.publishedParts === 1, error: summary.error ?? null });
});

/**
 * Когда последний раз выкладывали историю по этому объекту — MAX(publishedAt)
 * из PropertyStoryPost (21.09.2026). Показывается рядом с кнопкой «Выложить в
 * истории», чтобы не гадать, публиковалось ли уже сегодня. `channel`
 * (28.09.2026) — с приходом Facebook «последняя история» может быть на любой
 * из двух площадок, карточка объекта показывает какой (ChannelIcon).
 */
videosRouter.get("/:id/instagram-stories/last", requireAuth, async (req, res) => {
  const last = await prisma.propertyStoryPost.findFirst({
    where: { propertyId: req.params.id },
    orderBy: { publishedAt: "desc" },
    select: { publishedAt: true, channel: true },
  });
  res.json({ lastPublishedAt: last?.publishedAt ?? null, channel: last?.channel ?? null });
});

/**
 * Сырое видео объекта (владелец 05.08.2026: агент снимает сам, без монтажа,
 * до ~20 роликов в 4K — гигабайты на объект). Хранится на диске сервера, в
 * ЗАКРЫТОЙ папке вне uploads (31.08.2026, до этого — Cloudflare R2, см.
 * lib/localVideoStorage.ts). Видимость та же, что и у остальной карточки на
 * этой стадии: canManageProperty (монтажёр/маркетинг/админ/создавший агент),
 * больше никто не видит объект до публикации.
 *
 * ПРЕДЕЛ ФАЙЛА — ЕДИНЫЙ (UPLOAD_VIDEO_MAX_BYTES, packages/shared, 07.10.2026).
 * Прежняя настройка Settings.propertyVideoMaxSizeMb (600 МБ) больше не читается:
 * колонка осталась в базе, но в интерфейсе не редактировалась, а второе число
 * рядом с общим пределом и давало расхождение «подсказка одно, сервер другое».
 *
 * ЭТОТ МАРШРУТ (одиночный POST, memoryStorage) — НЕ ДЛЯ БОЛЬШИХ РОЛИКОВ: веб
 * грузит видео объекта ТОЛЬКО сессиями по частям (upload-sessions ниже,
 * lib/uploadQueue.ts), а здесь файл целиком ложится в оперативную память ДО
 * проверок, поэтому потолок самого multer остаётся 700 МБ × 5 файлов (аудит
 * лимитов 21.08.2026) и сознательно НЕ поднят до общего предела: 2 ГБ × 5 в RAM
 * уронили бы процесс. Выше 700 МБ этот маршрут отвечает ошибкой multer, а общий
 * предел действует там, где ролики и правда идут большими, — в сессиях.
 */
const MAX_VIDEOS_PER_REQUEST = 5;
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 700 * 1024 * 1024, files: MAX_VIDEOS_PER_REQUEST },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("video/")) {
      return cb(new UploadRejectedError("Допустимо только видео"));
    }
    cb(null, true);
  },
});

videosRouter.post("/:id/videos", requireAuth, anyParams(videoUpload.array("videos", MAX_VIDEOS_PER_REQUEST)), async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (isGone(property)) return replyGone(req, res);
  if (!canManageProperty(req, property)) return res.status(403).json({ error: "Недостаточно прав" });
  const lock = propertyEditLockBody(req, property);
  if (lock) return res.status(409).json(lock);
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) return res.status(400).json({ error: "Файлы не переданы" });

  const parsedKeys = parseUploadKeys(req.body?.uploadKeys, files.length);
  if (!parsedKeys.ok) return res.status(400).json({ error: parsedKeys.error });
  const uploadKeys = parsedKeys.keys;
  // Тип файла — до записи на диск (находка №189): неподдерживаемое расширение
  // иначе давало ключ, который хранилище не принимает.
  const badVideo = files.find((f) => videoExtensionOf(f.originalname) === null);
  if (badVideo) return res.status(400).json({ error: `Файл «${badVideo.originalname}»: ${UNSUPPORTED_VIDEO_MESSAGE}` });

  /**
   * Уже загруженное с прошлой попытки — см. подробный разбор у фотографий выше.
   * Для видео это важнее вдвое: файл идёт минутами, ответ теряется чаще, а
   * повторная запись гигабайта на диск — впустую потраченное время и место.
   */
  const alreadyStored = uploadKeys?.length
    ? await prisma.propertyVideo.findMany({
        where: { uploadKey: { in: uploadKeys } },
        // Имя загрузившего — как в GET: файл мог положить другой сотрудник, и
        // подставлять сюда того, кто повторяет отправку, было бы неправдой.
        include: { uploadedBy: { select: { fullName: true } } },
      })
    : [];
  // Чужой ключ — явный отказ, а не падение на уникальном индексе: см. разбор
  // у фотографий выше (на 5xx очередь повторяла бы отправку вечно).
  if (alreadyStored.some((v) => v.propertyId !== property.id)) {
    return res.status(409).json({ error: "Ключ загрузки уже использован другим объектом" });
  }
  const storedByKey = new Map(alreadyStored.map((v) => [v.uploadKey!, v]));

  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { propertyVideoMaxCount: true },
  });
  const maxCount = settings?.propertyVideoMaxCount ?? 30;

  const oversize = files.find((f) => f.size > UPLOAD_VIDEO_MAX_BYTES);
  if (oversize) {
    return res.status(400).json({
      error: videoTooLargeMessage(oversize.originalname),
      code: VIDEO_TOO_LARGE_CODE,
      limitBytes: UPLOAD_VIDEO_MAX_BYTES,
    });
  }

  const uploader = await prisma.agent.findUnique({
    where: { id: req.agent!.id },
    select: { fullName: true },
  });

  /**
   * ЛИМИТ ЧИСЛА ВИДЕО — ПРОВЕРКА И ЗАПИСЬ ОДНИМ НЕДЕЛИМЫМ ШАГОМ (21.09.2026,
   * аудит «монтажёр ↔ CRM»). Было: currentCount читался и сравнивался с
   * maxCount ДО записи, без транзакции, — два агента, грузящие ролики в один
   * объект одновременно, оба проходили проверку и вместе превышали
   * propertyVideoMaxCount. Тот же приём, что и у очереди монтажа
   * (withQueueLock в lib/videoHandoff.ts), только замок свой на этот
   * propertyId, а не общий на всю очередь — разные объекты друг другу
   * не мешают и ждать друг друга не должны.
   */
  let limitError: string | null = null;
  /** Что отдаём клиенту: и загруженное сейчас, и пришедшее с прошлой попытки. */
  const stored: { video: PropertyVideo; uploaderName: string }[] = [];
  // Явная аннотация (23.09.2026): раньше тип вывода эволюционировал сам по
  // мере push() внутри withPropertyLock — добавленный ниже проход по created
  // для scheduleRawVideoFactsProbe читает массив РАНЬШЕ, чем TS успевает
  // достроить эволюционирующий тип через замыкание транзакции, и без явного
  // типа сборка падает `implicitly has an 'any[]' type`.
  const created: PropertyVideo[] = [];
  await withPropertyLock(property.id, async (tx) => {
    const currentCount = await tx.propertyVideo.count({ where: { propertyId: property.id } });
    // Считаем только НОВЫЕ файлы: уже сохранённые с прошлой попытки сидят в
    // currentCount, и повтор пачки иначе упирался бы в лимит, которого нет.
    const incomingCount = files.length - storedByKey.size;
    if (currentCount + incomingCount > maxCount) {
      limitError = `Лимит видео на объект — ${maxCount}, сейчас уже ${currentCount}`;
      return;
    }
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const uploadKey = uploadKeys?.[i] ?? null;
      const known = uploadKey ? storedByKey.get(uploadKey) : undefined;
      if (known) {
        // Повторной записи на диск не делаем: файл уже лежит под своим ключом.
        stored.push({ video: known, uploaderName: known.uploadedBy.fullName });
        continue;
      }
      const id = randomUUID();
      const ext = videoExtensionOf(file.originalname) ?? ".mp4";
      const storageKey = `${property.id}/${id}${ext}`;
      try {
        await localVideoUpload(storageKey, file.buffer);
      } catch (err) {
        void logSystemError("storage", `Видео объекта не сохранено на диск: ${err instanceof Error ? err.message : String(err)}`);
        // Часть файлов могла уже записаться — отдаём то, что реально загрузилось,
        // а не молча теряем прогресс всей пачки на первой же ошибке.
        break;
      }
      const video = await tx.propertyVideo.create({
        data: {
          propertyId: property.id,
          storageKey,
          filename: file.originalname,
          sizeBytes: file.size,
          uploadedById: req.agent!.id,
          uploadKey,
        },
      });
      created.push(video);
      stored.push({ video, uploaderName: uploader?.fullName ?? "" });
    }
  });
  if (limitError) return res.status(400).json({ error: limitError });

  // По stored, а не по created: повтор, целиком попавший в уже загруженное,
  // создаёт ноль записей — но это успех, а не отказ хранилища. С проверкой по
  // created очередь получала бы 502 и повторяла отправку вечно.
  if (!stored.length) {
    return res.status(502).json({ error: "Не удалось загрузить ни одного файла — попробуйте ещё раз" });
  }

  // Факты — ПОСЛЕ withPropertyLock, когда строки уже реально закоммичены (а не
  // внутри tx, где до конца колбэка ещё есть шанс отката): каждой заново
  // созданной записи, не повторам из stored.
  for (const video of created) scheduleRawVideoFactsProbe(video);

  // Агент дозагрузил видео, пока объект ждал новое, — вернуть на проверку маркетингу.
  // По created, а не stored: повтор, целиком попавший в уже загруженное, ничего нового
  // не принёс и статус двигать не должен (та же оговорка, что и у фото).
  // Проверка исходников выключена (25.09.2026) — объект с фото и видео CRM
  // одобряет сама и отдаёт монтажёру (lib/propertyReview.ts::autoApproveIfRawReviewOff).
  if (created.length > 0) {
    void revertToReviewAfterVideoUpload(property)
      .then(() => autoApproveIfRawReviewOff(property.id))
      .catch((err) => console.error("[конвейер] возврат на проверку после видео:", err));
  }
  // Хронология объекта (владелец 23.09.2026: «все правки в хронологию»).
  if (created.length > 0) {
    logAudit(req, "PROPERTY_VIDEOS_ADDED", "Property", property.id, { shortId: property.shortId, count: created.length });
    // Исходники изменились — монтажёру (если ролик у него) или модератору (07.10.2026).
    void notifySourceFilesChanged(property.id, "video", `добавлено ${created.length}`, req.agent!.id);
  }
  // Той же формой, что и GET: раньше здесь уходили сырые строки таблицы, вместе с
  // storageKey — внутренним путём файла в закрытом хранилище — и uploadedById. Наружу
  // ключ хранилища не нужен никому (скачивание идёт по временной ссылке через
  // отдельный маршрут), а два разных ответа на один и тот же ресурс рано или
  // поздно расходятся: клиент читает то, чего в другом ответе нет.
  // 207 — только когда хранилище оборвало пачку на середине. Файл, засчитанный
  // повтором, потерей не является: он уже лежит, и 207 сбивал бы с толку.
  res
    .status(stored.length === files.length ? 201 : 207)
    .json(stored.map((s) => presentVideo(s.video, s.uploaderName)));
});

/**
 * ДОКАЧКА ВИДЕО С СЕРЕДИНЫ — многочастевая загрузка на локальный диск
 * (31.08.2026, до этого — протокол S3/R2 multipart, см. историю).
 *
 * Одиночный POST /:id/videos выше отправляет файл целиком одним запросом: обрыв
 * связи на 900-й секунде из 900 означает начать заново. Ролик с площадки идёт
 * минутами, и такое повторение — не редкий случай, а обычный вечер на площадке
 * со слабым интернетом.
 *
 * Здесь файл режется на части (планом распоряжается сервер — computeVideoPartPlan),
 * каждая часть шлётся своим запросом с собственным номером и пишется на диск
 * своим файлом (lib/localVideoStorage.ts). Оборвалась связь — очередь на клиенте
 * (lib/uploadQueue.ts) досылает только недостающие части, а не файл заново.
 *
 * Три шага: START заводит сессию и присылает план; PART шлёт одну часть, можно
 * повторять — часть с тем же номером просто перезаписывается, это не создаёт
 * дублей; COMPLETE собирает части по порядку в готовый файл, когда все на месте.
 */

/** 8 МБ — компромисс между числом запросов на большом ролике и ценой повтора
 *  одной части при обрыве. 10 000 частей — тот же потолок, что был у R2:
 *  если при таком размере файл в него не укладывается (десятки терабайт, у нас
 *  такого не бывает), берём часть крупнее, лишь бы уложиться. */
const VIDEO_PART_SIZE = 8 * 1024 * 1024;
const MAX_UPLOAD_PARTS = 10_000;

function computeVideoPartPlan(sizeBytes: number): { partSize: number; totalParts: number } {
  let partSize = VIDEO_PART_SIZE;
  let totalParts = Math.max(1, Math.ceil(sizeBytes / partSize));
  if (totalParts > MAX_UPLOAD_PARTS) {
    partSize = Math.ceil(sizeBytes / MAX_UPLOAD_PARTS);
    totalParts = Math.ceil(sizeBytes / partSize);
  }
  return { partSize, totalParts };
}

/**
 * `purpose` (23.09.2026): RAW (по умолчанию, для обратной совместимости со
 * старым клиентом) — сырое видео объекта, заводит PropertyVideo, как раньше.
 * HANDOFF — готовый ролик от монтажёра через ту же докачку с середины вместо
 * одного запроса POST /:id/video-handoff/upload (та остаётся для Telegram-бота,
 * см. upload.ts::videoHandoffUpload) — на COMPLETE делает ровно то, что раньше
 * делал одиночный приём: receiveEditedVideoFromFile, а не создание PropertyVideo.
 */
const startVideoSessionSchema = z.object({
  uploadKey: z.string().min(1).max(64),
  filename: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  contentType: z.string().min(1).max(100),
  purpose: z.enum(["raw", "handoff"]).default("raw"),
});

function sessionUploadedParts(session: { parts: Prisma.JsonValue }): number[] {
  const raw = session.parts;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => (p && typeof p === "object" && "partNumber" in p ? Number((p as { partNumber: unknown }).partNumber) : null))
    .filter((n): n is number => n !== null && Number.isInteger(n))
    .sort((a, b) => a - b);
}

/**
 * Заводит сессию — или, если этот же ключ уже видели, возвращает её состояние
 * без второго создания папки сессии. Тот же смысл, что и uploadKey у фото/видео
 * целиком (см. разбор выше): обрыв связи после ответа сервера, но до того, как
 * ответ дошёл до телефона, не должен открывать вторую сессию на тот же файл.
 */
videosRouter.post("/:id/videos/upload-sessions", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (isGone(property)) return replyGone(req, res);

  const parsed = startVideoSessionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });
  const { uploadKey, filename, sizeBytes, contentType, purpose } = parsed.data;
  if (!contentType.startsWith("video/")) return res.status(400).json({ error: "Допустимо только видео" });

  // Право заводить сессию: у RAW (сырое видео) — только canManageProperty, как
  // было; у HANDOFF (готовый ролик) — то же правило, что у одиночной загрузки
  // /:id/video-handoff/upload (canManageProperty ИЛИ назначенный монтажёр).
  const permitted = purpose === "handoff" ? await canManageOrIsHandoffMontajer(req, property) : canManageProperty(req, property);
  if (!permitted) return res.status(403).json({ error: "Недостаточно прав" });
  // Тип и размер — на старте, а не после того, как человек закачал гигабайты
  // (находки №189 и №163): расширение идёт в ключ хранения, и неподдерживаемое
  // раньше падало только на сборке файла (502); размер сессии «монтаж» не
  // ограничивался вовсе.
  const startExt = videoExtensionOf(filename);
  if (!startExt) return res.status(400).json({ error: UNSUPPORTED_VIDEO_MESSAGE });
  if (sizeBytes > MAX_VIDEO_SESSION_BYTES) {
    return res.status(400).json({
      error: videoTooLargeMessage(filename),
      code: VIDEO_TOO_LARGE_CODE,
      limitBytes: MAX_VIDEO_SESSION_BYTES,
    });
  }
  // Сырое видео на монтаже — под замком; готовый ролик монтажёра (handoff) — нет.
  if (purpose !== "handoff") {
    const lock = propertyEditLockBody(req, property);
    if (lock) return res.status(409).json(lock);
  }

  // Файл целиком уже собран с прошлой попытки — сессию заново заводить незачем.
  // Для purpose=HANDOFF готовый файл никогда не становится PropertyVideo, этот
  // ключ здесь просто никогда не найдётся — отдельной ветки не требуется.
  const existingVideo = await prisma.propertyVideo.findUnique({
    where: { uploadKey },
    include: { uploadedBy: { select: { fullName: true } } },
  });
  if (existingVideo) {
    if (existingVideo.propertyId !== property.id) {
      return res.status(409).json({ error: "Ключ загрузки уже использован другим объектом" });
    }
    return res.status(200).json({ status: "done", video: presentVideo(existingVideo, existingVideo.uploadedBy.fullName) });
  }

  // Сессия уже открыта — присылаем её план и то, что уже приняли, вместо второй
  // папки сессии на тот же файл.
  const existingSession = await prisma.videoUploadSession.findUnique({ where: { uploadKey } });
  if (existingSession) {
    if (existingSession.propertyId !== property.id) {
      return res.status(409).json({ error: "Ключ загрузки уже использован другим объектом" });
    }
    return res.status(200).json({
      status: "in-progress",
      sessionId: existingSession.id,
      partSize: existingSession.partSize,
      totalParts: existingSession.totalParts,
      uploadedPartNumbers: sessionUploadedParts(existingSession),
    });
  }

  if (purpose === "handoff") {
    // ЗАМЕНА РОЛИКА ВРУЧНУЮ — та же проверка состояния и реоткрытие, что и у
    // одиночной загрузки (finishHandoffAfterStateCheck, finalReopenDeniedReason),
    // но ЗДЕСЬ, на старте сессии, а не на COMPLETE: чинить состояние объекта
    // после того, как человек уже закачал гигабайты по частям, было бы поздно
    // и обидно.
    if (property.videoHandoffStatus !== "SENT_TO_EDITOR") {
      const reopenDenied = finalReopenDeniedReason(req, property);
      if (reopenDenied) {
        return res.status(409).json({ error: reopenDenied });
      }
      const opened = await openForManualFinalVideo(property.id);
      if (!opened.ok) return res.status(409).json({ error: opened.error });
      logAudit(req, "PROPERTY_FINAL_VIDEO_MANUAL", "Property", property.id, { shortId: property.shortId });
    }
  } else {
    // Лимиты числа/веса сырых видео объекта — HANDOFF (один готовый ролик,
    // заменяющий предыдущий, не PropertyVideo) им не подчиняется.
    const [settings, currentCount, activeSessions] = await Promise.all([
      prisma.settings.findUnique({
        where: { id: "singleton" },
        select: { propertyVideoMaxCount: true },
      }),
      prisma.propertyVideo.count({ where: { propertyId: property.id } }),
      prisma.videoUploadSession.count({ where: { propertyId: property.id, purpose: "RAW" } }),
    ]);
    const maxCount = settings?.propertyVideoMaxCount ?? 30;

    // Открытые сессии считаем наравне с готовыми видео: иначе агент мог бы открыть
    // сессий больше лимита и досрочно завершить их все разом.
    if (currentCount + activeSessions + 1 > maxCount) {
      return res.status(400).json({ error: `Лимит видео на объект — ${maxCount}, сейчас уже ${currentCount}` });
    }
    // Размер уже сверен выше с единым пределом (MAX_VIDEO_SESSION_BYTES): вес
    // видео объекта больше не настраивается (Settings.propertyVideoMaxSizeMb, 07.10.2026).
  }

  const { partSize, totalParts } = computeVideoPartPlan(sizeBytes);
  const ext = startExt;
  // Для HANDOFF это поле не читается на COMPLETE (тот собирает во временный
  // файл и переносит через receiveEditedVideoFromFile) — заполняем тем же
  // форматом, что и у RAW, просто как учётную бирку, не как настоящий путь.
  const storageKey = `${property.id}/${randomUUID()}${ext}`;

  // Свой id сессии заранее (а не тот, что выдаст Prisma после create) — папка
  // частей на диске заводится ДО записи в базу: если сервер упадёт между этими
  // двумя шагами, максимум останется пустая папка без записи (её подберёт
  // videoUploadCleanup.ts по возрасту), а не запись без папки для частей.
  const sessionId = randomUUID();
  try {
    await createLocalUploadSession(sessionId);
  } catch (err) {
    void logSystemError("storage", `Не удалось открыть загрузку видео на диск: ${err instanceof Error ? err.message : String(err)}`);
    return res.status(502).json({ error: "Не удалось начать загрузку видео — попробуйте ещё раз" });
  }

  const session = await prisma.videoUploadSession.create({
    data: {
      id: sessionId,
      propertyId: property.id,
      uploadKey,
      storageKey,
      filename,
      sizeBytes,
      contentType,
      partSize,
      totalParts,
      purpose: purpose === "handoff" ? "HANDOFF" : "RAW",
      createdById: req.agent!.id,
    },
  });

  res.status(201).json({ status: "started", sessionId: session.id, partSize, totalParts, uploadedPartNumbers: [] });
});

/**
 * Тело — сырые байты части, не JSON и не multipart/form-data: express.json()
 * выше пропускает его молча (парсит только Content-Type: application/json),
 * поэтому express.raw ставится прямо на этот маршрут, а не на всё приложение —
 * остальным роутам гигабайтный лимит не нужен и был бы риском.
 *
 * Часть с уже принятым номером НЕ ошибка: writeFile её просто перезапишет
 * тем же файлом на диске — и очередь на клиенте может смело повторять
 * последнюю часть после любого сомнения в том, дошла ли она.
 */
videosRouter.put(
  "/:id/videos/upload-sessions/:sessionId/parts/:partNumber",
  requireAuth,
  express.raw({ type: () => true, limit: "32mb" }),
  async (req, res) => {
    const property = await prisma.property.findUnique({ where: { id: req.params.id } });
    if (isGone(property)) return replyGone(req, res);

    const session = await prisma.videoUploadSession.findUnique({ where: { id: req.params.sessionId } });
    if (!session || session.propertyId !== property.id) return res.status(404).json({ error: "Загрузка не найдена" });

    // Право зависит от сессии, а не от заранее объявленного purpose в теле
    // запроса: HANDOFF пускает и назначенного монтажёра, RAW — только
    // canManageProperty, как раньше.
    const permitted = session.purpose === "HANDOFF" ? await canManageOrIsHandoffMontajer(req, property) : canManageProperty(req, property);
    if (!permitted) return res.status(403).json({ error: "Недостаточно прав" });

    const partNumber = Number(req.params.partNumber);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.totalParts) {
      return res.status(400).json({ error: "Неверный номер части" });
    }

    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: "Пустая часть" });
    }
    // Части, кроме последней, обязаны совпадать по размеру с планом — иначе части
    // сдвинутся относительно друг друга и собранный файл не совпадёт с исходным.
    // Последняя часть — хвост файла, она короче плана почти всегда.
    const isLastPart = partNumber === session.totalParts;
    if (!isLastPart && body.length !== session.partSize) {
      return res.status(400).json({ error: "Размер части не совпадает с планом загрузки" });
    }

    try {
      await writeLocalUploadPart(session.id, partNumber, body);
    } catch (err) {
      void logSystemError("storage", `Не удалось записать часть видео на диск: ${err instanceof Error ? err.message : String(err)}`);
      return res.status(502).json({ error: "Часть не дошла до хранилища — попробуйте ещё раз" });
    }

    const parts = sessionUploadedParts(session)
      .filter((n) => n !== partNumber)
      .concat(partNumber)
      .sort((a, b) => a - b);

    await prisma.videoUploadSession.update({
      where: { id: session.id },
      data: { parts: parts.map((n) => ({ partNumber: n })) },
    });

    res.json({ ok: true, partNumber });
  }
);

/**
 * СОБИРАЕТ ФАЙЛ ИЗ ЧАСТЕЙ. Два разных итога по `session.purpose`:
 *  - RAW — заводит PropertyVideo, тот же результат, что у одиночной загрузки
 *    выше, только по итогам многих частей вместо одного запроса.
 *  - HANDOFF (23.09.2026) — готовый ролик от монтажёра: собранный файл уходит
 *    в receiveEditedVideoFromFile (lib/videoHandoff.ts), тот же хвост, что у
 *    одиночного POST /:id/video-handoff/upload (finishHandoffAfterStateCheck
 *    выше уже отработал на СТАРТЕ сессии — здесь состояние объекта заново не
 *    проверяем, оно не могло смениться иначе как через ту же передачу).
 */
videosRouter.post("/:id/videos/upload-sessions/:sessionId/complete", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (isGone(property)) return replyGone(req, res);

  const session = await prisma.videoUploadSession.findUnique({ where: { id: req.params.sessionId } });
  if (!session || session.propertyId !== property.id) return res.status(404).json({ error: "Загрузка не найдена" });

  const permitted = session.purpose === "HANDOFF" ? await canManageOrIsHandoffMontajer(req, property) : canManageProperty(req, property);
  if (!permitted) return res.status(403).json({ error: "Недостаточно прав" });
  // Докачка, начатая до одобрения, не должна дописать сырьё монтажёру задним числом.
  if (session.purpose !== "HANDOFF") {
    const lock = propertyEditLockBody(req, property);
    if (lock) return res.status(409).json(lock);
  }

  const completeBody = completeVideoSessionSchema.safeParse(req.body && Object.keys(req.body).length ? req.body : undefined);
  if (!completeBody.success) return res.status(400).json({ error: "Неверные данные" });
  const isMontajerSource = completeBody.data?.purpose === "MONTAJER_SOURCE";

  const uploadedParts = sessionUploadedParts(session);
  if (uploadedParts.length !== session.totalParts) {
    // Не отказ — ждём: очередь на клиенте досылает недостающие части и повторит
    // завершение сама. 409, а не 400: это про состояние, а не про сам запрос.
    return res.status(409).json({ error: "Не все части получены", uploadedPartNumbers: uploadedParts });
  }

  if (session.purpose === "HANDOFF") {
    const ext = videoExtensionOf(session.filename) ?? ".mp4";
    // Собираем во временный каталог видео-загрузчиков (upload.ts::videoTmpDir),
    // тот же, куда multer кладёт файл одиночной загрузки — receiveEditedVideoFromFile
    // переносит его в videoHandoffDir РОВНО ТЕМ ЖЕ кодом, что и multer-путь.
    const assembledPath = path.join(videoTmpDir, `${randomUUID()}${ext}`);
    try {
      await completeLocalUploadSessionToPath(session.id, assembledPath, session.totalParts);
    } catch (err) {
      void logSystemError("storage", `Не удалось собрать ролик монтажёра из частей на диске: ${err instanceof Error ? err.message : String(err)}`);
      // Части на диске остаются: повтор завершения не требует загружать файл заново.
      return res.status(502).json({ error: "Не удалось собрать файл — попробуйте ещё раз" });
    }
    const result = await receiveEditedVideoFromFile(property.id, assembledPath, session.filename);
    // Сессия свою роль сыграла независимо от исхода приёма — часть на диске уже
    // разобрана (успешно или нет, файл перенесён/удалён внутри receiveEditedVideoFromFile).
    await prisma.videoUploadSession.delete({ where: { id: session.id } }).catch(() => {});
    if (!result.ok) {
      // Отказ приёма не отменяет уже принятый прежний ролик (24.09.2026).
      await closeManualFinalVideoWait(property.id);
      return res.status(409).json({ error: result.error });
    }
    return res.status(200).json(handoffReceivedBody(result));
  }

  try {
    await completeLocalUploadSession(session.id, session.storageKey, session.totalParts);
  } catch (err) {
    void logSystemError("storage", `Не удалось собрать видео из частей на диске: ${err instanceof Error ? err.message : String(err)}`);
    // Части на диске остаются: повтор завершения не требует загружать файл заново.
    return res.status(502).json({ error: "Не удалось собрать файл — попробуйте ещё раз" });
  }

  const uploader = await prisma.agent.findUnique({ where: { id: session.createdById }, select: { fullName: true } });

  /**
   * Гонка двух завершений одной сессии (двойное нажатие «повторить», два тика
   * очереди на разных вкладках) — пишем и смотрим, не упало ли на уникальном
   * ограничении uploadKey, а не проверяем заранее: между проверкой и записью
   * тот же зазор, в котором и рождается гонка (тот же приём, что и в
   * lib/webhookDedupe.ts — арбитром выступает сама база, а не наша проверка).
   */
  let video;
  try {
    video = await prisma.propertyVideo.create({
      data: {
        propertyId: property.id,
        storageKey: session.storageKey,
        filename: session.filename,
        sizeBytes: session.sizeBytes,
        uploadedById: session.createdById,
        uploadKey: session.uploadKey,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
    const raced = await prisma.propertyVideo.findUniqueOrThrow({
      where: { uploadKey: session.uploadKey },
      include: { uploadedBy: { select: { fullName: true } } },
    });
    await prisma.videoUploadSession.delete({ where: { id: session.id } }).catch(() => {});
    // Проигравший гонку файл уже собран на диске (completeLocalUploadSession
    // выше это сделала до того, как create() узнал о победителе) — без удаления
    // здесь он остался бы сиротой: ни одна уборочная задача не находит файлы
    // без строки VideoUploadSession, только по ней и ходит.
    //
    // НО ТОЛЬКО ЕСЛИ ЭТО НЕ ФАЙЛ ПОБЕДИТЕЛЯ (аудит 04.10.2026, PUB12): два завершения
    // ОДНОЙ сессии собирают части в один и тот же session.storageKey, и запись
    // победителя ссылается именно на него — удалив его, мы стёрли бы видео, о котором
    // отвечаем 200 «есть». Сиротой файл бывает только когда у победителя другой ключ.
    if (raced.storageKey !== session.storageKey) void localVideoDelete(session.storageKey);
    return res.status(200).json(presentVideo(raced, raced.uploadedBy.fullName));
  }
  scheduleRawVideoFactsProbe(video);
  // Сессия свою роль сыграла — удаляем её ПОСЛЕ успешной записи видео: если
  // отвалиться раньше, повтор complete() найдёт видео уже созданным (P2002 выше)
  // и лишь подчистит сессию, ничего не потеряв.
  await prisma.videoUploadSession.delete({ where: { id: session.id } }).catch(() => {});

  // Тот же возврат на проверку, что и у обычной загрузки: докачка с середины —
  // такое же «агент переснял и залил», просто файл шёл частями. КРОМЕ нового
  // исходника из «Вернуть монтажёру» (владелец 22.09.2026): это сырьё для
  // перемонтажа, а не новая версия объявления — объект остаётся на своём этапе.
  if (!isMontajerSource) {
    void revertToReviewAfterVideoUpload(property)
      .then(() => autoApproveIfRawReviewOff(property.id))
      .catch((err) => console.error("[конвейер] возврат на проверку после докачки видео:", err));
  }
  logAudit(req, "PROPERTY_VIDEOS_ADDED", "Property", property.id, { shortId: property.shortId, count: 1 });
  if (!isMontajerSource) void notifySourceFilesChanged(property.id, "video", "добавлен 1", req.agent!.id);

  res.status(201).json(presentVideo(video, uploader?.fullName ?? ""));
});

/** Отмена — «убрать из очереди» по незавершённой загрузке. Отвечает сразу: агент
 *  не должен ждать уборку папки сессии, чтобы задание пропало из списка. Если
 *  отмена не удалась, строка остаётся и её подберёт ночная уборка
 *  (lib/videoUploadCleanup.ts) — без этого недописанные части остались бы
 *  висеть на диске без единой ссылки на себя. */
videosRouter.delete("/:id/videos/upload-sessions/:sessionId", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property) return res.status(404).json({ error: PROPERTY_GONE_MESSAGE });

  const session = await prisma.videoUploadSession.findUnique({ where: { id: req.params.sessionId } });
  if (!session || session.propertyId !== property.id) return res.status(204).end();

  const permitted = session.purpose === "HANDOFF" ? await canManageOrIsHandoffMontajer(req, property) : canManageProperty(req, property);
  if (!permitted) return res.status(403).json({ error: "Недостаточно прав" });

  if (await abortLocalUploadSession(session.id)) {
    await prisma.videoUploadSession.delete({ where: { id: session.id } });
  }
  // Отменили замену готового ролика — ожидание, открытое на старте сессии,
  // снимается сразу, а не через сутки (24.09.2026), если другой загрузки
  // готового ролика по объекту не идёт.
  // Объект в Корзине: сессию убираем (это уборка диска), а карточку не трогаем.
  if (session.purpose === "HANDOFF" && !property.deletedAt) {
    const otherHandoffUploads = await prisma.videoUploadSession.count({ where: { propertyId: property.id, purpose: "HANDOFF" } });
    if (otherHandoffUploads === 0) await closeManualFinalVideoWait(property.id);
  }
  res.status(204).end();
});

videosRouter.get("/:id/videos", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  if (!canManageProperty(req, property)) return res.status(403).json({ error: "Недостаточно прав" });

  const videos = await prisma.propertyVideo.findMany({
    where: { propertyId: property.id },
    orderBy: { uploadedAt: "asc" },
    include: { uploadedBy: { select: { fullName: true } } },
  });
  res.json(videos.map((v) => presentVideo(v, v.uploadedBy.fullName)));
});

/**
 * Ссылка «Скачать» (31.08.2026) — раньше presigned-URL R2 (самодостаточная
 * ссылка, TTL 600с), которую браузер открывает window.open() БЕЗ участия кода
 * приложения (а значит, без заголовка Authorization). Теперь то же самое своим
 * коротким токеном (auth/jwt.ts::signVideoDownloadToken) — .../download-file
 * ниже его проверяет вместо requireAuth, тем же принципом, что и presign:
 * сама ссылка временно самодостаточна, а не защищена сессией открывшего её.
 */
videosRouter.get("/:id/videos/:videoId/download", requireAuth, async (req, res) => {
  const video = await prisma.propertyVideo.findUnique({ where: { id: req.params.videoId } });
  if (!video || video.propertyId !== req.params.id) return res.status(404).json({ error: "Видео не найдено" });
  const property = await prisma.property.findUnique({ where: { id: video.propertyId } });
  if (!property || !canManageProperty(req, property)) return res.status(403).json({ error: "Недостаточно прав" });

  const token = signVideoDownloadToken(video.id);
  res.json({ url: `/api/v1/properties/${property.id}/videos/${video.id}/download-file?token=${token}`, filename: video.filename });
});

/** Сама выдача файла по короткому токену из /download выше — БЕЗ requireAuth
 *  намеренно (тот же компромисс, что раньше давал presigned-URL R2): токен уже
 *  доказывает, что ссылку выдал сервер тому, у кого была настоящая сессия, и
 *  живёт 10 минут. */
videosRouter.get("/:id/videos/:videoId/download-file", async (req, res) => {
  const video = await prisma.propertyVideo.findUnique({ where: { id: req.params.videoId } });
  if (!video || video.propertyId !== req.params.id) return res.status(404).json({ error: "Видео не найдено" });
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!verifyVideoDownloadToken(token, video.id)) return res.status(403).json({ error: "Ссылка недействительна или истекла" });

  const filePath = localVideoFilePath(video.storageKey);
  if (!filePath) return res.status(404).json({ error: "Файл не найден в хранилище" });

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="video-${video.id.slice(0, 8)}.mp4"; filename*=UTF-8''${encodeURIComponent(video.filename)}`
  );
  // root + basename, а не абсолютный путь целиком: в Express 5 у send нет прежнего
  // послабления, и ЛЮБОЙ сегмент пути, начинающийся с точки, даёт 404 (dotfiles:
  // "ignore"). Корень так не проверяется — проверяется только имя файла, чего мы и
  // хотим. Тот же приём уже используют attachments/dealDocuments/greeting/me.
  res.sendFile(path.basename(filePath), { root: path.dirname(filePath) }, (err) => {
    if (err && !res.headersSent) {
      void logSystemError("storage", `Видео ${video.storageKey} не отдано: ${describeError(err)}`);
      res.status(404).json({ error: "Файл не найден в хранилище" });
    }
  });
});

/**
 * То же видео, но потоком через наш сервер, а не отдельной ссылкой. Нужно для
 * сохранения ролика в Галерею на телефоне (владелец 17.08.2026): клиент качает
 * файл через fetch() и передаёт Blob в системное «Поделиться» (Web Share API) —
 * fetch() требует авторизованный запрос именно ЭТИМ маршрутом (requireAuth),
 * в отличие от .../download-file выше, рассчитанного на голую навигацию
 * window.open() без заголовков приложения.
 */
videosRouter.get("/:id/videos/:videoId/file", requireAuth, async (req, res) => {
  const video = await prisma.propertyVideo.findUnique({ where: { id: req.params.videoId } });
  if (!video || video.propertyId !== req.params.id) return res.status(404).json({ error: "Видео не найдено" });
  const property = await prisma.property.findUnique({ where: { id: video.propertyId } });
  if (!property || !canManageProperty(req, property)) return res.status(403).json({ error: "Недостаточно прав" });

  const filePath = localVideoFilePath(video.storageKey);
  if (!filePath) return res.status(404).json({ error: "Файл не найден в хранилище" });

  res.setHeader("Content-Type", "video/mp4");
  // filename* с кодировкой — имя файла может быть кириллическим (см. тот же
  // приём в routes/interactions.ts), обычный filename отдаёт латинскую замену.
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="video-${video.id.slice(0, 8)}.mp4"; filename*=UTF-8''${encodeURIComponent(video.filename)}`
  );
  // root + basename, а не абсолютный путь целиком: в Express 5 у send нет прежнего
  // послабления, и ЛЮБОЙ сегмент пути, начинающийся с точки, даёт 404 (dotfiles:
  // "ignore"). Корень так не проверяется — проверяется только имя файла, чего мы и
  // хотим. Тот же приём уже используют attachments/dealDocuments/greeting/me.
  res.sendFile(path.basename(filePath), { root: path.dirname(filePath) }, (err) => {
    if (err && !res.headersSent) {
      void logSystemError("storage", `Видео ${video.storageKey} объекта ${property.id} не отдано: ${describeError(err)}`);
      res.status(404).json({ error: "Файл не найден в хранилище" });
    }
  });
});

/** Все видео объекта одним ZIP — «Скачать всё» на карточке. Каждый файл читается
 * с диска потоком и сразу дописывается в архив (archive.append), без буферизации
 * всей пачки в памяти — важно при ~20 роликах в 4K на объект. Файл, пропавший с
 * диска между запросами, пропускается, а не рушит архив целиком. */
videosRouter.get("/:id/videos/archive.zip", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  if (!canManageProperty(req, property)) return res.status(403).json({ error: "Недостаточно прав" });

  const videos = await prisma.propertyVideo.findMany({
    where: { propertyId: property.id },
    orderBy: { uploadedAt: "asc" },
  });
  if (!videos.length) return res.status(400).json({ error: "Видео не загружены" });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="videos-${property.shortId}.zip"`);

  // Видео уже сжаты кодеком — level 0 (store, без повторного deflate) экономит CPU,
  // не меняя итоговый размер архива заметно.
  const archive = new ZipArchive({ zlib: { level: 0 } });
  archive.on("error", (err: Error) => {
    void logSystemError("storage", `Архив видео объекта ${property.id} не собран: ${err.message}`);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  archive.pipe(res);

  for (const video of videos) {
    const filePath = localVideoFilePath(video.storageKey);
    if (!filePath || !(await localVideoExists(video.storageKey))) continue;
    archive.append(createReadStream(filePath), { name: video.filename });
  }

  await archive.finalize();
});

videosRouter.delete("/:id/videos/:videoId", requireAuth, async (req, res) => {
  const video = await prisma.propertyVideo.findUnique({ where: { id: req.params.videoId } });
  if (!video || video.propertyId !== req.params.id) return res.status(404).json({ error: "Видео не найдено" });
  const property = await prisma.property.findUnique({ where: { id: video.propertyId } });
  if (!property || !canManageProperty(req, property)) return res.status(403).json({ error: "Недостаточно прав" });
  // Исходник, с которым сейчас работает монтажёр, агент удалить не может.
  const lock = propertyEditLockBody(req, property);
  if (lock) return res.status(409).json(lock);
  // Объект в Корзине — видео не удаляем (D13, 02.10.2026): «Восстановить»
  // обещает вернуть всё как было.
  if (property.deletedAt) return res.status(409).json({ error: "Объект удалён — сначала восстановите его из Корзины." });

  await prisma.propertyVideo.delete({ where: { id: video.id } });
  void localVideoDelete(video.storageKey);
  logAudit(req, "PROPERTY_VIDEO_DELETED", "Property", property.id, { shortId: property.shortId, filename: video.filename });
  void notifySourceFilesChanged(property.id, "video", `удалён ${video.filename}`, req.agent!.id);
  res.status(204).send();
});

/**
 * ИСПРАВИТЬ УЖЕ ВЫПУЩЕННЫЙ РОЛИК — три маршрута одного механизма
 * (lib/publishedVideoFix.ts, владелец 19.09.2026: «чтобы не проходить весь путь
 * заново и не заполнять карточку второй раз»). Четвёртый способ — ручная
 * загрузка готового файла — живёт выше, в /video-handoff/upload: заводить ради
 * него отдельный приёмник значило бы держать две копии публикации.
 */

/**
 * Вернуть объект монтажёру — ОБЯЗАТЕЛЬНО с причиной (20.09.2026, владелец:
 * «чтобы просто так не ходил, а причину чтобы я указал, зачем, чтобы он тоже
 * прочитал»). Поля карточки не трогаются. Валидация тела — на границе, той же
 * zod-схемой, что использует UI (sendBackToMontajerSchema, @royal-home/shared):
 * пустая/неизвестная причина — 400, а не молчаливый возврат, и не 409, которым
 * отвечают уже легитимные бизнес-отказы ниже (объект занят монтажёром и т.п.).
 */
/**
 * СНОВА НА МОНТАЖ — объект сняли с монтажа, а готового ролика у него так и нет
 * (lib/videoHandoff.ts::requeueVideoHandoff, 23.09.2026, случай №121). Право —
 * как у «Вернуть монтажёру»: тот, кто ведёт объект.
 */
videosRouter.post("/:id/video-handoff/requeue", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  if (!canManageProperty(req, property)) return res.status(403).json({ error: "Недостаточно прав" });
  const requeueDenied = publishedActionDeniedReason(req, property);
  if (requeueDenied) return res.status(403).json({ error: requeueDenied });
  const result = await requeueVideoHandoff(property.id);
  if (!result.ok) return res.status(409).json({ error: result.error });
  logAudit(req, "PROPERTY_VIDEO_HANDOFF_REQUEUED", "Property", property.id, { shortId: property.shortId, queued: result.queued });
  res.json(result);
});

videosRouter.post("/:id/send-back-to-montajer", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  if (!canManageProperty(req, property)) return res.status(403).json({ error: "Недостаточно прав" });
  const sendBackDenied = publishedActionDeniedReason(req, property);
  if (sendBackDenied) return res.status(403).json({ error: sendBackDenied });

  const parsed = sendBackToMontajerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Неверные данные" });
  }

  // Право на removeFromSocial:true — то же, что у кнопки «Убрать из соцсетей»
  // (POST /:id/social-unpublish, requireMarketingRole): снятие вышедшего поста
  // видно подписчикам так же, как публикация, и отменить его нельзя. Без
  // права поле молча игнорировать нельзя — веб показал бы «убрали», когда не
  // убирали, — поэтому 403 тем же текстом, что и у social-unpublish.
  if (parsed.data.removeFromSocial && !hasMarketingRole(req.agent?.role)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }

  // Замена исходника стирает старые ролики — право то же, что у DELETE
  // /:id/videos/:videoId выше (canManageProperty), он уже проверен в начале.
  const result = await sendBackToMontajer(
    property.id,
    req.agent!.id,
    parsed.data.reason,
    parsed.data.comment ?? null,
    parsed.data.replaceVideoIds ?? null,
    { removeFromSocial: parsed.data.removeFromSocial }
  );
  if (!result.ok) return res.status(409).json({ error: result.error });
  // Ролик ждал проверки модератора — этот возврат и есть решение по нему
  // (25.09.2026, lib/clipReview.ts): журнал и кнопки у модераторов в Telegram.
  if (result.clipReviewWasPending) {
    afterClipRejected({
      propertyId: property.id,
      shortId: property.shortId,
      byId: req.agent!.id,
      source: "crm",
      reason: parsed.data.reason,
      comment: parsed.data.comment ?? null,
    });
  }
  logAudit(req, "PROPERTY_SENT_BACK_TO_MONTAJER", "Property", property.id, {
    shortId: property.shortId,
    queued: result.queued,
    reason: parsed.data.reason,
    replacedSource: !!parsed.data.replaceVideoIds?.length,
    socialRemoved: result.social?.removed ?? undefined,
  });
  res.json(result);
});

/**
 * ПРЕВЬЮ ТЕКСТА, КОТОРЫЙ УЙДЁТ МОНТАЖЁРУ (20.09.2026, владелец: «я хочу видеть,
 * что отправляется монтажёру, а то бывали ошибки, я каждый раз скриншот у него
 * просил»). Собирает текст ТОЙ ЖЕ функцией, что и настоящая отправка
 * (buildMontajerMessageText, lib/videoHandoff.ts) — не второй копией сборки,
 * которая разойдётся с оригиналом. `reason`/`comment` — необязательные query-
 * параметры: без них показывается текст обычной передачи, с ними — текст
 * перемонтажа с той причиной (комментарий здесь необязателен даже для причин,
 * где его требует sendBackToMontajerSchema, — это просмотр, а не отправка).
 */
const montajerPreviewQuerySchema = z.object({
  reason: z.enum(VIDEO_REMAKE_REASONS).optional(),
  comment: z.string().trim().max(2000).optional(),
});

videosRouter.get("/:id/montajer-preview", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  if (!canManageProperty(req, property)) return res.status(403).json({ error: "Недостаточно прав" });

  const parsed = montajerPreviewQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });

  const text = await buildMontajerMessageText(
    property.id,
    parsed.data.reason ? { reason: parsed.data.reason, comment: parsed.data.comment ?? null } : null
  );
  res.json({ text });
});

/**
 * ЖУРНАЛ ВСЕГО, ЧТО CRM РЕАЛЬНО ОТПРАВИЛА МОНТАЖЁРУ ПО ЭТОМУ ОБЪЕКТУ (20.09.2026,
 * владелец: «я хочу видеть, что отправляется ему вообще, где-то должно быть окно
 * или что-то»). Источник — MontajerMessage, пишется recordMontajerMessage
 * (lib/videoHandoff.ts) из каждого места отправки. Новые сверху, с пределом
 * выборки (правило репозитория — любой роут, возвращающий массив, ограничен).
 */
const MONTAJER_MESSAGES_LIMIT = 100;

videosRouter.get("/:id/montajer-messages", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  if (!canManageProperty(req, property)) return res.status(403).json({ error: "Недостаточно прав" });

  const messages = await prisma.montajerMessage.findMany({
    where: { propertyId: property.id },
    orderBy: { sentAt: "desc" },
    take: MONTAJER_MESSAGES_LIMIT,
    select: { id: true, kind: true, text: true, sentAt: true },
  });
  res.json({ messages });
});

/**
 * Снять посты объекта из соцсетей. Право — как у ручной публикации в TikTok
 * (requireMarketingRole): удаление вышедшего поста видно подписчикам ровно так
 * же, как публикация, и отменить его нельзя.
 */
videosRouter.post("/:id/social-unpublish", requireAuth, requireMarketingRole, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  // Удалённый объект — 404, как у остальных действий над роликом (25.09.2026):
  // раньше снятие шло и по объекту из корзины.
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден или удалён" });

  // Выбор сетей галочками (05.10.2026): тело `{ channels: [...] }`. Без тела — все сети,
  // как раньше (старые вызовы, «убрать перед заменой ролика»).
  const picked = z.object({ channels: z.array(z.enum(["INSTAGRAM", "FACEBOOK", "YOUTUBE", "TIKTOK", "TELEGRAM", "THREADS"])).min(1).max(6).optional() }).safeParse(req.body ?? {});
  if (!picked.success) return res.status(400).json({ error: "Неверный список сетей" });
  const only = picked.data.channels;

  const result = await removeFromSocial(property.id, only);
  // Идёт публикация — честный 409 вместо «ничего не снято» (25.09.2026, Б3).
  if (result.blocked) return res.status(409).json({ error: result.blocked });
  // Фото-посты и повторные показы — только при снятии «всего» (28.09.2026): выбрав
  // отдельные сети, человек не просил трогать карусели и повторы.
  if (!only) {
    // Фото-посты — рядом, НЕ внутри removeFromSocial (28.09.2026, agent-brief.md):
    // своя таблица, свой best-effort, кнопка «Убрать из соцсетей» снимает и их же.
    void removePropertyPhotoPosts(property.id).catch((err) =>
      void logSystemError("meta", `Объект ${property.id}: снятие фото-постов кнопкой «Убрать из соцсетей» не удалось: ${describeError(err)}`)
    );
    // Повторные показы — та же кнопка снимает и их (28.09.2026, reposts-digests).
    void removePropertySocialReposts(property.id).catch((err) =>
      void logSystemError("meta", `Объект ${property.id}: снятие повторов кнопкой «Убрать из соцсетей» не удалось: ${describeError(err)}`)
    );
  }
  logAudit(req, "PROPERTY_SOCIAL_UNPUBLISHED", "Property", property.id, {
    shortId: property.shortId,
    removed: result.removed,
    failed: result.failed.map((f) => f.channel),
  });
  res.json(result);
});

/** Сколько каруселей, повторов и живых историй сейчас можно снять — для кнопки в карточке. */
videosRouter.get("/:id/social-extras", requireAuth, requireMarketingRole, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id }, select: { deletedAt: true } });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден или удалён" });
  res.json(await countRemovableSocialExtras(req.params.id));
});

/**
 * «Снять карусели и истории» (владелец, 02.10.2026). Ролик не трогает — его
 * снимает /social-unpublish. Права те же: удаление видно подписчикам и
 * необратимо. Ответ — что снято и что осталось на ручное снятие.
 */
videosRouter.post("/:id/social-extras/remove", requireAuth, requireMarketingRole, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден или удалён" });

  const summary = await removeSocialExtras(property.id);
  logAudit(req, "PROPERTY_SOCIAL_EXTRAS_REMOVED", "Property", property.id, {
    shortId: property.shortId,
    photoPosts: summary.photoPosts.removed,
    reposts: summary.reposts.removed,
    stories: summary.stories.removed,
    failed: summary.photoPosts.failed.length + summary.reposts.failed.length + summary.stories.failed.length,
  });
  res.json(summary);
});

/**
 * ФОТО-ПОСТ ВРУЧНУЮ (28.09.2026, agent-brief.md) — кнопка «Опубликовать
 * фото-пост сейчас» в карточке объекта без ролика. `force: true`, как у
 * `/instagram-stories-publish` выше: явное действие человека, не автомат,
 * Settings.photoPostsEnabled не спрашивает. Права — маркетинг, публикация
 * видна подписчикам так же необратимо, как и остальные ручные кнопки здесь.
 */
videosRouter.post("/:id/photo-post", requireAuth, requireMarketingRole, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден или удалён" });

  const summary = await publishPropertyPhotoPost(property.id, { force: true });
  logAudit(req, "PROPERTY_PHOTO_POST_PUBLISHED", "Property", property.id, {
    shortId: property.shortId,
    ok: summary.ok,
    reason: summary.reason ?? null,
    channels: Object.keys(summary.results),
  });
  res.status(200).json(summary);
});

/** Список фото-постов объекта — карточка показывает чипы по каналам и дату. */
videosRouter.get("/:id/photo-posts", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден или удалён" });
  if (!canManageProperty(req, property)) return res.status(403).json({ error: "Недостаточно прав" });

  const posts = await prisma.propertyPhotoPost.findMany({
    where: { propertyId: property.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      channel: true,
      status: true,
      scheduledAt: true,
      publishedAt: true,
      permalink: true,
      error: true,
    },
  });
  res.json({ posts });
});

/**
 * ПОВТОРНЫЙ ПОКАЗ ВРУЧНУЮ (28.09.2026, agent-brief.md reposts-digests) —
 * кнопка «Показать ещё раз сейчас» в карточке объекта. `force: true`, как у
 * `/photo-post` выше: явное действие человека, Settings.repostsEnabled не
 * спрашивает. Круг — следующий за последним ОПУБЛИКОВАННЫМ (лимит
 * repostMaxRounds проверяет publishPropertyRepost сама и вернёт честную
 * причину отказа, а не тихо промолчит).
 */
videosRouter.post("/:id/repost", requireAuth, requireMarketingRole, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден или удалён" });

  const lastPublished = await prisma.propertySocialRepost.aggregate({
    where: { propertyId: property.id, status: "PUBLISHED" },
    _max: { round: true },
  });
  const round = (lastPublished._max.round ?? 0) + 1;

  const summary = await publishPropertyRepost(property.id, round, { force: true });
  logAudit(req, "PROPERTY_REPOST_PUBLISHED", "Property", property.id, {
    shortId: property.shortId,
    round,
    ok: summary.ok,
    reason: summary.reason ?? null,
    channels: Object.keys(summary.results),
  });
  res.status(200).json({ ...summary, round });
});

/** Список повторов объекта — карточка показывает «Повторный показ №N: дата (каналы)». */
videosRouter.get("/:id/reposts", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден или удалён" });
  if (!canManageProperty(req, property)) return res.status(403).json({ error: "Недостаточно прав" });

  const reposts = await prisma.propertySocialRepost.findMany({
    where: { propertyId: property.id },
    orderBy: [{ round: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      round: true,
      hook: true,
      channel: true,
      status: true,
      scheduledAt: true,
      publishedAt: true,
      permalink: true,
      error: true,
    },
  });
  res.json({ reposts });
});

/**
 * «Удалено в приложении» (24.09.2026) — пост в Instagram или TikTok снят руками,
 * канал вычёркивается, и новый ролик туда уйдёт. Подробности —
 * lib/publishedVideoFix.ts::markRemovedByHand. Права те же, что у «Убрать из
 * соцсетей».
 */
videosRouter.post("/:id/social-removed-by-hand", requireAuth, requireMarketingRole, async (req, res) => {
  const parsed = markRemovedByHandSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Укажите площадку: Instagram или TikTok" });

  const result = await markRemovedByHand(req.params.id, parsed.data.channel);
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  if (result.changed) {
    logAudit(req, "PROPERTY_SOCIAL_REMOVED_BY_HAND", "Property", req.params.id, { channel: parsed.data.channel });
  }
  res.json({ changed: result.changed, willPublish: result.willPublish, publishRunning: result.publishRunning });
});

/**
 * УДАЛИТЬ С КАРТОЧКИ ОШИБОЧНО ПРИНЯТЫЙ ГОТОВЫЙ РОЛИК (09.10.2026, №154 держал
 * ролик №153). Права те же, что у снятия из сетей: маркетинг, директор, админ.
 * Посты в сетях не снимает — ответ несёт publishedChannels, чтобы карточка
 * сказала «в сетях остался ролик — Убрать из соцсетей».
 */
videosRouter.post("/:id/final-video/discard", requireAuth, requireMarketingRole, async (req, res) => {
  const result = await discardReceivedFinalVideo(req.params.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  logAudit(req, "PROPERTY_FINAL_VIDEO_DISCARDED", "Property", req.params.id, { publishedChannels: result.publishedChannels });
  res.json({ ok: true, publishedChannels: result.publishedChannels });
});

/** Пересобрать подпись из текущих полей карточки и разослать в вышедшие посты. */
videosRouter.post("/:id/refresh-captions", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  // Корзина — как у соседних finish-edit и social-removed-by-hand (глубокая
  // проверка 02.10.2026, П9): по удалённому объекту подписи не рассылаются.
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден" });
  if (!canManageProperty(req, property)) return res.status(403).json({ error: "Недостаточно прав" });
  const refreshDenied = publishedActionDeniedReason(req, property);
  if (refreshDenied) return res.status(403).json({ error: refreshDenied });

  const result = await refreshPublishedCaptions(property.id);
  // Холостой вызов (менять нечего) в историю не пишем: три клика давали три записи.
  if (result.updated.length > 0 || result.failed.length > 0) {
    logAudit(req, "PROPERTY_CAPTIONS_REFRESHED", "Property", property.id, {
      shortId: property.shortId,
      updated: result.updated,
      failed: result.failed.map((f) => f.channel),
    });
  }
  res.json(result);
});

/**
 * «ГОТОВО» ПОСЛЕ ПРАВКИ ОБЪЕКТА (владелец 23.09.2026: «после „Готово“ подписи
 * обновляются везде автоматически»). Раньше кнопка только закрывала режим
 * правки и на сервер не ходила.
 *
 * Шлёт в вышедшие посты подпись, которую PATCH уже переписал точечно (факты
 * заменены, живые фразы и шаблон дня публикации сохранены), и досылает объект
 * на сайт. Instagram и TikTok правке через API не поддаются — для них ответ
 * несёт шаги руками (manual). Если с прошлой рассылки поля не менялись, в
 * соцсети не ходим вовсе: Telegram на тот же текст отвечает ошибкой, а лишний
 * вызов Meta и Google не бесплатен.
 */
videosRouter.post("/:id/finish-edit", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден" });
  if (!canManageProperty(req, property)) return res.status(403).json({ error: "Недостаточно прав" });
  const finishDenied = publishedActionDeniedReason(req, property);
  if (finishDenied) return res.status(403).json({ error: finishDenied });

  const [lastEdit, lastPush] = await Promise.all([
    prisma.auditLog.findFirst({
      where: { entityType: "Property", entityId: property.id, action: "PROPERTY_FIELDS_CHANGED" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.auditLog.findFirst({
      where: { entityType: "Property", entityId: property.id, action: { in: ["PROPERTY_EDIT_FINISHED", "PROPERTY_CAPTIONS_REFRESHED"] } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  const changedSincePush = !!lastEdit && (!lastPush || lastEdit.createdAt > lastPush.createdAt);
  const published = (property.publishedChannels ?? []).length > 0;

  if (!changedSincePush || (!published && !property.publishedOnSite)) {
    return res.json({ changed: changedSincePush, captions: null, site: false });
  }

  const captions = published ? await refreshPublishedCaptions(property.id, { keepStoredCaption: true }) : null;
  if (property.publishedOnSite) void resyncPhotosIfPublished(property.id, "«Готово» после правки карточки");
  logAudit(req, "PROPERTY_EDIT_FINISHED", "Property", property.id, {
    shortId: property.shortId,
    updated: captions?.updated ?? [],
    failed: captions?.failed.map((f) => f.channel) ?? [],
    site: property.publishedOnSite,
  });
  res.json({ changed: true, captions, site: property.publishedOnSite });
});

/**
 * КАРТОЧКА-ИСТОРИЯ ДЛЯ INSTAGRAM (21.09.2026) — превью 1080x1920, рисуется на
 * лету из главного фото объекта (lib/video/storyCard.ts). Не кэшируется на
 * диске: объект меняется (цена, фото) чаще, чем кто-то откроет ссылку дважды.
 *
 * Права — как у соседних маркетинговых действий этого файла (requireMarketingRole,
 * см. /:id/tiktok-publish выше): это и предпросмотр для владельца, и будущий
 * источник для публикации (её делает отдельная ветка, см. lib/video/storyCard.ts).
 */
videosRouter.get("/:id/story-card.jpg", requireAuth, requireMarketingRole, async (req, res) => {
  const result = await generateStoryCard(req.params.id);
  if (!result.ok || !result.image) {
    return res.status(result.error === "Объект не найден или удалён" ? 404 : 409).json({ error: result.error });
  }
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "no-store");
  res.send(result.image);
});

/**
 * ОБЛОЖКА ДЛЯ СОЦСЕТЕЙ (21.09.2026) — премиальный постер Royal Home TJ поверх
 * главного фото объекта, рисуется на лету (`lib/video/coverPoster.ts`). Не
 * кэшируется на диске — та же причина, что у `/story-card.jpg` выше.
 *
 * `?aspect=square` (по умолчанию, для сетки Instagram/Facebook/Telegram/сайта)
 * или `?aspect=story` (1080×1920 — тот же кадр, что уходит в `cover_url`
 * Instagram Reels при публикации ролика монтажёра). Обе площадки, которые
 * API не пускает к своей обложке (TikTok — только `video_cover_timestamp_ms`
 * кадра в самом ролике; YouTube Shorts — `thumbnails.set` требует
 * подтверждённый по телефону канал и почти не виден в самой ленте Shorts),
 * владелец при желании выкладывает вручную этой же картинкой — отсюда её и
 * скачать.
 *
 * `?style=gemini` (21.09.2026, решение владельца после первой версии без
 * обработки) — прогнать фото через световую обработку Gemini
 * (`ai/coverPosterStyle.ts`) перед тем, как наложить текст/логотип. НЕ
 * включено по умолчанию: вызов внешней модели ~20с и стоит квоты, а этот
 * роут — предпросмотр, дёргать его лишний раз не глядя не стоит. Заголовок
 * `X-Cover-Style-Applied` говорит, применилась ли обработка на самом деле —
 * `false`, даже когда стиль просили, значит Gemini отказал и обложка ушла
 * необработанным фото (см. `CoverPosterResult.styleApplied`).
 */
videosRouter.get("/:id/cover-poster.jpg", requireAuth, requireMarketingRole, async (req, res) => {
  // С 25.09.2026 обложку рисует только ChatGPT (lib/video/coverOpenAi.ts), наш
  // шаблон отключён: отдаём уже сохранённую обложку объекта, а не рисуем на лету.
  const aspect = req.query.aspect === "story" ? "story" : "square";
  const property = await prisma.property.findUnique({
    where: { id: req.params.id },
    select: { deletedAt: true, socialCoverSquareUrl: true, socialCoverStoryUrl: true, socialCoverError: true },
  });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден или удалён" });
  const url = aspect === "story" ? property.socialCoverStoryUrl : property.socialCoverSquareUrl;
  if (!url) {
    return res.status(409).json({ error: property.socialCoverError ? `Обложка не создана: ${property.socialCoverError}` : "Обложки ещё нет" });
  }
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(propertyCoversDir, path.basename(url)), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Файл обложки не найден на диске" });
  });
});

/**
 * «ПЕРЕРИСОВАТЬ ОБЛОЖКУ» (25.09.2026, v2) — мимо кэша, заново через ChatGPT.
 * Права — как у публикации (requireMarketingRole). Ответ ждёт генерацию
 * (до нескольких минут): 200 с новыми адресами или 422 с причиной отказа.
 */
videosRouter.post("/:id/cover/regenerate", requireAuth, requireMarketingRole, async (req, res) => {
  const exists = await prisma.property.findUnique({ where: { id: req.params.id }, select: { deletedAt: true } });
  if (!exists || exists.deletedAt) return res.status(404).json({ error: "Объект не найден или удалён" });
  const enabled = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { coverGenerationEnabled: true } });
  if (enabled && !enabled.coverGenerationEnabled) return res.status(409).json({ error: "Обложки выключены в Настройках → «Обложки для соцсетей»" });
  const cover = await makePropertyCover(req.params.id, { force: true });
  logAudit(req, "PROPERTY_COVER_REGENERATED", "Property", req.params.id, { ok: !!cover });
  if (!cover) {
    const after = await prisma.property.findUnique({ where: { id: req.params.id }, select: { socialCoverError: true } });
    return res.status(422).json({ error: `Обложка не создана: ${after?.socialCoverError ?? "причина в журнале ошибок"}` });
  }
  res.json(cover);
});

/**
 * «ЗАМЕНИТЬ ОБЛОЖКУ СВОЕЙ» (владелец, 29.09.2026) — квадрат и/или вертикаль
 * картинками (поля `square`, `story`). Такую обложку публикация и добор больше
 * не перерисовывают, только кнопка «Перерисовать». Права — как у публикации.
 */
videosRouter.post(
  "/:id/cover/upload",
  requireAuth,
  requireMarketingRole,
  upload.fields([
    { name: "square", maxCount: 1 },
    { name: "story", maxCount: 1 },
  ]),
  async (req, res) => {
    const id = String(req.params.id);
    const exists = await prisma.property.findUnique({ where: { id }, select: { deletedAt: true } });
    if (!exists || exists.deletedAt) return res.status(404).json({ error: "Объект не найден или удалён" });
    const files = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>;
    const square = files.square?.[0]?.buffer ?? null;
    const story = files.story?.[0]?.buffer ?? null;
    if (!square && !story) return res.status(400).json({ error: "Пришлите картинку: квадрат, вертикаль или обе" });
    try {
      const cover = await storeManualCover(id, { square, story });
      logAudit(req, "PROPERTY_COVER_REGENERATED", "Property", id, { ok: true, manual: true });
      res.json(cover);
    } catch (err) {
      res.status(400).json({ error: `Обложка не поставлена: ${describeError(err)}` });
    }
  }
);

/**
 * «ОПУБЛИКОВАТЬ СЕЙЧАС» (21.09.2026, расстановка публикаций по времени) —
 * ролик уже принят от монтажёра и ждёт своего слота (Property.scheduledPublishAt),
 * кнопка просто сдвигает `runAt` уже стоящего задания на текущий момент, см.
 * докстринг `publishHandoffNow` (lib/videoHandoff.ts) почему не публикует сама.
 * Права — те же маркетинговые (requireMarketingRole), что и у соседних действий.
 */
videosRouter.post("/:id/publish-now", requireAuth, requireMarketingRole, async (req, res) => {
  const result = await publishHandoffNow(req.params.id);
  if (!result.ok) return res.status(409).json({ error: result.error });
  // В журнал действий — как у соседних ручных публикаций (TikTok, истории):
  // человек своим решением сдвинул выход поста, и в «Архиве» должно быть видно,
  // кто и когда, а не только что пост вышел не в свой час.
  logAudit(req, "PROPERTY_PUBLISHED_NOW", "Property", req.params.id);
  res.json({ ok: true });
});

/**
 * «ПЕРЕНЕСТИ» (24.09.2026, очередь в «Маркетинг → Расписание») — своё время
 * выхода для ролика, который ждёт слота. Как и «Опубликовать сейчас», только
 * двигает уже стоящее задание, см. `rescheduleHandoffPublish`.
 */
videosRouter.post("/:id/publish-at", requireAuth, requireMarketingRole, async (req, res) => {
  const parsed = publishAtSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Не указано время выхода." });
  const result = await rescheduleHandoffPublish(req.params.id, new Date(parsed.data.at));
  if (!result.ok) return res.status(409).json({ error: result.error });
  logAudit(req, "PROPERTY_PUBLISH_RESCHEDULED", "Property", req.params.id, { at: result.at.toISOString() });
  res.json({ ok: true, at: result.at.toISOString() });
});

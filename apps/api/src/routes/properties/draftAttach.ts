/**
 * ПЕРЕЕЗД ФАЙЛОВ ЧЕРНОВИКА В КАРТОЧКУ ОБЪЕКТА и уборка брошенных черновиков.
 *
 * Вынесено из drafts.ts отдельным модулем, потому что этим пользуется crud.ts
 * (создание объекта) и ночная уборка — а тянуть ради двух функций весь роутер с
 * его express-зависимостями значило бы завести кольцо импортов.
 *
 * ПЕРЕЕЗД НЕ ДВИГАЕТ НИ ОДНОГО БАЙТА. Снимок черновика уже лежит в общей папке
 * uploads готовым webp под именем `<uuid>.webp` — ровно там же и в том же виде,
 * куда его положил бы POST /properties/:id/photos. Ролик уже собран в закрытом
 * хранилище ключом `<id черновика>/<uuid>.<ext>` — формат ключа тот же
 * двухуровневый, что и у видео объекта (первый уровень исторически был id
 * объекта, но хранилище проверяет только форму ключа, см. KEY_RE в
 * lib/localVideoStorage.ts). Поэтому переезд — это создание строк PropertyPhoto и
 * PropertyVideo с уже готовыми путями.
 *
 * ПОЧЕМУ ОДНОЙ ТРАНЗАКЦИЕЙ. Фото, видео и удаление черновика — одно событие: если
 * строки создались, а черновик остался, агент при следующем заходе получил бы
 * предложение «продолжить» с уже перенесёнными файлами и залил бы их второй раз.
 * Файлы на диске в транзакцию не входят — но их и не трогаем.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { PropertyDraftMedia } from "../../generated/prisma/client.js";
import { prisma, type TxClient } from "../../db.js";
import { uploadsDir, thumbsDir, clipVideoDir } from "../../upload.js";
import {
  abortLocalUploadSession,
  localVideoDelete,
  localVideoFilePath,
} from "../../lib/localVideoStorage.js";
import { probeDurationSec, MAX_CLIP_VIDEO_DURATION_SEC } from "../../lib/propertyClipVideo.js";
import { enqueueBackgroundJob } from "../../jobs/enqueue.js";
import { CLIP_COMPRESS_MAX_ATTEMPTS } from "../../jobs/clipCompress.js";
import { logSystemError } from "../../lib/systemError.js";
import { logAgentAudit } from "../../lib/audit.js";
import { sendPushToAgent } from "../../push.js";
import { DRAFT_INCLUDE, DraftConflictError, assertActiveDraft, checkDraftReference, closeDraftRows, withDraftLock, type DraftRecord, type DraftReference } from "./draftLifecycle.js";

/**
 * Удаление файлов снимка с диска по его публичным путям.
 *
 * Имя берём только базовое — путь приходит из базы, куда в теории когда-нибудь
 * попадёт не только то, что писали сюда же. Тот же рубеж от обхода пути, что в
 * lib/privateFiles.ts.
 */
export async function removePhotoFiles(url: string | null, thumbUrl: string | null): Promise<void> {
  const unlinkIn = async (dir: string, publicPath: string | null) => {
    if (!publicPath) return;
    const name = path.basename(publicPath);
    if (!/^[0-9a-f-]{36}\.webp$/i.test(name)) return;
    await fs.unlink(path.join(dir, name)).catch(() => undefined);
  };
  await unlinkIn(uploadsDir, url);
  await unlinkIn(thumbsDir, thumbUrl);
}

/**
 * Закрытие черновика вместе с удалением файлов. Tombstone сохраняет generation.
 *
 * ФАЙЛЫ СТИРАЕМ ТОЛЬКО ПОСЛЕ УСПЕШНОГО УДАЛЕНИЯ СТРОК (07.10.2026, класс «тихая
 * потеря»). Раньше отказ `delete` глотался, а файлы стирались всё равно: строки
 * PropertyDraftMedia со статусом READY оставались без файлов, и следующий
 * attachDraftToProperty создал бы PropertyPhoto с мёртвыми url. Теперь отказ
 * оставляет и строки, и файлы на месте, а уборка подберёт их на следующем проходе.
 * Закрытый черновик не трогаем: файлы могли уже перейти в карточку объекта.
 *
 * Возвращает true, если черновик удалён нами и файлы убраны.
 */
export async function discardDraft(draftId: string, options: { reference?: DraftReference; throwOnError?: boolean; expiredAt?: Date } = {}): Promise<boolean> {
  const own = await prisma.propertyDraft.findUnique({ where: { id: draftId }, select: { agentId: true } });
  if (!own) return false;
  let media: PropertyDraftMedia[] = [];
  try {
    const closed = await withDraftLock(own.agentId, async (tx) => {
      const draft = await tx.propertyDraft.findUnique({ where: { agentId: own.agentId }, include: DRAFT_INCLUDE });
      if (!draft || draft.closedAt || draft.id !== draftId) return false;
      checkDraftReference(draft, { ...options.reference, draftId });
      if (options.expiredAt && (draft.expiresAt > options.expiredAt || draft.media.some((m) => m.status === "UPLOADING" && m.updatedAt.getTime() >= options.expiredAt!.getTime() - DRAFT_ACTIVE_UPLOAD_MS))) return false;
      media = draft.media;
      await closeDraftRows(tx, draft);
      return true;
    });
    if (!closed) return false;
  } catch (err) {
    if (err instanceof DraftConflictError || options.throwOnError) throw err;
    if ((err as { code?: string }).code !== "P2025") {
      void logSystemError(
        "storage",
        `Не удалось удалить черновик объекта ${draftId}, файлы оставлены на месте: ${err instanceof Error ? err.message : String(err)}`,
        { dedupKey: `draft-discard-failed:${draftId}` }
      );
    }
    return false;
  }
  for (const m of media) {
    await removeDraftMediaFiles(m);
  }
  return true;
}

async function removeDraftMediaFiles(m: PropertyDraftMedia): Promise<void> {
  if (m.kind === "PHOTO") {
    await removePhotoFiles(m.url, m.thumbUrl);
    return;
  }
  await abortLocalUploadSession(m.id).catch(() => undefined);
  if (m.storageKey) await localVideoDelete(m.storageKey);
}

export interface DraftAttachResult {
  photos: number;
  videos: number;
  /** Незаконченные закачки — их в карточку не переносим и честно называем числом. */
  skippedPhotos: number;
  skippedVideos: number;
  /**
   * Почему переезд не состоялся целиком (07.10.2026). Нет поля — всё, что было
   * в черновике, готово и перенесено. `empty` — в черновике не было файлов
   * вовсе (штатно: агент создал объект без медиа), это не отказ.
   */
  reason?: "not-found" | "foreign" | "empty" | "error";
  /** Текст сбоя при reason = "error" — уходит клиенту в `media.error`. */
  errorMessage?: string;
}

function emptyResult(reason: DraftAttachResult["reason"], errorMessage?: string): DraftAttachResult {
  return { photos: 0, videos: 0, skippedPhotos: 0, skippedVideos: 0, reason, ...(errorMessage ? { errorMessage } : {}) };
}

/** Объект в тексте уведомления — тот же вид «ОБ-000082», что и в интерфейсе. */
function propertyCode(shortId: number): string {
  return `ОБ-${String(shortId).padStart(6, "0")}`;
}

/**
 * «ФАЙЛЫ ИЗ МАСТЕРА НЕ ДОШЛИ» — СИГНАЛ АГЕНТУ, А НЕ ТИХАЯ ПОТЕРЯ (владелец
 * 07.10.2026: «ролики и фото всегда дозагружаются, агент видит процесс»).
 *
 * Живой случай: видео не догрузилось до нажатия «Создать», сервер молча стёр
 * незаконченную закачку, объект и фото создались, ролика нет, и никто не узнал.
 * Объект при этом создан (решение «создать без них» принял пользователь в
 * мастере), поэтому здесь не 500 и не откат — запись в журнал ошибок (для
 * руководителя), запись в журнал действий (история объекта) и пуш автору и
 * принявшему агенту со ссылкой на карточку, где файлы дозагружаются.
 *
 * Никогда не бросает: сам сигнал не имеет права ронять создание объекта.
 */
async function reportDraftMediaLoss(
  property: { id: string; shortId: number; intakeAgentId?: string | null },
  authorId: string,
  detail: { skippedPhotos: number; skippedVideos: number; reason?: DraftAttachResult["reason"]; errorMessage?: string }
): Promise<void> {
  try {
    const code = propertyCode(property.shortId);
    const skipped = detail.skippedPhotos + detail.skippedVideos;
    const text =
      skipped > 0
        ? `${code}: ${skipped} ${skipped === 1 ? "файл" : "файлов"} из мастера не дошли — добавьте их в карточке`
        : `${code}: файлы из мастера не перенеслись — добавьте их в карточке`;
    void logSystemError(
      "storage",
      `${text} (фото ${detail.skippedPhotos}, видео ${detail.skippedVideos}, причина: ${detail.reason ?? "незаконченная загрузка"}${
        detail.errorMessage ? `, ${detail.errorMessage}` : ""
      })`,
      { dedupKey: `draft-media-lost:${property.id}` }
    );
    logAgentAudit(authorId, "PROPERTY_DRAFT_MEDIA_LOST", "Property", property.id, {
      shortId: property.shortId,
      skippedPhotos: detail.skippedPhotos,
      skippedVideos: detail.skippedVideos,
      reason: detail.reason ?? "unfinished-upload",
    });
    const recipients = [...new Set([authorId, property.intakeAgentId].filter((id): id is string => !!id))];
    await Promise.all(
      recipients.map((agentId) =>
        sendPushToAgent(agentId, {
          title: "⚠️ Файлы не догрузились",
          body: text,
          url: `/properties/${property.shortId}`,
          tag: `property-draft-media-lost-${property.id}`,
        }).catch((err) => console.error("[черновик] пуш «файлы не дошли»:", err instanceof Error ? err.message : err))
      )
    );
  } catch (err) {
    console.error("[черновик] сигнал «файлы не дошли»:", err instanceof Error ? err.message : err);
  }
}

/**
 * Перенос файлов черновика в только что созданный объект.
 *
 * Никогда не бросает: объект уже создан, и отказ переезда не должен превращаться
 * в 500 на запросе, который по сути прошёл. Отказ попадает в журнал через
 * logSystemError, а агент увидит карточку без части файлов и дозагрузит их с
 * карточки — это хуже, чем успех, но несравнимо лучше «объект не создался».
 */
export async function attachDraftToProperty(
  draftId: string,
  agentId: string,
  property: { id: string; shortId: number; status: string; offSite: boolean; intakeAgentId?: string | null },
  uploadedById: string,
  /**
   * Обложка, выбранная агентом тапом по плитке (мастер, StepMedia.tsx,
   * владелец 12.09.2026) — ключ отправки снимка, который должен стать первым
   * фото объекта. `order` в PropertyDraftMedia отражает только ПОРЯДОК
   * ЗАГРУЗКИ, а не выбор агента, поэтому здесь и только здесь (перед тем как
   * разложить его по PropertyPhoto.order) список фото переставляется —
   * единственная точка, где это вообще можно сделать: порядок PropertyPhoto
   * решается один раз в этой транзакции и клиенту неоткуда взять готовые id.
   */
  coverUploadKey?: string | null
): Promise<DraftAttachResult> {
  try {
    const plan = await withDraftLock(agentId, async (tx) => {
      const draft = await assertActiveDraft(tx, agentId, { draftId });
      return attachDraftRows(tx, draft, property, uploadedById, coverUploadKey);
    });
    return finishDraftAttachment(plan, property, uploadedById);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void logSystemError("storage", `Не удалось перенести файлы черновика в объект ${property.id}: ${message}`, { dedupKey: `draft-attach-failed:${property.id}` });
    await reportDraftMediaLoss(property, uploadedById, { skippedPhotos: 0, skippedVideos: 0, reason: "error", errorMessage: message });
    return emptyResult("error", message);
  }
}

export interface DraftAttachmentPlan { result: DraftAttachResult; media: PropertyDraftMedia[]; videos: PropertyDraftMedia[] }
type AttachmentProperty = { id: string; shortId: number; status: string; offSite: boolean; intakeAgentId?: string | null };

/** Caller holds lockOwnDraft in the same short transaction as property.create. No filesystem/network work. */
export async function attachDraftRows(tx: TxClient, draft: DraftRecord, property: AttachmentProperty, uploadedById: string, coverUploadKey?: string | null): Promise<DraftAttachmentPlan> {

    const photos = draft.media.filter((m) => m.kind === "PHOTO" && m.status === "READY");
    if (coverUploadKey) {
      const coverIndex = photos.findIndex((m) => m.uploadKey === coverUploadKey);
      if (coverIndex > 0) {
        const [cover] = photos.splice(coverIndex, 1);
        photos.unshift(cover);
      }
    }
    const videos = draft.media.filter((m) => m.kind === "VIDEO" && m.status === "READY" && m.storageKey);
    const skippedPhotos = draft.media.filter((m) => m.kind === "PHOTO").length - photos.length;
    const skippedVideos = draft.media.filter((m) => m.kind === "VIDEO").length - videos.length;

    // Ключ повторной отправки уникален на всю таблицу, и он уже может быть занят
    // (глубокая проверка 02.10.2026, D2): снимок из переписки продавца с ключом
    // `chat:<sha256>` лежит в объекте, который агент удалил в Корзину и теперь
    // собирает заново. Раньше createMany падал на уникальном ключе, транзакция
    // откатывала ВСЕ фото и видео, и агент получал пустую карточку без
    // объяснения. Снимок переносим, а занятый ключ оставляем прежнему владельцу:
    // ключ нужен только чтобы повтор той же пачки не задвоил её, а эта пачка
    // повтором не является.
    const draftKeys = [...photos, ...videos].map((m) => m.uploadKey).filter((k): k is string => !!k);
    const takenKeys = new Set<string>();
    if (draftKeys.length > 0) {
      const [takenPhotos, takenVideos] = await Promise.all([
        tx.propertyPhoto.findMany({ where: { uploadKey: { in: draftKeys } }, select: { uploadKey: true } }),
        tx.propertyVideo.findMany({ where: { uploadKey: { in: draftKeys } }, select: { uploadKey: true } }),
      ]);
      for (const m of [...takenPhotos, ...takenVideos]) if (m.uploadKey) takenKeys.add(m.uploadKey);
    }
    const freeKey = (key: string | null) => (key && takenKeys.has(key) ? null : key);

      if (photos.length > 0) {
        await tx.propertyPhoto.createMany({
          data: photos.map((m, i) => ({
            propertyId: property.id,
            url: m.url!,
            thumbUrl: m.thumbUrl!,
            order: i,
            // Ключ повторной отправки переезжает вместе со снимком: он уникален на
            // всю таблицу, и вторая попытка той же пачки с карточки объекта
            // упрётся в него, а не задвоит снимок.
            uploadKey: freeKey(m.uploadKey),
          })),
        });
      }
      if (videos.length > 0) {
        await tx.propertyVideo.createMany({
          data: videos.map((m) => ({
            propertyId: property.id,
            storageKey: m.storageKey!,
            filename: m.filename,
            sizeBytes: m.sizeBytes,
            uploadKey: freeKey(m.uploadKey),
            uploadedById,
          })),
        });
      }
      // Незаконченные закачки уносим вместе с черновиком: их части на диске
      // подберёт та же уборка, что и части брошенных сессий видео объекта.
      await closeDraftRows(tx, draft);

    return { result: { photos: photos.length, videos: videos.length, skippedPhotos, skippedVideos,
      ...(draft.media.length === 0 ? { reason: "empty" as const } : {}) }, media: draft.media, videos };
}

/** Run only after commit; rollback must keep the source files available for retry. */
export async function finishDraftAttachment(plan: DraftAttachmentPlan, property: AttachmentProperty, uploadedById: string): Promise<DraftAttachResult> {
    const { result, videos } = plan;
    const { skippedPhotos, skippedVideos } = result;

    for (const m of plan.media) {
      if (m.status !== "READY") await removeDraftMediaFiles(m).catch((err) => {
        void logSystemError("storage", `Не удалось убрать незавершённую загрузку ${m.id}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    // Первый ролик — ещё и обзор карточки, как это было в мастере до черновика:
    // сервер сжимает его в 480p и показывает в карточке и по приватной ссылке.
    // Фоном и без await: копирование сотен мегабайт и ffprobe не должны держать
    // ответ на создание объекта, а отказ сжатия не отменяет самого объекта.
    //
    // НАХОДКА 12.09.2026: это сжатие (480p, clipVideoStatus) задумывалось 18.08 ТОЛЬКО
    // для НЕСАЙТОВЫХ объектов (offSite) — они не проходят конвейер маркетинга и монтаж,
    // и без этого шага на карточке не было бы вообще никакого видео. Обычный объект
    // получает готовый Reels от монтажёра тем же конвейером; сжимать для него ролик
    // черновика — работа впустую, ffmpeg жёгся на КАЖДОМ обычном объекте с видео. Не
    // путать с автомонтажом — той другой вещью, которую убрали 04.09.2026: это разные
    // механизмы, и один не заменяет другой.
    if (property.offSite && videos[0]) void queueClipFromDraftVideo(property.id, videos[0]);

    if (skippedPhotos + skippedVideos > 0) {
      await reportDraftMediaLoss(property, uploadedById, { skippedPhotos, skippedVideos });
    }
    return result;
}

/**
 * ОБЗОР КАРТОЧКИ ИЗ ПЕРВОГО РОЛИКА ЧЕРНОВИКА.
 *
 * До черновика мастер сам решал, какой ролик отправить в сжатие
 * (POST /:id/clip-video), а какой — исходником монтажёру. Теперь ролики уезжают
 * ДО того, как объект существует, и этот выбор делает сервер здесь — иначе
 * карточка осталась бы вовсе без обзорного ролика, тихо и незаметно.
 *
 * Ролик, который сжатие не примет (длиннее пяти минут или не читается ffprobe),
 * просто остаётся исходником монтажёру — ровно то же поведение, что было на
 * вкладке. Молча выбросить его нельзя, и объявлять ошибкой создания объекта —
 * тоже: он уже лежит в карточке как PropertyVideo.
 */
async function queueClipFromDraftVideo(propertyId: string, media: PropertyDraftMedia): Promise<void> {
  try {
    const source = media.storageKey ? localVideoFilePath(media.storageKey) : null;
    if (!source) return;
    // Задание сжатия читает исходник из ОБЩЕГО тома (clipVideoDir, префикс
    // incoming-): у api и worker разные контейнеры и разный /tmp, но один
    // /app/uploads. Копия, а не ссылка: исходник остаётся у монтажёра.
    const inputFilename = `incoming-${randomUUID()}`;
    const inputPath = path.join(clipVideoDir, inputFilename);
    await fs.copyFile(source, inputPath);

    const durationSec = await probeDurationSec(inputPath);
    if (durationSec === null || durationSec > MAX_CLIP_VIDEO_DURATION_SEC) {
      await fs.rm(inputPath, { force: true });
      return;
    }

    await prisma.property.update({ where: { id: propertyId }, data: { clipVideoStatus: "PROCESSING" } });
    // Результат постановки проверяем (07.10.2026): отказ очереди раньше оставлял
    // карточку в «PROCESSING» навсегда — задания нет, и никто не придёт снять статус.
    const queued = await enqueueBackgroundJob({
      type: "clip-compress",
      payload: {
        propertyId,
        inputFilename,
        outputFilename: `${randomUUID()}.mp4`,
        previousUrl: null,
        sizeBytes: media.sizeBytes,
        durationSec: Math.round(durationSec),
      },
      maxAttempts: CLIP_COMPRESS_MAX_ATTEMPTS,
    });
    if (!queued.enqueued) {
      await prisma.property.update({ where: { id: propertyId }, data: { clipVideoStatus: "NONE" } });
      await fs.rm(inputPath, { force: true });
      void logSystemError(
        "storage",
        `Обзорный ролик объекта ${propertyId} не поставлен в сжатие (${queued.skipped}), статус возвращён`,
        { dedupKey: `clip-enqueue-failed:${propertyId}` }
      );
    }
  } catch (err) {
    void logSystemError(
      "storage",
      `Не удалось поставить обзорный ролик объекта ${propertyId} в сжатие: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** За сколько до конца срока предупреждаем автора, что черновик исчезнет. */
export const DRAFT_EXPIRY_WARNING_MS = 2 * 24 * 60 * 60 * 1000;
/** Закачка, обновлявшаяся недавно, считается живой: черновик с ней не удаляем,
 *  даже если срок истёк (агент грузит ролик с телефона по плохой сети). */
export const DRAFT_ACTIVE_UPLOAD_MS = 6 * 60 * 60 * 1000;

/**
 * УБОРКА ПРОСРОЧЕННЫХ ЧЕРНОВИКОВ — раз в сутки, вместе с остальной ночной
 * работой. Брошенный черновик держит на диске десятки мегабайт снимков и сотни
 * мегабайт роликов; без уборки диск сервера кончится молча.
 *
 * НЕ МОЛЧА ДЛЯ АВТОРА (07.10.2026): за двое суток до срока — пуш «черновик будет
 * удалён» (тег с датой срока: продлил черновик — сигнал выйдет заново, не продлил
 * — второй ночной проход его не повторит); при удалении черновика с файлами —
 * запись в ленту со счётчиком. Черновик с закачкой в статусе UPLOADING,
 * обновлённой за последние 6 часов, не трогаем: ролик ещё едет.
 *
 * Возвращает число удалённых черновиков.
 */
export async function cleanupExpiredPropertyDrafts(now: Date = new Date()): Promise<number> {
  await warnAboutExpiringDrafts(now);

  const expired = await prisma.propertyDraft.findMany({
    where: { closedAt: null, expiresAt: { lte: now } },
    select: {
      id: true,
      agentId: true,
      media: { select: { kind: true, status: true, updatedAt: true } },
    },
    take: 200,
  });
  const activeSince = new Date(now.getTime() - DRAFT_ACTIVE_UPLOAD_MS);
  let removed = 0;
  for (const d of expired) {
    if (d.media.some((m) => m.status === "UPLOADING" && m.updatedAt >= activeSince)) continue;
    if (!(await discardDraft(d.id, { expiredAt: now }))) continue;
    removed++;
    const photos = d.media.filter((m) => m.kind === "PHOTO").length;
    const videos = d.media.filter((m) => m.kind === "VIDEO").length;
    if (photos + videos > 0) {
      await sendPushToAgent(d.agentId, {
        title: "🗑 Черновик объекта удалён",
        body: `Срок черновика истёк, удалено файлов: фото ${photos}, видео ${videos}. Загрузите их заново при создании объекта`,
        url: "/properties/new",
        tag: `property-draft-expired-${d.id}`,
      }).catch((err) => console.error("[черновик] пуш об удалении:", err instanceof Error ? err.message : err));
    }
  }
  return removed;
}

/** Предупреждение автору: черновик с наработкой исчезнет менее чем через двое суток. */
async function warnAboutExpiringDrafts(now: Date): Promise<void> {
  const soon = await prisma.propertyDraft.findMany({
    where: { closedAt: null, expiresAt: { gt: now, lte: new Date(now.getTime() + DRAFT_EXPIRY_WARNING_MS) } },
    select: { id: true, agentId: true, step: true, expiresAt: true, _count: { select: { media: true } } },
    take: 200,
  });
  for (const d of soon) {
    if (d._count.media === 0 && d.step === 0) continue; // пустой черновик терять нечего
    const tag = `property-draft-expiring-${d.id}-${d.expiresAt.getTime()}`;
    try {
      if (await prisma.notification.findFirst({ where: { agentId: d.agentId, tag }, select: { id: true } })) continue;
      await sendPushToAgent(d.agentId, {
        title: "⏳ Черновик объекта будет удалён",
        body:
          d._count.media > 0
            ? `Черновик с ${d._count.media} файлами исчезнет в ближайшие два дня — завершите создание объекта`
            : "Черновик исчезнет в ближайшие два дня — завершите создание объекта",
        url: "/properties/new",
        tag,
      });
    } catch (err) {
      console.error("[черновик] пуш «будет удалён»:", err instanceof Error ? err.message : err);
    }
  }
}

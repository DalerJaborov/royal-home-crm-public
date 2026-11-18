import fs from "node:fs";
import path from "node:path";
import { prisma, type TxClient } from "../db.js";
import { videoHandoffDir } from "../upload.js";
import { legacyHandoffCoverPath } from "./diskCleanup.js";
import { NARRATION_CLOSED_STATUSES } from "./narrationOptOut.js";
import { NARRATION_PREVIEW_CLEARED } from "./narrationPreviewFields.js";
import { narrationFactsCurrent } from "./propertyNarration.js";
import { clipCountsAsPublished } from "./publishedClip.js";
import { openReplacement } from "./remakeRequests.js";
import { logSystemError } from "./systemError.js";
import { isHandoffPublishRunning, withPropertyLock } from "./videoHandoff.js";

/**
 * СВЕДЁННЫЙ РОЛИК — НА МЕСТО (перемикс новой озвучки, lib/narrationAutoFlow.ts → remixFromMasterClaimed).
 *
 * 18.11.2026, владелец: «человек поменял данные, послушал, утвердил — и ролик СРАЗУ уходит в соцсети». Прежний
 * шаг «прослушать перед выпуском» (17.11.2026: кандидат рядом с вышедшим роликом, «Выпустить / Другой голос /
 * Оставить старый», самовыпуск по сроку) убран: человек слушает саму озвучку и утверждает ОДИН раз
 * (approveNarrationVersion), дальше сведённый ролик сразу становится роликом объекта и встаёт на выпуск.
 *
 * Кандидаты, которые ждали решения в момент выката, разбирает clearLeftoverNarrationPreviews (задача
 * narration-preview-due): файл кандидата удаляется, а его версия озвучки снова ждёт «Утвердить и выпустить» —
 * без человека ролик в сети не уходит (решение 18.11.2026, журнал docs/journal/2026-11-18-narration-simple-approve.md).
 */

/** Ролик вышел — одно место в lib/publishedClip.ts (там же «идёт замена постов» тоже считается вышедшим). */
export { isPublishedClip } from "./publishedClip.js";

const fileOf = (publicPath: string) => path.join(videoHandoffDir, path.basename(publicPath));
async function removeClipFiles(publicPath: string | null | undefined) {
  if (!publicPath) return;
  await fs.promises.unlink(fileOf(publicPath)).catch(() => {});
  await fs.promises.unlink(legacyHandoffCoverPath(publicPath)).catch(() => {});
}

/**
 * Замок строки объекта поверх замка объекта (ревью 18.11): «Без озвучки» (narrationOptOut.ts) закрывает
 * саму строку FOR UPDATE, а не общий замок — без этого её нажатие между чтением и записью пропустило
 * бы ролик с голосом в сеть.
 */
async function lockPropertyRow(tx: TxClient, propertyId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${propertyId} FOR UPDATE`;
}

/**
 * Новый голос в сеть нельзя: озвучка у объекта выключена, объект закрыт или удалён, или факты (цена и т.п.)
 * уже не те, что в этой версии озвучки.
 */
function voiceBlocked(cur: Parameters<typeof narrationFactsCurrent>[1] & { deletedAt: Date | null; narrationOff: boolean; status: string },
  version: { factsHash: string; factsSnapshot?: unknown }): boolean {
  return !!cur.deletedAt || cur.narrationOff || NARRATION_CLOSED_STATUSES.some((s) => s === cur.status) || !narrationFactsCurrent(version, cur);
}

/**
 * Подмена ролика объекта сведённым файлом (внутри замка). Вышедший ролик — заявка NARRATION_CHANGED с заменой
 * старых постов: по ней выпуск идёт своей короткой очередью (schedulePublishAfterAccept), а старые посты
 * снимаются после новых (lib/remakeOldPosts.ts).
 */
export async function replaceFinalWithMix(tx: TxClient, input: {
  propertyId: string; publicPath: string; versionId: string; revision: number; requestedById: string; published: boolean;
}): Promise<void> {
  await tx.property.update({ where: { id: input.propertyId }, data: {
    videoHandoffFinalPath: input.publicPath, videoHandoffReceivedAt: new Date(), videoMasterNarrationVersionId: input.versionId,
    videoMasterMixError: null, videoMasterMixErrorVersionId: null, scheduledPublishAt: null, scheduledPublishReason: null,
    ...NARRATION_PREVIEW_CLEARED,
  } });
  // Недоделанный Reels прежнего ролика вышел бы рядом с новым (тот же шаг, что при приёме ролика).
  await tx.pendingInstagramContainer.updateMany({ where: { propertyId: input.propertyId, status: "PENDING", kind: "REEL" },
    data: { status: "CANCELLED", resolvedAt: new Date(), error: "CRM наложила новую озвучку — Reels прежнего ролика отменён" } });
  // Одна дверь замены (lib/remakeRequests.ts): вторая озвучка, пока первая замена не закрыта, берёт свежий снимок
  // (посты первой — «старые»), переносит её нерешённые старые посты и выходит во все сети.
  if (input.published) {
    await openReplacement(tx, { propertyId: input.propertyId, reason: "NARRATION_CHANGED", requestedById: input.requestedById, narrationVersionId: input.versionId,
      comment: `Новая озвучка, версия ${input.revision}: утверждена человеком, CRM наложила её сама, монтажёр не нужен.` });
  }
}

export type PlacedMix =
  | { kind: "REPLACED"; oldFinal: string | null; oldPreview: string | null; reviewPending: boolean }
  | { kind: "SKIPPED" };

/**
 * Сведённый файл — на место. Под замком и по свежей записи: пока шёл ffmpeg, всё могло поменяться —
 * тогда SKIPPED (ничего не записано; файл удаляет вызывающий).
 */
export async function placeMixedClip(input: {
  propertyId: string; publicPath: string; masterKey: string | null; seenVersionId: string | null; versionId: string; revision: number;
  requestedById: string;
  /** Своя музыка (18.11.2026): сведено из вышедшего ролика, мастера нет. Ролик сменился — SKIPPED; трек запоминается. */
  music?: { sourceFinalPath: string; trackId: string };
}): Promise<PlacedMix> {
  return withPropertyLock(input.propertyId, async (tx): Promise<PlacedMix> => {
    await lockPropertyRow(tx, input.propertyId);
    const cur = await tx.property.findUnique({ where: { id: input.propertyId }, include: { district: true } });
    const stillLatest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId: input.propertyId }, orderBy: { revision: "desc" }, select: { id: true, factsHash: true, factsSnapshot: true } });
    if (!cur || !stillLatest || cur.videoHandoffStatus !== "RECEIVED" || cur.videoMasterStorageKey !== input.masterKey
      || cur.videoMasterNarrationVersionId !== input.seenVersionId || stillLatest.id !== input.versionId) return { kind: "SKIPPED" };
    // Пока шёл ffmpeg, включили «Без озвучки», объект закрыли или цена поменялась — подмены нет.
    if (voiceBlocked(cur, stillLatest)) return { kind: "SKIPPED" };
    if (input.music && cur.videoHandoffFinalPath !== input.music.sourceFinalPath) return { kind: "SKIPPED" };
    if (await isHandoffPublishRunning(input.propertyId, tx)) return { kind: "SKIPPED" };
    await replaceFinalWithMix(tx, { propertyId: input.propertyId, publicPath: input.publicPath, versionId: input.versionId, revision: input.revision,
      requestedById: input.requestedById, published: await clipCountsAsPublished(input.propertyId, cur, tx) });
    // Трек, который лёг в этот ролик: следующий раз — другой.
    if (input.music) await tx.property.update({ where: { id: input.propertyId }, data: { narrationMusicTrackId: input.music.trackId } });
    return { kind: "REPLACED", oldFinal: cur.videoHandoffFinalPath, oldPreview: cur.narrationPreviewPath, reviewPending: cur.clipReviewStatus === "PENDING" };
  });
}

/** Старые файлы после placeMixedClip (вне замка). */
export async function dropReplacedClipFiles(placed: PlacedMix, keep: string): Promise<void> {
  if (placed.kind === "SKIPPED") return;
  if (placed.oldPreview && placed.oldPreview !== keep) await removeClipFiles(placed.oldPreview);
  if (placed.oldFinal && placed.oldFinal !== keep) await removeClipFiles(placed.oldFinal);
}

/**
 * КАНДИДАТЫ, ОСТАВШИЕСЯ ОТ «ПРОСЛУШАТЬ ПЕРЕД ВЫПУСКОМ» (18.11.2026, задача narration-preview-due): шаг убран,
 * кандидата больше никто не выпустит — файл удаляется, поля очищаются. Утверждения их версий (и версий, от которых
 * отказались «Оставить старый», и утверждённых автоматически на вышедшем ролике) снимает SQL миграции
 * 20261118220000_narration_simple_approve; кандидата, заведённого старым worker уже после SQL (окно выката), — эта
 * уборка; а перемикс такие версии не выпускает никогда (постоянный сторож в remixWanted). Идемпотентно.
 */
export async function clearLeftoverNarrationPreviews(): Promise<number> {
  const rows = await prisma.property.findMany({ where: { OR: [{ narrationPreviewVersionId: { not: null } }, { narrationPreviewPath: { not: null } }] },
    select: { id: true, narrationPreviewVersionId: true, narrationPreviewPath: true }, take: 200 });
  let cleared = 0;
  for (const row of rows) {
    try {
      const done = await withPropertyLock(row.id, async (tx) => {
        await lockPropertyRow(tx, row.id);
        const cur = await tx.property.findUnique({ where: { id: row.id }, select: { narrationPreviewVersionId: true, narrationPreviewPath: true, videoMasterNarrationVersionId: true } });
        if (!cur || cur.narrationPreviewVersionId !== row.narrationPreviewVersionId || cur.narrationPreviewPath !== row.narrationPreviewPath) return false;
        // Отметку отказа «Оставить старый» не трогаем: она держит версию ещё один выпуск (remixWanted).
        await tx.property.update({ where: { id: row.id }, data: NARRATION_PREVIEW_CLEARED });
        // Кандидата мог завести старый worker уже ПОСЛЕ шага SQL (выкат гонит миграцию при живом старом коде, ревью 18.11):
        // его версия, если она последняя и не наложена, снова ждёт человека.
        const latest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId: row.id }, orderBy: { revision: "desc" }, select: { id: true } });
        if (cur.narrationPreviewVersionId && latest?.id === cur.narrationPreviewVersionId && cur.videoMasterNarrationVersionId !== latest.id) {
          await tx.propertyNarrationVersion.updateMany({ where: { id: latest.id, status: "READY" },
            data: { approvedAt: null, approvedById: null, approvalNotifiedAt: null, approvalRemindedAt: null, approvalEscalatedAt: null } });
        }
        return true;
      });
      if (!done) continue;
      cleared++;
      if (row.narrationPreviewPath) await removeClipFiles(row.narrationPreviewPath);
    } catch (err) {
      void logSystemError("video-handoff", `Оставшийся кандидат «прослушать перед выпуском» не убран: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: `narration-preview-leftover:${row.id}` });
    }
  }
  return cleared;
}

/**
 * САМООДОБРЕНИЕ НА ВЫШЕДШЕМ РОЛИКЕ — СНОВА К ЧЕЛОВЕКУ (третье ревью 18.11, задача narration-preview-due). Такая версия
 * в сеть не выходит (сторож в remixWanted), но сообщение «послушайте и утвердите» о ней уже числится отправленным —
 * без этой уборки она молча висела бы. Тот же отбор, что у шага данных миграции (последняя версия объекта, не наложена,
 * не у монтажёра), только по самоодобрению: утверждение и отметки сообщения снимаются, обычное одно сообщение уходит
 * заново. Массовой рассылки нет: по одной (последней) версии на объект, и только самоодобренных.
 */
export async function reopenAutoApprovalsOnPublishedClips(): Promise<number> {
  return prisma.$executeRaw`
    WITH latest AS (
      SELECT DISTINCT ON (v."propertyId") v."id", v."propertyId", v."status", v."approvedAt", v."approvalNotifiedAt"
      FROM "PropertyNarrationVersion" v ORDER BY v."propertyId", v."revision" DESC
    )
    UPDATE "PropertyNarrationVersion" t
    SET "approvedAt" = NULL, "approvedById" = NULL, "approvalNotifiedAt" = NULL, "approvalRemindedAt" = NULL, "approvalEscalatedAt" = NULL
    FROM latest l JOIN "Property" p ON p."id" = l."propertyId"
    WHERE t."id" = l."id" AND t."status" = 'READY' AND t."approvedAt" IS NOT NULL AND t."approvalNotifiedAt" = t."approvedAt"
      AND p."deletedAt" IS NULL AND (cardinality(p."publishedChannels") > 0 OR p."instagramUrl" IS NOT NULL)
      AND p."videoMasterNarrationVersionId" IS DISTINCT FROM l."id" AND p."videoMasterMixErrorVersionId" IS DISTINCT FROM l."id"
      AND NOT EXISTS (SELECT 1 FROM "PropertyNarrationDelivery" d WHERE d."versionId" = l."id" AND d."status" IN ('SENT', 'QUEUED', 'SENDING', 'UNKNOWN'))`;
}

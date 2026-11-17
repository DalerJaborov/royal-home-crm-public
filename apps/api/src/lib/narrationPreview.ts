import fs from "node:fs";
import path from "node:path";
import { prisma, type TxClient } from "../db.js";
import { videoHandoffDir } from "../upload.js";
import { logAgentAudit } from "./audit.js";
import { clipOwnerDueOrNull } from "./clipOwnerDue.js";
import { legacyHandoffCoverPath } from "./diskCleanup.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";
import { NARRATION_PREVIEW_CLEARED } from "./narrationPreviewFields.js";
import { logSystemError } from "./systemError.js";
import { isHandoffPublishRunning, schedulePublishAfterAccept, withPropertyLock } from "./videoHandoff.js";

/**
 * ПРОСЛУШАТЬ ПЕРЕД ВЫПУСКОМ (17.11.2026, задача владельца после #219).
 *
 * CRM сама накладывает новую озвучку на вышедший ролик (смена цены и т.п., lib/narrationAutoFlow.ts →
 * remixFromMasterClaimed). Раньше новый файл сразу подменял вышедший и уходил в сети. Теперь, если ролик
 * уже вышел и рубильник «Прослушать перед выпуском» включён, новый ролик — КАНДИДАТ: лежит рядом,
 * вышедший не трогается, хозяин объекта получает его в Telegram и в карточке CRM с тремя решениями:
 *   • «Выпустить» — кандидат становится роликом объекта (та же подмена, что была раньше, одна функция
 *     replaceFinalWithMix), старые посты снимутся, когда выйдет новый;
 *   • «Оставить старый» — кандидат удаляется, эту версию озвучки CRM больше не накладывает;
 *   • «Другой голос или текст» — то же, плюс хозяину кнопки выбора; новая версия → новый кандидат.
 * Молчит — кандидат выходит сам в narrationPreviewDueAt: те же часы, что «Ролик подтверждает хозяин»
 * (Settings.clipOwnerAutoPublishHours, по умолчанию 3; ночью — в 07:00 по Душанбе; 0 — сам не выходит).
 *
 * Гонки: всё под замком объекта (withPropertyLock) и с проверкой «кандидат тот же, ролик без голоса тот
 * же, версия всё ещё последняя». Устаревший кандидат (пришёл новый ролик от монтажёра, новая версия
 * озвучки) не выпускается и убирается.
 */

export type NarrationPreviewReadyEvent = { propertyId: string; versionId: string };

const readyListeners: Array<(e: NarrationPreviewReadyEvent) => Promise<void>> = [];
/** Telegram (telegram/narrationPreviewBot.ts) подписывается при старте: lib не тянет бота к себе. */
export function onNarrationPreviewReady(fn: (e: NarrationPreviewReadyEvent) => Promise<void>): void {
  readyListeners.push(fn);
}
async function emitReady(e: NarrationPreviewReadyEvent) {
  for (const fn of readyListeners) {
    await fn(e).catch((err) => logSystemError("video-handoff", `Новый ролик с озвучкой не отправлен хозяину на прослушивание: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: `narration-preview-notify:${e.versionId}` }));
  }
}

/** Ролик вышел хотя бы в один канал — тогда новый голос сначала слушает хозяин. */
export function isPublishedClip(p: { publishedChannels?: readonly string[] | null; instagramUrl?: string | null }): boolean {
  return (p.publishedChannels?.length ?? 0) > 0 || !!p.instagramUrl;
}

const fileOf = (publicPath: string) => path.join(videoHandoffDir, path.basename(publicPath));
async function removeClipFiles(publicPath: string | null | undefined) {
  if (!publicPath) return;
  await fs.promises.unlink(fileOf(publicPath)).catch(() => {});
  await fs.promises.unlink(legacyHandoffCoverPath(publicPath)).catch(() => {});
}

const clearedPreview = NARRATION_PREVIEW_CLEARED;

/**
 * Подмена ролика объекта сведённым файлом (внутри замка). Одна на прямой перемикс (ролик ещё не вышел
 * или рубильник выключен) и на «Выпустить».
 */
export async function replaceFinalWithMix(tx: TxClient, input: {
  propertyId: string; publicPath: string; versionId: string; revision: number; requestedById: string; published: boolean; viaPreview: boolean;
}): Promise<void> {
  await tx.property.update({ where: { id: input.propertyId }, data: {
    videoHandoffFinalPath: input.publicPath, videoHandoffReceivedAt: new Date(), videoMasterNarrationVersionId: input.versionId,
    videoMasterMixError: null, videoMasterMixErrorVersionId: null, scheduledPublishAt: null, scheduledPublishReason: null,
    ...clearedPreview,
  } });
  // Недоделанный Reels прежнего ролика вышел бы рядом с новым (тот же шаг, что при приёме ролика).
  await tx.pendingInstagramContainer.updateMany({ where: { propertyId: input.propertyId, status: "PENDING", kind: "REEL" },
    data: { status: "CANCELLED", resolvedAt: new Date(), error: "CRM наложила новую озвучку — Reels прежнего ролика отменён" } });
  if (input.published && !await tx.videoRemakeRequest.findFirst({ where: { propertyId: input.propertyId, replaceOldPostsOnPublish: true, oldPostsReplacedAt: null }, select: { id: true } })) {
    await tx.videoRemakeRequest.create({ data: { propertyId: input.propertyId, reason: "NARRATION_CHANGED", requestedById: input.requestedById, replaceOldPostsOnPublish: true,
      comment: input.viaPreview
        ? `Новая озвучка, версия ${input.revision}: CRM наложила её сама, хозяин объекта выпустил (или срок прослушивания прошёл).`
        : `Новая озвучка, версия ${input.revision}: CRM наложила её сама, монтажёр не нужен.` } });
  }
}

/** Срок самовыпуска: часы из «Ролик подтверждает хозяин» (0 — сам не выходит). */
async function previewDueAt(now: Date): Promise<Date | null> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { clipOwnerAutoPublishHours: true } });
  return clipOwnerDueOrNull(now, s?.clipOwnerAutoPublishHours ?? 3);
}

/**
 * Сведённый файл — кандидатом к вышедшему ролику. Прежний кандидат (старая версия озвучки) заменяется.
 * SKIPPED — пока сводили, всё поменялось: файл удалён, ничего не записано.
 */
export async function storeNarrationPreview(input: {
  propertyId: string; outPath: string; publicPath: string; masterKey: string; seenVersionId: string | null;
  versionId: string; voiceSec: number; clipSec: number; now?: Date;
}): Promise<"STORED" | "SKIPPED"> {
  const now = input.now ?? new Date();
  const dueAt = await previewDueAt(now);
  let oldPreview: string | null = null;
  let stored: boolean;
  try {
    stored = await withPropertyLock(input.propertyId, async (tx) => {
      const cur = await tx.property.findUnique({ where: { id: input.propertyId }, select: { deletedAt: true, videoHandoffStatus: true,
        videoMasterStorageKey: true, videoMasterNarrationVersionId: true, narrationPreviewPath: true } });
      const stillLatest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId: input.propertyId }, orderBy: { revision: "desc" }, select: { id: true } });
      if (!cur || cur.deletedAt || cur.videoHandoffStatus !== "RECEIVED" || cur.videoMasterStorageKey !== input.masterKey
        || cur.videoMasterNarrationVersionId !== input.seenVersionId || stillLatest?.id !== input.versionId) return false;
      if (await isHandoffPublishRunning(input.propertyId, tx)) return false;
      oldPreview = cur.narrationPreviewPath;
      await tx.property.update({ where: { id: input.propertyId }, data: {
        narrationPreviewPath: input.publicPath, narrationPreviewVersionId: input.versionId, narrationPreviewMasterKey: input.masterKey,
        narrationPreviewAt: now, narrationPreviewDueAt: dueAt, narrationPreviewVoiceSec: input.voiceSec, narrationPreviewClipSec: input.clipSec,
        narrationPreviewDeclinedVersionId: null, videoMasterMixError: null, videoMasterMixErrorVersionId: null,
      } });
      return true;
    });
  } catch (err) {
    await fs.promises.unlink(input.outPath).catch(() => {});
    throw err;
  }
  if (!stored) {
    await fs.promises.unlink(input.outPath).catch(() => {});
    return "SKIPPED";
  }
  if (oldPreview && oldPreview !== input.publicPath) await removeClipFiles(oldPreview);
  await emitReady({ propertyId: input.propertyId, versionId: input.versionId });
  return "STORED";
}

export type NarrationPreviewActor = { agentId: string | null; source: "crm" | "telegram" | "auto" };
export type NarrationPreviewResult = "RELEASED" | "DECLINED" | "STALE";

/**
 * «Выпустить» (или срок прослушивания прошёл): кандидат становится роликом объекта и встаёт на
 * публикацию, как раньше вставал сразу после перемикса. Устарел — убирается, STALE.
 */
export async function releaseNarrationPreview(propertyId: string, versionId: string, actor: NarrationPreviewActor, now: Date = new Date()): Promise<NarrationPreviewResult> {
  type Done = { oldFinal: string | null; reviewPending: boolean; revision: number; requestedById: string };
  let stalePreview: string | null = null;
  const done = await withPropertyLock(propertyId, async (tx): Promise<Done | null> => {
    const cur = await tx.property.findUnique({ where: { id: propertyId }, select: { deletedAt: true, videoHandoffStatus: true, videoHandoffFinalPath: true,
      videoMasterStorageKey: true, narrationPreviewPath: true, narrationPreviewVersionId: true, narrationPreviewMasterKey: true, narrationPreviewDueAt: true,
      publishedChannels: true, instagramUrl: true, clipReviewStatus: true, assignedAgentId: true, intakeAgentId: true, createdById: true } });
    if (!cur || cur.narrationPreviewVersionId !== versionId || !cur.narrationPreviewPath) return null;
    // Самовыпуск — только если срок всё тот же (хозяин мог уже решить, кандидат мог смениться).
    if (actor.source === "auto" && !(cur.narrationPreviewDueAt && cur.narrationPreviewDueAt.getTime() <= now.getTime())) return null;
    const version = await tx.propertyNarrationVersion.findUnique({ where: { id: versionId }, select: { revision: true, approvedById: true } });
    const stillLatest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" }, select: { id: true } });
    if (cur.deletedAt || cur.videoHandoffStatus !== "RECEIVED" || cur.videoMasterStorageKey !== cur.narrationPreviewMasterKey || stillLatest?.id !== versionId || !version) {
      stalePreview = cur.narrationPreviewPath;
      await tx.property.update({ where: { id: propertyId }, data: clearedPreview });
      return null;
    }
    // Публикация прежнего ролика идёт прямо сейчас — подмена под ней сорвала бы её; решение повторят.
    if (await isHandoffPublishRunning(propertyId, tx)) return null;
    const requestedById = actor.agentId ?? version.approvedById ?? propertyOwnerAgentId(cur);
    if (!requestedById) return null;
    await replaceFinalWithMix(tx, { propertyId, publicPath: cur.narrationPreviewPath, versionId, revision: version.revision, requestedById, published: isPublishedClip(cur), viaPreview: true });
    return { oldFinal: cur.videoHandoffFinalPath, reviewPending: cur.clipReviewStatus === "PENDING", revision: version.revision, requestedById };
  });
  if (stalePreview) await removeClipFiles(stalePreview);
  if (!done) return "STALE";
  await removeClipFiles(done.oldFinal);
  // Ролик на проверке модератора встанет на публикацию после «Одобрить», как обычно.
  const scheduled = done.reviewPending ? null : await schedulePublishAfterAccept(propertyId);
  logAgentAudit(done.requestedById, "PROPERTY_NARRATION_PREVIEW_RELEASED", "Property", propertyId, { narrationVersionId: versionId, revision: done.revision, source: actor.source,
    scheduledPublishAt: scheduled?.scheduledPublishAt?.toISOString() ?? null, notPublishingReason: scheduled?.notPublishingReason ?? null });
  return "RELEASED";
}

/**
 * «Оставить старый» / «Другой голос или текст»: кандидат удаляется, вышедший ролик остаётся, эту версию
 * озвучки CRM больше не накладывает (remixWanted смотрит narrationPreviewDeclinedVersionId).
 */
export async function declineNarrationPreview(propertyId: string, versionId: string, actor: { agentId: string; source: "crm" | "telegram" }, reason: "KEEP_OLD" | "CHANGE"): Promise<NarrationPreviewResult> {
  const cur = await prisma.property.findUnique({ where: { id: propertyId }, select: { narrationPreviewPath: true, narrationPreviewVersionId: true } });
  if (cur?.narrationPreviewVersionId !== versionId) return "STALE";
  const res = await prisma.property.updateMany({ where: { id: propertyId, narrationPreviewVersionId: versionId, narrationPreviewPath: cur.narrationPreviewPath },
    data: { ...clearedPreview, narrationPreviewDeclinedVersionId: versionId } });
  if (!res.count) return "STALE";
  await removeClipFiles(cur.narrationPreviewPath);
  logAgentAudit(actor.agentId, reason === "KEEP_OLD" ? "PROPERTY_NARRATION_PREVIEW_KEPT_OLD" : "PROPERTY_NARRATION_PREVIEW_CHANGE", "Property", propertyId, { narrationVersionId: versionId, source: actor.source });
  return "DECLINED";
}

/** Задача `narration-preview-due` (cron.ts): кандидаты, чей срок прослушивания прошёл, выходят сами. */
export async function releaseDueNarrationPreviews(now: Date = new Date()): Promise<{ released: number }> {
  const due = await prisma.property.findMany({ where: { narrationPreviewDueAt: { lte: now }, narrationPreviewVersionId: { not: null }, deletedAt: null },
    select: { id: true, narrationPreviewVersionId: true }, orderBy: { narrationPreviewDueAt: "asc" }, take: 20 });
  let released = 0;
  for (const row of due) {
    try {
      if (await releaseNarrationPreview(row.id, row.narrationPreviewVersionId!, { agentId: null, source: "auto" }, now) === "RELEASED") released++;
    } catch (err) {
      void logSystemError("video-handoff", `Новый ролик с озвучкой не выпущен по сроку прослушивания: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: `narration-preview-due:${row.id}` });
    }
  }
  return { released };
}

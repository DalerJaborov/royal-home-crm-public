import fs from "node:fs";
import path from "node:path";
import { prisma, type TxClient } from "../db.js";
import { videoHandoffDir } from "../upload.js";
import { logAgentAudit } from "./audit.js";
import { clipOwnerDueOrNull } from "./clipOwnerDue.js";
import { legacyHandoffCoverPath } from "./diskCleanup.js";
import { NARRATION_CLOSED_STATUSES } from "./narrationOptOut.js";
import { NARRATION_PREVIEW_CLEARED } from "./narrationPreviewFields.js";
import { narrationFactsCurrent } from "./propertyNarration.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";
import { logSystemError } from "./systemError.js";
import { isHandoffPublishRunning, schedulePublishAfterAccept, withPropertyLock } from "./videoHandoff.js";

/**
 * ПРОСЛУШАТЬ ПЕРЕД ВЫПУСКОМ (17.11.2026, задача владельца после #219; ревью architect 18.11).
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
 * Гонки: «кандидат или сразу подмена» решается под замком объекта по свежей записи (публикация могла
 * завершиться, пока шёл ffmpeg). Выпуск — под тем же замком с проверкой: кандидат тот же, ролик без голоса
 * тот же, версия последняя и с нынешними фактами, озвучка не выключена, объект не закрыт, файл на месте.
 * Устаревший кандидат не выпускается и убирается. Хозяину сообщает задача narration-preview-due
 * (notifyPendingNarrationPreviews) с отметкой narrationPreviewNotifiedAt — упал процесс, повторит тик.
 */

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
const fileExists = (publicPath: string) => fs.promises.access(fileOf(publicPath)).then(() => true, () => false);

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

export type PlacedMix =
  | { kind: "PREVIEW"; oldPreview: string | null }
  | { kind: "REPLACED"; oldFinal: string | null; oldPreview: string | null; reviewPending: boolean }
  | { kind: "SKIPPED" };

/**
 * Сведённый файл — на место (перемикс, lib/narrationAutoFlow.ts). Под замком и по свежей записи: ролик вышел
 * и «прослушать» включено — кандидат к вышедшему (прежний кандидат заменяется); иначе — сразу роликом
 * объекта. SKIPPED — пока сводили, всё поменялось (ничего не записано; файл удаляет вызывающий).
 */
export async function placeMixedClip(input: {
  propertyId: string; publicPath: string; masterKey: string; seenVersionId: string | null; versionId: string; revision: number;
  requestedById: string; previewEnabled: boolean; voiceSec: number; clipSec: number; now?: Date;
}): Promise<PlacedMix> {
  const now = input.now ?? new Date();
  const dueAt = input.previewEnabled ? await previewDueAt(now) : null;
  return withPropertyLock(input.propertyId, async (tx): Promise<PlacedMix> => {
    const cur = await tx.property.findUnique({ where: { id: input.propertyId }, select: { deletedAt: true, videoHandoffStatus: true, videoHandoffFinalPath: true,
      videoMasterStorageKey: true, videoMasterNarrationVersionId: true, publishedChannels: true, instagramUrl: true, clipReviewStatus: true, narrationPreviewPath: true } });
    const stillLatest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId: input.propertyId }, orderBy: { revision: "desc" }, select: { id: true } });
    if (!cur || cur.deletedAt || cur.videoHandoffStatus !== "RECEIVED" || cur.videoMasterStorageKey !== input.masterKey
      || cur.videoMasterNarrationVersionId !== input.seenVersionId || stillLatest?.id !== input.versionId) return { kind: "SKIPPED" };
    if (await isHandoffPublishRunning(input.propertyId, tx)) return { kind: "SKIPPED" };
    const published = isPublishedClip(cur);
    if (input.previewEnabled && published) {
      await tx.property.update({ where: { id: input.propertyId }, data: {
        narrationPreviewPath: input.publicPath, narrationPreviewVersionId: input.versionId, narrationPreviewMasterKey: input.masterKey,
        narrationPreviewAt: now, narrationPreviewDueAt: dueAt, narrationPreviewVoiceSec: input.voiceSec, narrationPreviewClipSec: input.clipSec,
        narrationPreviewNotifiedAt: null, narrationPreviewDeclinedVersionId: null, videoMasterMixError: null, videoMasterMixErrorVersionId: null,
      } });
      return { kind: "PREVIEW", oldPreview: cur.narrationPreviewPath };
    }
    await replaceFinalWithMix(tx, { propertyId: input.propertyId, publicPath: input.publicPath, versionId: input.versionId, revision: input.revision,
      requestedById: input.requestedById, published, viaPreview: false });
    return { kind: "REPLACED", oldFinal: cur.videoHandoffFinalPath, oldPreview: cur.narrationPreviewPath, reviewPending: cur.clipReviewStatus === "PENDING" };
  });
}

/** Старые файлы после placeMixedClip (вне замка). */
export async function dropReplacedClipFiles(placed: PlacedMix, keep: string): Promise<void> {
  if (placed.kind === "SKIPPED") return;
  if (placed.oldPreview && placed.oldPreview !== keep) await removeClipFiles(placed.oldPreview);
  if (placed.kind === "REPLACED" && placed.oldFinal && placed.oldFinal !== keep) await removeClipFiles(placed.oldFinal);
}

export type NarrationPreviewActor = { agentId: string | null; source: "crm" | "telegram" | "auto" };
/** BUSY — прежний ролик прямо сейчас уходит в сети: решение не принято, повторить через пару минут. */
export type NarrationPreviewResult = "RELEASED" | "DECLINED" | "STALE" | "BUSY";

/**
 * «Выпустить» (или срок прослушивания прошёл): кандидат становится роликом объекта и встаёт на
 * публикацию, как раньше вставал сразу после перемикса. Устарел — убирается, STALE.
 */
export async function releaseNarrationPreview(propertyId: string, versionId: string, actor: NarrationPreviewActor, now: Date = new Date()): Promise<NarrationPreviewResult> {
  type Done = { oldFinal: string | null; reviewPending: boolean; revision: number; requestedById: string };
  const pre = await prisma.property.findUnique({ where: { id: propertyId }, select: { narrationPreviewPath: true, narrationPreviewVersionId: true } });
  // Файла нет (стёрт с диска) — выпускать нечего: без проверки объект остался бы вовсе без ролика.
  const fileOk = !!pre?.narrationPreviewPath && pre.narrationPreviewVersionId === versionId && await fileExists(pre.narrationPreviewPath);
  let stalePreview: string | null = null;
  const done = await withPropertyLock(propertyId, async (tx): Promise<Done | "STALE" | "BUSY"> => {
    const cur = await tx.property.findUnique({ where: { id: propertyId }, include: { district: true } });
    if (!cur || cur.narrationPreviewVersionId !== versionId || !cur.narrationPreviewPath) return "STALE";
    // Самовыпуск — только если срок всё тот же (хозяин мог уже решить, кандидат мог смениться).
    if (actor.source === "auto" && !(cur.narrationPreviewDueAt && cur.narrationPreviewDueAt.getTime() <= now.getTime())) return "STALE";
    const version = await tx.propertyNarrationVersion.findUnique({ where: { id: versionId }, select: { revision: true, approvedById: true, factsHash: true, factsSnapshot: true } });
    const stillLatest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" }, select: { id: true } });
    const requestedById = actor.agentId ?? version?.approvedById ?? propertyOwnerAgentId(cur);
    const stale = !fileOk || cur.narrationPreviewPath !== pre?.narrationPreviewPath || cur.deletedAt || cur.narrationOff
      || NARRATION_CLOSED_STATUSES.some((s) => s === cur.status) || cur.videoHandoffStatus !== "RECEIVED"
      || cur.videoMasterStorageKey !== cur.narrationPreviewMasterKey || stillLatest?.id !== versionId || !version
      // Цена (или другой факт) поменялась, а новая версия ещё не готова: старую цену в сети не выпускаем.
      || !narrationFactsCurrent(version, cur) || !requestedById;
    if (stale) {
      stalePreview = cur.narrationPreviewPath;
      await tx.property.update({ where: { id: propertyId }, data: clearedPreview });
      return "STALE";
    }
    // Публикация прежнего ролика идёт прямо сейчас — подмена под ней сорвала бы её; решение повторят.
    if (await isHandoffPublishRunning(propertyId, tx)) return "BUSY";
    await replaceFinalWithMix(tx, { propertyId, publicPath: cur.narrationPreviewPath, versionId, revision: version!.revision, requestedById: requestedById!, published: isPublishedClip(cur), viaPreview: true });
    return { oldFinal: cur.videoHandoffFinalPath, reviewPending: cur.clipReviewStatus === "PENDING", revision: version!.revision, requestedById: requestedById! };
  });
  if (stalePreview) await removeClipFiles(stalePreview);
  if (done === "STALE" || done === "BUSY") return done;
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
  const due = await prisma.property.findMany({ where: { narrationPreviewDueAt: { lte: now }, narrationPreviewVersionId: { not: null } },
    select: { id: true, narrationPreviewVersionId: true }, orderBy: { narrationPreviewDueAt: "asc" }, take: 20 });
  let released = 0;
  for (const row of due) {
    try {
      // STALE убирает кандидата, BUSY — следующим тиком; вечно в выборке висеть некому.
      if (await releaseNarrationPreview(row.id, row.narrationPreviewVersionId!, { agentId: null, source: "auto" }, now) === "RELEASED") released++;
    } catch (err) {
      void logSystemError("video-handoff", `Новый ролик с озвучкой не выпущен по сроку прослушивания: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: `narration-preview-due:${row.id}` });
    }
  }
  return { released };
}

export type NarrationPreviewNotice = { propertyId: string; versionId: string };
/**
 * Хозяину — новые кандидаты (та же задача narration-preview-due, отдельно от сведения: Telegram и
 * перекодирование видео не держат тик перемикса). Отметка ставится ДО отправки: два тика не пришлют дважды;
 * упал процесс до отметки — пришлёт следующий тик.
 */
export async function notifyPendingNarrationPreviews(notify: (n: NarrationPreviewNotice) => Promise<void>, now: Date = new Date()): Promise<{ notified: number }> {
  const rows = await prisma.property.findMany({ where: { narrationPreviewVersionId: { not: null }, narrationPreviewNotifiedAt: null, deletedAt: null },
    select: { id: true, narrationPreviewVersionId: true }, orderBy: { narrationPreviewAt: "asc" }, take: 5 });
  let notified = 0;
  for (const row of rows) {
    const claimed = await prisma.property.updateMany({ where: { id: row.id, narrationPreviewVersionId: row.narrationPreviewVersionId, narrationPreviewNotifiedAt: null }, data: { narrationPreviewNotifiedAt: now } });
    if (!claimed.count) continue;
    try {
      await notify({ propertyId: row.id, versionId: row.narrationPreviewVersionId! });
      notified++;
    } catch (err) {
      void logSystemError("video-handoff", `Новый ролик с озвучкой не отправлен хозяину на прослушивание: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: `narration-preview-notify:${row.id}` });
    }
  }
  return { notified };
}

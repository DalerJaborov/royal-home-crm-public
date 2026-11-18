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
 * Замок строки объекта поверх замка объекта (ревью 18.11): «Без озвучки» (narrationOptOut.ts) закрывает
 * саму строку FOR UPDATE, а не общий замок — без этого её нажатие между чтением и записью выпуска пропустило
 * бы ролик с голосом в сеть.
 */
async function lockPropertyRow(tx: TxClient, propertyId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${propertyId} FOR UPDATE`;
}

/**
 * Новый голос в сеть нельзя (одна проверка на «положить» и на «выпустить», ревью 18.11): озвучка у объекта
 * выключена, объект закрыт или удалён, или факты (цена и т.п.) уже не те, что в этой версии озвучки.
 */
function voiceBlocked(cur: Parameters<typeof narrationFactsCurrent>[1] & { deletedAt: Date | null; narrationOff: boolean; status: string },
  version: { factsHash: string; factsSnapshot?: unknown }): boolean {
  return !!cur.deletedAt || cur.narrationOff || NARRATION_CLOSED_STATUSES.some((s) => s === cur.status) || !narrationFactsCurrent(version, cur);
}

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
  propertyId: string; publicPath: string; masterKey: string | null; seenVersionId: string | null; versionId: string; revision: number;
  requestedById: string; previewEnabled: boolean; voiceSec: number; clipSec: number; now?: Date;
  /** Своя музыка (18.11.2026): сведено из вышедшего ролика, мастера нет. Ролик сменился — SKIPPED; трек запоминается. */
  music?: { sourceFinalPath: string; trackId: string };
}): Promise<PlacedMix> {
  const now = input.now ?? new Date();
  const dueAt = input.previewEnabled ? await previewDueAt(now) : null;
  return withPropertyLock(input.propertyId, async (tx): Promise<PlacedMix> => {
    await lockPropertyRow(tx, input.propertyId);
    const cur = await tx.property.findUnique({ where: { id: input.propertyId }, include: { district: true } });
    const stillLatest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId: input.propertyId }, orderBy: { revision: "desc" }, select: { id: true, factsHash: true, factsSnapshot: true } });
    if (!cur || !stillLatest || cur.videoHandoffStatus !== "RECEIVED" || cur.videoMasterStorageKey !== input.masterKey
      || cur.videoMasterNarrationVersionId !== input.seenVersionId || stillLatest.id !== input.versionId) return { kind: "SKIPPED" };
    // Пока шёл ffmpeg, включили «Без озвучки», объект закрыли или цена поменялась — ни подмены, ни кандидата.
    if (voiceBlocked(cur, stillLatest)) return { kind: "SKIPPED" };
    if (input.music && cur.videoHandoffFinalPath !== input.music.sourceFinalPath) return { kind: "SKIPPED" };
    // Трек, который лёг в этот ролик (кандидат или сразу подмена): следующий раз — другой.
    const musicData = input.music ? { narrationMusicTrackId: input.music.trackId } : {};
    if (await isHandoffPublishRunning(input.propertyId, tx)) return { kind: "SKIPPED" };
    const published = isPublishedClip(cur);
    if (input.previewEnabled && published) {
      await tx.property.update({ where: { id: input.propertyId }, data: {
        narrationPreviewPath: input.publicPath, narrationPreviewVersionId: input.versionId, narrationPreviewMasterKey: input.masterKey,
        narrationPreviewAt: now, narrationPreviewDueAt: dueAt, narrationPreviewVoiceSec: input.voiceSec, narrationPreviewClipSec: input.clipSec,
        narrationPreviewNotifiedAt: null, narrationPreviewDeclinedVersionId: null, videoMasterMixError: null, videoMasterMixErrorVersionId: null,
        ...musicData,
      } });
      return { kind: "PREVIEW", oldPreview: cur.narrationPreviewPath };
    }
    await replaceFinalWithMix(tx, { propertyId: input.propertyId, publicPath: input.publicPath, versionId: input.versionId, revision: input.revision,
      requestedById: input.requestedById, published, viaPreview: false });
    if (input.music) await tx.property.update({ where: { id: input.propertyId }, data: musicData });
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
    await lockPropertyRow(tx, propertyId);
    const cur = await tx.property.findUnique({ where: { id: propertyId }, include: { district: true } });
    if (!cur || cur.narrationPreviewVersionId !== versionId || !cur.narrationPreviewPath) return "STALE";
    // Самовыпуск — только если срок всё тот же (хозяин мог уже решить, кандидат мог смениться).
    if (actor.source === "auto" && !(cur.narrationPreviewDueAt && cur.narrationPreviewDueAt.getTime() <= now.getTime())) return "STALE";
    const version = await tx.propertyNarrationVersion.findUnique({ where: { id: versionId }, select: { revision: true, approvedById: true, factsHash: true, factsSnapshot: true } });
    const stillLatest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" }, select: { id: true } });
    const requestedById = actor.agentId ?? version?.approvedById ?? propertyOwnerAgentId(cur);
    const stale = !fileOk || cur.narrationPreviewPath !== pre?.narrationPreviewPath || cur.videoHandoffStatus !== "RECEIVED"
      || cur.videoMasterStorageKey !== cur.narrationPreviewMasterKey || stillLatest?.id !== versionId || !version
      // Цена (или другой факт) поменялась, а новая версия ещё не готова: старую цену в сети не выпускаем.
      || voiceBlocked(cur, version) || !requestedById;
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
  // Под тем же замком, что «Выпустить» и самовыпуск (ревью 18.11): иначе отказ мог стереть файл кандидата,
  // который выпуск в тот же миг ставил роликом объекта, — и объект оставался без ролика.
  const cur = await withPropertyLock(propertyId, async (tx) => {
    await lockPropertyRow(tx, propertyId);
    const row = await tx.property.findUnique({ where: { id: propertyId }, select: { narrationPreviewPath: true, narrationPreviewVersionId: true } });
    if (!row || row.narrationPreviewVersionId !== versionId) return null;
    await tx.property.update({ where: { id: propertyId }, data: { ...clearedPreview, narrationPreviewDeclinedVersionId: versionId } });
    return row;
  });
  if (!cur) return "STALE";
  await removeClipFiles(cur.narrationPreviewPath);
  logAgentAudit(actor.agentId, reason === "KEEP_OLD" ? "PROPERTY_NARRATION_PREVIEW_KEPT_OLD" : "PROPERTY_NARRATION_PREVIEW_CHANGE", "Property", propertyId, { narrationVersionId: versionId, source: actor.source });
  return "DECLINED";
}

/**
 * Задача `narration-preview-due` (cron.ts): кандидаты, чей срок прослушивания прошёл, выходят сами; заодно
 * убираются кандидаты, которые уже не к чему выпускать (ролик вернули монтажёру, сменился ролик без голоса,
 * «Без озвучки», объект закрыт) — без этого при «0 часов» такой кандидат висел бы невидимым вечно.
 */
export async function releaseDueNarrationPreviews(now: Date = new Date()): Promise<{ released: number; cleared: number }> {
  const waiting = await prisma.property.findMany({ where: { narrationPreviewVersionId: { not: null } },
    select: { id: true, narrationPreviewVersionId: true, narrationPreviewPath: true, narrationPreviewMasterKey: true, narrationPreviewDueAt: true,
      videoMasterStorageKey: true, videoHandoffStatus: true, narrationOff: true, status: true, deletedAt: true },
    orderBy: { narrationPreviewAt: "asc" }, take: 200 });
  let released = 0, cleared = 0;
  for (const row of waiting) {
    const orphan = !!row.deletedAt || row.narrationOff || row.videoHandoffStatus !== "RECEIVED" || row.narrationPreviewMasterKey !== row.videoMasterStorageKey
      || NARRATION_CLOSED_STATUSES.some((s) => s === row.status);
    try {
      if (orphan) {
        const res = await prisma.property.updateMany({ where: { id: row.id, narrationPreviewVersionId: row.narrationPreviewVersionId }, data: clearedPreview });
        if (res.count) { cleared++; await removeClipFiles(row.narrationPreviewPath); }
        continue;
      }
      if (!row.narrationPreviewDueAt || row.narrationPreviewDueAt.getTime() > now.getTime()) continue;
      // STALE убирает кандидата, BUSY — следующим тиком.
      if (await releaseNarrationPreview(row.id, row.narrationPreviewVersionId!, { agentId: null, source: "auto" }, now) === "RELEASED") released++;
    } catch (err) {
      void logSystemError("video-handoff", `Новый ролик с озвучкой не выпущен по сроку прослушивания: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: `narration-preview-due:${row.id}` });
    }
  }
  return { released, cleared };
}

export type NarrationPreviewNotice = { propertyId: string; versionId: string };
/**
 * Хозяину — новые кандидаты (та же задача narration-preview-due, отдельно от сведения: Telegram и
 * перекодирование видео не держат тик перемикса). Отметка ставится ПОСЛЕ отправки (ревью 18.11): упал
 * процесс или отправка — следующий тик пришлёт снова; в худшем случае хозяин получит сообщение дважды,
 * но не останется без него. Задача одна на worker и не перекрывается сама с собой.
 */
export async function notifyPendingNarrationPreviews(notify: (n: NarrationPreviewNotice) => Promise<void>, now: Date = new Date()): Promise<{ notified: number }> {
  const rows = await prisma.property.findMany({ where: { narrationPreviewVersionId: { not: null }, narrationPreviewNotifiedAt: null, deletedAt: null, narrationOff: false, videoHandoffStatus: "RECEIVED" },
    select: { id: true, narrationPreviewVersionId: true, narrationPreviewMasterKey: true, videoMasterStorageKey: true }, orderBy: { narrationPreviewAt: "asc" }, take: 20 });
  let notified = 0;
  // Кандидат к сменившемуся ролику без голоса хозяину не шлём — задача по сроку его уберёт (ревью 18.11).
  for (const row of rows.filter((r) => r.narrationPreviewMasterKey === r.videoMasterStorageKey).slice(0, 5)) {
    try {
      await notify({ propertyId: row.id, versionId: row.narrationPreviewVersionId! });
      const marked = await prisma.property.updateMany({ where: { id: row.id, narrationPreviewVersionId: row.narrationPreviewVersionId, narrationPreviewNotifiedAt: null }, data: { narrationPreviewNotifiedAt: now } });
      if (marked.count) notified++;
    } catch (err) {
      void logSystemError("video-handoff", `Новый ролик с озвучкой не отправлен хозяину на прослушивание (повтор через минуту): ${err instanceof Error ? err.message : String(err)}`, { dedupKey: `narration-preview-notify:${row.id}` });
    }
  }
  return { notified };
}

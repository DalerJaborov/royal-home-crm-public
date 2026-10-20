import type { Request } from "express";
import type { Prisma } from "../generated/prisma/client.js";
import type { PropertyVideoHandoffBrief } from "@royal-home/shared";
import { prisma } from "../db.js";
import { can } from "../auth/middleware.js";
import { computeDemandCounts } from "../routes/matching.js";
import { loadPipelineDeadlines, stageState } from "./propertyPipeline.js";
import { stripEmbedding, stripOwnerContact } from "./ownerContact.js";
import { videoHandoffQueuePositions } from "./videoHandoff.js";

/**
 * ОБЪЕКТ В СПИСКЕ — ОДНА ФОРМА НА ВСЕ СПИСКИ (24.09.2026, владелец про конвейер:
 * «добавь карточку объекта полностью со всей информацией, как и везде»).
 *
 * Вынесено из routes/properties/list.ts (GET /properties) без изменений, чтобы
 * конвейер (routes/marketing.ts: /queue, /editor-queue) отдавал объект той же
 * формы и тем же сериализатором, а веб рисовал его тем же PropertyRow. Вторая
 * копия набора полей разошлась бы со списком объектов в первую же правку.
 */
export const PROPERTY_LIST_INCLUDE = {
  // ВНИМАНИЕ: include отдаёт ВСЕ скаляры Property, включая embedding (768 float
  // на объект, ~15 КБ JSON) — перед ответом он вырезается stripEmbedding ниже.
  district: true,
  photos: { orderBy: { order: "asc" } },
  assignedAgent: { select: { id: true, fullName: true, avatarUrl: true } },
  // Кто принял объект у продавца — нужен в списке, а не только в карточке
  // (владелец 21.08.2026: «к нему прикрепилось и везде видно»). До сделки
  // assignedAgent пуст у большинства объектов, и без intakeAgent колонка/бейдж
  // «Агент» в списке оставались пустыми у только что заведённых карточек.
  intakeAgent: { select: { id: true, fullName: true, avatarUrl: true } },
  // От кого объект передан (24.09.2026): плашка «передан вам, примите» и
  // история последней передачи в карточке.
  handoverFromAgent: { select: { id: true, fullName: true, avatarUrl: true } },
} satisfies Prisma.PropertyInclude;

export type PropertyListRecord = Prisma.PropertyGetPayload<{ include: typeof PROPERTY_LIST_INCLUDE }>;

/**
 * «В КАКОМ СОСТОЯНИИ МОНТАЖ» СРАЗУ В СПИСКЕ (25.09.2026, владелец: «в списке
 * объектов сразу видеть, в каком состоянии»). БЕЗ N+1: позиции очереди —
 * ОДИН запрос на всю страницу (videoHandoffQueuePositions, уже дешёвый — см.
 * его докстринг), доставленные ролики держателя места — ОДИН запрос
 * `WHERE propertyId IN (...)` по объектам страницы, у которых реально есть
 * что считать (SENT_TO_EDITOR без ручной загрузки), а не по каждому отдельно.
 */
async function computeVideoHandoffBriefs(
  items: PropertyListRecord[],
  positions: Map<string, number>
): Promise<Map<string, PropertyVideoHandoffBrief>> {
  const now = Date.now();
  const editingIds = items
    .filter((p) => p.videoHandoffStatus === "SENT_TO_EDITOR" && !p.videoHandoffManualSince)
    .map((p) => p.id);
  const deliveredRows = editingIds.length
    ? await prisma.propertyVideo.findMany({
        where: { propertyId: { in: editingIds } },
        select: { propertyId: true, telegramFileId: true },
      })
    : [];
  const deliveredByProperty = new Map<string, { total: number; delivered: number }>();
  for (const v of deliveredRows) {
    const acc = deliveredByProperty.get(v.propertyId) ?? { total: 0, delivered: 0 };
    acc.total += 1;
    if (v.telegramFileId) acc.delivered += 1;
    deliveredByProperty.set(v.propertyId, acc);
  }

  const result = new Map<string, PropertyVideoHandoffBrief>();
  for (const p of items) {
    if (p.videoHandoffStatus === "NONE") {
      result.set(p.id, { state: "none" });
      continue;
    }
    // Отложен (25.09.2026, «Отложить») — стоит на своём месте в очереди, но
    // видно сразу, что монтажёру он пока не уйдёт, без числа позиции: число
    // читалось бы как «скоро», а он придержан осознанно.
    if (p.videoHandoffStatus === "QUEUED" && p.videoHandoffHeldAt) {
      result.set(p.id, { state: "held" });
      continue;
    }
    if (p.videoHandoffStatus === "QUEUED") {
      const pos = positions.get(p.id);
      // Та же нумерация, что у экрана подготовки и бота: держатель места — №1,
      // очередь начинается со 2-го (иначе один объект показывался «1-й» в списке
      // и «2-й» на экране подготовки).
      result.set(p.id, { state: "queued", position: pos ?? undefined });
      continue;
    }
    if (p.videoHandoffStatus === "SENT_TO_EDITOR" && !p.videoHandoffManualSince) {
      const counts = deliveredByProperty.get(p.id);
      result.set(p.id, {
        state: "editing",
        hours: p.videoHandoffSentAt ? Math.floor((now - p.videoHandoffSentAt.getTime()) / 3_600_000) : undefined,
        deliveredOf: counts ? [counts.delivered, counts.total] : undefined,
      });
      continue;
    }
    // Ролик принят, но ждёт проверки модератора (25.09.2026, lib/clipReview.ts):
    // слота нет, и «принят» без времени читался бы как «застрял».
    if (p.videoHandoffStatus === "RECEIVED" && p.clipReviewStatus === "PENDING") {
      result.set(p.id, { state: "clip_review" });
      continue;
    }
    if (p.videoHandoffStatus === "RECEIVED") {
      const publishAt = p.scheduledPublishAt?.toISOString();
      result.set(
        p.id,
        p.scheduledPublishAt && p.scheduledPublishAt.getTime() > now
          ? { state: "scheduled", publishAt }
          : { state: "received", publishAt }
      );
      continue;
    }
    // SENT_TO_EDITOR + videoHandoffManualSince (объект открыт под ручную
    // загрузку готового ролика, publishedVideoFix.ts) — монтажёр его не
    // держит, «5 ч у монтажёра» здесь была бы неправдой.
    result.set(p.id, { state: "editing" });
  }
  return result;
}

/**
 * Записи списка → ответ: без embedding, контакт хозяина по праву смотрящего,
 * спрос и этап конвейера. Сроки конвейера и спрос читаются ОДИН раз на страницу,
 * а не на объект: одинаковые запросы в настройки на каждую строку — это N+1.
 */
/**
 * СРОК ЭТАПА «МОНТАЖ» СЧИТАЕТСЯ ПО ТОМУ, КТО ДЕРЖИТ ОБЪЕКТ (05.10.2026, владелец:
 * «причём тут модерация и объекты монтажёра»). Статус EDITING живёт всё время —
 * очередь, работа монтажёра, проверка ролика модератором, ожидание слота публикации, —
 * а часы шли от входа в статус и красили «Монтажёр задерживает объект» за чужое
 * ожидание: объект 11 дней стоял без исходного видео (ждал агента), другой —
 * на проверке у модератора, а винили монтажёра.
 *  — у монтажёра по-настоящему (SENT_TO_EDITOR): отсчёт с момента передачи ему;
 *  — монтажёр сдал ролик (RECEIVED): он больше не держит объект, виноват тот, кто
 *    проверяет и публикует, — Маркетинг, отсчёт с момента приёма ролика.
 * Остальные состояния — как раньше.
 */
function pipelineStateFor(p: PropertyListRecord, deadlines: Awaited<ReturnType<typeof loadPipelineDeadlines>>) {
  if (p.status === "EDITING" && p.videoHandoffStatus === "SENT_TO_EDITOR" && !p.videoHandoffManualSince && p.videoHandoffSentAt) {
    return stageState(p.status, p.videoHandoffSentAt, deadlines);
  }
  if (p.status === "EDITING" && p.videoHandoffStatus === "RECEIVED" && p.videoHandoffReceivedAt) {
    return { ...stageState(p.status, p.videoHandoffReceivedAt, deadlines), owner: "MARKETING" as const };
  }
  return stageState(p.status, p.stageEnteredAt, deadlines);
}

export async function presentPropertyListItems(items: PropertyListRecord[], req: Request) {
  const [demandCounts, deadlines, positions] = await Promise.all([
    computeDemandCounts(items),
    loadPipelineDeadlines(),
    videoHandoffQueuePositions(),
  ]);
  const briefs = await computeVideoHandoffBriefs(items, positions);
  const viewOwners = can(req, "properties.viewOwners");
  return items.map((p) => ({
    ...stripEmbedding(stripOwnerContact(p, req.agent!.id, viewOwners)),
    demandCount: demandCounts.get(p.id) ?? 0,
    // Этап конвейера считается на сервере: у интерфейса не должно быть своей копии
    // правила «просрочен», иначе список и карточка однажды покрасятся по-разному.
    // Ключ pipeline, а НЕ stage: stage у объекта уже занят стадией строительства
    // (фундамент, коробка, сдан), и второй такой ключ молча затирал бы её в ответе.
    pipeline: pipelineStateFor(p, deadlines),
    /** Компактное состояние монтажа для чипа в строке списка (25.09.2026,
     *  задание D) — см. computeVideoHandoffBriefs выше. */
    videoHandoffBrief: briefs.get(p.id) ?? { state: "none" },
  }));
}

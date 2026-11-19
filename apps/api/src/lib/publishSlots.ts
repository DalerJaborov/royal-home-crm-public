import type { TxClient } from "../db.js";
import { DUSHANBE_OFFSET_MS } from "./dushanbeTime.js";

/**
 * Один замок на всю шкалу публикаций: ролики объектов, фото-посты, повторы, подборки и свободные ролики
 * ставят свои часы только держа его (`SELECT pg_advisory_xact_lock(...)` в своей транзакции). Живёт здесь, а не в
 * videoHandoff.ts, чтобы свободные ролики (socialVideoPosts) могли его взять без цикла импортов; videoHandoff
 * переизлучает константу для прежних импортов.
 */
export const PUBLISH_SLOT_LOCK_ID = 2209_2026;

/** Чей слот занят — для человеческого объяснения «в 14:00 уже выходит …». */
export type OccupiedSlotKind = "propertyVideo" | "photoPost" | "repost" | "digest" | "freeVideo";

export interface OccupiedSlot {
  at: Date;
  kind: OccupiedSlotKind;
}

export const OCCUPIED_SLOT_KIND_LABEL: Record<OccupiedSlotKind, string> = {
  propertyVideo: "ролик объекта",
  photoPost: "фото-пост объекта",
  repost: "повтор поста",
  digest: "подборка объектов",
  freeVideo: "другой ролик из «Роликов в соцсети»",
};

/**
 * ЗАНЯТЫЕ СЛОТЫ ПУБЛИКАЦИИ — ОБЩИЙ ИСТОЧНИК ПРАВДЫ (28.09.2026).
 *
 * До фото-постов единственным источником занятых слотов был
 * `Property.scheduledPublishAt` (см. lib/videoHandoff.ts::schedulePublishAfterAccept),
 * читаемый под общим advisory-замком `PUBLISH_SLOT_LOCK_ID`. Фото-посты
 * (lib/photoPosts.ts::schedulePhotoPostsTick) встают на ту же шкалу времени и
 * берут тот же замок — если бы они считали слоты отдельно, ролик и фото-пост
 * могли бы получить один и тот же час, и расстановка «не давать нескольким
 * публикациям уйти залпом» перестала бы работать для смеси из двух видов постов.
 *
 * Вызывающий код сам открывает транзакцию и берёт `PUBLISH_SLOT_LOCK_ID`
 * (`SELECT pg_advisory_xact_lock(...)`) ДО вызова этой функции — она только
 * читает, замок не трогает: держать его в одном месте нагляднее, чем прятать
 * внутрь читающей функции.
 *
 * ПОВТОРЫ И ПОДБОРКИ (28.09.2026, agent-brief.md reposts-digests) встают на ту
 * же шкалу тем же замком — PropertySocialRepost.scheduledAt и
 * SocialDigestPost.scheduledAt читаются здесь же, по той же причине, что и
 * фото-посты выше: отдельный счёт слотов дал бы повтору/подборке тот же час,
 * что уже занят роликом или фото-постом.
 */
export async function loadOccupiedPublishSlots(
  tx: TxClient,
  since: Date,
  /** Свой объект — при пересылке ролика после ошибки он сам уже держит
   *  прежний слот и не должен мешать себе же выбрать новый. */
  excludePropertyId?: string,
  /** Свой свободный ролик — при перестановке времени он не должен мешать сам себе. */
  excludeFreeVideoId?: string
): Promise<Date[]> {
  return (await loadOccupiedPublishSlotsDetailed(tx, since, excludePropertyId, excludeFreeVideoId)).map((s) => s.at);
}

/** То же, но с видом публикации — для предупреждения человеку при выборе времени свободного ролика. */
export async function loadOccupiedPublishSlotsDetailed(
  tx: TxClient,
  since: Date,
  excludePropertyId?: string,
  excludeFreeVideoId?: string,
  /** Верхняя граница выборки: проверке времени нужны только слоты рядом, а не всё расписание на годы вперёд. */
  until?: Date
): Promise<OccupiedSlot[]> {
  const upTo = until ? { lte: until } : {};
  const [videoRows, photoRows, repostRows, digestRows, freeRows] = await Promise.all([
    tx.property.findMany({
      where: {
        deletedAt: null,
        ...(excludePropertyId ? { id: { not: excludePropertyId } } : {}),
        scheduledPublishAt: { gte: since, ...upTo },
      },
      orderBy: { scheduledPublishAt: "asc" },
      take: 1000,
      select: { scheduledPublishAt: true },
    }),
    // Только SCHEDULED — PUBLISHED/FAILED/REMOVED больше не держат время: слот
    // уже свободен, ровно как publishedChannels ролика не считается занятым
    // местом в комментарии у schedulePublishAfterAccept.
    tx.propertyPhotoPost.findMany({
      where: {
        status: "SCHEDULED",
        scheduledAt: { gte: since, ...upTo },
        ...(excludePropertyId ? { propertyId: { not: excludePropertyId } } : {}),
      },
      orderBy: { scheduledAt: "asc" },
      take: 1000,
      select: { scheduledAt: true },
    }),
    tx.propertySocialRepost.findMany({
      where: {
        status: "SCHEDULED",
        scheduledAt: { gte: since, ...upTo },
        ...(excludePropertyId ? { propertyId: { not: excludePropertyId } } : {}),
      },
      orderBy: { scheduledAt: "asc" },
      take: 1000,
      select: { scheduledAt: true },
    }),
    tx.socialDigestPost.findMany({
      where: { status: "SCHEDULED", scheduledAt: { gte: since } },
      orderBy: { scheduledAt: "asc" },
      take: 1000,
      select: { scheduledAt: true },
    }),
    // СВОБОДНЫЕ РОЛИКИ (19.11.2026): человек сам выбрал время, но выйдут они в те же соцсети, что ролики объектов,
    // и автоматическая расстановка обязана держать от них тот же промежуток. Раньше их здесь не было — свободный
    // ролик и ролик объекта могли уйти в одну минуту. Только SCHEDULED: ушедший/снятый время больше не держит.
    tx.socialVideoPost.findMany({
      where: {
        deletedAt: null,
        status: "SCHEDULED",
        scheduledAt: { gte: since, ...upTo },
        ...(excludeFreeVideoId ? { id: { not: excludeFreeVideoId } } : {}),
      },
      orderBy: { scheduledAt: "asc" },
      take: 1000,
      select: { scheduledAt: true },
    }),
  ]);
  const pick = <T,>(rows: T[], at: (r: T) => Date | null, kind: OccupiedSlotKind): OccupiedSlot[] =>
    rows.flatMap((r) => {
      const t = at(r);
      return t ? [{ at: t, kind }] : [];
    });
  return [
    ...pick(videoRows, (r) => r.scheduledPublishAt, "propertyVideo"),
    ...pick(photoRows, (r) => r.scheduledAt, "photoPost"),
    ...pick(repostRows, (r) => r.scheduledAt, "repost"),
    ...pick(digestRows, (r) => r.scheduledAt, "digest"),
    ...pick(freeRows, (r) => r.scheduledAt, "freeVideo"),
  ];
}

export interface SlotCollision {
  /** Занятое время, с которым столкнулись (ближайшее к выбранному). */
  takenAt: Date;
  kind: OccupiedSlotKind;
  /** Ближайшее свободное время не раньше выбранного, с соблюдением промежутка до каждой публикации. */
  suggestedAt: Date;
}

/** Рабочее окно публикаций, минуты от полуночи по Душанбе. */
export interface PublishWindow {
  startMin: number;
  endMin: number;
}

/** Время `t` (мс), приведённое в рабочее окно: до открытия — на открытие того же дня, после закрытия — на открытие завтра. */
function intoWindow(t: number, w: PublishWindow): number {
  const dayStart = Math.floor((t + DUSHANBE_OFFSET_MS) / 86_400_000) * 86_400_000 - DUSHANBE_OFFSET_MS;
  const minute = (t - dayStart) / 60_000;
  if (minute < w.startMin) return dayStart + w.startMin * 60_000;
  if (minute >= w.endMin) return dayStart + 86_400_000 + w.startMin * 60_000;
  return t;
}

/**
 * Столкновение выбранного человеком времени с уже занятыми слотами: ближе промежутка `gapMs` к любому из них.
 * null — время свободно. Подсказка — ближайшее свободное время ПОСЛЕ выбранного: сдвигаемся за каждую занятую
 * публикацию на промежуток и, если вышли за рабочее окно (`window`), переносим на открытие окна — ночью не публикуем.
 */
export function findSlotCollision(at: Date, occupied: readonly OccupiedSlot[], gapMs: number, window?: PublishWindow): SlotCollision | null {
  const clash = (t: number) => occupied.filter((o) => Math.abs(t - o.at.getTime()) < gapMs);
  const first = clash(at.getTime());
  if (first.length === 0) return null;
  const nearest = first.reduce((a, b) => (Math.abs(a.at.getTime() - at.getTime()) <= Math.abs(b.at.getTime() - at.getTime()) ? a : b));
  let t = at.getTime();
  // Предел шагов — страховка от бесконечного цикла; каждый шаг уходит за очередную занятую публикацию или за окно.
  for (let i = 0; i < occupied.length * 2 + 30; i++) {
    if (window) t = intoWindow(t, window);
    const blocking = clash(t);
    if (blocking.length === 0) break;
    t = Math.max(...blocking.map((o) => o.at.getTime())) + gapMs;
  }
  return { takenAt: nearest.at, kind: nearest.kind, suggestedAt: new Date(t) };
}

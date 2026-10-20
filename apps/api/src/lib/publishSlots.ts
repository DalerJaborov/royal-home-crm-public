import type { TxClient } from "../db.js";

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
  excludePropertyId?: string
): Promise<Date[]> {
  const [videoRows, photoRows, repostRows, digestRows] = await Promise.all([
    tx.property.findMany({
      where: {
        deletedAt: null,
        ...(excludePropertyId ? { id: { not: excludePropertyId } } : {}),
        scheduledPublishAt: { gte: since },
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
        scheduledAt: { gte: since },
        ...(excludePropertyId ? { propertyId: { not: excludePropertyId } } : {}),
      },
      orderBy: { scheduledAt: "asc" },
      take: 1000,
      select: { scheduledAt: true },
    }),
    tx.propertySocialRepost.findMany({
      where: {
        status: "SCHEDULED",
        scheduledAt: { gte: since },
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
  ]);
  const videoTimes = videoRows.flatMap((r) => (r.scheduledPublishAt ? [r.scheduledPublishAt] : []));
  const photoTimes = photoRows.flatMap((r) => (r.scheduledAt ? [r.scheduledAt] : []));
  const repostTimes = repostRows.flatMap((r) => (r.scheduledAt ? [r.scheduledAt] : []));
  const digestTimes = digestRows.flatMap((r) => (r.scheduledAt ? [r.scheduledAt] : []));
  return [...videoTimes, ...photoTimes, ...repostTimes, ...digestTimes];
}

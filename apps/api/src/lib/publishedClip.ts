import { prisma, type TxClient } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";

/**
 * «РОЛИК ОБЪЕКТА УЖЕ ВЫШЕЛ» — одно место (18.11.2026). От ответа зависит, утверждает ли новую озвучку человек
 * (вышел — только человек, утверждение = выпуск) или она утверждается сама.
 *
 * Пометок в карточке мало: на время замены постов (lib/remakeOldPosts.ts) каналы из карточки вычеркнуты, а старые
 * посты висят в сетях; упадёт задание посреди публикации — так может пробыть до двух суток. Поэтому открытая
 * заявка на замену со снятым снимком старых постов тоже значит «вышел». Модуль без зависимостей от роликов и
 * публикации: его зовут и генерация озвучки, и подмена ролика, без циклов импорта.
 */
export function isPublishedClip(p: { publishedChannels?: readonly string[] | null; instagramUrl?: string | null }): boolean {
  return (p.publishedChannels?.length ?? 0) > 0 || !!p.instagramUrl;
}

/** То же с учётом идущей замены постов (снимок старых постов взят, заявка не закрыта). */
export async function clipCountsAsPublished(propertyId: string, p: { publishedChannels?: readonly string[] | null; instagramUrl?: string | null }, db: TxClient = prisma): Promise<boolean> {
  if (isPublishedClip(p)) return true;
  const open = await db.videoRemakeRequest.findFirst({
    where: { propertyId, replaceOldPostsOnPublish: true, oldPostsReplacedAt: null, oldPosts: { not: Prisma.DbNull } },
    select: { oldPosts: true },
  });
  const snap = open?.oldPosts as { channels?: unknown[] } | null | undefined;
  return !!snap && Array.isArray(snap.channels) && snap.channels.length > 0;
}

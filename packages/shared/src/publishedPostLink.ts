/**
 * ПУБЛИЧНАЯ ССЫЛКА НА ВЫШЕДШИЙ ПОСТ ОБЪЕКТА — одно правило на карточку объекта в
 * CRM (PropertyVideoFixCard) и на бот монтажёра («📈 Где вышел», 25.09.2026).
 * Две копии разошлись бы на первой же смене формата ссылки, как это уже было с
 * переводом в сомони (правка #752), — поэтому правило живёт здесь.
 *
 * Собирается из того, что уже хранит объект, без новых полей:
 *  - Instagram — `Property.instagramUrl` (permalink);
 *  - YouTube — id ролика в `publishedPostIds.YOUTUBE`, адрес Shorts по тому же
 *    правилу, что у сервера (lib/socialPublish.ts::publishYouTubeShort);
 *  - Facebook — id видео в `publishedPostIds.FACEBOOK`, `/watch/?v=`;
 *  - TikTok — id поста CRM не хранит (Content Posting API его не отдаёт) — ссылки нет;
 *  - Telegram — есть `message_id` канала, но не публичное имя канала — ссылки нет;
 *  - Threads — permalink приходит от самой площадки при публикации и уже ГОТОВ,
 *    лежит под своим ключом `publishedPostIds.THREADS_URL` (не `THREADS` — под
 *    тем ключом id поста, см. lib/videoHandoff.ts), поэтому собирать её не
 *    нужно, в отличие от YouTube/Facebook выше.
 */
export function publishedPostLink(
  channel: string,
  post: { instagramUrl?: string | null; publishedPostIds?: unknown }
): string | null {
  if (channel === "INSTAGRAM") return post.instagramUrl || null;
  const ids = post.publishedPostIds;
  if (channel === "THREADS") {
    const threadsUrl = ids && typeof ids === "object" ? (ids as Record<string, unknown>).THREADS_URL : undefined;
    return typeof threadsUrl === "string" && threadsUrl ? threadsUrl : null;
  }
  const postId = ids && typeof ids === "object" ? (ids as Record<string, unknown>)[channel] : undefined;
  if (typeof postId !== "string" || !postId) return null;
  if (channel === "YOUTUBE") return `https://youtube.com/shorts/${postId}`;
  if (channel === "FACEBOOK") return `https://www.facebook.com/watch/?v=${postId}`;
  return null;
}

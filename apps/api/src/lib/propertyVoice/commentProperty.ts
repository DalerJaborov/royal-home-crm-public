import { prisma } from "../../db.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";

/**
 * ОБЪЕКТ ПОД КОММЕНТАРИЕМ — ТОЛЬКО ПО ДАННЫМ БАЗЫ («голос рынка», 03.10.2026).
 *
 * Комментарии приходят под постами. Ответ бота узнаёт объект по полному пути
 * (Graph API за адресом публикации, подпись, ссылка) — это дорого и живёт в
 * messengers/comments.ts. Но записывался найденный объект не во всех исходах:
 * ранние выходы (повтор, спам, «отвечает только воронка», лимит ИИ) оставляли
 * `propertyId` пустым. Здесь — второй, ДЕШЁВЫЙ путь: только запросы к своей базе,
 * без единого обращения к Meta, и только прямая привязка, которую пишет сама
 * публикация из CRM:
 *   • `Property.publishedPostIds.<КАНАЛ>` — id публикации, сохранённый автопубликацией;
 *   • `PropertyPhotoPost` — фото-пост (карусель) с тем же id.
 * Совпало однозначно — объект найден; нет — null (никаких догадок по тексту).
 */

/** Какие записи одного и того же id публикации сверяем: Facebook называет их тремя способами. */
export function commentMediaCandidates(channel: string, mediaId: string): string[] {
  const ids = new Set<string>([mediaId]);
  if (channel === "FACEBOOK" && mediaId.includes("_")) {
    // webhook присылает `{page-id}_{post-id}`, а POST /{page-id}/videos отдаёт id
    // без префикса страницы (тот же приём в messengers/comments.ts::loadMediaContext).
    ids.add(mediaId.slice(mediaId.lastIndexOf("_") + 1));
  }
  return [...ids].filter(Boolean);
}

/** Каналы, где у публикации из CRM есть свой ключ в Property.publishedPostIds. */
const PUBLISHED_CHANNELS = new Set(["INSTAGRAM", "FACEBOOK", "YOUTUBE"]);

export async function resolveCommentPropertyByMedia(channel: string, mediaId: string): Promise<string | null> {
  if (!PUBLISHED_CHANNELS.has(channel) || !mediaId) return null;
  const candidates = commentMediaCandidates(channel, mediaId);

  const direct = await prisma.property.findFirst({
    where: {
      deletedAt: null,
      OR: candidates.map((id) => ({ publishedPostIds: { path: [channel], equals: id } })),
    },
    // Один и тот же ролик могли привязать к двум карточкам — как и в
    // messengers/comments.ts, побеждает свежая, чтобы ответ не зависел от случая.
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (direct) return direct.id;

  if (channel === "YOUTUBE") return null; // у YouTube фото-постов нет
  const photoPost = await prisma.propertyPhotoPost.findFirst({
    where: {
      channel,
      status: "PUBLISHED",
      OR: candidates.flatMap((id) => [{ mediaId: id }, { secondaryId: id }]),
    },
    orderBy: { createdAt: "desc" },
    select: { propertyId: true },
  });
  return photoPost?.propertyId ?? null;
}

/**
 * Объект для уже сохранённого комментария Instagram/Facebook/YouTube, если у него
 * `propertyId` ещё пуст. Никогда не бросает: вызывается из записи итога комментария,
 * и сбой этого необязательного шага не должен ронять разбор.
 */
export async function propertyIdForStoredComment(commentRowId: string): Promise<string | null> {
  try {
    const row = await prisma.instagramComment.findUnique({
      where: { id: commentRowId },
      select: { propertyId: true, channel: true, mediaId: true },
    });
    if (!row || row.propertyId) return null;
    return await resolveCommentPropertyByMedia(row.channel, row.mediaId);
  } catch (err) {
    void logSystemError("meta", `Объект комментария не определён по базе: ${describeError(err)}`, {
      dedupKey: "property-voice-comment-property",
    });
    return null;
  }
}

/**
 * Объект поста для комментария в группе-обсуждении Telegram.
 *
 * Зеркало поста в группе несёт id ИСХОДНОГО поста канала (`forward_origin` /
 * `forward_from_message_id`), и он сверяется с `Property.publishedPostIds.TELEGRAM`
 * (там лежит message_id поста канала строкой). У комментариев глубже по ветке
 * зеркала в апдейте нет — тогда объект берётся у соседнего комментария той же
 * ветки (`postMessageId`), если там он уже определён. Не определился — null.
 */
export async function resolveTelegramCommentProperty(input: {
  postMessageId: string;
  channelPostId?: number | null;
}): Promise<string | null> {
  try {
    if (input.channelPostId) {
      const property = await prisma.property.findFirst({
        where: { deletedAt: null, publishedPostIds: { path: ["TELEGRAM"], equals: String(input.channelPostId) } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (property) return property.id;
    }
    const sibling = await prisma.telegramGroupComment.findFirst({
      where: { postMessageId: input.postMessageId, propertyId: { not: null } },
      select: { propertyId: true },
    });
    return sibling?.propertyId ?? null;
  } catch (err) {
    void logSystemError("telegram", `Объект поста Telegram не определён: ${describeError(err)}`, {
      dedupKey: "property-voice-telegram-property",
    });
    return null;
  }
}

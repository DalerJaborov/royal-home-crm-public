import { prisma } from "../db.js";
import { describeError } from "./describeError.js";
import { loadCredentials } from "../messengers/meta.js";
import { deleteInstagramMedia, deleteFacebookVideo } from "./socialPublish.js";
import { instagramManageToken } from "./publishedVideoFix.js";
import { removePropertyPhotoPosts, type PhotoPostRemovalResult } from "./photoPosts.js";
import { removePropertySocialReposts, type RepostRemovalResult } from "./socialReposts.js";

/**
 * КНОПКА В КАРТОЧКЕ «СНЯТЬ КАРУСЕЛИ И ИСТОРИИ» (владелец, 02.10.2026: «чтобы мы
 * сами снимали истории и карусели»). Не трогает ролик — его снимает «Убрать из
 * соцсетей» (publishedVideoFix.removeFromSocial). Здесь только то, что выходит
 * ПОМИМО ролика: фото-посты (карусели), повторные показы и истории.
 *
 * История живёт в соцсети 24 часа и сама исчезает, поэтому снимаем только те,
 * что вышли за последние STORY_LIVE_HOURS (+ запас): удалять давно истёкшую —
 * получить «объекта нет» без пользы для человека.
 */
const STORY_LIVE_HOURS = 26;

export interface StoryRemovalResult {
  removed: number;
  failed: { channel: string; error: string }[];
  manual: { channel: string; reason: string }[];
}

function liveStoriesWhere(propertyId: string) {
  return { propertyId, mediaId: { not: "" }, publishedAt: { gte: new Date(Date.now() - STORY_LIVE_HOURS * 3_600_000) } };
}

/** Что сейчас можно снять — для подписи и доступности кнопки. */
export async function countRemovableSocialExtras(propertyId: string): Promise<{ photoPosts: number; reposts: number; stories: number }> {
  const [photoPosts, reposts, stories] = await Promise.all([
    prisma.propertyPhotoPost.count({ where: { propertyId, status: "PUBLISHED" } }),
    prisma.propertySocialRepost.count({ where: { propertyId, status: "PUBLISHED" } }),
    prisma.propertyStoryPost.count({ where: liveStoriesWhere(propertyId) }),
  ]);
  return { photoPosts, reposts, stories };
}

/**
 * Снять живые истории объекта (Instagram — маркером Facebook Login, как Reels;
 * Facebook — токеном Страницы). Строка PropertyStoryPost удаляется только после
 * успеха (или «объекта уже нет»): отказ оставляет её, и повторное нажатие
 * попробует снова. Отказ одной истории не мешает остальным.
 */
export async function removePropertyStories(propertyId: string): Promise<StoryRemovalResult> {
  const rows = await prisma.propertyStoryPost.findMany({ where: liveStoriesWhere(propertyId) });
  const result: StoryRemovalResult = { removed: 0, failed: [], manual: [] };
  if (rows.length === 0) return result;

  const igToken = rows.some((r) => r.channel === "INSTAGRAM") ? await instagramManageToken() : null;
  const pageToken = rows.some((r) => r.channel === "FACEBOOK") ? (await loadCredentials()).pageToken : null;

  for (const row of rows) {
    try {
      let outcome: { ok: boolean; error?: string } | null = null;
      if (row.channel === "INSTAGRAM") {
        if (!igToken) {
          result.manual.push({ channel: "INSTAGRAM", reason: "маркер удаления Instagram не настроен — снимите историю в приложении" });
          continue;
        }
        outcome = await deleteInstagramMedia(row.mediaId, igToken);
      } else if (row.channel === "FACEBOOK") {
        if (!pageToken) {
          result.failed.push({ channel: "FACEBOOK", error: "Facebook не подключён в Настройках" });
          continue;
        }
        outcome = await deleteFacebookVideo(row.mediaId, pageToken);
      }
      if (!outcome) continue;
      if (outcome.ok) {
        await prisma.propertyStoryPost.delete({ where: { id: row.id } });
        result.removed++;
      } else {
        result.failed.push({ channel: row.channel, error: outcome.error ?? "неизвестная ошибка" });
      }
    } catch (err) {
      result.failed.push({ channel: row.channel, error: describeError(err) });
    }
  }
  return result;
}

export interface SocialExtrasRemovalSummary {
  photoPosts: PhotoPostRemovalResult;
  reposts: RepostRemovalResult;
  stories: StoryRemovalResult;
}

/** Все три вида разом; каждый вид независим — отказ одного не мешает остальным. */
export async function removeSocialExtras(propertyId: string): Promise<SocialExtrasRemovalSummary> {
  const photoPosts = await removePropertyPhotoPosts(propertyId);
  const reposts = await removePropertySocialReposts(propertyId);
  const stories = await removePropertyStories(propertyId);
  return { photoPosts, reposts, stories };
}

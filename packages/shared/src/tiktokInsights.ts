import { z } from "zod";

/**
 * СТАТИСТИКА TIKTOK (23.09.2026) — аккаунт + ролики через Display API
 * (`user.info.profile`, `user.info.stats`, `video.list`).
 *
 * Эти три права ещё НЕ одобрены TikTok для продакшен-приложения — заявка на
 * ревизию только подаётся, и её демо-ролик снимается ключами песочницы
 * (client key начинается с "sb", см. lib/tokenScopes.ts и routes/tiktok.ts).
 * Схема здесь — договор между `GET /api/v1/tiktok/insights` и экраном
 * «Маркетинг», на случай отказа (`available: false`) — честная причина и
 * список недостающих прав, а не пустой список видео.
 *
 * ВНИМАНИЕ исполнителю в изолированном worktree: `packages/shared` собирается
 * в `dist/`, а `@royal-home/shared` резолвится через node_modules в СОБСТВЕННЫЙ
 * дистрибутив ГЛАВНОГО дерева (junction на node_modules, но не на dist) — то
 * есть до `npm run build:shared` в главном дереве и мержа этот тип из
 * `apps/api`/`apps/web` не виден. Пока это не сделано, обе стороны держат
 * СВОЙ локальный тип той же формы (apps/api/src/lib/tiktokInsights.ts,
 * apps/web/src/hooks/useMarketing.ts) — сверить и убрать дубликат при следующей
 * пересборке shared.
 */

export const TikTokInsightsAccountSchema = z.object({
  openId: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  bioDescription: z.string().nullable(),
  profileDeepLink: z.string().nullable(),
  isVerified: z.boolean().nullable(),
  followerCount: z.number().nullable(),
  followingCount: z.number().nullable(),
  likesCount: z.number().nullable(),
  videoCount: z.number().nullable(),
});
export type TikTokInsightsAccount = z.infer<typeof TikTokInsightsAccountSchema>;

export const TikTokInsightsVideoSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  videoDescription: z.string().nullable(),
  createTime: z.number().nullable(),
  coverImageUrl: z.string().nullable(),
  shareUrl: z.string().nullable(),
  duration: z.number().nullable(),
  viewCount: z.number().nullable(),
  likeCount: z.number().nullable(),
  commentCount: z.number().nullable(),
  shareCount: z.number().nullable(),
  /** Найденная по Property.publishedPostIds.TIKTOK карточка объекта — null,
   *  если ролик не публиковался из CRM (снят в приложении TikTok напрямую). */
  propertyId: z.string().nullable(),
});
export type TikTokInsightsVideo = z.infer<typeof TikTokInsightsVideoSchema>;

export const TikTokInsightsAvailableSchema = z.object({
  available: z.literal(true),
  account: TikTokInsightsAccountSchema,
  videos: z.array(TikTokInsightsVideoSchema),
  fetchedAt: z.string(),
});

export const TikTokInsightsUnavailableSchema = z.object({
  available: z.literal(false),
  reason: z.string(),
  missingScopes: z.array(z.string()),
});

export const TikTokInsightsResponseSchema = z.union([
  TikTokInsightsAvailableSchema,
  TikTokInsightsUnavailableSchema,
]);
export type TikTokInsightsResponse = z.infer<typeof TikTokInsightsResponseSchema>;

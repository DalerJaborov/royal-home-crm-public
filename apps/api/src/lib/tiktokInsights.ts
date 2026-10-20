/**
 * СТАТИСТИКА TIKTOK: аккаунт + ролики через Display API (23.09.2026).
 *
 * Права `user.info.profile`, `user.info.stats`, `video.list` ещё НЕ одобрены
 * TikTok для продакшен-приложения (см. lib/tokenScopes.ts) — заявка на ревизию
 * только подаётся, демо-ролик к ней снимается ключами песочницы (client key
 * начинается с "sb"). Поэтому отказ по правам («scope_not_authorized» и
 * похожие коды) здесь ОЖИДАЕМЫЙ и обычный результат, а не сбой: возвращается
 * структурой `{ available: false, reason, missingScopes }`, наверх ничего не
 * бросается.
 *
 * Токен обновляется тем же путём, что публикация (tiktokAccessToken,
 * socialPublish.ts) — второй копии обмена refresh_token → access_token здесь
 * нет намеренно: TikTok ротирует refresh_token на каждый обмен, и вторая копия
 * рано или поздно рассинхронизировалась бы с той, что публикует ролики.
 *
 * Дубликат типа: см. предупреждение в packages/shared/src/tiktokInsights.ts —
 * тип здесь и в apps/web/src/hooks/useMarketing.ts та же форма, что там,
 * держится локально, пока стенд не может пересобрать @royal-home/shared.
 */
import { prisma } from "../db.js";
import { fetchWithRetry } from "../messengers/meta.js";
import { readJson, tiktokAccessToken, type TikTokCredentials } from "./socialPublish.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { TOKEN_SCOPE_CATALOG, describeMissingScopes } from "./tokenScopes.js";

const INSIGHTS_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 15 * 60_000;
const MAX_VIDEO_PAGES = 5;
const VIDEO_PAGE_SIZE = 20;

const USER_INFO_FIELDS =
  "open_id,avatar_url,display_name,bio_description,profile_deep_link,is_verified,follower_count,following_count,likes_count,video_count";
const VIDEO_LIST_FIELDS =
  "id,title,video_description,create_time,cover_image_url,share_url,duration,view_count,like_count,comment_count,share_count";

export interface TikTokInsightsAccount {
  openId: string;
  displayName: string | null;
  avatarUrl: string | null;
  bioDescription: string | null;
  profileDeepLink: string | null;
  isVerified: boolean | null;
  followerCount: number | null;
  followingCount: number | null;
  likesCount: number | null;
  videoCount: number | null;
}

export interface TikTokInsightsVideo {
  id: string;
  title: string | null;
  videoDescription: string | null;
  createTime: number | null;
  coverImageUrl: string | null;
  shareUrl: string | null;
  duration: number | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  /** Карточка объекта, из которой ролик ушёл в TikTok (Property.publishedPostIds.TIKTOK) —
   *  null, если ролик снят не через CRM. */
  propertyId: string | null;
}

export type TikTokInsightsResult =
  | { available: true; account: TikTokInsightsAccount; videos: TikTokInsightsVideo[]; fetchedAt: string }
  | { available: false; reason: string; missingScopes: string[] };

interface CacheEntry {
  at: number;
  result: TikTokInsightsResult;
}
let cache: CacheEntry | null = null;

/** Только для тестов — без этого 15-минутный кэш пережил бы моки между тестами. */
export function resetTikTokInsightsCache(): void {
  cache = null;
}

/** Код TikTok про нехватку прав встречается в нескольких формах
 *  ("scope_not_authorized", "scope_permission_missing" и т.п.) — ловим по
 *  подстроке "scope", а не по одному точному значению. */
function isScopeError(code: string | undefined): boolean {
  return !!code && /scope/i.test(code);
}

interface TikTokErrorBody {
  code?: string;
  message?: string;
}

async function fetchAccount(
  accessToken: string
): Promise<{ ok: true; account: TikTokInsightsAccount } | { ok: false; scopeError: boolean; message: string }> {
  try {
    const res = await fetchWithRetry(
      `https://open.tiktokapis.com/v2/user/info/?fields=${encodeURIComponent(USER_INFO_FIELDS)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      INSIGHTS_TIMEOUT_MS
    );
    const body = await readJson(res);
    const user = body.data as { user?: Record<string, unknown> } | undefined;
    const error = body.error as TikTokErrorBody | undefined;
    if (!res.ok || !user?.user) {
      return {
        ok: false,
        scopeError: isScopeError(error?.code),
        message: error?.message ?? `HTTP ${res.status}: не удалось получить данные аккаунта TikTok`,
      };
    }
    const u = user.user;
    return {
      ok: true,
      account: {
        openId: String(u.open_id ?? ""),
        displayName: (u.display_name as string | undefined) ?? null,
        avatarUrl: (u.avatar_url as string | undefined) ?? null,
        bioDescription: (u.bio_description as string | undefined) ?? null,
        profileDeepLink: (u.profile_deep_link as string | undefined) ?? null,
        isVerified: typeof u.is_verified === "boolean" ? u.is_verified : null,
        followerCount: typeof u.follower_count === "number" ? u.follower_count : null,
        followingCount: typeof u.following_count === "number" ? u.following_count : null,
        likesCount: typeof u.likes_count === "number" ? u.likes_count : null,
        videoCount: typeof u.video_count === "number" ? u.video_count : null,
      },
    };
  } catch (err) {
    return { ok: false, scopeError: false, message: describeError(err) };
  }
}

interface RawTikTokVideo {
  id?: string;
  title?: string;
  video_description?: string;
  create_time?: number;
  cover_image_url?: string;
  share_url?: string;
  duration?: number;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
}

function toInsightsVideo(v: RawTikTokVideo): TikTokInsightsVideo {
  return {
    id: String(v.id ?? ""),
    title: v.title ?? null,
    videoDescription: v.video_description ?? null,
    createTime: typeof v.create_time === "number" ? v.create_time : null,
    coverImageUrl: v.cover_image_url ?? null,
    shareUrl: v.share_url ?? null,
    duration: typeof v.duration === "number" ? v.duration : null,
    viewCount: typeof v.view_count === "number" ? v.view_count : null,
    likeCount: typeof v.like_count === "number" ? v.like_count : null,
    commentCount: typeof v.comment_count === "number" ? v.comment_count : null,
    shareCount: typeof v.share_count === "number" ? v.share_count : null,
    propertyId: null,
  };
}

/** До MAX_VIDEO_PAGES страниц (20 роликов каждая — 100 всего с запасом на
 *  «последние 20» из задания): TikTok честно может отдавать has_more вечно на
 *  очень старом аккаунте, и без потолка запрос ушёл бы в цикл на минуты. */
async function fetchAllVideos(
  accessToken: string
): Promise<{ ok: true; videos: TikTokInsightsVideo[] } | { ok: false; scopeError: boolean; message: string }> {
  const videos: TikTokInsightsVideo[] = [];
  let cursor = 0;
  for (let page = 0; page < MAX_VIDEO_PAGES; page++) {
    try {
      const res = await fetchWithRetry(
        `https://open.tiktokapis.com/v2/video/list/?fields=${encodeURIComponent(VIDEO_LIST_FIELDS)}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
          body: JSON.stringify({ max_count: VIDEO_PAGE_SIZE, cursor }),
        },
        INSIGHTS_TIMEOUT_MS
      );
      const body = await readJson(res);
      const data = body.data as { videos?: RawTikTokVideo[]; cursor?: number; has_more?: boolean } | undefined;
      const error = body.error as TikTokErrorBody | undefined;
      if (!res.ok || !data) {
        return {
          ok: false,
          scopeError: isScopeError(error?.code),
          message: error?.message ?? `HTTP ${res.status}: не удалось получить список роликов TikTok`,
        };
      }
      for (const v of data.videos ?? []) videos.push(toInsightsVideo(v));
      if (!data.has_more) break;
      cursor = data.cursor ?? cursor + VIDEO_PAGE_SIZE;
    } catch (err) {
      return { ok: false, scopeError: false, message: describeError(err) };
    }
  }
  return { ok: true, videos };
}

/**
 * Соответствие ролик → карточка объекта. ОДИН запрос ко всем объектам с
 * непустым publishedPostIds (без N+1 по каждому ролику) — id роликов из
 * TikTok сверяются в памяти, а не по одному findFirst на видео.
 */
async function mapVideosToProperties(videoIds: string[]): Promise<Map<string, string>> {
  const byPostId = new Map<string, string>();
  if (videoIds.length === 0) return byPostId;
  // БЕЗ `where: { publishedPostIds: ... }` нарочно: фильтрация JSON-поля на
  // "не null" в Prisma различает DbNull/JsonNull и на этой версии Prisma
  // (см. docs/claude-memory/royalhome-prisma7-p2002-target-changed-15-09.md
  // про смену поведения между мажорными версиями) — риск тихо отфильтровать
  // не то. Поле узкое (id + JSON), фильтр "есть ли TIKTOK" делаем в памяти.
  const properties = await prisma.property.findMany({
    select: { id: true, publishedPostIds: true },
    // Предохранитель, а не ожидаемый потолок: объектов на масштабе этой CRM
    // на порядки меньше.
    take: 20_000,
  });
  const wanted = new Set(videoIds);
  for (const p of properties) {
    const ids = p.publishedPostIds as Record<string, string> | null;
    const tiktokId = ids?.TIKTOK;
    if (tiktokId && wanted.has(tiktokId)) byPostId.set(tiktokId, p.id);
  }
  return byPostId;
}

/** Права аккаунта (user.info.profile/user.info.stats) и списка роликов
 *  (video.list) — те же три, что помечены `awaitingApproval` в lib/tokenScopes.ts. */
function requiredScopeNames(kind: "account" | "videos"): string[] {
  return kind === "account" ? ["user.info.profile", "user.info.stats"] : ["video.list"];
}

/**
 * Главная точка входа: аккаунт + ролики, с кэшем на 15 минут (лимиты TikTok —
 * то же соображение, что у кэша creator-info в routes/tiktok.ts).
 */
export async function fetchTikTokInsights(creds: TikTokCredentials): Promise<TikTokInsightsResult> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result;

  let accessToken: string;
  try {
    accessToken = await tiktokAccessToken(creds);
  } catch (err) {
    const message = `Не удалось обновить токен TikTok: ${describeError(err)}`;
    void logSystemError("tiktok", message);
    return { available: false, reason: message, missingScopes: [] };
  }

  const [accountRes, videosRes] = await Promise.all([fetchAccount(accessToken), fetchAllVideos(accessToken)]);

  const missing = new Set<string>();
  if (!accountRes.ok && accountRes.scopeError) for (const s of requiredScopeNames("account")) missing.add(s);
  if (!videosRes.ok && videosRes.scopeError) for (const s of requiredScopeNames("videos")) missing.add(s);

  if (missing.size > 0) {
    const specs = TOKEN_SCOPE_CATALOG.TIKTOK.scopes.filter((s) => missing.has(s.scope));
    const result: TikTokInsightsResult = {
      available: false,
      reason: `нет доступа: ${describeMissingScopes("TIKTOK", specs)}`,
      missingScopes: [...missing],
    };
    cache = { at: Date.now(), result };
    return result;
  }

  if (!accountRes.ok) {
    void logSystemError("tiktok", `Статистика TikTok (аккаунт): ${accountRes.message}`);
    return { available: false, reason: accountRes.message, missingScopes: [] };
  }
  if (!videosRes.ok) {
    void logSystemError("tiktok", `Статистика TikTok (ролики): ${videosRes.message}`);
    return { available: false, reason: videosRes.message, missingScopes: [] };
  }

  const propertyByPostId = await mapVideosToProperties(videosRes.videos.map((v) => v.id));
  const videos = videosRes.videos
    .map((v) => ({ ...v, propertyId: propertyByPostId.get(v.id) ?? null }))
    .sort((a, b) => (b.createTime ?? 0) - (a.createTime ?? 0));

  const result: TikTokInsightsResult = {
    available: true,
    account: accountRes.account,
    videos,
    fetchedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), result };
  return result;
}

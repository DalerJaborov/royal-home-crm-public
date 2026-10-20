/**
 * СТАТИСТИКА РОЛИКОВ ПО ВСЕМ ПЛОЩАДКАМ (24.09.2026, владелец: «статистика
 * роликов по всем площадкам» — просмотры/лайки/комментарии на каждой площадке
 * по каждому опубликованному ролику, и какая площадка и какой час публикации
 * работают лучше всего).
 *
 * ИСТОЧНИК СПИСКА РОЛИКОВ — `Property.publishedChannels`/`publishedPostIds`
 * (то же поле, что читают публикация, сверка фантомов
 * lib/publishedChannelsAudit.ts и снятие с публикации lib/publishedVideoFix.ts).
 * Идентификатор канала в `publishedPostIds` берём СТРОГО по имени канала из
 * `publishedChannels` — служебные ключи того же JSON (`FACEBOOK_POST`,
 * `AUDIT_CHECKED_AT`, `TIKTOK_PENDING`/`_AT`, `FACEBOOK_PENDING`/`_AT`,
 * `YOUTUBE_PENDING`/`_AT`) никогда не совпадают с именем канала и потому сами
 * себя исключают — отдельного списка «игнорировать» не нужно.
 *
 * ТОКЕНЫ — те же функции, что уже читают их для публикации/сверки, вторая
 * копия логики токенов здесь не заводится:
 *  - Instagram/Facebook — `loadCredentials()` (messengers/meta.ts);
 *  - YouTube — `Settings.youtubeClientId/Secret/RefreshToken` через
 *    `youtubeAccessToken` (lib/socialPublish.ts), как в
 *    `lib/publishedChannelsAudit.ts::youtubeCredentials`;
 *  - TikTok — целиком `lib/tiktokInsights.ts::fetchTikTokInsights` (она уже
 *    решает вопрос «ещё не одобрено» и уже сопоставляет ролик с карточкой
 *    объекта — вторая копия этого сопоставления здесь не нужна);
 *  - Telegram — Bot API не отдаёт число просмотров поста в канале ботам,
 *    поэтому площадка всегда `available: false` с этой причиной.
 *
 * ТРИ ИСХОДА НА ПЛОЩАДКУ, а не просто "работает/не работает": `connected`
 * (ключи заданы) отдельно от `available` (числа реально прочитались) — те же
 * два вопроса, что уже разделены в `routes/marketing.ts::/channels-status` и
 * `lib/tiktokInsights.ts`. Отказ ОДНОГО поста (просроченный/удалённый ролик,
 * `views`-инсайт недоступен) не должен гасить всю площадку — только сам этот
 * пост остаётся с `null` в соответствующем поле; площадка становится
 * `available: false` только когда ВСЕ попытки по ней провалились.
 *
 * КЭШ НА 30 МИНУТ — тот же приём, что `lib/tiktokInsights.ts` (там 15 минут):
 * экран может открываться много раз за смену, а числа за прошедший час не
 * меняют картину «что сработало». `?refresh=1` в роуте обходит кэш явно.
 */
import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { isYoutubeScopeError, reportYoutubeScopeMissing, YOUTUBE_SCOPE_MISSING_SHORT } from "./youtubeScope.js";
import { describeError } from "./describeError.js";
import { decryptSecretSafe } from "../crypto.js";
import { loadCredentials, instagramApiUrl, instagramRequest, fetchWithRetry, GRAPH_VERSION } from "../messengers/meta.js";
import { readJson, graphErrorMessage, youtubeAccessToken, type YouTubeCredentials, type TikTokCredentials } from "./socialPublish.js";
import { fetchTikTokInsights } from "./tiktokInsights.js";
import { mapWithConcurrency } from "./concurrency.js";
import { dushanbeHour } from "@royal-home/shared";

export type PostStatsChannel = "INSTAGRAM" | "FACEBOOK" | "YOUTUBE" | "TIKTOK" | "TELEGRAM";

/** Порядок площадок везде в ответе — фиксированный, чтобы карточки на экране не
 *  прыгали местами между обновлениями. */
export const POST_STATS_CHANNELS: readonly PostStatsChannel[] = [
  "INSTAGRAM",
  "FACEBOOK",
  "YOUTUBE",
  "TIKTOK",
  "TELEGRAM",
];

export interface PostChannelStat {
  channel: PostStatsChannel;
  views: number | null;
  likes: number | null;
  comments: number | null;
  url: string | null;
  /** «Первые секунды» (24.09.2026): среднее время просмотра, секунды —
   *  Instagram, Facebook, YouTube. */
  avgWatchSec: number | null;
  /** Доля ушедших в первые 3 секунды, 0–1 — только Instagram. */
  skipRate: number | null;
  /** Какую часть ролика смотрят в среднем, 0–1 — только YouTube отдаёт сам. */
  watchedShare: number | null;
  /** Почему по ЭТОМУ посту площадка не отдала числа (12.10.2026): раньше причина терялась, и экран
   *  писал «площадка не отдала число» без объяснения. null — числа есть или причина неизвестна. */
  note: string | null;
}

export interface PostStatsPost {
  propertyId: string;
  shortId: number;
  title: string;
  publishedAt: string | null;
  publishHour: number | null;
  stats: PostChannelStat[];
}

/** Свободный ролик (промо без объекта, раздел «Ролики в соцсети»): те же числа с площадок, но карточки объекта нет. */
export interface PostStatsFreeVideo {
  id: string;
  title: string;
  publishedAt: string | null;
  publishHour: number | null;
  stats: PostChannelStat[];
}

export interface PostStatsPlatform {
  channel: PostStatsChannel;
  connected: boolean;
  available: boolean;
  reason: string | null;
  posts: number;
  views: number;
  likes: number;
  comments: number;
}

export interface PostStatsHourBucket {
  hour: number;
  posts: number;
  avgViews: number;
}

export interface PostStatsResult {
  fetchedAt: string;
  platforms: PostStatsPlatform[];
  posts: PostStatsPost[];
  /** Свободные ролики (12.10.2026). Входят в итоги площадок и в «часы», но НЕ в `posts`: разбор «почему взлетели»
   *  и «первые секунды» привязаны к карточке объекта. */
  freeVideos: PostStatsFreeVideo[];
  byHour: PostStatsHourBucket[];
}

/** Сколько последних вышедших свободных роликов показываем рядом с роликами объектов. */
const FREE_VIDEO_LIMIT = 15;
const FREE_ID_PREFIX = "free:";
const isFreeId = (id: string): boolean => id.startsWith(FREE_ID_PREFIX);

/** Не карта продукта, а сама витрина: сколько ПОСЛЕДНИХ опубликованных
 *  роликов показываем (класс «Пагинация» — роут отдаёт массив). */
const POST_STATS_LIMIT = 30;

/** Сколько карточек читаем из базы, чтобы выбрать из них POST_STATS_LIMIT
 *  самых свежих — предохранитель сам по себе (без него `findMany` по всем
 *  опубликованным объектам не ограничен ничем), а не ожидаемый потолок:
 *  опубликованных карточек на масштабе агентства заметно меньше. */
const PROPERTY_SCAN_CAP = 500;

/** Внешние вызовы этого модуля — не публикация и не бот, ждать дольше нет
 *  смысла: пользователь смотрит на открывшийся экран. */
const CALL_TIMEOUT_MS = 10_000;

/** Не больше стольких запросов к Instagram/Facebook одновременно — те же
 *  доводы, что у TICK_CONCURRENCY в lib/noAnswerStreak.ts: несколько внешних
 *  вызовов, но не толпой. */
const CALL_CONCURRENCY = 4;

const CACHE_TTL_MS = 30 * 60_000;

/** Только для тестов — без этого получасовой кэш пережил бы моки между тестами. */
export function resetPostStatsCache(): void {
  cache = null;
  propertyCache.clear();
}

let cache: { at: number; result: PostStatsResult } | null = null;

/** Час по Душанбе (0-23) — общее правило из packages/shared, одно на сервер и
 *  сайт (сторож audit:rules); переизлучается ради прежних вызовов. */
export { dushanbeHour };

interface CandidateProperty {
  id: string;
  shortId: number;
  title: string;
  publishedChannels: string[];
  postIds: Record<string, string>;
  scheduledPublishAt: Date | null;
  updatedAt: Date;
}

/**
 * 30 САМЫХ СВЕЖИХ опубликованных карточек. Сортировка в JS, а не в SQL — тем
 * же доводом, что `pickQueue` в lib/publishedChannelsAudit.ts: момент публикации
 * не одна колонка (берём `scheduledPublishAt`, а без него — `updatedAt`), и
 * выражать это через `ORDER BY` с фолбэком в Prisma без сырого SQL нельзя.
 */
const CANDIDATE_SELECT = {
  id: true,
  shortId: true,
  title: true,
  publishedChannels: true,
  publishedPostIds: true,
  scheduledPublishAt: true,
  updatedAt: true,
} as const;

function toCandidate(r: {
  id: string;
  shortId: number;
  title: string;
  publishedChannels: unknown;
  publishedPostIds: unknown;
  scheduledPublishAt: Date | null;
  updatedAt: Date;
}): CandidateProperty {
  return {
    id: r.id,
    shortId: r.shortId,
    title: r.title,
    publishedChannels: (r.publishedChannels ?? []) as string[],
    postIds: (r.publishedPostIds ?? {}) as Record<string, string>,
    scheduledPublishAt: r.scheduledPublishAt,
    updatedAt: r.updatedAt,
  };
}

async function loadNewestPublishedProperties(): Promise<CandidateProperty[]> {
  const rows = await prisma.property.findMany({
    where: { deletedAt: null, NOT: { publishedChannels: { isEmpty: true } } },
    select: CANDIDATE_SELECT,
    orderBy: { updatedAt: "desc" },
    take: PROPERTY_SCAN_CAP,
  });
  const candidates: CandidateProperty[] = rows.map(toCandidate);
  return candidates
    .sort((a, b) => (b.scheduledPublishAt ?? b.updatedAt).getTime() - (a.scheduledPublishAt ?? a.updatedAt).getTime())
    .slice(0, POST_STATS_LIMIT);
}

/**
 * Свободные ролики, вышедшие хотя бы в одну сеть. Идентификатор получает префикс `free:`, чтобы жить в тех же
 * таблицах «ролик → числа площадки», что и объекты (там это просто строковый ключ), и не пересечься с id объекта.
 * Читаем id постов только по именам каналов (`INSTAGRAM`, `FACEBOOK`, `YOUTUBE`): посты второго аккаунта
 * (`INSTAGRAM:<id>`) читаются токеном того аккаунта, которого здесь нет, - их числа честно не показываем.
 */
async function loadNewestFreeVideos(): Promise<CandidateProperty[]> {
  const rows = await prisma.socialVideoPost.findMany({
    where: { deletedAt: null, NOT: { publishedChannels: { isEmpty: true } } },
    select: { id: true, title: true, publishedChannels: true, publishedPostIds: true, finishedAt: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: FREE_VIDEO_LIMIT,
  });
  return rows.map((r) => {
    const raw = (r.publishedPostIds ?? {}) as Record<string, unknown>;
    const postIds: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) if (typeof value === "string" && value) postIds[key] = value;
    return {
      id: `${FREE_ID_PREFIX}${r.id}`,
      shortId: 0,
      title: r.title,
      publishedChannels: r.publishedChannels,
      postIds,
      scheduledPublishAt: r.finishedAt,
      updatedAt: r.updatedAt,
    };
  });
}

async function youtubeCredentialsFromSettings(): Promise<YouTubeCredentials> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { youtubeClientId: true, youtubeClientSecret: true, youtubeRefreshToken: true },
  });
  return {
    clientId: settings?.youtubeClientId ?? undefined,
    clientSecret: decryptSecretSafe(settings?.youtubeClientSecret ?? null) ?? undefined,
    refreshToken: decryptSecretSafe(settings?.youtubeRefreshToken ?? null) ?? undefined,
  };
}

async function tiktokCredentialsFromSettings(): Promise<TikTokCredentials> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { tiktokClientKey: true, tiktokClientSecret: true, tiktokRefreshToken: true },
  });
  return {
    clientKey: settings?.tiktokClientKey ?? undefined,
    clientSecret: decryptSecretSafe(settings?.tiktokClientSecret ?? null) ?? undefined,
    refreshToken: decryptSecretSafe(settings?.tiktokRefreshToken ?? null) ?? undefined,
  };
}

/** Итог одного внешнего вызова на пост — только то, что нужно, чтобы решить,
 *  засчитывать ли площадку `available`, и вписать числа в ответ. */
interface ProbeOutcome {
  propertyId: string;
  ok: boolean;
  error?: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  url: string | null;
  /** Только Instagram — момент реальной публикации (`timestamp` медиа). */
  publishedAt?: string | null;
  /** Только Instagram: лайки прочитались, а просмотры нет — почему (текст площадки). */
  viewsNote?: string | null;
  /** Удержание («Первые секунды») — отказ его чтения пост не роняет. */
  avgWatchSec?: number | null;
  skipRate?: number | null;
}

/** Удержание нет смысла ждать дольше, чем сами просмотры; не прочиталось — null. */
function numberOrNull(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return null;
}

/**
 * Доля ушедших в первые 3 секунды. Instagram отдаёт `reels_skip_rate` в
 * процентах (42.5), а не долей — приводим к 0–1; значение уже долей тоже
 * понимаем, чтобы смена формата у площадки не дала «4250 %».
 */
export function normalizeSkipRate(raw: unknown): number | null {
  const n = numberOrNull(raw);
  if (n === null || n < 0) return null;
  const share = n > 1 ? n / 100 : n;
  return share <= 1 ? share : null;
}

/** Значение метрики из ответа `insights` Graph API по её имени. */
function insightValue(body: Record<string, unknown>, name: string): unknown {
  const data = body.data as { name?: string; values?: { value?: unknown }[] }[] | undefined;
  return data?.find((d) => d.name === name)?.values?.[0]?.value;
}

/**
 * Удержание ролика Instagram — ОТДЕЛЬНЫМ запросом от просмотров: Graph API
 * отвечает отказом на весь список метрик, если хоть одна не подходит (старое
 * медиа, не Reels), а просмотры терять из-за удержания нельзя. Вторая попытка —
 * одно среднее время: `reels_skip_rate` у Instagram моложе остальных метрик.
 */
async function fetchInstagramRetention(
  mediaId: string,
  token: string
): Promise<{ avgWatchSec: number | null; skipRate: number | null }> {
  for (const metrics of ["ig_reels_avg_watch_time,reels_skip_rate", "ig_reels_avg_watch_time"]) {
    try {
      const req = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/${mediaId}/insights?metric=${metrics}`), token);
      const res = await fetchWithRetry(req.url, { headers: req.headers }, CALL_TIMEOUT_MS);
      if (!res.ok) continue;
      const body = await readJson(res);
      const ms = numberOrNull(insightValue(body, "ig_reels_avg_watch_time"));
      return {
        avgWatchSec: ms !== null && ms > 0 ? ms / 1000 : null,
        skipRate: normalizeSkipRate(insightValue(body, "reels_skip_rate")),
      };
    } catch {
      // Удержание недоступно — не отказ поста.
    }
  }
  return { avgWatchSec: null, skipRate: null };
}

/** Среднее время просмотра видео Страницы Facebook (мс в ответе). */
async function fetchFacebookAvgWatch(videoId: string, token: string): Promise<number | null> {
  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${videoId}/video_insights?metric=total_video_avg_time_watched&access_token=${encodeURIComponent(token)}`;
    const res = await fetchWithRetry(url, {}, CALL_TIMEOUT_MS);
    if (!res.ok) return null;
    const ms = numberOrNull(insightValue(await readJson(res), "total_video_avg_time_watched"));
    return ms !== null && ms > 0 ? ms / 1000 : null;
  } catch {
    return null;
  }
}

/** Собрать площадку из списка попыток: не подключена — сразу неудача без сети;
 *  подключена, но ВСЕ попытки провалились — `available: false` с последней
 *  причиной; иначе площадка живая, даже если часть постов не прочиталась. */
function settleChannel(
  channel: PostStatsChannel,
  connected: boolean,
  notConnectedReason: string,
  outcomes: ProbeOutcome[]
): { connected: boolean; available: boolean; reason: string | null } {
  if (!connected) return { connected: false, available: false, reason: notConnectedReason };
  if (outcomes.length === 0) return { connected: true, available: true, reason: null };
  const failed = outcomes.filter((o) => !o.ok);
  // Нет права у ключа YouTube — причина не в постах, а в ключе, и чинит её только
  // владелец: одна суточная строка с рецептом (lib/youtubeScope.ts) вместо
  // «не удалось прочитать N из N» на каждое открытие карточки (25.09.2026).
  const scopeMissing = channel === "YOUTUBE" && failed.some((o) => isYoutubeScopeError(o.error));
  if (scopeMissing) {
    reportYoutubeScopeMissing();
    if (failed.length === outcomes.length) {
      return { connected: true, available: false, reason: YOUTUBE_SCOPE_MISSING_SHORT };
    }
  } else if (failed.length > 0) {
    void logSystemError(
      "meta",
      `Статистика роликов (${channel}): не удалось прочитать ${failed.length} из ${outcomes.length} постов — ${failed[0].error ?? "неизвестная причина"}`,
      { dedupKey: `post-stats:${channel}` }
    );
  }
  if (failed.length === outcomes.length) {
    return { connected: true, available: false, reason: failed[0].error ?? "не удалось прочитать статистику" };
  }
  return { connected: true, available: true, reason: null };
}

/**
 * Одно медиа Instagram: сначала `like_count`/`comments_count`/`permalink`/
 * `timestamp`, затем ОТДЕЛЬНО `views` — как и предупреждает задание, инсайты
 * могут быть недоступны (частный аккаунт, старое медиа, нет прав) там, где сами
 * поля медиа читаются нормально; отказ инсайтов не должен ронять весь пост.
 */
async function fetchInstagramMedia(propertyId: string, mediaId: string, token: string): Promise<ProbeOutcome> {
  try {
    const fieldsReq = instagramRequest(
      instagramApiUrl(`/${GRAPH_VERSION}/${mediaId}?fields=like_count,comments_count,permalink,timestamp`),
      token
    );
    const fieldsRes = await fetchWithRetry(fieldsReq.url, { headers: fieldsReq.headers }, CALL_TIMEOUT_MS);
    const fieldsBody = await readJson(fieldsRes);
    if (!fieldsRes.ok) {
      return {
        propertyId,
        ok: false,
        error: graphErrorMessage(fieldsBody, `HTTP ${fieldsRes.status}`),
        views: null,
        likes: null,
        comments: null,
        url: null,
      };
    }

    let views: number | null = null;
    let viewsNote: string | null = null;
    try {
      const insightsReq = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/${mediaId}/insights?metric=views`), token);
      const insightsRes = await fetchWithRetry(insightsReq.url, { headers: insightsReq.headers }, CALL_TIMEOUT_MS);
      const insightsBody = await readJson(insightsRes);
      if (insightsRes.ok) {
        const data = insightsBody.data as { values?: { value?: unknown }[] }[] | undefined;
        const raw = data?.[0]?.values?.[0]?.value;
        views = typeof raw === "number" ? raw : null;
        if (views === null) viewsNote = "Instagram не прислал число просмотров для этого ролика";
      } else {
        // Причину отдаём экрану (12.10.2026): «не отдала число» без объяснения не говорило, что чинить.
        viewsNote = `Instagram: ${graphErrorMessage(insightsBody, `HTTP ${insightsRes.status}`)}`;
      }
    } catch (err) {
      // Просмотры недоступны — не отказ поста, лайки/комментарии уже прочитаны (см. докстринг модуля).
      viewsNote = `Instagram: ${describeError(err)}`;
    }

    const retention = await fetchInstagramRetention(mediaId, token);

    return {
      propertyId,
      ok: true,
      views,
      viewsNote,
      ...retention,
      likes: typeof fieldsBody.like_count === "number" ? fieldsBody.like_count : null,
      comments: typeof fieldsBody.comments_count === "number" ? fieldsBody.comments_count : null,
      url: typeof fieldsBody.permalink === "string" ? fieldsBody.permalink : null,
      publishedAt: typeof fieldsBody.timestamp === "string" ? fieldsBody.timestamp : null,
    };
  } catch (err) {
    return { propertyId, ok: false, error: describeError(err), views: null, likes: null, comments: null, url: null };
  }
}

/** Facebook напрямую (не через прокси Instagram) — тем же приёмом, что
 *  `checkGraphObjectExists` в lib/socialPublish.ts: токен параметром запроса. */
async function fetchFacebookVideo(propertyId: string, videoId: string, token: string): Promise<ProbeOutcome> {
  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${videoId}?fields=views,permalink_url,likes.summary(true),comments.summary(true)&access_token=${encodeURIComponent(token)}`;
    const res = await fetchWithRetry(url, {}, CALL_TIMEOUT_MS);
    const body = await readJson(res);
    if (!res.ok) {
      return { propertyId, ok: false, error: graphErrorMessage(body, `HTTP ${res.status}`), views: null, likes: null, comments: null, url: null };
    }
    const likesSummary = (body.likes as { summary?: { total_count?: unknown } } | undefined)?.summary?.total_count;
    const commentsSummary = (body.comments as { summary?: { total_count?: unknown } } | undefined)?.summary?.total_count;
    const rawViews = body.views;
    const avgWatchSec = await fetchFacebookAvgWatch(videoId, token);
    return {
      propertyId,
      ok: true,
      avgWatchSec,
      views: typeof rawViews === "number" ? rawViews : typeof rawViews === "string" && rawViews !== "" ? Number(rawViews) : null,
      likes: typeof likesSummary === "number" ? likesSummary : null,
      comments: typeof commentsSummary === "number" ? commentsSummary : null,
      url: typeof body.permalink_url === "string" ? body.permalink_url : null,
    };
  } catch (err) {
    return { propertyId, ok: false, error: describeError(err), views: null, likes: null, comments: null, url: null };
  }
}

interface YouTubeStat {
  views: number | null;
  likes: number | null;
  comments: number | null;
  avgWatchSec: number | null;
  watchedShare: number | null;
}

/**
 * Удержание роликов YouTube — YouTube Analytics API (право
 * `yt-analytics.readonly` уже в ключе, lib/tokenScopes.ts): среднее время и
 * средний досмотренный процент за всё время, одним запросом на пачку.
 * Отказ (нет права, аналитика ещё не посчитана) — пустая карта, просмотры
 * от этого не страдают.
 */
async function fetchYouTubeRetention(
  accessToken: string,
  videoIds: string[]
): Promise<Map<string, { avgWatchSec: number | null; watchedShare: number | null }>> {
  const out = new Map<string, { avgWatchSec: number | null; watchedShare: number | null }>();
  if (videoIds.length === 0) return out;
  try {
    const params = new URLSearchParams({
      ids: "channel==MINE",
      startDate: "2020-01-01",
      endDate: new Date().toISOString().slice(0, 10),
      metrics: "averageViewDuration,averageViewPercentage",
      dimensions: "video",
      filters: `video==${videoIds.join(",")}`,
      maxResults: String(videoIds.length),
    });
    const res = await fetchWithRetry(
      `https://youtubeanalytics.googleapis.com/v2/reports?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      CALL_TIMEOUT_MS
    );
    if (!res.ok) return out;
    const rows = ((await readJson(res)).rows as unknown[][] | undefined) ?? [];
    for (const row of rows) {
      const [id, duration, percent] = row;
      if (typeof id !== "string") continue;
      const d = numberOrNull(duration);
      const p = numberOrNull(percent);
      out.set(id, { avgWatchSec: d !== null && d > 0 ? d : null, watchedShare: p !== null && p >= 0 ? p / 100 : null });
    }
  } catch {
    // см. докстринг — удержание необязательно
  }
  return out;
}

/** ОДИН батч на всю пачку роликов (до 50 id за запрос — квота YouTube Data API
 *  тратится на запрос, а не на идентификатор внутри него), а не запрос на пост:
 *  ровно то, о чём просит задание, и тот же приём, которым `checkYouTubeVideoExists`
 *  уже читает одно видео. Разбивка на чанки — на случай, если предел витрины
 *  (POST_STATS_LIMIT) когда-нибудь вырастет за 50. */
const YOUTUBE_BATCH_SIZE = 50;

async function fetchYouTubeStats(
  creds: YouTubeCredentials,
  ids: { propertyId: string; videoId: string }[]
): Promise<{ ok: true; byPropertyId: Map<string, YouTubeStat> } | { ok: false; error: string }> {
  if (ids.length === 0) return { ok: true, byPropertyId: new Map() };
  try {
    const accessToken = await youtubeAccessToken(creds);
    const byPropertyId = new Map<string, YouTubeStat>();
    for (let i = 0; i < ids.length; i += YOUTUBE_BATCH_SIZE) {
      const chunk = ids.slice(i, i + YOUTUBE_BATCH_SIZE);
      const res = await fetchWithRetry(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(chunk.map((c) => c.videoId).join(","))}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
        CALL_TIMEOUT_MS
      );
      const body = await readJson(res);
      if (!res.ok) return { ok: false, error: graphErrorMessage(body, `HTTP ${res.status}`) };
      const items = (body.items as { id?: string; statistics?: Record<string, string> }[] | undefined) ?? [];
      const byVideoId = new Map(items.filter((it) => it.id).map((it) => [it.id as string, it.statistics ?? {}]));
      const retention = await fetchYouTubeRetention(
        accessToken,
        chunk.map((c) => c.videoId)
      );
      for (const { propertyId, videoId } of chunk) {
        const stats = byVideoId.get(videoId);
        byPropertyId.set(propertyId, {
          views: stats?.viewCount != null ? Number(stats.viewCount) : null,
          likes: stats?.likeCount != null ? Number(stats.likeCount) : null,
          comments: stats?.commentCount != null ? Number(stats.commentCount) : null,
          avgWatchSec: retention.get(videoId)?.avgWatchSec ?? null,
          watchedShare: retention.get(videoId)?.watchedShare ?? null,
        });
      }
    }
    return { ok: true, byPropertyId };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/** Момент публикации: живой `timestamp` Instagram, если удалось его прочитать
 *  (единственная площадка из четырёх, которая вообще его отдаёт), иначе слот
 *  расстановки (`Property.scheduledPublishAt`), иначе неизвестно. */
function resolvePublishedAt(igTimestamp: string | null | undefined, scheduledPublishAt: Date | null): string | null {
  if (igTimestamp) {
    const parsed = Date.parse(igTimestamp);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return scheduledPublishAt ? scheduledPublishAt.toISOString() : null;
}

/**
 * Чистая функция (не ходит в сеть и в базу) — суммы по площадкам и разбивка по
 * часу публикации. Вынесена отдельно ровно затем, чтобы её можно было
 * проверить тестом без сети и без базы.
 *
 * `posts` в сумме площадки — число постов, у которых по НЕЙ прочитался хоть
 * один показатель (не ноль постов с площадкой вообще, а ноль с ЧИСЛАМИ):
 * запись со всеми `null` в сумму не идёт, иначе неудачно прочитанный пост
 * тихо считался бы «нулевым просмотром» и портил бы среднее по часам.
 */
export function summarizePostStats(posts: PostStatsPost[]): {
  totals: Record<PostStatsChannel, { posts: number; views: number; likes: number; comments: number }>;
  byHour: PostStatsHourBucket[];
} {
  const totals = Object.fromEntries(
    POST_STATS_CHANNELS.map((c) => [c, { posts: 0, views: 0, likes: 0, comments: 0 }])
  ) as Record<PostStatsChannel, { posts: number; views: number; likes: number; comments: number }>;

  const byHourViews = new Map<number, number[]>();

  for (const post of posts) {
    let totalViewsThisPost = 0;
    for (const stat of post.stats) {
      const bucket = totals[stat.channel];
      if (!bucket) continue;
      const hasAny = stat.views != null || stat.likes != null || stat.comments != null;
      if (hasAny) bucket.posts += 1;
      bucket.views += stat.views ?? 0;
      bucket.likes += stat.likes ?? 0;
      bucket.comments += stat.comments ?? 0;
      totalViewsThisPost += stat.views ?? 0;
    }
    if (post.publishHour != null) {
      const list = byHourViews.get(post.publishHour) ?? [];
      list.push(totalViewsThisPost);
      byHourViews.set(post.publishHour, list);
    }
  }

  const byHour = [...byHourViews.entries()]
    .map(([hour, views]) => ({
      hour,
      posts: views.length,
      avgViews: Math.round(views.reduce((a, b) => a + b, 0) / views.length),
    }))
    .sort((a, b) => a.hour - b.hour);

  return { totals, byHour };
}

/**
 * Точка входа, читающая базу и сеть (не чистая — см. `summarizePostStats` для
 * тестируемой части). `forceRefresh` — обход получасового кэша (`?refresh=1`
 * в роуте).
 */
export async function loadPostStats(options?: { forceRefresh?: boolean }): Promise<PostStatsResult> {
  if (!options?.forceRefresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result;
  const result = await buildPostStats();
  cache = { at: Date.now(), result };
  return result;
}

/**
 * ОДИН ОБЪЕКТ — для вкладки «Статистика» в карточке (24.09.2026): те же
 * площадки тем же кодом, что витрина «Обзор», но только его ролики. Свой
 * кэш на объект: карточку открывают часто, а площадки считают обращения.
 * null — объекта нет или он нигде не опубликован.
 */
const PROPERTY_CACHE_CAP = 200;
const propertyCache = new Map<string, { at: number; post: PostStatsPost; platforms: PostStatsPlatform[] }>();

export async function loadPropertyPostStats(
  propertyId: string
): Promise<{ post: PostStatsPost; platforms: PostStatsPlatform[] } | null> {
  const hit = propertyCache.get(propertyId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
  const row = await prisma.property.findUnique({ where: { id: propertyId }, select: CANDIDATE_SELECT });
  if (!row) return null;
  const candidate = toCandidate(row);
  if (candidate.publishedChannels.length === 0) return null;
  const result = await buildPostStats([candidate]);
  const entry = { at: Date.now(), post: result.posts[0], platforms: result.platforms };
  if (propertyCache.size >= PROPERTY_CACHE_CAP) propertyCache.delete(propertyCache.keys().next().value as string);
  propertyCache.set(propertyId, entry);
  return entry;
}

async function buildPostStats(only?: CandidateProperty[]): Promise<PostStatsResult> {
  const [propertyRows, freeCandidates, creds, settings, ytCreds, tiktokCreds] = await Promise.all([
    only ? Promise.resolve(only) : loadNewestPublishedProperties(),
    only ? Promise.resolve([] as CandidateProperty[]) : loadNewestFreeVideos(),
    loadCredentials(),
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramChannelId: true } }),
    youtubeCredentialsFromSettings(),
    tiktokCredentialsFromSettings(),
  ]);

  const properties = [...propertyRows, ...freeCandidates];

  const igConnected = Boolean(creds.igToken);
  const fbConnected = Boolean(creds.pageToken);
  const ytConnected = Boolean(ytCreds.clientId && ytCreds.clientSecret && ytCreds.refreshToken);
  const ttConnected = Boolean(tiktokCreds.clientKey && tiktokCreds.clientSecret && tiktokCreds.refreshToken);
  const tgConnected = Boolean(settings?.telegramChannelId);

  // Список попыток по площадке — только карточки, где канал реально стоит в
  // publishedChannels И для него сохранён id (старые публикации до 20.09.2026
  // могли остаться без id — тем же доводом, что в lib/publishedChannelsAudit.ts,
  // такие пропускаем, а не считаем отказом).
  const igTargets = properties
    .filter((p) => p.publishedChannels.includes("INSTAGRAM") && p.postIds.INSTAGRAM)
    .map((p) => ({ propertyId: p.id, mediaId: p.postIds.INSTAGRAM }));
  const fbTargets = properties
    .filter((p) => p.publishedChannels.includes("FACEBOOK") && p.postIds.FACEBOOK)
    .map((p) => ({ propertyId: p.id, videoId: p.postIds.FACEBOOK }));
  const ytTargets = properties
    .filter((p) => p.publishedChannels.includes("YOUTUBE") && p.postIds.YOUTUBE)
    .map((p) => ({ propertyId: p.id, videoId: p.postIds.YOUTUBE }));

  const [igOutcomes, fbOutcomes, ytResult, ttResult] = await Promise.all([
    igConnected
      ? mapWithConcurrency(igTargets, CALL_CONCURRENCY, (t) => fetchInstagramMedia(t.propertyId, t.mediaId, creds.igToken!))
      : Promise.resolve([]),
    fbConnected
      ? mapWithConcurrency(fbTargets, CALL_CONCURRENCY, (t) => fetchFacebookVideo(t.propertyId, t.videoId, creds.pageToken!))
      : Promise.resolve([]),
    ytConnected ? fetchYouTubeStats(ytCreds, ytTargets) : Promise.resolve({ ok: true as const, byPropertyId: new Map<string, YouTubeStat>() }),
    ttConnected
      ? fetchTikTokInsights(tiktokCreds)
      : Promise.resolve({ available: false as const, reason: "TikTok не подключён (нет ключей в Настройках)", missingScopes: [] }),
  ]);

  const igByPropertyId = new Map(igOutcomes.map((o) => [o.propertyId, o]));
  const fbByPropertyId = new Map(fbOutcomes.map((o) => [o.propertyId, o]));
  const ytOutcomeList: ProbeOutcome[] = ytTargets.map(({ propertyId }) =>
    ytResult.ok
      ? { propertyId, ok: true, views: ytResult.byPropertyId.get(propertyId)?.views ?? null, likes: ytResult.byPropertyId.get(propertyId)?.likes ?? null, comments: ytResult.byPropertyId.get(propertyId)?.comments ?? null, url: null }
      : { propertyId, ok: false, error: ytResult.error, views: null, likes: null, comments: null, url: null }
  );
  const ytByPropertyId = new Map(ytOutcomeList.map((o) => [o.propertyId, o]));

  // TikTok сопоставляет ролик с карточкой уже сам (mapVideosToProperties внутри
  // fetchTikTokInsights) — переиспользуем это сопоставление, вторую копию по
  // publishedPostIds.TIKTOK не заводим.
  const ttByPropertyId = new Map<string, { views: number | null; likes: number | null; comments: number | null; url: string | null }>();
  if (ttResult.available) {
    for (const video of ttResult.videos) {
      if (video.propertyId) {
        ttByPropertyId.set(video.propertyId, {
          views: video.viewCount,
          likes: video.likeCount,
          comments: video.commentCount,
          url: video.shareUrl,
        });
      }
    }
  }
  // Свободные ролики сюда не входят: TikTok сопоставляет ролики с карточками объектов (см. выше), а у них карточки нет.
  const ttTargetIds = propertyRows.filter((p) => p.publishedChannels.includes("TIKTOK") && p.postIds.TIKTOK).map((p) => p.id);
  const ttOutcomeList: ProbeOutcome[] = ttResult.available
    ? ttTargetIds.map((propertyId) => {
        const v = ttByPropertyId.get(propertyId);
        return v
          ? { propertyId, ok: true, views: v.views, likes: v.likes, comments: v.comments, url: v.url }
          : { propertyId, ok: false, error: "ролик не найден в списке TikTok", views: null, likes: null, comments: null, url: null };
      })
    : [];

  const allPosts: PostStatsPost[] = properties.map((p) => {
    const stats: PostChannelStat[] = [];
    let igTimestamp: string | null | undefined;
    for (const channel of POST_STATS_CHANNELS) {
      if (!p.publishedChannels.includes(channel)) continue;
      if (channel === "INSTAGRAM") {
        const o = igByPropertyId.get(p.id);
        if (o) igTimestamp = o.publishedAt;
        stats.push({
          channel,
          views: o?.views ?? null,
          likes: o?.likes ?? null,
          comments: o?.comments ?? null,
          url: o?.url ?? null,
          avgWatchSec: o?.avgWatchSec ?? null,
          skipRate: o?.skipRate ?? null,
          watchedShare: null,
          note: o ? (o.ok ? (o.viewsNote ?? null) : (o.error ?? null)) : null,
        });
      } else if (channel === "FACEBOOK") {
        const o = fbByPropertyId.get(p.id);
        stats.push({
          channel,
          views: o?.views ?? null,
          likes: o?.likes ?? null,
          comments: o?.comments ?? null,
          url: o?.url ?? null,
          avgWatchSec: o?.avgWatchSec ?? null,
          skipRate: null,
          watchedShare: null,
          note: o && !o.ok ? (o.error ?? null) : null,
        });
      } else if (channel === "YOUTUBE") {
        const o = ytByPropertyId.get(p.id);
        const r = ytResult.ok ? ytResult.byPropertyId.get(p.id) : undefined;
        stats.push({
          channel,
          views: o?.views ?? null,
          likes: o?.likes ?? null,
          comments: o?.comments ?? null,
          url: o?.url ?? null,
          avgWatchSec: r?.avgWatchSec ?? null,
          skipRate: null,
          watchedShare: r?.watchedShare ?? null,
          note: o && !o.ok ? (o.error ?? null) : null,
        });
      } else if (channel === "TIKTOK") {
        const v = ttByPropertyId.get(p.id);
        stats.push({
          channel,
          views: v?.views ?? null,
          likes: v?.likes ?? null,
          comments: v?.comments ?? null,
          url: v?.url ?? null,
          avgWatchSec: null,
          skipRate: null,
          watchedShare: null,
          note: v ? null : (ttOutcomeList.find((t) => t.propertyId === p.id && !t.ok)?.error ?? null),
        });
      } else {
        // TELEGRAM — Bot API не отдаёт число просмотров, см. докстринг модуля.
        stats.push({ channel, views: null, likes: null, comments: null, url: null, avgWatchSec: null, skipRate: null, watchedShare: null, note: null });
      }
    }

    const publishedAt = resolvePublishedAt(igTimestamp, p.scheduledPublishAt);
    return {
      propertyId: p.id,
      shortId: p.shortId,
      title: p.title,
      publishedAt,
      publishHour: publishedAt ? dushanbeHour(new Date(publishedAt)) : null,
      stats,
    };
  });

  const posts = allPosts.filter((p) => !isFreeId(p.propertyId));
  const freeVideos: PostStatsFreeVideo[] = allPosts
    .filter((p) => isFreeId(p.propertyId))
    .map((p) => ({ id: p.propertyId.slice(FREE_ID_PREFIX.length), title: p.title, publishedAt: p.publishedAt, publishHour: p.publishHour, stats: p.stats }));
  const { totals, byHour } = summarizePostStats(allPosts);

  const igSettled = settleChannel("INSTAGRAM", igConnected, "Instagram не подключён (нет токена)", igOutcomes);
  const fbSettled = settleChannel("FACEBOOK", fbConnected, "Facebook не подключён (нет токена Страницы)", fbOutcomes);
  const ytSettled = settleChannel(
    "YOUTUBE",
    ytConnected,
    "YouTube не настроен (нет client_id/client_secret/refresh_token в Настройках)",
    ytOutcomeList
  );
  const ttSettled = ttConnected
    ? ttResult.available
      ? settleChannel("TIKTOK", true, "", ttOutcomeList)
      : { connected: true, available: false, reason: ttResult.reason }
    : { connected: false, available: false, reason: "TikTok не подключён (нет ключей в Настройках)" };
  const tgSettled = {
    connected: tgConnected,
    available: false,
    reason: "Telegram не отдаёт ботам число просмотров постов в канале",
  };

  const settledByChannel: Record<PostStatsChannel, { connected: boolean; available: boolean; reason: string | null }> = {
    INSTAGRAM: igSettled,
    FACEBOOK: fbSettled,
    YOUTUBE: ytSettled,
    TIKTOK: ttSettled,
    TELEGRAM: tgSettled,
  };

  const platforms: PostStatsPlatform[] = POST_STATS_CHANNELS.map((channel) => ({
    channel,
    ...settledByChannel[channel],
    ...totals[channel],
  }));

  return {
    fetchedAt: new Date().toISOString(),
    platforms,
    posts,
    freeVideos,
    byHour,
  };
}

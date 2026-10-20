import { prisma } from "../db.js";
import { publicReplyReceipt } from "./publicCommentReply.js";
import { logSystemError } from "../lib/systemError.js";
import { reportYoutubeScopeMissing } from "../lib/youtubeScope.js";
import { describeError } from "../lib/describeError.js";
import { decryptSecretSafe } from "../crypto.js";
import { fetchWithRetry } from "./meta.js";
import { youtubeAccessToken, type YouTubeCredentials } from "../lib/socialPublish.js";
import { loadBotCapabilities } from "./botCapabilities.js";
import { enqueueComments, noteCommentsOff, type IncomingComment } from "./commentsQueue.js";
import { requireModerationAccepted, youtubeRejectOutcome } from "./commentModerationOutcome.js";

/**
 * ИИ отвечает на комментарии под YouTube Shorts (17.09.2026) — третий канал в той
 * же очереди, что Instagram/Facebook (messengers/comments.ts), по образцу того, как
 * 16.08.2026 туда добавили Facebook.
 *
 * ГЛАВНОЕ ОТЛИЧИЕ ОТ INSTAGRAM/FACEBOOK: у YouTube нет вебхука комментариев, только
 * опрос YouTube Data API v3. Этот файл — весь опрос и все YouTube-специфичные вызовы
 * (ответ/скрытие/удаление/карточка видео), которые из messengers/comments.ts зовут
 * per-channel веткой ("YOUTUBE"). Общая разборка очереди (processDueComments,
 * handleComment, decideOnComment) не дублируется — она осталась одна в comments.ts.
 *
 * Не импортирует ничего из comments.ts (см. commentsQueue.ts — почему это важно:
 * иначе получился бы цикл импортов, который ловит `npm run audit:deps`).
 */

const YOUTUBE_TIMEOUT_MS = 15_000;

/** Google для refresh_token-обмена всегда возвращает expires_in=3600 (документированное
 *  поведение этого grant type). youtubeAccessToken() в lib/socialPublish.ts отдаёт
 *  только сам токен, без числа секунд, — трогать её сигнатуру ради второго
 *  потребителя не стали (публикация роликов и так работает и её касаться нельзя было
 *  бы без переразбора testов). Поэтому кэшируем на этот же практический срок с
 *  запасом больше минуты, а не выдумываем случайное число. */
const ACCESS_TOKEN_TTL_MS = 55 * 60_000;
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

/** Свой channel id — кэш на время жизни процесса (см. задание): публикация под
 *  которую опрашиваем комментарии не меняется, пока жив процесс API. */
let cachedChannelId: string | null = null;

async function loadYoutubeCredentials(): Promise<YouTubeCredentials | null> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { youtubeClientId: true, youtubeClientSecret: true, youtubeRefreshToken: true },
  });
  const clientId = settings?.youtubeClientId ?? undefined;
  const clientSecret = decryptSecretSafe(settings?.youtubeClientSecret ?? null) ?? undefined;
  const refreshToken = decryptSecretSafe(settings?.youtubeRefreshToken ?? null) ?? undefined;
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

/** Тот же select, что checkYouTubeTokenHealth в lib/socialPublish.ts — есть ли вообще
 *  чем ходить в YouTube Data API. */
export async function youtubeCommentsConfigured(): Promise<boolean> {
  return (await loadYoutubeCredentials()) !== null;
}

async function getAccessToken(): Promise<string | null> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now()) return cachedAccessToken.token;
  const creds = await loadYoutubeCredentials();
  if (!creds) return null;
  const token = await youtubeAccessToken(creds);
  cachedAccessToken = { token, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS };
  return token;
}

/** Отказ YouTube Data API — разобран один раз, чтобы отличить нехватку scope
 *  (`insufficientPermissions`/`forbidden`) и исчерпанную квоту (`quotaExceeded`) от
 *  обычного сбоя: у первых двух свой текст в журнал и своя дневная дедупликация
 *  (см. reportYoutubeApiError), у остального — обычный logSystemError. */
class YoutubeApiError extends Error {
  status: number;
  reason?: string;
  constructor(status: number, body: unknown) {
    const errors = (body as { error?: { errors?: { reason?: string }[]; message?: string } } | undefined)?.error;
    super(errors?.message || `HTTP ${status}`);
    this.status = status;
    this.reason = errors?.errors?.[0]?.reason;
  }
}

/**
 * Общий вызов YouTube Data API: сам получает токен, шлёт его Bearer-заголовком (а
 * не access_token в теле/строке запроса — так исторически делает только OAuth
 * Playground, а не рабочий код), разбирает ошибку в YoutubeApiError. Один помощник
 * на поллер (channels/commentThreads) и на действия бота (comments/videos) — второй
 * копии этого запроса в проекте нет.
 */
async function youtubeApiRequest<T = unknown>(method: "GET" | "POST" | "DELETE", url: string, body?: unknown, moderation = false, beforePost?: () => Promise<void>): Promise<T> {
  const accessToken = await getAccessToken();
  if (!accessToken) throw new Error("YouTube не настроен (нет client_id/client_secret/refresh_token в Настройках)");
  const res = await fetchWithRetry(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    YOUTUBE_TIMEOUT_MS, beforePost
  );
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // Пустое тело (setModerationStatus/DELETE отвечают без JSON) — не ошибка.
  }
  // 401/403 — маркер протух или выпущен без нужного scope: кэш сбросить сразу,
  // иначе после перевыпуска refresh-токена владельцем поллер ещё 55 минут ходит
  // со старым access-токеном и продолжает получать тот же отказ.
  if (res.status === 401 || res.status === 403) cachedAccessToken = null;
  if (!res.ok) throw new YoutubeApiError(res.status, parsed);
  if (moderation) requireModerationAccepted(youtubeRejectOutcome(res.status, text));
  return parsed as T;
}

async function getChannelId(): Promise<string | null> {
  if (cachedChannelId) return cachedChannelId;
  const body = await youtubeApiRequest<{ items?: { id?: string }[] }>(
    "GET",
    "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true"
  );
  const id = body.items?.[0]?.id;
  if (id) cachedChannelId = id;
  return id ?? null;
}

/** Дневная дедупликация отдельно от общей (noteCommentsOff метит «модерация не
 *  работает целиком», а это два конкретных, разных по смыслу отказа: нехватка
 *  scope лечится перевыпуском токена, квота — сама пройдёт к полуночи по Тихому
 *  океану). Раз в сутки на причину, не на канал: обе причины технически возможны
 *  одновременно. */
const API_ERROR_LOG_EVERY_MS = 24 * 60 * 60 * 1000;
const lastApiErrorLogAt = new Map<string, number>();

function reportYoutubeApiError(err: unknown, where: string): void {
  if (err instanceof YoutubeApiError && err.status === 403 && (err.reason === "insufficientPermissions" || err.reason === "forbidden")) {
    const key = "scope";
    if (Date.now() - (lastApiErrorLogAt.get(key) ?? 0) < API_ERROR_LOG_EVERY_MS) return;
    lastApiErrorLogAt.set(key, Date.now());
    // Общая строка с суточной дедупликацией ещё и в базе (lib/youtubeScope.ts) —
    // та же, что у статистики и правки подписей: причина одна, напоминание одно,
    // и перезапуск сервера (счётчик выше живёт в памяти) его не повторяет.
    reportYoutubeScopeMissing();
    return;
  }
  if (err instanceof YoutubeApiError && err.reason === "quotaExceeded") {
    const key = "quota";
    if (Date.now() - (lastApiErrorLogAt.get(key) ?? 0) < API_ERROR_LOG_EVERY_MS) return;
    lastApiErrorLogAt.set(key, Date.now());
    void logSystemError("youtube", `Суточная квота YouTube Data API исчерпана (${where}) — поллер подождёт до завтра.`);
    return;
  }
  void logSystemError("youtube", `${where}: ${describeError(err)}`);
}

// ─── Действия бота (зовутся из comments.ts) ────────────────────────────────

/**
 * Публичный ответ. YouTube принимает ответ ТОЛЬКО на верхний комментарий: если
 * строка — ответ в ветке (есть parentId), в теле уходит именно он, а не
 * commentId самой реплики.
 */
export async function postYouTubeCommentReplyResponse(topLevelOrOwnId: string, message: string, beforePost?: () => Promise<void>): Promise<unknown> {
  try {
    const created = await youtubeApiRequest<{ id?: string }>(
      "POST",
      "https://www.googleapis.com/youtube/v3/comments?part=snippet",
      { snippet: { parentId: topLevelOrOwnId, textOriginal: message } }, false, beforePost
    );
    return created;
  } catch (err) {
    reportYoutubeApiError(err, "исход публичного ответа YouTube не подтверждён");
    throw err;
  }
}

export async function postYouTubeCommentReply(topLevelOrOwnId: string, message: string, beforePost?: () => Promise<void>): Promise<string | null> {
  const receipt = publicReplyReceipt("YOUTUBE", await postYouTubeCommentReplyResponse(topLevelOrOwnId, message, beforePost));
  return receipt.outcome === "accepted" ? receipt.providerId : null;
}

/**
 * Отклонить комментарий от публичного отображения.
 *
 * У YouTube это состояние `rejected`; документация запрещает возвращать его в
 * `published`. Boolean hide сохранён для совместимости общей функции модерации,
 * но false отвергается до provider call. Успех здесь — документированный 204.
 */
export async function setYouTubeCommentHidden(commentId: string, hide: boolean): Promise<void> {
  if (!hide) throw new Error("Возврат отклонённого комментария YouTube не поддерживается");
  try {
    await youtubeApiRequest(
      "POST",
      `https://www.googleapis.com/youtube/v3/comments/setModerationStatus?id=${encodeURIComponent(commentId)}&moderationStatus=rejected`,
      undefined, true
    );
  } catch (err) {
    reportYoutubeApiError(err, "отклонение комментария YouTube не подтверждено");
    throw err;
  }
}

export async function hideYouTubeComment(commentId: string): Promise<void> {
  await setYouTubeCommentHidden(commentId, true);
}

/**
 * «Удалить» чужой комментарий под своим роликом — это отклонить его (24.09.2026).
 *
 * `DELETE /comments` YouTube выполняет только для комментариев, написанных самим
 * владельцем маркера; на чужой отвечает 403 `forbidden`. Бот звал именно его для
 * рекламы чужой квартиры (action `delete`), получал отказ — и реклама оставалась
 * висеть, строка уходила в три повтора и FAILED, а лид по номеру из неё не
 * заводился, потому что удаление бросало раньше. Владелец канала убирает чужой
 * комментарий состоянием модерации `rejected`. Это отдельный эффект, а не
 * подтверждение физического удаления.
 */
export async function deleteYouTubeComment(commentId: string): Promise<void> {
  try {
    await youtubeApiRequest(
      "POST",
      `https://www.googleapis.com/youtube/v3/comments/setModerationStatus?id=${encodeURIComponent(commentId)}&moderationStatus=rejected`,
      undefined, true
    );
  } catch (err) {
    reportYoutubeApiError(err, "отклонение комментария YouTube не подтверждено");
    throw err;
  }
}

/** Адрес и подпись видео — тот же контракт, что fetchMedia в comments.ts. */
export async function fetchYouTubeVideoInfo(videoId: string): Promise<{ permalink?: string; caption?: string } | null> {
  try {
    const body = await youtubeApiRequest<{ items?: { snippet?: { title?: string; description?: string } }[] }>(
      "GET",
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}`
    );
    const snippet = body.items?.[0]?.snippet;
    if (!snippet) return null;
    return {
      permalink: `https://youtube.com/shorts/${videoId}`,
      caption: `${snippet.title ?? ""}\n${snippet.description ?? ""}`.trim(),
    };
  } catch (err) {
    reportYoutubeApiError(err, `Видео YouTube ${videoId} не получено`);
    return null;
  }
}

// ─── Поллер ─────────────────────────────────────────────────────────────────

interface YoutubeCommentSnippet {
  videoId?: string;
  textOriginal?: string;
  authorDisplayName?: string;
  authorChannelId?: { value?: string };
  publishedAt?: string;
  parentId?: string;
}

interface YoutubeCommentThread {
  snippet?: { videoId?: string; topLevelComment?: { id?: string; snippet?: YoutubeCommentSnippet } };
  replies?: { comments?: { id?: string; snippet?: YoutubeCommentSnippet }[] };
}

/** Не отвечаем на комментарии старше 3 суток — при первом включении (или после
 *  долгого простоя из-за нехватки scope) под роликами могло накопиться старьё, и
 *  отвечать на него постфактум выглядело бы страннее, чем промолчать. */
const YT_STALE_MS = 3 * 24 * 60 * 60 * 1000;
const YT_MAX_RESULTS = 50;

/**
 * СТРАНИЦ ЗА ОДИН ОПРОС — ДО ПЯТИ (заведено 18.09.2026).
 *
 * До этого запрос уходил вообще без `pageToken`, то есть брал ровно первые 50
 * веток и на этом заканчивался. Комментарии, не поместившиеся в эти 50 между
 * двумя тиками (ролик разошёлся, рекламу включили), не попадали в очередь
 * НИКОГДА: следующий опрос видел ту же первую страницу, а через трое суток
 * отсечка YT_STALE_MS закрывала им дорогу насовсем.
 *
 * Пять страниц (250 веток за тик, 5 единиц квоты из 10 000 в сутки) — с запасом
 * на всплеск и всё ещё далеко от лимита. Обычный тик тратит одну: перебор
 * прекращается на первой странице, где все ветки старше отсечки (порядок
 * `order=time` — от новых к старым, значит дальше только старьё).
 */
const YT_MAX_PAGES = 5;

/** Есть ли на странице хоть одна ветка, которой отсечка по возрасту ещё не
 *  закрыла дорогу. Смотрим ВЕРХНИЕ комментарии: именно по их времени YouTube
 *  сортирует ветки, и дальше по списку будут только более старые. */
function pageHasFreshThread(threads: YoutubeCommentThread[], cutoffMs: number): boolean {
  return threads.some((t) => {
    const at = t.snippet?.topLevelComment?.snippet?.publishedAt;
    if (!at) return true;
    const ms = Date.parse(at);
    return !Number.isFinite(ms) || ms >= cutoffMs;
  });
}

function toRow(
  commentId: string | undefined,
  videoId: string | undefined,
  snippet: YoutubeCommentSnippet | undefined,
  parentId: string | undefined,
  ourChannelId: string,
  cutoffMs: number
): IncomingComment | null {
  if (!commentId || !videoId || !snippet) return null;
  const authorId = snippet.authorChannelId?.value || snippet.authorDisplayName;
  const text = (snippet.textOriginal ?? "").trim();
  if (!authorId || !text) return null;
  // Своя же реплика — назад в очередь не берём (та же защита, что у Instagram:
  // без неё бот отвечает сам себе, YouTube исправно возвращает её следующим опросом).
  if (authorId === ourChannelId) return null;
  const publishedAt = snippet.publishedAt ? Date.parse(snippet.publishedAt) : Date.now();
  if (Number.isFinite(publishedAt) && publishedAt < cutoffMs) return null;
  return {
    channel: "YOUTUBE",
    commentId,
    mediaId: videoId,
    accountExternalId: ourChannelId,
    parentId,
    authorId,
    authorName: snippet.authorDisplayName,
    text,
  };
}

/** Разбор ответа commentThreads в строки очереди. Чистая функция — проверяется
 *  тестом без сети и без базы (см. tests/youtube-comments.test.ts). */
export function parseYouTubeCommentThreads(threads: YoutubeCommentThread[], ourChannelId: string, now: number = Date.now()): IncomingComment[] {
  const cutoffMs = now - YT_STALE_MS;
  const out: IncomingComment[] = [];
  for (const thread of threads) {
    const top = thread.snippet?.topLevelComment;
    const videoId = thread.snippet?.videoId ?? top?.snippet?.videoId;
    const topRow = toRow(top?.id, videoId, top?.snippet, undefined, ourChannelId, cutoffMs);
    if (topRow) out.push(topRow);
    for (const reply of thread.replies?.comments ?? []) {
      const replyRow = toRow(reply.id, videoId, reply.snippet, reply.snippet?.parentId ?? top?.id, ourChannelId, cutoffMs);
      if (replyRow) out.push(replyRow);
    }
  }
  return out;
}

/**
 * Опрос YouTube Data API раз в 2 минуты (см. cron.ts, "youtube-comments"):
 * 1 единица квоты на commentThreads, лимит 10 000/день — 720 в сутки при этом
 * ритме, запас с большим избытком.
 *
 * Выходит тихо (только noteCommentsOff), если ключей нет: опрашивать нечем.
 *
 * ВЫКЛЮЧЕННЫЙ ПОЛЗУНОК «ОТВЕЧАТЬ НА КОММЕНТАРИИ» БОЛЬШЕ НЕ ОТМЕНЯЕТ ОПРОС
 * (18.09.2026). Раньше он выходил здесь же, до всякого обращения к API, и
 * комментарии YouTube за это время не сохранялись ВООБЩЕ — то есть их не было ни
 * в ленте комментариев CRM, ни потом: отсечка YT_STALE_MS (3 суток) закрывает
 * дорогу назад, а повторно YouTube их не «доставит», это опрос, а не вебхук.
 * Instagram и Facebook ведут себя обратным образом и правильно: комментарий
 * ложится в базу со статусом SKIPPED и пометкой "bot_off" (см.
 * commentsQueue.ts::enqueueComments — «бот выключен — комментарий всё равно
 * сохраняем: он должен остаться в журнале»). Теперь так же и здесь: опрашиваем,
 * складываем, но не отвечаем.
 */
export async function pollYouTubeComments(): Promise<void> {
  const enabled = (await loadBotCapabilities()).comments;
  if (!enabled) {
    await noteCommentsOff("YOUTUBE", "выключен общий ползунок «Отвечать на комментарии» (Настройки → Бот)");
  }
  if (!(await youtubeCommentsConfigured())) {
    await noteCommentsOff("YOUTUBE", "YouTube не настроен: нет client_id/client_secret/refresh_token в Настройках");
    return;
  }

  let channelId: string | null;
  try {
    channelId = await getChannelId();
  } catch (err) {
    reportYoutubeApiError(err, "поллер YouTube: свой канал не определён");
    return;
  }
  if (!channelId) {
    void logSystemError("youtube", "Поллер YouTube: channels?mine=true не вернул id — комментарии не опрошены.");
    return;
  }

  const cutoffMs = Date.now() - YT_STALE_MS;
  const threads: YoutubeCommentThread[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < YT_MAX_PAGES; page++) {
    let body: { items?: YoutubeCommentThread[]; nextPageToken?: string };
    try {
      body = await youtubeApiRequest<{ items?: YoutubeCommentThread[]; nextPageToken?: string }>(
        "GET",
        `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet,replies&allThreadsRelatedToChannelId=${encodeURIComponent(
          channelId
        )}&order=time&maxResults=${YT_MAX_RESULTS}&textFormat=plainText` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "")
      );
    } catch (err) {
      reportYoutubeApiError(err, "поллер YouTube: список комментариев не получен");
      // Уже собранные страницы НЕ выбрасываем: отказ на третьей странице не повод
      // потерять первые две — повторно YouTube их не пришлёт, это опрос.
      break;
    }
    const items = body.items ?? [];
    threads.push(...items);
    pageToken = body.nextPageToken;
    // Страница целиком старше отсечки — дальше только ещё старее (order=time).
    if (!pageToken || items.length === 0 || !pageHasFreshThread(items, cutoffMs)) break;
  }
  if (threads.length === 0) return;

  const rows = parseYouTubeCommentThreads(threads, channelId);
  if (rows.length === 0) return;

  // Своя же реплика, вернувшаяся как новый комментарий (защита сверх проверки
  // authorId выше — та же двойная защита, что у Instagram в comments.ts).
  const ours = await prisma.instagramComment.findMany({
    where: { replyCommentId: { in: rows.map((r) => r.commentId) } },
    select: { replyCommentId: true },
    take: rows.length,
  });
  const ownIds = new Set(ours.map((o) => o.replyCommentId));
  const fresh = rows.filter((r) => !ownIds.has(r.commentId));
  if (fresh.length === 0) return;

  // enabled — состояние общего ползунка, посчитанное в начале функции: выключенный
  // складывает строки как SKIPPED/"bot_off", а не теряет их (см. шапку функции).
  await enqueueComments(fresh, enabled);
}

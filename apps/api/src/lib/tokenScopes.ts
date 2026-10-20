import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { describeError } from "./describeError.js";
import { fetchWithRetry, GRAPH_VERSION, instagramApiUrl, instagramRequest } from "../messengers/meta.js";

/**
 * ВСЕ ПРАВА ВСЕХ МАРКЕРОВ — ОДНИМ СПИСКОМ (23.09.2026).
 *
 * Жалоба владельца дословно: «каждые несколько дней мы выпускаем новые маркеры,
 * потому что там нет каких-то прав, я уже устал». Причина была не в Meta и не в
 * TikTok, а в том, как росла CRM: каждая новая возможность (комментарии Facebook,
 * статистика, удаление из Instagram, комментарии YouTube) добавлялась со своим
 * правом, а узнавали о нём в момент первой поломки. Проверка «Здоровье системы»
 * отвечала только «маркер жив», и маркер без половины прав выглядел зелёным.
 * Хуже того, кнопка «Подключить TikTok» сама просила три права из пяти нужных, и
 * каждое переподключение выдавало заведомо неполный маркер.
 *
 * Теперь так:
 *  1. Этот список — единственное место, где записано, какие права нужны каждому
 *     маркеру и зачем. Кнопки подключения берут права отсюда же.
 *  2. Суточная проверка (lib/integrationHealth.ts::checkTokenScopesHealth)
 *     спрашивает у каждой площадки, какие права маркеру выданы на самом деле, и
 *     пишет в журнал и на экран «Здоровье системы», ЧЕГО не хватает и для чего.
 *  3. Новая возможность, которой нужно новое право, дописывает его СЮДА в той же
 *     правке. Проверка в ту же ночь скажет владельцу, что маркер пора перевыпустить,
 *     до того, как новая возможность откажет у клиента на глазах.
 */

export type TokenKind =
  | "FACEBOOK_PAGE"
  | "WHATSAPP"
  | "INSTAGRAM"
  | "INSTAGRAM_MANAGE"
  | "META_ADS"
  | "YOUTUBE"
  | "TIKTOK"
  | "THREADS";

export interface RequiredScope {
  scope: string;
  /** Для чего нужно — человеческими словами, это читает владелец. */
  forWhat: string;
  /**
   * Право ещё не одобрено площадкой для нашего приложения — почему, одной строкой.
   * Такое право НЕ просится при подключении и НЕ считается недостающим: площадка
   * отвечает на запрос неодобренного права отказом во входе целиком (TikTok 23.09.2026:
   * «Что-то пошло не так… scope» — кнопка «Подключить» перестала работать вовсе),
   * а перевыпуск маркера его всё равно не даст. Снять пометку в той же правке,
   * в какой площадка одобрит право.
   */
  awaitingApproval?: string;
}

export interface TokenScopeSpec {
  /** Как маркер называется в Настройках. */
  title: string;
  scopes: RequiredScope[];
}

export const TOKEN_SCOPE_CATALOG: Record<TokenKind, TokenScopeSpec> = {
  FACEBOOK_PAGE: {
    title: "Маркер Страницы Facebook",
    scopes: [
      { scope: "pages_show_list", forWhat: "найти нашу Страницу" },
      { scope: "pages_messaging", forWhat: "отвечать клиентам в Messenger" },
      { scope: "pages_manage_metadata", forWhat: "получать сообщения и комментарии Страницы" },
      { scope: "pages_read_engagement", forWhat: "читать публикации Страницы" },
      { scope: "pages_read_user_content", forWhat: "читать комментарии людей под постами" },
      { scope: "pages_manage_engagement", forWhat: "отвечать, скрывать и удалять комментарии" },
      { scope: "pages_manage_posts", forWhat: "публиковать и удалять ролики на Странице" },
      { scope: "read_insights", forWhat: "статистика Страницы и постов" },
      { scope: "instagram_basic", forWhat: "найти Instagram, привязанный к Странице" },
    ],
  },
  WHATSAPP: {
    title: "Маркер WhatsApp",
    scopes: [
      { scope: "whatsapp_business_messaging", forWhat: "отвечать клиентам в WhatsApp" },
      { scope: "whatsapp_business_management", forWhat: "читать номер и шаблоны сообщений" },
    ],
  },
  INSTAGRAM: {
    // Вход через Instagram (graph.instagram.com) — маркер каждого аккаунта в списке
    // «Аккаунты Instagram», а не поле «Маркер Instagram» (см. meta.ts::loadCredentials).
    title: "Маркер аккаунта Instagram",
    scopes: [
      { scope: "instagram_business_basic", forWhat: "видеть аккаунт и его публикации" },
      { scope: "instagram_business_manage_messages", forWhat: "отвечать клиентам в Direct" },
      { scope: "instagram_business_manage_comments", forWhat: "отвечать, скрывать и удалять комментарии" },
      { scope: "instagram_business_content_publish", forWhat: "публиковать Reels и истории" },
      { scope: "instagram_business_manage_insights", forWhat: "статистика и часы активности подписчиков" },
    ],
  },
  INSTAGRAM_MANAGE: {
    // Отдельный маркер через Facebook Login — только им Instagram даёт удалить
    // публикацию (проверено вживую 20.09.2026, см. socialPublish.ts).
    title: "Маркер удаления Instagram",
    scopes: [
      { scope: "instagram_basic", forWhat: "видеть публикации Instagram" },
      { scope: "instagram_manage_contents", forWhat: "удалять публикации проданных объектов" },
    ],
  },
  META_ADS: {
    title: "Маркер рекламного кабинета",
    scopes: [{ scope: "ads_read", forWhat: "расходы и заявки по рекламе" }],
  },
  YOUTUBE: {
    title: "Ключ доступа к каналу YouTube",
    scopes: [
      { scope: "https://www.googleapis.com/auth/youtube.upload", forWhat: "публиковать Shorts" },
      { scope: "https://www.googleapis.com/auth/youtube.force-ssl", forWhat: "отвечать, скрывать и удалять комментарии, снимать ролики" },
      { scope: "https://www.googleapis.com/auth/yt-analytics.readonly", forWhat: "статистика просмотров" },
    ],
  },
  TIKTOK: {
    title: "Доступ TikTok",
    scopes: [
      { scope: "user.info.basic", forWhat: "видеть аккаунт" },
      { scope: "video.upload", forWhat: "загружать ролики" },
      { scope: "video.publish", forWhat: "публиковать ролики" },
      {
        scope: "video.list",
        forWhat: "статистика просмотров по роликам",
        awaitingApproval:
          "в одобренной 23.09.2026 версии приложения только user.info.basic, video.upload, video.publish; video.list нужна отдельная ревизия в TikTok for Developers",
      },
      {
        scope: "user.info.profile",
        forWhat: "био и ссылка профиля",
        awaitingApproval:
          "та же ревизия, что video.list (23.09.2026) — ждёт одобрения TikTok for Developers",
      },
      {
        scope: "user.info.stats",
        forWhat: "подписчики, лайки, число роликов",
        awaitingApproval:
          "та же ревизия, что video.list (23.09.2026) — ждёт одобрения TikTok for Developers",
      },
    ],
  },
  THREADS: {
    title: "Доступ Threads",
    scopes: [
      { scope: "threads_basic", forWhat: "видеть аккаунт" },
      { scope: "threads_content_publish", forWhat: "публиковать посты" },
      { scope: "threads_manage_insights", forWhat: "статистика (следующий шаг, задел на будущее)" },
    ],
  },
};

/**
 * Права, которые надо просить у площадки при подключении, — строкой, как её ждёт
 * площадка (TikTok — через запятую, Google — через пробел).
 *
 * `includeAwaitingApproval` — ТОЛЬКО для песочницы TikTok (client key начинается
 * с `sb`): песочничный app может просить ещё не одобренные для прод-приложения
 * права, ревью там не требуется. Прод-приложению (`aw…`) их просить нельзя —
 * TikTok отказывает во входе целиком на неодобренный scope (см. докстринг выше).
 */
export function scopesForRequest(
  kind: TokenKind,
  separator: string,
  opts?: { includeAwaitingApproval?: boolean }
): string {
  return grantableScopes(kind, opts?.includeAwaitingApproval ?? false)
    .map((s) => s.scope)
    .join(separator);
}

/** Права, которые площадка сейчас готова выдать нашему приложению.
 *  `includeAwaitingApproval` — см. scopesForRequest. */
function grantableScopes(kind: TokenKind, includeAwaitingApproval = false): RequiredScope[] {
  return TOKEN_SCOPE_CATALOG[kind].scopes.filter((s) => includeAwaitingApproval || !s.awaitingApproval);
}

/** Каких прав из списка нет среди выданных. Чистая функция. */
export function missingScopes(kind: TokenKind, granted: readonly string[]): RequiredScope[] {
  const have = new Set(granted);
  return grantableScopes(kind).filter((s) => !have.has(s.scope));
}

/** «Короткое» имя права для текста: у Google полный адрес длиной в строку. */
function shortScope(scope: string): string {
  return scope.replace("https://www.googleapis.com/auth/", "");
}

/** Текст для журнала и экрана: чего не хватает и для чего. */
export function describeMissingScopes(kind: TokenKind, missing: readonly RequiredScope[]): string {
  const list = missing.map((m) => `${shortScope(m.scope)} (${m.forWhat})`).join(", ");
  return `не хватает прав: ${list}`;
}

// ─── Что выдано на самом деле ────────────────────────────────────────────────

const CHECK_TIMEOUT_MS = 15_000;

export interface MetaTokenInfo {
  scopes: string[];
  /** null — маркер бессрочный (Meta отдаёт expires_at = 0). */
  expiresAt: Date | null;
}

/** Маркер приложения `appId|appSecret` — им Meta разрешает смотреть любой маркер
 *  своего приложения. Нет пары в Настройках — смотрим маркер им же самим. */
async function metaAppAccessToken(): Promise<string | null> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaAppId: true, metaAppSecret: true },
  });
  const appId = s?.metaAppId?.trim() || process.env.META_APP_ID || "";
  const appSecret = decryptSecretSafe(s?.metaAppSecret ?? null) || process.env.META_APP_SECRET || "";
  return appId && appSecret ? `${appId}|${appSecret}` : null;
}

async function debugToken(inputToken: string, accessToken: string): Promise<MetaTokenInfo | null> {
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/debug_token` +
    `?input_token=${encodeURIComponent(inputToken)}&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetchWithRetry(url, { method: "GET" }, CHECK_TIMEOUT_MS);
  const body = (await res.json().catch(() => ({}))) as {
    data?: { is_valid?: boolean; scopes?: string[]; expires_at?: number; data_access_expires_at?: number };
  };
  const data = body.data;
  if (!res.ok || !data || data.is_valid === false || !Array.isArray(data.scopes)) return null;
  return {
    scopes: data.scopes,
    expiresAt: data.expires_at ? new Date(data.expires_at * 1000) : null,
  };
}

/**
 * Права маркера Facebook (Страница, WhatsApp, удаление Instagram, реклама) — через
 * `debug_token`. Ничего не меняет и квоту не тратит. Сначала маркером приложения,
 * при отказе — самим маркером: маркер может принадлежать второму приложению Meta,
 * и тогда наш маркер приложения его «не видит».
 *
 * `null` — узнать не удалось; это НЕ «прав нет», и тревогу по нему не поднимаем.
 */
export async function metaTokenInfo(token: string): Promise<MetaTokenInfo | null> {
  const appToken = await metaAppAccessToken();
  if (appToken) {
    const info = await debugToken(token, appToken).catch(() => null);
    if (info) return info;
  }
  return debugToken(token, token).catch(() => null);
}

export type ProbeResult = "granted" | "missing" | "unknown";

/** Отказ Graph по правам: код 10 или 200-299, либо слово permission в тексте.
 *  Код 190 (маркер мёртв) — не про права, это ловит проверка «маркер жив». */
export function classifyGraphDenial(status: number, body: unknown): ProbeResult {
  if (status >= 200 && status < 300) return "granted";
  const err = (body as { error?: { code?: number; message?: string } } | null)?.error;
  const code = err?.code;
  if (code === 10 || (typeof code === "number" && code >= 200 && code < 300)) return "missing";
  if (code !== 190 && /permission/i.test(err?.message ?? "")) return "missing";
  return "unknown";
}

async function instagramProbe(path: string, token: string): Promise<{ result: ProbeResult; body: unknown }> {
  try {
    const req = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}${path}`), token);
    const res = await fetchWithRetry(req.url, { headers: req.headers }, CHECK_TIMEOUT_MS);
    const body = await res.json().catch(() => ({}));
    return { result: classifyGraphDenial(res.status, body), body };
  } catch (err) {
    return { result: "unknown", body: { error: { message: describeError(err) } } };
  }
}

/**
 * Права маркера входа через Instagram. `debug_token` у этого продукта нет, поэтому
 * спрашиваем по одному безопасному ЧТЕНИЮ на каждое право: отказ по правам и есть
 * ответ «права нет». Ничего не публикует, не отвечает и не скрывает.
 */
export async function instagramLoginScopeProbes(token: string): Promise<Record<string, ProbeResult>> {
  const out: Record<string, ProbeResult> = {};
  out.instagram_business_basic = (await instagramProbe("/me?fields=user_id,username", token)).result;
  out.instagram_business_content_publish = (await instagramProbe("/me/content_publishing_limit", token)).result;
  out.instagram_business_manage_insights = (
    await instagramProbe("/me/insights?metric=online_followers&period=lifetime", token)
  ).result;
  out.instagram_business_manage_messages = (
    await instagramProbe("/me/conversations?platform=instagram&limit=1", token)
  ).result;

  // Комментарии читаются только у конкретной публикации: берём последнюю. Нет ни
  // одной — проверить нечем, это не отказ.
  const media = await instagramProbe("/me/media?fields=id&limit=1", token);
  const mediaId = (media.body as { data?: { id?: string }[] } | null)?.data?.[0]?.id;
  out.instagram_business_manage_comments = mediaId
    ? (await instagramProbe(`/${encodeURIComponent(mediaId)}/comments?limit=1`, token)).result
    : "unknown";
  return out;
}

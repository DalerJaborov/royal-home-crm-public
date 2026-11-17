/** Версия Graph API фиксируется явно: без неё Meta берёт самую старую поддерживаемую.
 *  Экспортируется, потому что комментарии Instagram (messengers/comments.ts) ходят
 *  в те же адреса и обязаны использовать ту же версию. */
export const GRAPH_VERSION = "v23.0";

/**
 * Адрес Instagram Graph API — через прокси, если он настроен.
 *
 * С нашего VPS `graph.instagram.com` недоступен на сетевом уровне (запросы
 * отваливаются с «fetch failed»), тогда как `graph.facebook.com` работает — из-за
 * этого WhatsApp отвечал, а Instagram молчал: входящие приходили, ответ уйти не мог.
 * Тот же Cloudflare Worker уже проксирует Gemini (см. ai/transcribe.ts) и умеет
 * Instagram, поэтому по умолчанию берём его ключи — отдельная настройка сервера не
 * нужна. IG_PROXY_URL/IG_PROXY_KEY оставлены на случай, если понадобится развести.
 */
const GRAPH_INSTAGRAM_ORIGIN = "https://graph.instagram.com";
const GRAPH_FACEBOOK_ORIGIN = "https://graph.facebook.com";

/**
 * МАРКЕР FACEBOOK LOGIN (начинается на `EAA`) — одна проверка на всю CRM
 * (13.11.2026, «Войти через Facebook»).
 *
 * У аккаунта Instagram в CRM маркер бывает двух видов:
 *  - вход через Instagram (`IGAA…`) — ходит на graph.instagram.com;
 *  - маркер Страницы Facebook (`EAA…`), к которой привязан этот Instagram, —
 *    такой аккаунт подключён кнопкой «Войти через Facebook» и может говорить
 *    ТОЛЬКО через Страницу на graph.facebook.com. graph.instagram.com такой
 *    маркер не принимает вовсе («Cannot parse access token», живой случай
 *    20.09.2026 — см. lib/secretFormat.ts).
 * Это свойство самого маркера, а не того, как его завели, поэтому решается по
 * началу строки здесь, в одном месте, а не флажком в базе.
 */
export function isFacebookLoginToken(token: string | null | undefined): boolean {
  return typeof token === "string" && /^EAA/.test(token.trim());
}

function instagramProxyBase(): string | undefined {
  return process.env.IG_PROXY_URL || process.env.GEMINI_PROXY_URL || undefined;
}

/** Путь адреса Instagram (graph.instagram.com или прокси), иначе null. */
function instagramPathOf(url: string, proxy: string | undefined): string | null {
  if (url.startsWith(GRAPH_INSTAGRAM_ORIGIN)) return url.slice(GRAPH_INSTAGRAM_ORIGIN.length);
  if (proxy && url.startsWith(proxy)) return url.slice(proxy.length);
  return null;
}

export function instagramApiUrl(path: string): string {
  const proxy = instagramProxyBase();
  return proxy ? `${proxy}${path}` : `${GRAPH_INSTAGRAM_ORIGIN}${path}`;
}

/**
 * Адрес и заголовки запроса к Instagram с учётом прокси.
 *
 * Worker пробрасывает наверх только `Content-Type` — заголовок `Authorization`
 * до Meta не доходит, поэтому через прокси маркер уходит параметром запроса
 * (так же, как это давно делает сайт). Напрямую — обычный Bearer.
 * `x-proxy-key` адресован самому Worker и выше не идёт.
 *
 * ССЫЛКА ПАГИНАЦИИ (`data.paging.next`) ТОЖЕ ТРЕБУЕТ ПЕРЕСБОРКИ (найдено 20.08.2026).
 * Graph API отдаёт её готовым абсолютным адресом на graph.instagram.com, а не через
 * прокси, — старая проверка `!url.startsWith(proxy)` на такой ссылке решала, что раз
 * префикса прокси нет, значит URL и так годится для прямого похода, и звала
 * graph.instagram.com напрямую. Это ровно противоположно правде: именно с нашего VPS
 * этот хост недоступен (см. instagramProxyBase), и первая страница ленты читалась
 * нормально, а вторая (и весь остаток за 25 постов) — с "aborted due to timeout" /
 * "connect timeout... graph.instagram.com" на каждом вызове (getAllOwnMedia,
 * instagramFeed.ts). Теперь адрес graph.instagram.com распознаётся отдельно и тоже
 * пересобирается через прокси, а не только префикс самого прокси.
 */
export function instagramRequest(url: string, token: string): { url: string; headers: Record<string, string> } {
  const proxy = instagramProxyBase();
  // Маркер Страницы у аккаунта Instagram (13.11.2026): graph.instagram.com его
  // не примет, а те же объекты Instagram (публикация, медиа, комментарий) по тому
  // же пути читаются на graph.facebook.com маркером Страницы. Адреса `/me…` НЕ
  // переносим: там `/me` маркера Страницы — это Страница, а не Instagram, и ответ
  // был бы чужим объектом (их обходят вызывающие: instagramTokenIdentity и др.).
  if (isFacebookLoginToken(token)) {
    const path = instagramPathOf(url, proxy);
    if (path !== null && !/^\/v\d+\.\d+\/me(?:[/?]|$)/.test(path) && !/^\/me(?:[/?]|$)/.test(path)) {
      return { url: `${GRAPH_FACEBOOK_ORIGIN}${path}`, headers: { Authorization: `Bearer ${token}` } };
    }
  }
  if (!proxy) return { url, headers: { Authorization: `Bearer ${token}` } };
  const target = url.startsWith(proxy)
    ? url
    : url.startsWith(GRAPH_INSTAGRAM_ORIGIN)
      ? proxy + url.slice(GRAPH_INSTAGRAM_ORIGIN.length)
      : null;
  if (!target) return { url, headers: { Authorization: `Bearer ${token}` } };
  const key = process.env.IG_PROXY_KEY || process.env.GEMINI_PROXY_KEY;
  // Ссылка пагинации (paging.next) приходит от Graph УЖЕ с access_token внутри —
  // второй такой же параметр в строке Graph отвергает 400-кой (26.08.2026).
  const alreadySigned = /[?&]access_token=/.test(target);
  const sep = target.includes("?") ? "&" : "?";
  return {
    url: alreadySigned ? target : `${target}${sep}access_token=${encodeURIComponent(token)}`,
    headers: key ? { "x-proxy-key": key } : {},
  };
}

/**
 * Запрос к адресу Instagram, который читает маркер ТОЛЬКО из строки запроса
 * (`/refresh_access_token`): Bearer-заголовок он не видит и отвечает 400
 * «The parameter access_token is required».
 *
 * Пока сервер жил в России, это скрывал прокси — он сам переносил маркер в строку.
 * С переезда на сервер в Германии (04.11.2026) прокси пуст, `instagramRequest`
 * шлёт обычный Bearer, и продление маркеров обоих аккаунтов молча падало каждую
 * неделю, пока маркеры не умерли бы через 60 дней. Маркер здесь всегда в строке
 * (ровно один раз), заголовок Authorization не дублирует его.
 */
export function instagramQueryTokenRequest(url: string, token: string): { url: string; headers: Record<string, string> } {
  const req = instagramRequest(url, token);
  if (/[?&]access_token=/.test(req.url)) return req;
  const headers = { ...req.headers };
  delete headers.Authorization;
  const sep = req.url.includes("?") ? "&" : "?";
  return { url: `${req.url}${sep}access_token=${encodeURIComponent(token)}`, headers };
}

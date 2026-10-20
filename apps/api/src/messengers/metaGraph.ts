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

function instagramProxyBase(): string | undefined {
  return process.env.IG_PROXY_URL || process.env.GEMINI_PROXY_URL || undefined;
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

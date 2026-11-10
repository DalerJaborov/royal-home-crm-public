/**
 * ТОЧКА ИЗ ТЕКСТА: координаты «38.5598, 68.7870» или ссылка Google/Yandex Maps
 * (10.11.2026, мастер объекта в Telegram — то же, что точка на карте в мастере
 * CRM). Только разбор строки, без сети: короткие ссылки (maps.app.goo.gl,
 * yandex.ru/maps/-/…) раскрывает сервер (apps/api/src/lib/mapLinkResolve.ts) и
 * отдаёт полученный адрес сюда же.
 *
 * Порядок координат у Яндекса — долгота, широта (`ll=68.78,38.55`, `pt=…`);
 * у Google и в простом тексте — широта, долгота.
 */
export interface MapPoint {
  lat: number;
  lng: number;
}

const NUM = "(-?\\d{1,3}(?:\\.\\d+)?)";

function point(lat: number, lng: number): MapPoint | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

function pair(raw: string | null | undefined, order: "latlng" | "lnglat"): MapPoint | null {
  const match = raw ? new RegExp(`^\\s*${NUM}\\s*,\\s*${NUM}`).exec(decodeURIComponent(raw)) : null;
  if (!match) return null;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return order === "latlng" ? point(a, b) : point(b, a);
}

function safeUrl(text: string): URL | null {
  try { return new URL(text); } catch { return null; }
}

const GOOGLE_HOST = /(?:^|\.)google\.[a-z.]+$|^maps\.app\.goo\.gl$|^goo\.gl$/u;
const YANDEX_HOST = /(?:^|\.)yandex\.[a-z.]+$|^ya\.ru$/u;

/** Точка из полной ссылки карты. null — ссылка не карт или без координат. */
export function mapPointFromUrl(raw: string): MapPoint | null {
  const url = safeUrl(raw.trim());
  if (!url || !/^https?:$/u.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  const query = url.searchParams;
  if (YANDEX_HOST.test(host)) {
    return pair(query.get("pt"), "lnglat") ?? pair(query.get("whatshere[point]"), "lnglat") ?? pair(query.get("ll"), "lnglat");
  }
  if (GOOGLE_HOST.test(host)) {
    const text = decodeURIComponent(url.pathname + url.search);
    const pin = new RegExp(`!3d${NUM}!4d${NUM}`).exec(text);
    if (pin) return point(Number(pin[1]), Number(pin[2]));
    for (const key of ["q", "query", "ll", "destination", "center"]) {
      const found = pair(query.get(key), "latlng");
      if (found) return found;
    }
    const at = new RegExp(`/@${NUM},${NUM}`).exec(url.pathname);
    if (at) return point(Number(at[1]), Number(at[2]));
    const place = new RegExp(`/(?:place|search|dir)/${NUM},\\+?${NUM}`).exec(text);
    if (place) return point(Number(place[1]), Number(place[2]));
  }
  return null;
}

/** Короткая ссылка карты, которую надо раскрыть переходом, чтобы узнать точку. */
export function isShortMapLink(raw: string): boolean {
  const url = safeUrl(raw.trim());
  if (!url || url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "maps.app.goo.gl" || (host === "goo.gl" && url.pathname.startsWith("/maps"))
    || (YANDEX_HOST.test(host) && /^\/maps\/-\//u.test(url.pathname));
}

/** Хост, на который вправе вести короткая ссылка карты (защита от перехода куда угодно). */
export function isMapHost(raw: string): boolean {
  const url = safeUrl(raw);
  if (!url || url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return GOOGLE_HOST.test(host) || YANDEX_HOST.test(host);
}

/**
 * Точка из сообщения целиком: «38.5598, 68.7870», «38.5598 68.7870» или одна
 * ссылка карты (можно с подписью вокруг). Без сети; короткую ссылку не раскрывает.
 */
export function parseMapPoint(text: string): MapPoint | null {
  const trimmed = text.trim();
  const plain = new RegExp(`^${NUM}\\s*[,;\\s]\\s*${NUM}$`).exec(trimmed);
  if (plain && plain[1].includes(".") && plain[2].includes(".")) return point(Number(plain[1]), Number(plain[2]));
  const link = /https?:\/\/\S+/u.exec(trimmed)?.[0];
  return link ? mapPointFromUrl(link) : null;
}

/** Первая ссылка в тексте, если это короткая ссылка карты. */
export function shortMapLinkIn(text: string): string | null {
  const link = /https?:\/\/\S+/u.exec(text.trim())?.[0];
  return link && isShortMapLink(link) ? link : null;
}

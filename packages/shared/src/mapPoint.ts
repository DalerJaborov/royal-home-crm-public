/**
 * ТОЧКА ИЗ ТЕКСТА: координаты «38.5598, 68.7870» или ссылка Google/Yandex Maps
 * (10.11.2026, мастер объекта в Telegram — то же, что точка на карте в мастере
 * CRM). Только разбор строки, без сети: короткие ссылки (maps.app.goo.gl,
 * yandex.ru/maps/-/…) раскрывает сервер (apps/api/src/lib/mapLinkResolve.ts),
 * проверяя КАЖДЫЙ шаг перенаправления той же `isMapHost`.
 *
 * Хосты — точный список (не «оканчивается на google.»: `google.evil.com` и
 * `yandex.evil.com` не карты), только https, без порта и без логина в адресе.
 *
 * Порядок координат у Яндекса — долгота, широта (`pt=68.78,38.55`); у Google и
 * в простом тексте — широта, долгота. Перепутанную пару, которая так попадает в
 * Таджикистан, меняем местами. `ll` у Яндекса и `@…` у Google — центр карты, а
 * не метка: берём их последними и помечаем `approximate`.
 */
export interface MapPoint {
  lat: number;
  lng: number;
  /** Точка — центр карты, а не поставленная метка: сотруднику стоит её проверить. */
  approximate?: boolean;
}

const NUM = "(-?\\d{1,3}(?:\\.\\d+)?)";
const TAJIKISTAN = { latMin: 36.6, latMax: 41.1, lngMin: 67.3, lngMax: 75.2 };
const inTajikistan = (lat: number, lng: number) =>
  lat >= TAJIKISTAN.latMin && lat <= TAJIKISTAN.latMax && lng >= TAJIKISTAN.lngMin && lng <= TAJIKISTAN.lngMax;

function point(lat: number, lng: number, approximate = false): MapPoint | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (!inTajikistan(lat, lng) && inTajikistan(lng, lat)) [lat, lng] = [lng, lat];
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return approximate ? { lat, lng, approximate } : { lat, lng };
}

/** Значение параметра адреса уже раскодировано (URLSearchParams) — второй раз не раскодируем. */
function pair(raw: string | null | undefined, order: "latlng" | "lnglat", approximate = false): MapPoint | null {
  const match = raw ? new RegExp(`^\\s*${NUM}\\s*,\\s*${NUM}`).exec(raw) : null;
  if (!match) return null;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return order === "latlng" ? point(a, b, approximate) : point(b, a, approximate);
}

function safeDecode(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

function safeUrl(text: string): URL | null {
  try { return new URL(text); } catch { return null; }
}

const GOOGLE_HOSTS = new Set(["google.com", "www.google.com", "maps.google.com", "maps.app.goo.gl", "goo.gl"]);
const YANDEX_HOSTS = new Set(["yandex.ru", "www.yandex.ru", "yandex.tj", "www.yandex.tj", "yandex.com", "www.yandex.com"]);

/** Адрес карт, по которому можно идти: https, хост из списка, без порта и логина. */
function mapUrl(raw: string): { url: URL; vendor: "google" | "yandex" } | null {
  const url = safeUrl(raw.trim());
  if (!url || url.protocol !== "https:" || url.port || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (GOOGLE_HOSTS.has(host)) return { url, vendor: "google" };
  if (YANDEX_HOSTS.has(host)) return { url, vendor: "yandex" };
  return null;
}

/** Хост, на который вправе вести ссылка карты — проверяется на каждом шаге перенаправления. */
export function isMapHost(raw: string): boolean {
  return mapUrl(raw) !== null;
}

/** Точка из полной ссылки карты. null — ссылка не карт или без координат. */
export function mapPointFromUrl(raw: string): MapPoint | null {
  const parsed = mapUrl(raw);
  if (!parsed) return null;
  const { url, vendor } = parsed;
  const query = url.searchParams;
  if (vendor === "yandex") {
    return pair(query.get("pt"), "lnglat") ?? pair(query.get("whatshere[point]"), "lnglat") ?? pair(query.get("ll"), "lnglat", true);
  }
  const text = safeDecode(url.pathname + url.search);
  const pin = new RegExp(`!3d${NUM}!4d${NUM}`).exec(text);
  if (pin) return point(Number(pin[1]), Number(pin[2]));
  for (const key of ["q", "query", "destination"]) {
    const found = pair(query.get(key), "latlng");
    if (found) return found;
  }
  const place = new RegExp(`/(?:place|search|dir)/${NUM},\\+?${NUM}`).exec(text);
  if (place) return point(Number(place[1]), Number(place[2]));
  const at = new RegExp(`/@${NUM},${NUM}`).exec(url.pathname);
  if (at) return point(Number(at[1]), Number(at[2]), true);
  for (const key of ["ll", "center"]) {
    const found = pair(query.get(key), "latlng", true);
    if (found) return found;
  }
  return null;
}

/** Короткая ссылка карты, которую надо раскрыть переходом, чтобы узнать точку. */
export function isShortMapLink(raw: string): boolean {
  const parsed = mapUrl(raw);
  if (!parsed) return false;
  const host = parsed.url.hostname.toLowerCase();
  return host === "maps.app.goo.gl" || (host === "goo.gl" && parsed.url.pathname.startsWith("/maps"))
    || (parsed.vendor === "yandex" && /^\/maps\/-\//u.test(parsed.url.pathname));
}

/** Первая ссылка в тексте. */
export function firstLinkIn(text: string): string | null {
  return /https?:\/\/\S+/u.exec(text)?.[0] ?? null;
}

/**
 * Точка из сообщения: «38.5598, 68.7870», «38.5598 68.7870» целиком или ссылка
 * карты в тексте. Без сети; короткую ссылку не раскрывает.
 */
export function parseMapPoint(text: string): MapPoint | null {
  const trimmed = text.trim();
  const plain = new RegExp(`^${NUM}\\s*[,;\\s]\\s*${NUM}$`).exec(trimmed);
  if (plain && plain[1].includes(".") && plain[2].includes(".")) return point(Number(plain[1]), Number(plain[2]));
  const link = firstLinkIn(trimmed);
  return link ? mapPointFromUrl(link) : null;
}

/** Первая ссылка в тексте, если это короткая ссылка карты. */
export function shortMapLinkIn(text: string): string | null {
  const link = firstLinkIn(text.trim());
  return link && isShortMapLink(link) ? link : null;
}

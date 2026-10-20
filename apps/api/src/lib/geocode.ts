/**
 * Геокодирование адреса объекта в точные координаты через Nominatim (OpenStreetMap) —
 * бесплатно, без API-ключа, тот же провайдер, что уже используется для карты районов.
 * Nominatim просит не более 1 запроса/сек и обязательный User-Agent с контактом —
 * см. https://operations.osmfoundation.org/policies/nominatim/. Геокодируем только при
 * создании объекта или смене адреса/района, не на каждый показ карты.
 */
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { DUSHANBE_BBOX, isInsideDushanbe } from "./geo.js";
import { normalizeGeoText } from "./geoNormalize.js";
import { resolveBuildingByText } from "./geoResolve.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "RoyalHomeCRM/1.0 (contact: admin@royalhome.tj)";

/** Минимальный интервал между запросами к Nominatim — политика провайдера требует
 *  не больше 1 запроса/сек (см. докстроку файла). 1100 мс — запас поверх секунды.
 *  18.09.2026 (docs/match-geo-analysis-18-09.md п.4.4): очередь джобов исполняет
 *  партию из BATCH_SIZE=10 подряд без паузы (jobs/runner.ts), и при массовом
 *  создании объектов (импорт) это отстреливало до 10 запросов почти одновременно —
 *  риск временного бана по User-Agent/IP. lastCallAt — процессный, не межпроцессный
 *  лимитер: годится, потому что API-сервер один процесс (см. CLAUDE.md). */
const MIN_INTERVAL_MS = 1100;
let lastCallAt = 0;
let throttleChain: Promise<void> = Promise.resolve();

/** Сериализует запросы к Nominatim и выдерживает MIN_INTERVAL_MS между началом
 *  каждого — цепочка промисов вместо мьютекса, чтобы параллельные вызовы
 *  geocodeAddress (например, из батча джобов) не били по API одновременно. */
function throttleNominatim(): Promise<void> {
  const next = throttleChain.then(async () => {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCallAt = Date.now();
  });
  throttleChain = next.catch(() => {});
  return next;
}

export interface GeocodeResult {
  lat: number;
  lng: number;
}

/** Номер дома — последнее слово куска адреса (тот же вид, что HOUSE_NUMBER_RE в
 *  lib/geoResolve.ts: цифры и одна буква литеры). */
const HOUSE_NUMBER_TAIL_RE = /(^| )\d+[a-zа-я]?$/;
/** Куски адреса, которые не улица: «кв. 12», «подъезд 3», «этаж 5», «офис 7». С
 *  ними в окне «улица + номер» номер квартиры приняли бы за номер дома, а «кв» —
 *  за начало названия улицы («квартал …»). */
const NOT_STREET_PART_RE = /^(кв|квартира|подъезд|под|эт|этаж|офис|оф)( |$)/;
/** Предел попыток по справочнику на один адрес — каждая стоит до четырёх
 *  запросов к базе (resolveBuildingByText). */
const MAX_DIRECTORY_ATTEMPTS = 6;

/**
 * Адрес объекта → дом из нашего справочника (24.09.2026, «16 известных поломок
 * карты»). Раньше адрес уходил только в Nominatim, хотя в `Building` у нас
 * больше двадцати тысяч домов Душанбе с улицей и номером — точнее, чем OSM по
 * городу, и без внешнего запроса.
 *
 * Агенты пишут адрес живым языком: «Шохмансур, улица Дехоти, 8», «ул. Рудаки
 * 45, кв. 12». Сопоставление «улица + номер» живёт в одном месте
 * (lib/geoResolve.ts::resolveBuildingByText — им же пользуются бот и
 * подсказка), а здесь только перебираются куски адреса между запятыми: сперва
 * длинные, потом короче — район спереди и квартира сзади отпадают сами.
 */
async function geocodeFromDirectory(address: string): Promise<GeocodeResult | null> {
  const segments = address
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !NOT_STREET_PART_RE.test(normalizeGeoText(part)));
  let attempts = 0;
  for (let end = segments.length; end >= 1; end--) {
    for (let start = 0; start < end; start++) {
      const text = segments.slice(start, end).join(" ");
      const normalized = normalizeGeoText(text);
      // Без номера в конце искать дом нечего; одиночный номер — без улицы.
      if (!HOUSE_NUMBER_TAIL_RE.test(normalized) || !normalized.includes(" ")) continue;
      if (++attempts > MAX_DIRECTORY_ATTEMPTS) return null;
      const building = await resolveBuildingByText(text);
      if (building && isInsideDushanbe(building.lat, building.lng)) return { lat: building.lat, lng: building.lng };
    }
  }
  return null;
}

/** viewbox Nominatim — «лево, верх, право, низ» (долгота, широта). */
const DUSHANBE_VIEWBOX = `${DUSHANBE_BBOX.minLng},${DUSHANBE_BBOX.maxLat},${DUSHANBE_BBOX.maxLng},${DUSHANBE_BBOX.minLat}`;

/**
 * Best-effort по смыслу («адрес не нашёлся» — штатный тихий исход, не блокирует
 * сохранение объекта), но НЕ best-effort по отказам сети/провайдера — те нужно
 * ретраить, не молчать.
 *
 * 18.09.2026 (docs/match-geo-analysis-18-09.md п.4.3): раньше и HTTP-ошибка
 * (403/429/5xx — Nominatim забанил или прилёг), и настоящее «не нашлось» одинаково
 * возвращали `null`. Вызывающий джоб (jobs/geocode.ts) трактует `null` как
 * «нашли ответ — не нашли координат», завершает задание успешно и не идёт по уже
 * готовой лестнице ретраев с бэкоффом — комментарий в том файле прямо обещал
 * ретрай именно для отказа сети, но код на это не давал ни единого шанса.
 *
 * Теперь: сеть/таймаут/не-2xx — бросаем исключение, вызывающий джоб его ловит и
 * ретраит. Пустой список результатов (или нечисловые координаты в ответе) —
 * по-прежнему `null`, ретраить бессмысленно.
 */
export async function geocodeAddress(address: string, districtName: string, city = "Душанбе"): Promise<GeocodeResult | null> {
  // Сперва свой справочник домов: нашёлся дом — Nominatim не нужен вовсе.
  const fromDirectory = await geocodeFromDirectory(address);
  if (fromDirectory) return fromDirectory;

  const query = [address, districtName, city, "Таджикистан"].filter((part) => part && part.trim()).join(", ");
  await throttleNominatim();
  let res: Response;
  try {
    // Только Таджикистан и только рамка Душанбе (24.09.2026): без countrycodes/
    // viewbox/bounded Nominatim отдавал «улицу Рудаки» из Худжанда или Бохтара —
    // точка уезжала в другой город молча, координаты-то «нашлись».
    const url =
      `${NOMINATIM_URL}?format=json&limit=1&countrycodes=tj&viewbox=${DUSHANBE_VIEWBOX}&bounded=1` +
      `&q=${encodeURIComponent(query)}`;
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error(`[geocode] Не удалось геокодировать «${address}»:`, err);
    void logSystemError("geocode", `Не удалось геокодировать «${address}»: ${describeError(err)}`);
    throw err;
  }
  if (!res.ok) {
    // 403/429/5xx — Nominatim нас ограничил, забанил или временно недоступен:
    // это отказ сети, а не «адрес не нашёлся», и заслуживает ретрая с бэкоффом.
    const message = `Nominatim HTTP ${res.status} на «${address}»`;
    void logSystemError("geocode", message);
    throw new Error(message);
  }
  const results = (await res.json()) as { lat: string; lon: string }[];
  if (results.length === 0) return null;
  const lat = Number(results[0].lat);
  const lng = Number(results[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // bounded=1 — просьба, а не гарантия (рамка — прямоугольник, ответ может
  // лечь на её край или прийти от старого зеркала). Точка вне города — не наш
  // объект: лучше честное «не нашлось», чем карточка на чужой улице.
  if (!isInsideDushanbe(lat, lng)) return null;
  return { lat, lng };
}

/**
 * ГЕОМЕТРИЯ: ОДНО ПРАВИЛО — ОДНО МЕСТО.
 *
 * Обе функции ниже были написаны дважды — на сервере и на сайте, — и оба
 * файла честно про это говорили: `apps/web/src/lib/wkt.ts` писал «зеркалит
 * apps/api/src/lib/geo.ts… не импорт (api и web не делят код вне
 * @royal-home/shared)». То есть расхождение видели, но развести его было
 * негде: общего дома у правила не было. Теперь есть.
 *
 * Почему это не «и так одинаково, не трогай». Тексты СЕГОДНЯ совпадают
 * посимвольно, но копия расходится не сразу, а с первой правкой одной из
 * сторон — и расходится молча, потому что каждая сторона остаётся согласна
 * сама с собой (так разошёлся `toTjs`, см. `money.ts` рядом). Цена
 * расхождения здесь высокая:
 *   • `distanceMeters` — на нём стоит правило подбора «радиус 1 км»; разные
 *     метры у сервера и у карты означают, что агент видит на экране не тот
 *     набор объектов, по которому сервер принял решение;
 *   • `parseWktPolygonRing` — порядок точек `[долгота, широта]`; перепутают
 *     одну сторону, и карта нарисует дом в другом месте, чем то, по которому
 *     считался подбор.
 */

/** Одна точка WKT — [долгота, широта], в порядке, как WKT её и хранит (X, Y). */
export type WktRing = [number, number][];

/**
 * Расстояние между двумя точками в метрах (формула гаверсинуса).
 * Земля считается шаром радиусом 6 371 км: на расстояниях города это даёт
 * ошибку меньше половины процента, а правило подбора работает с километром.
 */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Разбор списка точек `lon lat, lon lat, …` в кольцо. */
export function parseWktPointList(raw: string): WktRing {
  return raw
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [lon, lat] = pair.split(/\s+/).map(Number);
      return [lon, lat] as [number, number];
    });
}

/**
 * Достаёт первое (внешнее) кольцо точек из `POLYGON((lon lat, lon lat, ...))`.
 * Дырки полигона (второе и следующие кольца) не нужны ни проверке
 * целостности, ни точке-в-полигоне на этом справочнике — источник их не
 * использует. Возвращает null, если строка не похожа на POLYGON.
 *
 * WKT хранит точки как (долгота широта) — тот же порядок, что у GeoJSON
 * `[lng, lat]`, поэтому переставлять ничего не надо. Leaflet, которому нужны
 * пары `[lat, lng]`, — исключение, и перестановка делается у него на месте.
 */
export function parseWktPolygonRing(wkt: string): WktRing | null {
  const match = /POLYGON\s*\(\(([^)]+)\)/i.exec(wkt);
  if (!match) return null;
  return parseWktPointList(match[1]);
}

/** Bbox Душанбе из плана (раздел «Замер OSM», docs/geo-match-plan-12-09.md).
 *  Одно место для сервера и мастера объекта (02.10.2026): фото, снятое в другом
 *  городе, не должно ставить метку туда. */
export const DUSHANBE_BBOX = { minLat: 38.4, maxLat: 38.7, minLng: 68.6, maxLng: 68.95 };

export function isInsideDushanbe(lat: number, lng: number): boolean {
  return (
    lat >= DUSHANBE_BBOX.minLat &&
    lat <= DUSHANBE_BBOX.maxLat &&
    lng >= DUSHANBE_BBOX.minLng &&
    lng <= DUSHANBE_BBOX.maxLng
  );
}

/**
 * УТИЛИТЫ ГЕО-СПРАВОЧНИКА — разбор WKT и проверка целостности (12.09.2026,
 * docs/geo-match-plan-12-09.md, блок B). Полигонов и линий во всём справочнике
 * 31 штука на границы + около 13 500 контуров домов — PostGIS ради этого не
 * подключаем (владелец, тот же план, «Чего НЕ делать»), точка-в-полигоне и
 * проверка формы WKT считаются здесь, в памяти, обычным JS.
 *
 * Используется скриптом `prisma/scripts/import-geo.ts` (флаг `--check`) и
 * будет использовано блоком D/E плана (подбор и карта) — сама функция
 * точка-в-полигоне уже здесь, чтобы не писать её второй раз тогда.
 */

// Разбор WKT и расстояние живут в общем пакете: те же правила нужны сайту, а
// копия расходится с первой правкой одной из сторон и расходится молча
// (packages/shared/src/geo.ts, правка #752). Здесь они переизлучаются, чтобы
// вызовы `from "./geo.js"` по серверу остались прежними.
import {
  DUSHANBE_BBOX,
  distanceMeters,
  isInsideDushanbe,
  parseWktPointList,
  parseWktPolygonRing,
  type WktRing,
} from "@royal-home/shared";

export { DUSHANBE_BBOX, distanceMeters, isInsideDushanbe, parseWktPolygonRing, type WktRing };

/** Достаёт все линии `MULTILINESTRING((...), (...))` как список колец точек. */
export function parseWktMultiLineStrings(wkt: string): WktRing[] {
  const body = /MULTILINESTRING\s*\((.+)\)\s*$/is.exec(wkt);
  if (!body) return [];
  const lines: WktRing[] = [];
  const re = /\(([^()]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body[1]))) {
    lines.push(parseWktPointList(m[1]));
  }
  return lines;
}

/** Замкнуто ли кольцо (первая точка равна последней) и содержит ли минимум 4
 *  точки — правило простого валидного полигона (3 угла + точка замыкания). */
export function polygonIssues(ring: WktRing): { closed: boolean; enoughPoints: boolean } {
  const enoughPoints = ring.length >= 4;
  if (ring.length < 2) return { closed: false, enoughPoints };
  const [x0, y0] = ring[0];
  const [xn, yn] = ring[ring.length - 1];
  const closed = x0 === xn && y0 === yn;
  return { closed, enoughPoints };
}

/**
 * Точка-в-полигоне, луч по чётности пересечений (ray casting). Для контуров
 * домов и границ районов/микрорайонов этой точности достаточно — им не нужна
 * геодезическая точность PostGIS, только «внутри/снаружи» на масштабе города.
 */
export function isPointInPolygon(lon: number, lat: number, ring: WktRing): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}


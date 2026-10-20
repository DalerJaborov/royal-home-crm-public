/**
 * Расстояние «объект ↔ желаемое место клиента» — ЕДИНАЯ реализация
 * (docs/geo-match-plan-12-09.md, блок D4: тут же уже разъехались площадь и этаж
 * между buildPropertyMatchWhere и clientMatchesProperty — не повторяем ту же
 * ошибку с расстоянием). Используется и прямым подбором (клиент → объекты,
 * lib/propertyMatchFilter.ts), и обратным (объект → кто из клиентов ждёт,
 * routes/matching.ts).
 */
import type { Prisma } from "../generated/prisma/client.js";

const EARTH_RADIUS_M = 6_371_000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Расстояние по гаверсинусу, метры. Точная формула — используется ПОСЛЕ
 *  грубого SQL bbox-предфильтра (см. boundingBoxAround ниже), не вместо него. */
export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface DesiredPlacePoint {
  lat: Prisma.Decimal | number;
  lng: Prisma.Decimal | number;
  radiusM: number;
  label?: string | null;
}

export interface NearestPlaceMatch {
  distanceM: number;
  radiusM: number;
  label: string | null;
  /** Попал ли в радиус ЭТОГО места — с учётом множителя адаптивного расширения. */
  withinRadius: boolean;
}

/**
 * Ближайшее из желаемых мест клиента к точке объекта. Возвращает null, только
 * если список мест пуст — иначе всегда есть «ближайшее», даже если оно вне
 * своего радиуса (withinRadius=false); честная подпись «ближайшее, что есть»
 * в уведомлении строится именно из этого.
 */
export function nearestDesiredPlace(
  propertyLat: number,
  propertyLng: number,
  places: DesiredPlacePoint[],
  radiusMultiplier = 1
): NearestPlaceMatch | null {
  // У каждого места СВОЙ радиус (до пяти мест, радиусы правятся независимо). Ближайшее по
  // расстоянию место с маленьким радиусом не должно перекрывать более дальнее, в чей
  // радиус объект попал: докстрока ниже обещает «хотя бы одна зона» (аудит 04.10.2026,
  // CRM-GEO01). Поэтому из мест, куда объект попал, берём ближайшее; если не попал ни в
  // одно, как и раньше, возвращаем ближайшее вообще с withinRadius=false.
  let best: NearestPlaceMatch | null = null;
  let bestWithin: NearestPlaceMatch | null = null;
  for (const place of places) {
    const distanceM = haversineMeters(propertyLat, propertyLng, Number(place.lat), Number(place.lng));
    const match: NearestPlaceMatch = {
      distanceM,
      radiusM: place.radiusM,
      label: place.label ?? null,
      withinRadius: distanceM <= place.radiusM * radiusMultiplier,
    };
    if (!best || distanceM < best.distanceM) best = match;
    if (match.withinRadius && (!bestWithin || distanceM < bestWithin.distanceM)) bestWithin = match;
  }
  return bestWithin ?? best;
}

/**
 * Попадает ли точка объекта хотя бы в одно из желаемых мест клиента — ПРАВИЛО
 * ПОДБОРА (докстрока владельца, блок C плана): «подходит, если попал хотя бы в
 * одну зону; для балла берётся минимальное расстояние». radiusMultiplier —
 * адаптивное расширение (1 → 2 → 3), см. ADAPTIVE_RADIUS_STEPS.
 */
export function matchesAnyDesiredPlace(
  propertyLat: number,
  propertyLng: number,
  places: DesiredPlacePoint[],
  radiusMultiplier = 1
): NearestPlaceMatch | null {
  const nearest = nearestDesiredPlace(propertyLat, propertyLng, places, radiusMultiplier);
  return nearest?.withinRadius ? nearest : null;
}

/** Человеческое округление: до 50 м ниже километра, до 0,1 км выше — приём
 *  Booking.com («1,2 км до центра»), см. блок E0 плана. */
export function formatDistance(meters: number): string {
  if (meters < 1000) {
    const rounded = Math.max(0, Math.round(meters / 50) * 50);
    return `${rounded} м`;
  }
  const km = Math.round(meters / 100) / 10;
  return `${km.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} км`;
}

/** «Объект в 400 м от ЦУМа» / «ближайшее, что есть: 2,4 км от ЦУМа» — текст для
 *  уведомления (блок E0, D7). withinRadius=false отдельно подписывается как
 *  «ближайшее, что есть», чтобы адаптивно расширенный радиус не выглядел как
 *  точное совпадение. */
export function describeNearestPlace(match: NearestPlaceMatch): string {
  const distance = formatDistance(match.distanceM);
  const place = match.label ? ` от ${match.label}` : "";
  return match.withinRadius ? `${distance}${place}` : `ближайшее, что есть: ${distance}${place}`;
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * Грубый прямоугольник вокруг точки — ТОЛЬКО предфильтр в SQL (D2 плана),
 * точное расстояние досчитывается после выборки гаверсинусом. Формула из
 * плана: по широте radiusM/111320, по долготе radiusM/(111320·cos(lat)).
 */
export function boundingBoxAround(lat: number, lng: number, radiusM: number): BoundingBox {
  const latDelta = radiusM / 111_320;
  const cos = Math.cos(toRad(lat));
  const lngDelta = radiusM / (111_320 * (Math.abs(cos) > 1e-6 ? cos : 1e-6));
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
}

/** Prisma where-фрагмент для координатных полей — одинаковый вид что для
 *  Property.lat/lng, что для ClientDesiredPlace.lat/lng (оба Decimal, оба с
 *  индексом [lat, lng]). */
export function bboxWhere(box: BoundingBox): { gte: number; lte: number }[] {
  return [
    { gte: box.minLat, lte: box.maxLat },
    { gte: box.minLng, lte: box.maxLng },
  ];
}

/** lat/lng-фильтр одной точки (используется как элемент where.OR по нескольким
 *  желаемым местам сразу). */
export function pointBboxWhere(
  lat: number,
  lng: number,
  radiusM: number
): { lat: Prisma.DecimalFilter; lng: Prisma.DecimalFilter } {
  const box = boundingBoxAround(lat, lng, radiusM);
  return {
    lat: { gte: box.minLat, lte: box.maxLat },
    lng: { gte: box.minLng, lte: box.maxLng },
  };
}

/**
 * Потолок радиуса желаемого места (предел формы редактирования клиента, блок C
 * плана: «радиус 100–10 000 м») — используется как ширина SQL bbox-предфильтра
 * в тех запросах, где точный радиус каждого места клиента ещё не загружен на
 * этом шаге (например, счётчик спроса сразу по странице объектов). Предфильтр
 * специально ГРУБЕЕ точной проверки — переселектирует лишнее, но никогда не
 * теряет настоящих кандидатов; точность добирает nearestDesiredPlace в JS.
 */
export const MAX_DESIRED_PLACE_RADIUS_M = 10_000;

/** Шаги адаптивного радиуса (владелец, блок 1 плана, п.5): 1 → 2 → 3, пока не
 *  наберём хотя бы MIN_ADAPTIVE_CANDIDATES кандидатов или не кончатся шаги. */
export const ADAPTIVE_RADIUS_STEPS = [1, 2, 3] as const;
export const MIN_ADAPTIVE_CANDIDATES = 3;

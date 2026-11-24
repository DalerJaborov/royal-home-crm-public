import { boundingBoxAround, type BoundingBox } from "./geoDistance.js";

/**
 * ПОЛОСА «ОТ А ДО Б» — чистая геометрия для поиска объектов между двумя ориентирами
 * (24.11.2026, голосовой запрос владельца: «небольшая квартира от цирка до автоцентра»).
 *
 * Ориентир «около X» — круг вокруг одной точки (lib/searchPlace.ts); «от X до Y» — это полоса
 * вокруг отрезка X–Y: объект подходит, если он не дальше `widthM` от отрезка, а выше в выдаче —
 * тот, что ближе к отрезку. Здесь только расстояния и рамка для SQL; поиск и права — в
 * lib/staffPropertySearch.ts. Расстояния — на плоскости вокруг середины отрезка: на длине
 * города (десятки км) ошибка плоской проекции — доли процента, для полосы в сотни метров неважна.
 */

/** Ширина полосы по умолчанию — в каждую сторону от линии между ориентирами. */
export const CORRIDOR_DEFAULT_WIDTH_M = 800;
export const CORRIDOR_MIN_WIDTH_M = 200;
/** Потолок: шире — это уже не «между», а пол-города. */
export const CORRIDOR_MAX_WIDTH_M = 3_000;

const M_PER_DEG_LAT = 111_320;

export interface GeoPoint {
  lat: number;
  lng: number;
}

export function clampCorridorWidth(widthM: number | undefined): number {
  const raw = widthM !== undefined && Number.isFinite(widthM) ? widthM : CORRIDOR_DEFAULT_WIDTH_M;
  return Math.min(Math.max(Math.round(raw), CORRIDOR_MIN_WIDTH_M), CORRIDOR_MAX_WIDTH_M);
}

/** Расстояние от точки до ОТРЕЗКА a–b (не до прямой): за концами — расстояние до ближайшего конца. */
export function distanceToSegmentM(p: GeoPoint, a: GeoPoint, b: GeoPoint): number {
  const lat0 = (a.lat + b.lat) / 2;
  const kx = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  const ax = (a.lng - p.lng) * kx;
  const ay = (a.lat - p.lat) * ky;
  const bx = (b.lng - p.lng) * kx;
  const by = (b.lat - p.lat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  // Ориентиры в одной точке — обычный круг.
  if (len2 < 1e-6) return Math.hypot(ax, ay);
  // Точка p — начало координат; t — где на отрезке ближайшая к ней точка.
  const t = Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Длина отрезка a–b, метры. */
export function segmentLengthM(a: GeoPoint, b: GeoPoint): number {
  const lat0 = (a.lat + b.lat) / 2;
  return Math.hypot(
    (b.lng - a.lng) * M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180),
    (b.lat - a.lat) * M_PER_DEG_LAT,
  );
}

/** Рамка для SQL: оба конца с запасом в ширину полосы. Точное расстояние — уже по строкам. */
export function corridorBoundingBox(a: GeoPoint, b: GeoPoint, widthM: number): BoundingBox {
  const boxA = boundingBoxAround(a.lat, a.lng, widthM);
  const boxB = boundingBoxAround(b.lat, b.lng, widthM);
  return {
    minLat: Math.min(boxA.minLat, boxB.minLat),
    maxLat: Math.max(boxA.maxLat, boxB.maxLat),
    minLng: Math.min(boxA.minLng, boxB.minLng),
    maxLng: Math.max(boxA.maxLng, boxB.maxLng),
  };
}

const FROM_TO = /^(?:от|с)\s+(.+?)\s+до\s+(.+)$/iu;
const BETWEEN = /^(?:между|байни)\s+(.+?)\s+(?:и|ва)\s+(.+)$/iu;
// Таджикский: «аз цирк то автоцентр», «тарафи цирк то автоцентра». Голое «то» — русское слово,
// поэтому форма требует «аз» или «тарафи» в начале.
const TJ_FROM_TO = /^(?:аз\s+)?(?:тарафи|тарафи\s+аз|сӯи)\s+(.+?)\s+то\s+(.+)$|^аз\s+(.+?)\s+то\s+(.+)$/iu;

/** «от цирка до автоцентра» → два ориентира; не «от … до …» — null (обычный ориентир). */
export function parseCorridorPhrase(text: string | undefined): { from: string; to: string } | null {
  const raw = text?.trim().replace(/\s+/gu, " ");
  if (!raw) return null;
  const m = FROM_TO.exec(raw) ?? BETWEEN.exec(raw);
  if (m) return { from: m[1].trim(), to: m[2].trim() };
  const tj = TJ_FROM_TO.exec(raw);
  if (tj) {
    const from = (tj[1] ?? tj[3] ?? "").trim();
    const to = (tj[2] ?? tj[4] ?? "").trim();
    if (from && to) return { from, to };
  }
  return null;
}

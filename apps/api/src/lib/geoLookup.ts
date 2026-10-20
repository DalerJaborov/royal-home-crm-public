/**
 * АВТОЗАПОЛНЕНИЕ АДРЕСА ПО ТОЧКЕ (12.09.2026, docs/geo-match-plan-12-09.md,
 * блок H): координата (из фото/геолокации/булавки, блок A0) → дом, улица,
 * номер, микрорайон, жилой массив, район — без участия человека. Это тот
 * модуль, который позже позовёт мастер объекта (шаг «Где»), и роут
 * `GET /api/v1/geo/lookup` ниже отдаёт то же самое через HTTP.
 *
 * PostGIS НЕ подключаем (план, «Чего НЕ делать» — полигонов всего 31 плюс
 * ~13 500 контуров домов, точка-в-полигоне дешевле считать в памяти, чем
 * держать расширение ради этого объёма). Предфильтр по прямоугольнику через
 * индекс `[lat, lng]` (`Building.@@index([lat, lng])`), затем точка-в-полигоне
 * в памяти — тот же приём и те же функции, что и у `prisma/scripts/import-geo.ts
 * --check` (`lib/geo.ts`).
 *
 * ПОРЯДОК (план, блок H):
 *   1. точка внутри контура дома (`Building.outline`, WKT) — есть у 13 501 из
 *      24 325 домов;
 *   2. не попала ни в один контур (или у дома контура вовсе нет) — ближайший
 *      дом в радиусе 30 м;
 *   3. дома нет вовсе — ближайшие улица и микрорайон/жилой массив;
 *   4. район — ВСЕГДА по полигону (`District.boundary`), независимо от того,
 *      нашёлся дом или нет (план: «район всегда по полигону, агент его не
 *      выбирает»).
 */
import { prisma } from "../db.js";
import { parseWktPolygonRing, isPointInPolygon, distanceMeters } from "./geo.js";

/** Насколько уверенно определилось место — план, блок H: «в контуре / рядом /
 *  только район». */
export type GeoLookupConfidence = "contour" | "nearby" | "district_only";

export interface GeoLookupResult {
  /** Дом, если удалось определить (по контуру или по близости). `lat/lng` —
   *  точка ВНУТРИ дома (туда мастер переносит метку, поставленную по фото мимо
   *  дома), `distanceM` — сколько метров от точки до стены (0 — точка в доме). */
  building: { id: string; lat: number; lng: number; distanceM: number } | null;
  street: string | null;
  houseNumber: string | null;
  microdistrict: string | null;
  livingArea: string | null;
  district: { id: string; name: string } | null;
  floors: number | null;
  entrances: number | null;
  confidence: GeoLookupConfidence;
}

/** Метров в градусе широты — константа для перевода метрового радиуса в
 *  прямоугольник над индексом `[lat, lng]`; для долготы поправка на cos(lat),
 *  город целиком лежит около 38.5° с.ш., где 1° долготы ≈ 87 км. */
const METERS_PER_DEGREE_LAT = 111_000;

function latMarginDegrees(meters: number): number {
  return meters / METERS_PER_DEGREE_LAT;
}
function lngMarginDegrees(meters: number, atLat: number): number {
  return meters / (METERS_PER_DEGREE_LAT * Math.cos((atLat * Math.PI) / 180));
}

/** Запас прямоугольника под контур дома: точка внутри контура не дальше от
 *  центра дома, чем самый дальний угол контура, а это до 296 м (замер
 *  23.09.2026 по `.data-geo/дома.json`: медиана 17 м, 99% — до 90 м).
 *
 *  Было 500 м при пределе 200 кандидатов без порядка. В центре в такой
 *  прямоугольник попадает до 839 домов с контуром — дом, на который нажали,
 *  часто просто не доезжал до проверки, и ответ уходил на «ближайший дом в
 *  30 м», то есть соседний. Это и была жалоба владельца 14.09 («в одном доме
 *  несколько адресов»), из-за которой справочник отключили у клика по карте. */
const CONTOUR_BBOX_MARGIN_M = 300;
/** Предел кандидатов под контур: в прямоугольнике ±300 м замерено до 449
 *  домов с контуром — предел с двойным запасом, чтобы нужный дом не отрезался. */
const CONTOUR_CANDIDATE_LIMIT = 1000;
/** Шаг 2 плана: «не в контуре — ближайший дом в радиусе 30 м». */
const NEAREST_BUILDING_RADIUS_M = 30;
/** Растущий радиус поиска ближайшей улицы, когда дома нет вовсе — тот же
 *  приём адаптивного радиуса, что и у подбора (план, «Принципы», п.5): не
 *  молчим, если рядом пусто, а честно расширяем поиск. */
const NEAREST_STREET_RADII_M = [500, 1500, 3000, 6000];
/** Потолок «ближайшего» жилого массива без границы — у большинства записей
 *  (104 из 117) границы нет, и без потолка «ближайший» на разреженной окраине
 *  мог бы оказаться в нескольких километрах и вводить в заблуждение. */
const NEAREST_LIVING_AREA_LIMIT_M = 1500;
/** Предел выборки кандидатов в прямоугольнике — правило репозитория: у
 *  любого запроса, отдающего массив, есть предел. На масштабе города и этих
 *  радиусов реальных кандидатов на порядок меньше. */
const CANDIDATE_LIMIT = 200;

interface BuildingCandidate {
  id: string;
  street: string | null;
  houseNumber: string;
  microdistrict: string | null;
  livingArea: string | null;
  lat: unknown;
  lng: unknown;
  floors: number | null;
  entrances: number | null;
  outline: string | null;
}

/**
 * Расстояние от точки до контура дома в метрах: 0 — точка внутри, иначе до
 * ближайшей стены (28.09.2026). Прежде «ближайший дом» мерился до ЦЕНТРА дома:
 * точка по фото, упавшая на тротуар или дорогу перед длинной девятиэтажкой, была
 * в 20 м от стены, но в 50 м от центра — и дом не находился вовсе, номер не
 * выходил (владелец: «поставил меня на дороге… и не выходит номер дома»).
 * Плоская проекция около точки — на десятках метров ошибка ничтожна.
 */
function distanceToRingMeters(lat: number, lng: number, ring: readonly (readonly [number, number])[]): number {
  if (isPointInPolygon(lng, lat, ring as [number, number][])) return 0;
  const kx = METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
  const ky = METERS_PER_DEGREE_LAT;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    const x1 = (ax - lng) * kx;
    const y1 = (ay - lat) * ky;
    const x2 = (bx - lng) * kx;
    const y2 = (by - lat) * ky;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / len2)) : 0;
    const px = x1 + t * dx;
    const py = y1 + t * dy;
    best = Math.min(best, Math.hypot(px, py));
  }
  return best;
}

/** Точка внутри дома: центр из справочника, если он в контуре (у Г- и
 *  П-образных домов центр бывает во дворе), иначе середина самой длинной
 *  диагонали из вершин контура, лежащая внутри; нет контура — центр как есть. */
function buildingPoint(b: BuildingCandidate): { lat: number; lng: number } {
  const center = { lat: Number(b.lat), lng: Number(b.lng) };
  const ring = b.outline ? parseWktPolygonRing(b.outline) : null;
  if (!ring || ring.length < 3 || isPointInPolygon(center.lng, center.lat, ring)) return center;
  let best: { lat: number; lng: number; len: number } | null = null;
  for (let i = 0; i < ring.length; i++) {
    for (let j = i + 2; j < ring.length; j++) {
      const mid = { lng: (ring[i][0] + ring[j][0]) / 2, lat: (ring[i][1] + ring[j][1]) / 2 };
      if (!isPointInPolygon(mid.lng, mid.lat, ring)) continue;
      const len = Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
      if (!best || len > best.len) best = { ...mid, len };
    }
  }
  return best ? { lat: best.lat, lng: best.lng } : center;
}

/** Шаг 1: дом, чей контур содержит точку, — а если такого нет, дом с контуром,
 *  до стены которого не дальше NEAREST_BUILDING_RADIUS_M (тем же списком
 *  кандидатов, без второго запроса). */
async function findBuildingByContour(
  lat: number,
  lng: number
): Promise<{ inside: BuildingCandidate | null; nearest: { building: BuildingCandidate; distanceM: number } | null }> {
  const latMargin = latMarginDegrees(CONTOUR_BBOX_MARGIN_M);
  const lngMargin = lngMarginDegrees(CONTOUR_BBOX_MARGIN_M, lat);
  const candidates = await prisma.building.findMany({
    where: {
      outline: { not: null },
      lat: { gte: lat - latMargin, lte: lat + latMargin },
      lng: { gte: lng - lngMargin, lte: lng + lngMargin },
    },
    select: {
      id: true,
      street: true,
      houseNumber: true,
      microdistrict: true,
      livingArea: true,
      lat: true,
      lng: true,
      floors: true,
      entrances: true,
      outline: true,
    },
    take: CONTOUR_CANDIDATE_LIMIT,
  });
  let nearest: { building: BuildingCandidate; distanceM: number } | null = null;
  // Контуры бывают общими: у 3 460 из 13 501 домов справочника контур в точности
  // совпадает с соседним (секции одного дома). «Первый попавшийся» без порядка
  // отдавал чужой номер (аудит 02.10.2026) — из всех домов, чей контур содержит
  // точку, берём тот, чей центр ближе, при равенстве — меньший id (стабильно).
  let inside: { building: BuildingCandidate; centreM: number } | null = null;
  for (const b of candidates) {
    if (!b.outline) continue;
    const ring = parseWktPolygonRing(b.outline);
    if (!ring) continue;
    const distanceM = distanceToRingMeters(lat, lng, ring);
    if (distanceM === 0) {
      const centreM = distanceMeters(lat, lng, Number(b.lat), Number(b.lng));
      if (!inside || centreM < inside.centreM || (centreM === inside.centreM && b.id < inside.building.id)) {
        inside = { building: b, centreM };
      }
      continue;
    }
    if (distanceM <= NEAREST_BUILDING_RADIUS_M && (!nearest || distanceM < nearest.distanceM)) {
      nearest = { building: b, distanceM };
    }
  }
  if (inside) return { inside: inside.building, nearest: null };
  return { inside: null, nearest };
}

/** Шаг 2: ближайший дом БЕЗ контура (таких 10 824 из 24 325) — по центру в
 *  пределах NEAREST_BUILDING_RADIUS_M; дома с контуром меряются до стены в шаге 1. */
async function findNearestBuilding(lat: number, lng: number): Promise<{ building: BuildingCandidate; distanceM: number } | null> {
  const latMargin = latMarginDegrees(NEAREST_BUILDING_RADIUS_M * 3);
  const lngMargin = lngMarginDegrees(NEAREST_BUILDING_RADIUS_M * 3, lat);
  const candidates = await prisma.building.findMany({
    where: {
      outline: null,
      lat: { gte: lat - latMargin, lte: lat + latMargin },
      lng: { gte: lng - lngMargin, lte: lng + lngMargin },
    },
    select: {
      id: true,
      street: true,
      houseNumber: true,
      microdistrict: true,
      livingArea: true,
      lat: true,
      lng: true,
      floors: true,
      entrances: true,
      outline: true,
    },
    take: CANDIDATE_LIMIT,
  });
  let best: BuildingCandidate | null = null;
  let bestDist = Infinity;
  for (const b of candidates) {
    const d = distanceMeters(lat, lng, Number(b.lat), Number(b.lng));
    if (d <= NEAREST_BUILDING_RADIUS_M && d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best ? { building: best, distanceM: bestDist } : null;
}

/** Улица справочника, загруженная заранее, — для вызывающих, которые ищут
 *  ближайшую улицу для многих точек подряд (карта объектов, 24.09.2026):
 *  920 строк один раз вместо до четырёх запросов на каждую точку. */
export interface StreetPoint {
  name: string;
  lat: number;
  lng: number;
}

export async function loadStreetPoints(): Promise<StreetPoint[]> {
  const rows = await prisma.street.findMany({ select: { name: true, lat: true, lng: true } });
  return rows.map((r) => ({ name: r.name, lat: Number(r.lat), lng: Number(r.lng) }));
}

/** Шаг 3а: ближайшая улица по центру (Street.lat/lng) — линию геометрии
 *  (есть только у 346 из 920) для этой оценки не используем, расстояние до
 *  центра улицы достаточно точно на масштабе «дома нет вовсе». Экспортирована
 *  — тот же приём зовёт `lib/landmarkPick.ts` как запасной третий уровень
 *  описания места (нет ориентира — хотя бы улица, не голое название района),
 *  копии этого запроса быть не должно (CLAUDE.md, класс дефектов «копия
 *  логики вместо самой логики»). */
export async function findNearestStreetName(
  lat: number,
  lng: number,
  streets?: readonly StreetPoint[]
): Promise<string | null> {
  for (const radiusM of NEAREST_STREET_RADII_M) {
    const latMargin = latMarginDegrees(radiusM);
    const lngMargin = lngMarginDegrees(radiusM, lat);
    // Справочник улиц уже в памяти (карта объектов описывает сотни точек за
    // один запрос, 24.09.2026) — тот же прямоугольник и тот же предел, только
    // без похода в базу на каждый радиус каждой точки.
    const candidates: { name: string; lat: unknown; lng: unknown }[] = streets
      ? streets
          .filter(
            (s) =>
              s.lat >= lat - latMargin && s.lat <= lat + latMargin && s.lng >= lng - lngMargin && s.lng <= lng + lngMargin
          )
          .slice(0, CANDIDATE_LIMIT)
      : await prisma.street.findMany({
          where: { lat: { gte: lat - latMargin, lte: lat + latMargin }, lng: { gte: lng - lngMargin, lte: lng + lngMargin } },
          select: { name: true, lat: true, lng: true },
          take: CANDIDATE_LIMIT,
        });
    let best: string | null = null;
    let bestDist = Infinity;
    for (const s of candidates) {
      const d = distanceMeters(lat, lng, Number(s.lat), Number(s.lng));
      if (d < bestDist) {
        bestDist = d;
        best = s.name;
      }
    }
    if (best) return best;
  }
  return null;
}

/** Микрорайон — сперва по контуру (у всех 27 записей источника есть граница,
 *  цикл по 27 полигонам дёшев), иначе ближайший по центру без потолка радиуса
 *  (27 микрорайонов покрывают почти всю застроенную территорию города). */
async function findMicrodistrictName(lat: number, lng: number): Promise<string | null> {
  const all = await prisma.microdistrict.findMany({ select: { name: true, lat: true, lng: true, boundary: true } });
  for (const m of all) {
    const ring = parseWktPolygonRing(m.boundary);
    if (ring && isPointInPolygon(lng, lat, ring)) return m.name;
  }
  let best: string | null = null;
  let bestDist = Infinity;
  for (const m of all) {
    const d = distanceMeters(lat, lng, Number(m.lat), Number(m.lng));
    if (d < bestDist) {
      bestDist = d;
      best = m.name;
    }
  }
  return best;
}

/** Жилой массив — тот же приём, что у микрорайона, но граница есть только у
 *  13 из 117 записей; без границы «ближайший» ограничен NEAREST_LIVING_AREA_LIMIT_M,
 *  иначе на окраине им стал бы жилой массив за несколько километров. */
async function findLivingAreaName(lat: number, lng: number): Promise<string | null> {
  const all = await prisma.livingArea.findMany({ select: { name: true, lat: true, lng: true, boundary: true } });
  for (const l of all) {
    if (!l.boundary) continue;
    const ring = parseWktPolygonRing(l.boundary);
    if (ring && isPointInPolygon(lng, lat, ring)) return l.name;
  }
  let best: string | null = null;
  let bestDist = Infinity;
  for (const l of all) {
    const d = distanceMeters(lat, lng, Number(l.lat), Number(l.lng));
    if (d < bestDist && d <= NEAREST_LIVING_AREA_LIMIT_M) {
      bestDist = d;
      best = l.name;
    }
  }
  return best;
}

/** Район — ВСЕГДА по полигону, независимо от того, нашёлся дом или нет
 *  (план, блок H). Районов 4 — цикл по всем дёшев. Точка вне всех границ
 *  (окраина города/погрешность) — не молчим, отдаём ближайший центр района. */
async function findDistrict(lat: number, lng: number): Promise<{ id: string; name: string } | null> {
  const all = await prisma.district.findMany({ select: { id: true, name: true, lat: true, lng: true, boundary: true } });
  for (const d of all) {
    if (!d.boundary) continue;
    const ring = parseWktPolygonRing(d.boundary);
    if (ring && isPointInPolygon(lng, lat, ring)) return { id: d.id, name: d.name };
  }
  let best: { id: string; name: string } | null = null;
  let bestDist = Infinity;
  for (const d of all) {
    if (d.lat == null || d.lng == null) continue;
    const dist = distanceMeters(lat, lng, Number(d.lat), Number(d.lng));
    if (dist < bestDist) {
      bestDist = dist;
      best = { id: d.id, name: d.name };
    }
  }
  return best;
}

/**
 * ТОЧКА — НА ДОМ (28.09.2026, владелец: «по EXIF на пару метров в дорогу ввёл,
 * и не выходит номер дома, потому что метка не на доме»). Точка, поставленная
 * НЕ рукой (снимок, геопозиция телефона), в доме не лежит почти никогда: GPS в
 * помещении уходит на 10–30 м, чаще всего на улицу. Если справочник нашёл дом
 * рядом (`nearby`, до стены не дальше NEAREST_BUILDING_RADIUS_M), точка
 * переносится внутрь этого дома; дальше — остаётся как есть. Точку, которую
 * агент поставил сам, не двигаем никогда — это решает вызывающий.
 */
export function snapToBuilding(point: { lat: number; lng: number }, geo: GeoLookupResult): { lat: number; lng: number } {
  if (geo.confidence !== "nearby" || !geo.building) return point;
  return { lat: geo.building.lat, lng: geo.building.lng };
}

/**
 * Координата → место. Единая точка входа: и `GET /api/v1/geo/lookup`, и
 * будущий шаг «Где» мастера объекта обязаны звать эту функцию, а не заводить
 * свой разбор точки — иначе они разъедутся молча, ровно как площадь/этаж уже
 * разъехались в двух копиях фильтра подбора (план, раздел D4).
 */
export async function lookupGeoPoint(lat: number, lng: number): Promise<GeoLookupResult> {
  const [byContour, district] = await Promise.all([findBuildingByContour(lat, lng), findDistrict(lat, lng)]);

  let building = byContour.inside;
  let confidence: GeoLookupConfidence = "contour";
  let distanceM = 0;
  if (!building) {
    const withoutOutline = await findNearestBuilding(lat, lng);
    const near = [byContour.nearest, withoutOutline]
      .filter((c): c is { building: BuildingCandidate; distanceM: number } => c !== null)
      .sort((a, b) => a.distanceM - b.distanceM)[0];
    building = near?.building ?? null;
    distanceM = near?.distanceM ?? 0;
    confidence = building ? "nearby" : "district_only";
  }

  if (building) {
    return {
      building: { id: building.id, ...buildingPoint(building), distanceM: Math.round(distanceM) },
      street: building.street,
      houseNumber: building.houseNumber,
      microdistrict: building.microdistrict,
      livingArea: building.livingArea,
      district,
      floors: building.floors,
      entrances: building.entrances,
      confidence,
    };
  }

  const [street, microdistrict, livingArea] = await Promise.all([
    findNearestStreetName(lat, lng),
    findMicrodistrictName(lat, lng),
    findLivingAreaName(lat, lng),
  ]);

  return {
    building: null,
    street,
    houseNumber: null,
    microdistrict,
    livingArea,
    district,
    floors: null,
    entrances: null,
    confidence: "district_only",
  };
}

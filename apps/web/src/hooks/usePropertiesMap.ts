import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { ApiError } from "../lib/apiError";

/**
 * Карта объектов (12.09.2026, docs/geo-match-plan-12-09.md, блок N) — своя лёгкая
 * выдача GET /properties/map (apps/api/src/routes/properties/map.ts), НЕ каталог:
 * там `pageSize = 20`, карте нужны все подходящие объекты разом. Типы здесь —
 * зеркало интерфейсов ответа роута (тот же приём, что у PropertiesSummary в
 * useProperties.ts — сервер и клиент не делят один файл типов ради этого).
 */
export interface MapProperty {
  id: string;
  shortId: number;
  title: string;
  lat: number | null;
  lng: number | null;
  price: number;
  currency: string;
  pricePerSqmTjs: number | null;
  rooms: number | null;
  buildingId: string | null;
  clusterId: string;
  clusterName: string;
  /** Кто принял объект — для «свои видны отличимо даже в режиме "Все"». */
  intakeAgentId: string | null;
  /** Готовая строка «Сино, 400 м от ЦУМа» — считает lib/landmarkPick.ts на
   *  сервере, здесь только показывается, второй раз не считается. */
  placeDescription: string;
  /** Обложка объекта (первое фото по порядку) — null у объекта без фото. */
  coverPhotoUrl: string | null;
}

export interface MapCluster {
  id: string;
  kind: "microdistrict" | "district";
  name: string;
  lat: number;
  lng: number;
  count: number;
  minPrice: number;
  avgPricePerSqm: number | null;
}

export interface MapBuilding {
  id: string;
  lat: number;
  lng: number;
  outline: string;
  /** Этажность — высота 3D-заливки (этажи × 3 м), null = дом плоским контуром. */
  floors: number | null;
  count: number;
  avgPricePerSqm: number | null;
}

export interface PropertiesMapResponse {
  properties: MapProperty[];
  clusters: MapCluster[];
  buildings: MapBuilding[];
  priceScale: { low: number; high: number } | null;
  bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number } | null;
  total: number;
  /** Объекты выдачи без точки — на карте их нет и в кластеры они не входят. */
  withoutPoint: number;
}

export interface PropertiesMapFilters {
  type?: string;
  districtId?: string;
  districtIds?: string[];
  priceMin?: number;
  priceMax?: number;
  rooms?: number;
  areaMin?: number;
  areaMax?: number;
  status?: string;
  agentId?: string;
}

function toQuery(filters: PropertiesMapFilters) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (Array.isArray(v)) {
      if (v.length > 0) params.set(k, v.join(","));
      return;
    }
    if (v !== undefined && v !== "" && v !== null) params.set(k, String(v));
  });
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function usePropertiesMap(filters: PropertiesMapFilters = {}) {
  return useQuery({
    queryKey: ["properties", "map", filters],
    queryFn: () => api<PropertiesMapResponse>(`/properties/map${toQuery(filters)}`),
    // Курс валюты и объекты не меняются каждую секунду — не дёргаем сервер лишний
    // раз при простом масштабировании/панорамировании карты (это чисто клиентское
    // действие, весь набор объектов уже на руках).
    staleTime: 60_000,
    /**
     * СТАРЫЕ ДАННЫЕ ОСТАЮТСЯ НА ВРЕМЯ ПЕРЕЗАПРОСА — иначе карта умирает целиком.
     *
     * Экран рисует холст условно: `{data && <PropertyMapExplorer …/>}`
     * (pages/PropertiesMap.tsx). При переключении «Все / Мои» меняется ключ
     * запроса, `data` на миг становится undefined — и MapLibre-карта
     * размонтируется со всем состоянием: ручка управления обнуляется, кадр
     * сбрасывается, а следующий стартовый показ снова разлетается на весь
     * город. Выбор подсказки адреса в это окно уходил в никуда.
     *
     * Показывать прошлый набор, пока едет новый, честно: он был верным секунду
     * назад, и это ровно то, что человек видит в любой карте при смене фильтра.
     */
    placeholderData: (prev: PropertiesMapResponse | undefined) => prev,
  });
}

/** Место по слову — «ЦУМ», «82 мкр», «Рудаки» — через lib/geoResolve.ts (блок B,
 *  ветка feat/geo-autofill-12-09), роут apps/api/src/routes/geo.ts. Не useQuery:
 *  поиск разовый по вводу человека, а не фоновые данные экрана, кэшировать нечего. */
export interface GeoResolveCandidate {
  targetType: "building" | "street" | "microdistrict" | "livingArea" | "landmark" | "district";
  targetId: string;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
  precision: "fullName" | "synonym" | "prefix" | "fuzzy";
}

export interface GeoResolveResult extends GeoResolveCandidate {
  confidence: "exact" | "prefix" | "fuzzy";
  /** До 4 следующих по рангу вариантов — «вы про проспект Рудаки или про
   *  3-й проезд?» — поиск на карте обязан их показывать, не только лучший. */
  alternatives: GeoResolveCandidate[];
}

export async function resolveGeoPlace(q: string): Promise<GeoResolveResult | null> {
  const { result } = await api<{ result: GeoResolveResult | null }>(`/geo/resolve?q=${encodeURIComponent(q)}`);
  return result;
}

/** Живые подсказки при вводе — GET /geo/suggest (apps/api/src/lib/geoSuggest.ts,
 *  план 12.09, блок H — построен тогда же, что и /resolve, но фронт его до
 *  14.09 не звал: поиск на карте ждал полного слова и нажатия «Найти», без
 *  выпадающего списка «как в топовых картах» (владелец 14.09.2026). */
export interface GeoSuggestPlace {
  kind: "place";
  targetType: "building" | "street" | "microdistrict" | "livingArea" | "landmark" | "district";
  targetId: string;
  label: string;
  lat: number;
  lng: number;
}

export interface GeoSuggestBuilding {
  kind: "building";
  buildingId: string;
  label: string;
  lat: number;
  lng: number;
}

export type GeoSuggestItem = GeoSuggestPlace | GeoSuggestBuilding;

export async function suggestGeoAddress(q: string, limit = 6): Promise<GeoSuggestItem[]> {
  const { items } = await api<{ items: GeoSuggestItem[] }>(`/geo/suggest?q=${encodeURIComponent(q)}&limit=${limit}`);
  return items;
}

/**
 * Точка объекта по номеру (05.10.2026): «ОБ-000088», «№88», «88» в строке поиска
 * карты — это объект, а не адрес. `GET /properties/:shortId` номер понимает;
 * notFound (нет объекта или нет доступа) — повод продолжить обычным геопоиском,
 * noPoint — объект есть, но координат у него нет.
 */
export type PropertyPointResult =
  | { kind: "point"; lat: number; lng: number }
  | { kind: "noPoint" }
  | { kind: "notFound" };

export async function resolvePropertyPoint(shortId: number): Promise<PropertyPointResult> {
  try {
    const p = await api<{ lat: string | null; lng: string | null }>(`/properties/${shortId}`);
    const lat = p.lat == null ? NaN : Number(p.lat);
    const lng = p.lng == null ? NaN : Number(p.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { kind: "point", lat, lng } : { kind: "noPoint" };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return { kind: "notFound" };
    throw err;
  }
}

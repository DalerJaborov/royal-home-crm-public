import type { Feature, FeatureCollection, Point, Polygon } from "geojson";
import { parseWktPolygonRing } from "./wkt";
import { priceTier } from "./themeMapColors";
import type { MapBuilding, MapCluster, MapProperty } from "../hooks/usePropertiesMap";

/** Высота 3D-заливки дома, метры на этаж — актуально только пока в базе
 *  известна этажность (Building.floors); наклон камеры убран 14.09.2026
 *  (владелец: «никакого эффекта нет, лучше убрать») — без наклона высота
 *  визуально не отличима от 0 в любом случае, но поле оставлено честным. */
const METERS_PER_FLOOR = 3;
/** Дом без известной этажности (89% контуров) рисуется плоским — не гадаем
 *  про высоту там, где справочник её не знает. */
const DEFAULT_FLOORS_HEIGHT = 0;

export function propertiesToGeoJson(
  properties: MapProperty[],
  priceScale: { low: number; high: number } | null
): FeatureCollection<Point> {
  const features: Feature<Point>[] = properties
    .filter((p): p is MapProperty & { lat: number; lng: number } => p.lat != null && p.lng != null)
    .map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      properties: {
        id: p.id,
        shortId: p.shortId,
        title: p.title,
        price: p.price,
        currency: p.currency,
        pricePerSqmTjs: p.pricePerSqmTjs,
        tier: priceTier(p.pricePerSqmTjs, priceScale),
        buildingId: p.buildingId ?? "",
        clusterId: p.clusterId,
        intakeAgentId: p.intakeAgentId ?? "",
      },
    }));
  return { type: "FeatureCollection", features };
}

export function clustersToGeoJson(clusters: MapCluster[]): FeatureCollection<Point> {
  const features: Feature<Point>[] = clusters.map((c) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [c.lng, c.lat] },
    properties: {
      id: c.id,
      // Подпись словами, а не значком (правило 4 облика): «82-й мкр · 14
      // объектов · от 58 000». Саму строку собирает `clusterLabel` — её же
      // берёт DOM-плашка на карте (PropertyMapExplorer), чтобы подпись в
      // GeoJSON и подпись на холсте не могли разойтись.
      label: clusterLabel(c),
      count: c.count,
    },
  }));
  return { type: "FeatureCollection", features };
}

export function buildingsToGeoJson(
  buildings: MapBuilding[],
  priceScale: { low: number; high: number } | null
): FeatureCollection<Polygon> {
  const features: Feature<Polygon>[] = [];
  for (const b of buildings) {
    const ring = parseWktPolygonRing(b.outline);
    if (!ring) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: {
        id: b.id,
        tier: priceTier(b.avgPricePerSqm, priceScale),
        height: b.floors ? b.floors * METERS_PER_FLOOR : DEFAULT_FLOORS_HEIGHT,
        count: b.count,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/** «82-й мкр · 14 объектов · от 58 000» — одна строка подписи кластера. */
export function clusterLabel(c: MapCluster): string {
  return `${c.name} · ${c.count} ${pluralizeObjects(c.count)} · от ${formatShort(c.minPrice)}`;
}

/**
 * Текст плашки кластера НА САМОЙ КАРТЕ — коротко (21.09.2026).
 *
 * Владелец: «на карте слишком длинные названия адресов, а должно быть как у
 * Airbnb — маленькие цветные плашки с ценой». `clusterLabel` несёт три факта
 * («Сино · 143 объекта · от 58 000»), и на телефоне такая плашка шире четверти
 * экрана: десяток плашек закрывает саму карту, ради которой экран открыт.
 *
 * Здесь остаются два числа: сколько объектов и от какой цены. Название района
 * не потеряно — его печатает подложка под плашкой, а полная строка приходит
 * подсказкой (`title`) при наведении и остаётся в GeoJSON.
 */
export function clusterPlaque(c: MapCluster): string {
  return `${c.count} · от ${priceLabel(c.minPrice, "TJS")}`;
}

/**
 * Подпись ценовой плашки: цена округлённо, в тысячах. Цифры, а не иконка
 * (правило 4), но без хвоста — на карте её читают мельком.
 *
 * ВАЛЮТА НА ПЛАШКЕ ОБЯЗАТЕЛЬНА (24.09.2026). Раньше число делилось на тысячу
 * без оглядки на валюту: квартира за $85 000 и квартира за 850 000 сомони
 * стояли рядом как «85 т.» и «850 т.» — вторая выглядела вдесятеро дороже,
 * хотя по курсу они почти равны. Теперь плашка объекта — в СВОЕЙ валюте
 * объекта, со знаком: «$85 т.» / «850 т. с.» — та же пара знаков, что у
 * `formatMoney` в карточках списка, так что плашка и карточка говорят одно.
 * Плашка кластера («от …») остаётся в сомони — сервер считает `minPrice` в
 * сомони по курсу, иначе минимум по району из двух валют не сравнить, — и
 * тоже несёт «с.», чтобы сомони не читались долларами.
 *
 * До тысячи — число целиком (иначе «0 т.»), от миллиона — «1,2 млн».
 */
export function priceLabel(price: number, currency: string = "TJS"): string {
  const short = shortAmount(price);
  return currency === "USD" ? `$${short}` : `${short} с.`;
}

function shortAmount(amount: number): string {
  const n = Math.round(amount);
  if (Math.abs(n) >= 1_000_000) {
    const millions = Math.round(n / 100_000) / 10;
    return `${millions.toLocaleString("ru-RU")} млн`;
  }
  if (Math.abs(n) >= 1000) return `${Math.round(n / 1000)} т.`;
  return String(n);
}

function pluralizeObjects(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "объект";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "объекта";
  return "объектов";
}

/** «от 58 000» — целые тысячи сомони, без копеек: подпись кластера, не
 *  денежный документ, точность до сомони здесь не нужна. */
function formatShort(amount: number): string {
  return Math.round(amount).toLocaleString("ru-RU");
}

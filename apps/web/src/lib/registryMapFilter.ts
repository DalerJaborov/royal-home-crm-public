import { REGISTRY_COLOR_LABEL, type RegistryColor, type RegistryMapResponse } from "@royal-home/shared";
import type { MapBuilding, MapCluster, MapProperty, PropertiesMapResponse } from "../hooks/usePropertiesMap";

/**
 * Фильтр «Разрешение» на карте объектов (реестр строек, 20.11.2026).
 * Работает по связи объекта с проектом реестра (`propertyColors` из GET /construction-registry/map):
 * у объекта без связи цвета нет, поэтому при включённом фильтре он скрывается. Слой самого реестра
 * фильтруется тем же цветом. Существующий ответ /properties/map не меняется: здесь лишь копия набора.
 */
export type PermitFilter = "all" | RegistryColor;

export const PERMIT_FILTER_OPTIONS: { id: PermitFilter; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "green", label: "Есть" },
  { id: "yellow", label: "В согласовании" },
  { id: "red", label: "Нет" },
];

/** Подпись цвета для метки и попапа — те же слова, что в карточке объекта. */
export function registryColorTitle(color: RegistryColor): string {
  return REGISTRY_COLOR_LABEL[color].title;
}

type RegistryProject = RegistryMapResponse["projects"][number];

/** Жилые проекты реестра под фильтром; образовательные на карте не показываем. */
export function registryProjectsForMap(projects: readonly RegistryProject[], filter: PermitFilter): RegistryProject[] {
  return projects.filter((p) => p.category === "residential" && (filter === "all" || p.color === filter));
}

function priceTjs(p: MapProperty, usdRate: number): number {
  return p.currency === "USD" ? p.price * usdRate : p.price;
}

/**
 * Набор карты под фильтром: оставляет объекты с нужным цветом связи и пересобирает кластеры и дома,
 * чтобы плашки не врали («от …» и число объектов считаются по оставшимся). `all` возвращает набор как есть.
 */
export function applyPermitFilter(
  data: PropertiesMapResponse,
  propertyColors: Readonly<Record<string, RegistryColor>>,
  filter: PermitFilter,
  usdRate: number,
): PropertiesMapResponse {
  if (filter === "all") return data;
  const properties = data.properties.filter((p) => propertyColors[p.id] === filter);

  const byCluster = new Map<string, MapProperty[]>();
  for (const p of properties) byCluster.set(p.clusterId, [...(byCluster.get(p.clusterId) ?? []), p]);
  const clusters: MapCluster[] = [];
  for (const c of data.clusters) {
    const list = byCluster.get(c.id);
    if (!list || list.length === 0) continue;
    const ppsqm = list.map((p) => p.pricePerSqmTjs).filter((v): v is number => v != null);
    clusters.push({
      ...c,
      count: list.length,
      minPrice: Math.min(...list.map((p) => priceTjs(p, usdRate))),
      avgPricePerSqm: ppsqm.length > 0 ? Math.round(ppsqm.reduce((a, b) => a + b, 0) / ppsqm.length) : null,
    });
  }

  const byBuilding = new Map<string, MapProperty[]>();
  for (const p of properties) if (p.buildingId) byBuilding.set(p.buildingId, [...(byBuilding.get(p.buildingId) ?? []), p]);
  const buildings: MapBuilding[] = [];
  for (const b of data.buildings) {
    const list = byBuilding.get(b.id);
    if (!list || list.length === 0) continue;
    const ppsqm = list.map((p) => p.pricePerSqmTjs).filter((v): v is number => v != null);
    buildings.push({
      ...b,
      count: list.length,
      avgPricePerSqm: ppsqm.length > 0 ? Math.round(ppsqm.reduce((a, c) => a + c, 0) / ppsqm.length) : null,
    });
  }

  return { ...data, properties, clusters, buildings, total: properties.length };
}

/**
 * ЧИСТКА КУПЛЕННОГО СЛОЯ ОРИЕНТИРОВ (28.11.2026, владелец: «800 ориентиров, дубли Hyatt ×3, мусор I, HS, 1, 25»).
 *
 * Ничего не удаляется: лишнее СКРЫВАЕТСЯ флагом `enabled=false` (как и раньше, блок J: импорт запись из слоя
 * воскресил бы, а скрытую не трогает). Правила чистые, без базы — их проверяет landmark-cleanup.test.ts.
 */
import { geoMatchKey } from "./geoNormalize.js";
import { isGenericLandmarkName, landmarkNamesLookAlike } from "./landmarkDedup.js";

export interface CleanupRow {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
  lat: number;
  lng: number;
  mentions: number;
  weight: number;
  aliasCount: number;
  hasDistrict: boolean;
  isCityCenter: boolean;
}

/** Мусор: в названии меньше трёх букв («I», «HS», «1», «25», «№5»). Это не название места. */
export function isJunkLandmarkName(name: string): boolean {
  const letters = (name.match(/\p{L}/gu) ?? []).length;
  return letters < 3;
}

/** Можно ли чистке трогать запись: только купленный слой, включённый, ни разу не названный клиентом,
 *  без своих синонимов (синоним — след человека, такая запись не мусор), не центр города. */
export function isCleanable(r: CleanupRow): boolean {
  return r.source === "import" && r.enabled && r.mentions === 0 && r.aliasCount === 0 && !r.isCityCenter;
}

export function junkIds(rows: CleanupRow[]): string[] {
  return rows.filter((r) => isCleanable(r) && isJunkLandmarkName(r.name)).map((r) => r.id);
}

function metersBetween(a: CleanupRow, b: CleanupRow): number {
  const R = 6371000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Кто «главный» из двойников: названный клиентами, с синонимами, важный, с районом; дальше — по id (стабильно). */
function score(r: CleanupRow): number {
  return r.mentions * 1000 + r.aliasCount * 100 + r.weight + (r.hasDistrict ? 5 : 0) + (r.source === "agent" ? 10000 : 0);
}

export interface DuplicateGroup {
  keepId: string;
  hideIds: string[];
}

/** Один и тот же объект под одним названием («Hyatt Regency» ×3): то же имя (после нормализации, с теми же цифрами),
 *  не «общее слово» вроде «Школа» и не дальше `radiusM` метров от главного. Мусор и центры не трогаем. */
export function findDuplicateGroups(rows: CleanupRow[], radiusM = 700): DuplicateGroup[] {
  const byKey = new Map<string, CleanupRow[]>();
  for (const r of rows) {
    if (!r.enabled || isJunkLandmarkName(r.name) || isGenericLandmarkName(r.name)) continue;
    const key = geoMatchKey(r.name.trim());
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const groups: DuplicateGroup[] = [];
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    const ordered = [...list].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
    const used = new Set<string>();
    for (const keeper of ordered) {
      if (used.has(keeper.id)) continue;
      const hide = ordered.filter(
        (o) =>
          o.id !== keeper.id &&
          !used.has(o.id) &&
          isCleanable(o) &&
          landmarkNamesLookAlike(key, geoMatchKey(o.name.trim())) &&
          metersBetween(keeper, o) <= radiusM,
      );
      used.add(keeper.id);
      hide.forEach((h) => used.add(h.id));
      if (hide.length > 0) groups.push({ keepId: keeper.id, hideIds: hide.map((h) => h.id) });
    }
  }
  return groups;
}

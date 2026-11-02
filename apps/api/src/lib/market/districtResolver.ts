/**
 * РАЙОН ПО КООРДИНАТАМ для источников, которые район не называют (Paydo: адрес пуст,
 * координаты есть). Без района объявление не попадёт в выборку «Сино, 3-комнатные».
 *
 * Сначала точка-в-полигоне по границе района из справочника (District.boundary),
 * если границы нет — ближайший район по его центру (District.lat/lng) в пределах
 * MAX_NEAREST_M. Не нашли — null: лучше пропустить объявление, чем записать не тот район.
 */

import { prisma } from "../../db.js";
import { distanceMeters, isPointInPolygon, parseWktPolygonRing, type WktRing } from "../geo.js";

const MAX_NEAREST_M = 6000;
const CACHE_MS = 10 * 60_000;

interface DistrictGeo {
  name: string;
  ring: WktRing | null;
  lat: number | null;
  lng: number | null;
}

let cache: { at: number; items: DistrictGeo[] } | null = null;

async function loadDistricts(): Promise<DistrictGeo[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.items;
  const rows = await prisma.district.findMany({ where: { city: "Душанбе" }, select: { name: true, boundary: true, lat: true, lng: true } });
  const items = rows.map((r) => {
    let ring: WktRing | null = null;
    try {
      ring = r.boundary ? parseWktPolygonRing(r.boundary) : null;
    } catch {
      ring = null;
    }
    return { name: r.name, ring, lat: r.lat != null ? Number(r.lat) : null, lng: r.lng != null ? Number(r.lng) : null };
  });
  cache = { at: Date.now(), items };
  return items;
}

/** Чистая часть (для тестов): выбрать район по точке из готового списка. */
export function pickDistrict(items: DistrictGeo[], lat: number, lng: number): string | null {
  for (const d of items) if (d.ring && isPointInPolygon(lng, lat, d.ring)) return d.name;
  let best: { name: string; m: number } | null = null;
  for (const d of items) {
    if (d.lat == null || d.lng == null) continue;
    const m = distanceMeters(lat, lng, d.lat, d.lng);
    if (m <= MAX_NEAREST_M && (!best || m < best.m)) best = { name: d.name, m };
  }
  return best?.name ?? null;
}

export async function resolveDistrictByPoint(lat: number | null | undefined, lng: number | null | undefined): Promise<string | null> {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return pickDistrict(await loadDistricts(), lat, lng);
}

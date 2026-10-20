/**
 * ПОДСКАЗКА АДРЕСА ПРИ ВВОДЕ ТЕКСТОМ (12.09.2026, docs/geo-match-plan-12-09.md,
 * блок H): «поверх geoResolve и поиска по домам (улица + номер)» — план прямо
 * называет оба источника, эта функция их просто объединяет, не заводя
 * третьего разбора текста.
 *
 * Два источника, оба с пределом выдачи (правило репозитория — у любого
 * запроса, отдающего массив, есть предел):
 *   1. справочник (район/микрорайон/ориентир/улица/жилой массив) — через
 *      `GeoAlias.normalized`, тот же `normalizeGeoText`, что и `geoResolve.ts`,
 *      `contains` вместо `startsWith`: подсказка при вводе не обязана начинаться
 *      с начала слова («мкр 82» находит и «82-й микрорайон»);
 *   2. дома — «улица [номер]», через `toSearchTokens` (lib/searchTokens.ts) —
 *      тот же токенизатор, что у обычного поиска объектов/клиентов, а не
 *      свой разбор строки.
 */
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { normalizeGeoText, plainStreetQuery } from "./geoNormalize.js";
import { toSearchTokens } from "./searchTokens.js";
import { loadGeoPlace, type GeoTargetType } from "./geoResolve.js";

export interface GeoSuggestPlace {
  kind: "place";
  targetType: GeoTargetType;
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

export const SUGGEST_DEFAULT_LIMIT = 8;
/** Жёсткий потолок — параметр `limit` из запроса выше этого не поднимет. */
export const SUGGEST_MAX_LIMIT = 20;

/** С каким запасом тянуть строки словаря синонимов перед дедупом по цели —
 *  несколько алиасов одной цели схлопнутся в одну подсказку. */
const ALIAS_FETCH_MULTIPLIER = 3;

async function suggestPlaces(normalized: string, limit: number): Promise<GeoSuggestPlace[]> {
  const aliasRows = await prisma.geoAlias.findMany({
    where: { normalized: { contains: normalized } },
    orderBy: { normalized: "asc" },
    select: { targetType: true, targetId: true },
    take: limit * ALIAS_FETCH_MULTIPLIER,
  });

  const seen = new Set<string>();
  const out: GeoSuggestPlace[] = [];
  for (const row of aliasRows) {
    const key = `${row.targetType}:${row.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const place = await loadGeoPlace(row.targetType, row.targetId);
    if (!place) continue;
    out.push({
      kind: "place",
      targetType: row.targetType as GeoTargetType,
      targetId: row.targetId,
      label: place.name,
      lat: place.lat,
      lng: place.lng,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** «Рудаки 45», «Рудаки, 45», «пр рудаки 45» → улица «рудаки», номер «45».
 *  Номер — последний токен, если он похож на номер дома (цифры и не более
 *  4 хвостовых букв — «12а», «7/2»). */
function splitStreetAndHouseNumber(query: string): { streetPart: string; houseNumber: string | null } {
  const trimmed = query.trim();
  const m = /^(.*?)[,\s]+(\d+[а-яa-z/\-]{0,4})$/iu.exec(trimmed);
  if (m && m[1].trim()) return { streetPart: m[1].trim(), houseNumber: m[2].trim() };
  return { streetPart: trimmed, houseNumber: null };
}

async function suggestBuildings(rawQuery: string, limit: number): Promise<GeoSuggestBuilding[]> {
  const { streetPart, houseNumber } = splitStreetAndHouseNumber(rawQuery);
  // Дома записаны с русским видом улицы («улица Дехоти»): таджикский вид и
  // таджикские буквы запроса сводятся, иначе «кучаи» не найдётся ни в одном доме.
  const tokens = toSearchTokens(plainStreetQuery(normalizeGeoText(streetPart)));
  if (tokens.length === 0) return [];

  const conditions: Prisma.BuildingWhereInput[] = tokens.map((t) => ({
    street: { contains: t, mode: "insensitive" },
  }));
  const where: Prisma.BuildingWhereInput = { street: { not: null }, AND: conditions };
  if (houseNumber) where.houseNumber = { startsWith: houseNumber, mode: "insensitive" };

  const rows = await prisma.building.findMany({
    where,
    select: { id: true, street: true, houseNumber: true, lat: true, lng: true },
    take: limit,
  });
  return rows.map((b) => ({
    kind: "building" as const,
    buildingId: b.id,
    label: `${b.street}, ${b.houseNumber}`,
    lat: Number(b.lat),
    lng: Number(b.lng),
  }));
}

/**
 * Подсказка по тексту — справочник (места) + дома (улица+номер), объединённые
 * и обрезанные общим пределом. `limit` зажимается в `[1, SUGGEST_MAX_LIMIT]`.
 */
export async function suggestGeoAddress(rawQuery: string, limit = SUGGEST_DEFAULT_LIMIT): Promise<GeoSuggestItem[]> {
  const cappedLimit = Math.min(Math.max(1, Math.trunc(limit)), SUGGEST_MAX_LIMIT);
  const normalized = normalizeGeoText(rawQuery);
  if (!normalized) return [];

  // «кучаи Дехоти», «Рӯдакӣ 45» — второй заход без таджикского написания
  // (plainStreetQuery, geoNormalize.ts); повтор той же цели не дублируется.
  const plain = plainStreetQuery(normalized);
  const [places, plainPlaces, buildings] = await Promise.all([
    suggestPlaces(normalized, cappedLimit),
    plain && plain !== normalized ? suggestPlaces(plain, cappedLimit) : Promise.resolve([]),
    suggestBuildings(rawQuery, cappedLimit),
  ]);
  const seen = new Set(places.map((p) => `${p.targetType}:${p.targetId}`));
  const extra = plainPlaces.filter((p) => !seen.has(`${p.targetType}:${p.targetId}`));

  return [...places, ...extra, ...buildings].slice(0, cappedLimit);
}

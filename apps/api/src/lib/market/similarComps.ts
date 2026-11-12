/**
 * ПОДБОР ПОХОЖИХ ОБЪЯВЛЕНИЙ ДЛЯ КАРТОЧКИ ОБЪЕКТА (владелец 02.11.2026).
 *
 * Агент должен сразу видеть: цена владельца в рынке или нет. Для этого медиана
 * считается не «по району», а по ПОХОЖИМ объявлениям: район, комнаты, площадь,
 * ремонт, признак дома. Если похожих мало — лестница расширяется (сначала
 * отпускаем ремонт, потом признак дома, потом площадь), а если и тогда меньше
 * MIN_SAMPLE — честно «данных мало», без числа (правила comps.ts).
 *
 * Цены в объявлениях — не цены сделок: это сказано в основании выборки.
 */

import { prisma } from "../../db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { MARKET_REPAIR_LABEL } from "@royal-home/shared";
import { MIN_SAMPLE, VERDICT_THRESHOLD_PERCENT } from "./comps.js";

export type Repair = "SHELL" | "WHITE" | "PARTIAL" | "RENOVATED" | "DESIGNER";

/** Подписи ремонта — общие с экраном цен по сегментам (packages/shared). */
export const REPAIR_LABEL: Record<Repair, string> = MARKET_REPAIR_LABEL;

export interface Subject {
  propertyType: "APARTMENT" | "HOUSE";
  city?: string;
  districtName: string | null;
  rooms: number | null;
  areaSqm: number;
  floor: number | null;
  totalFloors: number | null;
  repair: Repair | null;
  /** Современный дом («новостройка» в РТ — признак дома). null — неизвестно, не фильтруем. */
  isNewBuilding: boolean | null;
}

export interface SimilarListing {
  sourceUrl: string;
  source: string;
  title: string;
  rooms: number | null;
  areaSqm: number | null;
  floor: number | null;
  totalFloors: number | null;
  repair: string | null;
  isNewBuilding: boolean | null;
  buildingReady: boolean | null;
  districtName: string | null;
  priceTjs: number | null;
  pricePerSqmTjs: number | null;
}

export interface SimilarResult {
  status: "ok" | "insufficient";
  medianPerSqm: number | null;
  p25PerSqm: number | null;
  p75PerSqm: number | null;
  estimatedPriceTjs: number | null;
  rangeLowTjs: number | null;
  rangeHighTjs: number | null;
  /** Число УНИКАЛЬНЫХ объявлений: один объект на двух площадках считается раз. */
  sampleSize: number;
  /** Сколько дублей между площадками склеено (в основании не участвуют). */
  mergedDuplicates: number;
  windowDays: number;
  basis: string;
  level: string;
  sources: { source: string; count: number }[];
  listings: SimilarListing[];
  moreCount: number;
}

/** Объявление, которого не видели 45 дней, — уже не рынок. */
export const WINDOW_DAYS = 45;
const MAX_AGE_YEARS = 2;
/** Предел на ОДНУ ступень после фильтра в запросе; порядок по свежести, не по цене — медиану не сдвигает. */
const FETCH_LIMIT = 2000;
const TOP_LISTINGS = 5;

/** Строка выборки: SimilarListing с гарантированной ценой за м². */
export type SimilarRow = SimilarListing;

export interface Rung {
  name: string;
  keepRepair: boolean;
  keepBuilding: boolean;
  /** Строки без указанного признака дома (Somon его не отдаёт) считаются подходящими. */
  unknownBuildingOk?: boolean;
  keepArea: boolean;
  keepRooms: boolean;
}

export const APARTMENT_RUNGS: Rung[] = [
  { name: "exact", keepRepair: true, keepBuilding: true, keepArea: true, keepRooms: true },
  { name: "no_repair", keepRepair: false, keepBuilding: true, keepArea: true, keepRooms: true },
  { name: "no_repair_unknown_building", keepRepair: false, keepBuilding: true, unknownBuildingOk: true, keepArea: true, keepRooms: true },
  { name: "no_building", keepRepair: false, keepBuilding: false, keepArea: true, keepRooms: true },
  { name: "no_area", keepRepair: false, keepBuilding: false, keepArea: false, keepRooms: true },
];

/** У домов комнатность ничего не значит (участок и постройка гуляют): держим район и площадь. */
export const HOUSE_RUNGS: Rung[] = [{ name: "house_area", keepRepair: false, keepBuilding: false, keepArea: true, keepRooms: false }];

/**
 * ОДИН ОБЪЕКТ НА ДВУХ ПЛОЩАДКАХ — ОДНО ОБЪЯВЛЕНИЕ. Агент выставляет квартиру и на Somon,
 * и на Paydo: без склейки выборка из пяти квартир выглядит как десять и проходит порог
 * MIN_SAMPLE. Допуски те же узкие, что в listingDedupe.ts (±3 м², ±5% цены): это разные
 * записи ОДНОГО объекта, а не «похожие квартиры». Склеиваем только РАЗНЫЕ площадки —
 * два объявления одной площадки имеют свои id, и две одинаковые квартиры в одном доме
 * там бывают на самом деле. «Неизвестно» в пользу склейки не засчитывается.
 */
export interface DedupeRow {
  source: string;
  districtName?: string | null;
  rooms?: number | null;
  areaSqm?: number | null;
  priceTjs?: number | null;
  floor?: number | null;
}

const DUP_AREA_SQM = 3;
const DUP_PRICE_SHARE = 0.05;

export function isCrossSourceDuplicate(a: DedupeRow, b: DedupeRow): boolean {
  if (a.source === b.source) return false;
  if (a.districtName == null || a.districtName !== b.districtName) return false;
  if ((a.rooms ?? null) !== (b.rooms ?? null)) return false;
  if (a.areaSqm == null || b.areaSqm == null || Math.abs(a.areaSqm - b.areaSqm) > DUP_AREA_SQM) return false;
  if (!a.priceTjs || !b.priceTjs || a.priceTjs <= 0 || b.priceTjs <= 0) return false;
  if (Math.abs(a.priceTjs - b.priceTjs) / Math.max(a.priceTjs, b.priceTjs) > DUP_PRICE_SHARE) return false;
  if (a.floor != null && b.floor != null && a.floor !== b.floor) return false;
  return true;
}

/** Склеивает дубли между площадками; из пары остаётся ПЕРВОЕ в порядке входа (вызывающий ставит ближайшие первыми). */
export function dedupeAcrossSources<T extends DedupeRow>(rows: T[]): T[] {
  const kept: T[] = [];
  const byDistrict = new Map<string, T[]>();
  for (const row of rows) {
    if (row.districtName == null) {
      kept.push(row);
      continue;
    }
    const bucket = byDistrict.get(row.districtName) ?? [];
    if (bucket.some((k) => isCrossSourceDuplicate(k, row))) continue;
    bucket.push(row);
    byDistrict.set(row.districtName, bucket);
    kept.push(row);
  }
  return kept;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function areaBand(subject: Subject): [number, number] {
  const k = subject.propertyType === "HOUSE" ? 0.3 : 0.15;
  return [subject.areaSqm * (1 - k), subject.areaSqm * (1 + k)];
}

function matches(row: SimilarRow, subject: Subject, rung: Rung): boolean {
  if (rung.keepRooms && subject.rooms && row.rooms !== subject.rooms) return false;
  if (rung.keepArea) {
    const [lo, hi] = areaBand(subject);
    if (row.areaSqm == null || row.areaSqm < lo || row.areaSqm > hi) return false;
  }
  if (rung.keepRepair && subject.repair && row.repair !== subject.repair) return false;
  if (rung.keepBuilding && subject.isNewBuilding != null && row.isNewBuilding !== subject.isNewBuilding) {
    if (!(rung.unknownBuildingOk && row.isNewBuilding == null)) return false;
  }
  return true;
}

/** Чем меньше, тем объявление ближе к объекту: площадь, ремонт, дом, этаж. */
export function dissimilarity(row: SimilarRow, subject: Subject): number {
  let d = row.areaSqm != null ? Math.abs(row.areaSqm - subject.areaSqm) / subject.areaSqm : 0.5;
  if (subject.repair && row.repair !== subject.repair) d += 0.3;
  if (subject.isNewBuilding != null && row.isNewBuilding !== subject.isNewBuilding) d += 0.3;
  if (subject.floor != null && row.floor != null) d += Math.min(Math.abs(row.floor - subject.floor), 10) * 0.01;
  return d;
}

function describe(subject: Subject, rung: Rung, sampleSize: number, merged: number): string {
  const parts: string[] = [subject.districtName ?? "весь город"];
  if (rung.keepRooms && subject.rooms) parts.push(`${subject.rooms}-комнатные`);
  if (rung.keepArea) {
    const [lo, hi] = areaBand(subject);
    parts.push(`${Math.round(lo)}–${Math.round(hi)} м²`);
  }
  if (rung.keepRepair && subject.repair) parts.push(REPAIR_LABEL[subject.repair]);
  if (rung.keepBuilding && subject.isNewBuilding != null) parts.push(subject.isNewBuilding ? "новостройка" : "старый фонд");
  if (rung.unknownBuildingOk) parts.push("включая объявления без указанного типа дома");
  const dup = merged > 0 ? ` (дубли между площадками склеены: ${merged})` : "";
  return `медиана по ${sampleSize} уникальным объявлениям${dup}: ${parts.join(", ")}`;
}

export function emptyResult(basis: string): SimilarResult {
  return {
    status: "insufficient",
    medianPerSqm: null,
    p25PerSqm: null,
    p75PerSqm: null,
    estimatedPriceTjs: null,
    rangeLowTjs: null,
    rangeHighTjs: null,
    sampleSize: 0,
    mergedDuplicates: 0,
    windowDays: WINDOW_DAYS,
    basis,
    level: "none",
    sources: [],
    listings: [],
    moreCount: 0,
  };
}

const INSUFFICIENT_BASIS = "данных для честной оценки мало — похожих объявлений на рынке почти нет";

/** Одна ступень лестницы: фильтр, склейка дублей, порог, расчёт. null — ступень не набрала выборку. */
function evaluateRung(rows: SimilarRow[], subject: Subject, rung: Rung): SimilarResult | null {
  const filtered = rows
    .filter((r) => r.pricePerSqmTjs != null && matches(r, subject, rung))
    .map((r) => ({ r, d: dissimilarity(r, subject) }))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.r);
  // Ближайшие к объекту идут первыми: из пары дублей остаётся более похожая.
  const sample = dedupeAcrossSources(filtered);
  if (sample.length < MIN_SAMPLE) return null;

  // На ступени без площади объект обязан попадать в основной диапазон выборки:
  // дворец в 400 м² нельзя оценивать по типовым двушкам (разбор в comps.ts).
  if (!rung.keepArea) {
    const areas = sample.map((r) => r.areaSqm).filter((v): v is number => v != null).sort((a, b) => a - b);
    if (areas.length >= MIN_SAMPLE && (subject.areaSqm < percentile(areas, 0.1) || subject.areaSqm > percentile(areas, 0.9))) return null;
  }

  const values = sample.map((r) => r.pricePerSqmTjs as number).sort((a, b) => a - b);
  const median = Math.round(percentile(values, 0.5));
  const p25 = Math.round(percentile(values, 0.25));
  const p75 = Math.round(percentile(values, 0.75));
  const merged = filtered.length - sample.length;

  const bySource = new Map<string, number>();
  for (const r of sample) bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);

  return {
    status: "ok",
    medianPerSqm: median,
    p25PerSqm: p25,
    p75PerSqm: p75,
    estimatedPriceTjs: Math.round(median * subject.areaSqm),
    rangeLowTjs: Math.round(p25 * subject.areaSqm),
    rangeHighTjs: Math.round(p75 * subject.areaSqm),
    sampleSize: sample.length,
    mergedDuplicates: merged,
    windowDays: WINDOW_DAYS,
    basis: describe(subject, rung, sample.length, merged),
    level: rung.name,
    sources: [...bySource].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    listings: sample.slice(0, TOP_LISTINGS),
    moreCount: Math.max(0, sample.length - TOP_LISTINGS),
  };
}

function ladder(subject: Subject): Rung[] {
  return subject.propertyType === "HOUSE" ? HOUSE_RUNGS : APARTMENT_RUNGS;
}

/** Чистая часть: выбрать ступень и посчитать. Отдельно от БД — тестируется без неё. */
export function pickSimilar(rows: SimilarRow[], subject: Subject): SimilarResult {
  for (const rung of ladder(subject)) {
    const result = evaluateRung(rows, subject, rung);
    if (result) return result;
  }
  return emptyResult(INSUFFICIENT_BASIS);
}

/**
 * Вердикт по объекту: порог ±VERDICT_THRESHOLD_PERCENT к середине рынка. Единственное место
 * вердикта (одна дверь). Решает ОКРУГЛЁННАЯ разница — ту же цифру агент видит в подписи,
 * иначе «+10%» рядом со словом «выше» выглядит ошибкой.
 */
export function verdictFor(
  askingTjs: number | null,
  estimatedTjs: number | null
): { verdict: "below" | "market" | "above" | "unknown"; diffPercent: number | null } {
  if (!askingTjs || !estimatedTjs) return { verdict: "unknown", diffPercent: null };
  const raw = ((askingTjs - estimatedTjs) * 100) / estimatedTjs;
  // Math.round(-10.5) = -10, а Math.round(10.5) = 11: округляем по модулю, чтобы граница была симметричной.
  const diff = Math.sign(raw) * Math.round(Math.abs(raw)) + 0;
  const verdict = diff < -VERDICT_THRESHOLD_PERCENT ? "below" : diff > VERDICT_THRESHOLD_PERCENT ? "above" : "market";
  return { verdict, diffPercent: diff };
}

/** Фильтры ступени в запросе: иначе обрезка по свежести выбросит нужную группу ещё до фильтра. */
export function rungWhere(subject: Subject, rung: Rung): Prisma.MarketListingWhereInput[] {
  const and: Prisma.MarketListingWhereInput[] = [];
  if (rung.keepRooms && subject.rooms) and.push({ rooms: subject.rooms });
  if (rung.keepArea) {
    const [lo, hi] = areaBand(subject);
    and.push({ areaSqm: { gte: lo, lte: hi } });
  }
  if (rung.keepRepair && subject.repair) and.push({ repair: subject.repair });
  if (rung.keepBuilding && subject.isNewBuilding != null) {
    and.push(
      rung.unknownBuildingOk
        ? { OR: [{ isNewBuilding: subject.isNewBuilding }, { isNewBuilding: null }] }
        : { isNewBuilding: subject.isNewBuilding }
    );
  }
  return and;
}

export interface FindSimilarOptions {
  /** Наш объект: объявления, найденные/подтверждённые как ЕГО, из выборки исключаются (тянут середину к нашей цене). */
  propertyId?: string;
}

/** id объявлений рынка, которые являются нашим объектом (CONFIRMED и CANDIDATE; DISMISSED — чужое). */
export async function ownListingIds(propertyId: string | undefined): Promise<string[]> {
  if (!propertyId) return [];
  const rows = await prisma.propertyMarketMatch.findMany({
    where: { propertyId, status: { in: ["CONFIRMED", "CANDIDATE"] } },
    select: { listingId: true },
  });
  return rows.map((r) => r.listingId);
}

export async function findSimilar(subject: Subject, options: FindSimilarOptions = {}): Promise<SimilarResult> {
  const city = subject.city ?? "Душанбе";
  const freshSince = new Date(Date.now() - WINDOW_DAYS * 24 * 3600_000);
  const oldest = new Date(Date.now() - MAX_AGE_YEARS * 365 * 24 * 3600_000);
  const own = await ownListingIds(options.propertyId);

  for (const rung of ladder(subject)) {
    const rows = await prisma.marketListing.findMany({
      where: {
        dealType: "SALE",
        propertyType: subject.propertyType,
        city,
        isActive: true,
        lastSeenAt: { gte: freshSince },
        pricePerSqmTjs: { not: null },
        ...(own.length ? { id: { notIn: own } } : {}),
        ...(subject.districtName ? { districtName: subject.districtName } : {}),
        AND: [{ OR: [{ publishedAt: null }, { publishedAt: { gte: oldest } }] }, ...rungWhere(subject, rung)],
      },
      select: {
        sourceUrl: true, source: true, title: true, rooms: true, areaSqm: true, floor: true, totalFloors: true,
        repair: true, isNewBuilding: true, buildingReady: true, districtName: true, priceTjs: true, pricePerSqmTjs: true,
      },
      // Свежие первыми: обрезка по цене сдвинула бы медиану.
      orderBy: { lastSeenAt: "desc" },
      take: FETCH_LIMIT,
    });
    const result = evaluateRung(
      rows.map((r) => ({
        ...r,
        areaSqm: r.areaSqm != null ? Number(r.areaSqm) : null,
        priceTjs: r.priceTjs != null ? Number(r.priceTjs) : null,
        pricePerSqmTjs: r.pricePerSqmTjs != null ? Number(r.pricePerSqmTjs) : null,
      })),
      subject,
      rung
    );
    if (result) return result;
  }
  return emptyResult(INSUFFICIENT_BASIS);
}

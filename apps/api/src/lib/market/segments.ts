/**
 * ЦЕНЫ ПО СЕГМЕНТАМ РЫНКА (10.11.2026): район × комнаты × ремонт, по активным объявлениям.
 *
 * Правила те же, что у comps.ts / similarComps.ts, и берутся оттуда, а не пишутся заново:
 *  · порог MIN_SAMPLE (8) — сегмент меньше него отдаётся БЕЗ чисел, с признаком enough=false;
 *  · выбросы (цена ниже порога или цена за м² вне 500–100 000) отсекаются (plausible.ts); «среднее» —
 *    усечённое, без 10% дешёвых и 10% дорогих с краёв;
 *  · медиана (не только среднее): одно объявление-выброс не должно двигать «типичную» цену;
 *  · один объект (на двух площадках или выложенный дважды) — одно объявление (dedupeListings), иначе пять квартир
 *    выглядят как десять и проходят порог;
 *  · объявления — не цены сделок (подпись на экране).
 *
 * Выборка ОДНИМ запросом с пределом (SEGMENTS_FETCH_LIMIT, свежие первыми), счёт — в памяти:
 * N+1 нет. В сегмент попадают объявления с известными районом и числом комнат: без них ячейку
 * таблицы не построить. Ремонт «не указан» — отдельная строка, а не «любой».
 */

import {
  MARKET_SEGMENT_REPAIRS,
  type MarketSegmentRepair,
  type MarketSegmentsQuery,
  type MarketSegmentsResponse,
  type MarketSegmentStat,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { MIN_SAMPLE } from "./comps.js";
import { isPlausibleSale, plausibleSaleWhere, trimmedMean } from "./plausible.js";
import { dedupeListings, WINDOW_DAYS } from "./similarComps.js";
import { marketCatalogWhere } from "./somonRubrics.js";

/** Предел выборки на запрос: каталог Душанбе — тысячи объявлений, не сотни тысяч. */
export const SEGMENTS_FETCH_LIMIT = 20_000;
const MAX_AGE_YEARS = 2;
const DAY_MS = 24 * 3600_000;

export interface SegmentRow {
  source: string;
  districtName: string;
  rooms: number;
  repair: string | null;
  areaSqm: number | null;
  priceTjs: number;
  pricePerSqmTjs: number | null;
  floor: number | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Продавец на площадке: повтор одной площадки склеивается, только если продавец тот же (или неизвестен). */
  sellerId?: string | null;
}

export function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = (sorted.length - 1) / 2;
  const lo = Math.floor(mid);
  const hi = Math.ceil(mid);
  return lo === hi ? sorted[lo] : (sorted[lo] + sorted[hi]) / 2;
}

function asRepair(value: string | null): MarketSegmentRepair | null {
  return (MARKET_SEGMENT_REPAIRS as readonly string[]).includes(value ?? "") ? (value as MarketSegmentRepair) : null;
}

/** Чистая часть: сегменты из строк. Без БД — тестируется отдельно. */
export function buildSegments(rows: SegmentRow[], now = Date.now()): MarketSegmentStat[] {
  const groups = new Map<string, SegmentRow[]>();
  for (const r of rows) {
    // Страховка: выбросы отсекает и запрос (plausibleSaleWhere), но чистая функция не должна на это полагаться.
    if (!isPlausibleSale(r, "APARTMENT")) continue;
    const key = `${r.districtName}|${r.rooms}|${asRepair(r.repair) ?? "-"}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(r);
    else groups.set(key, [r]);
  }
  const weekAgo = now - 7 * DAY_MS;
  const out: MarketSegmentStat[] = [];
  for (const [key, bucket] of groups) {
    // Дубли между площадками ищутся внутри района и числа комнат; сегмент по ремонту — их подмножество,
    // но один и тот же объект на двух площадках может иметь разный ремонт в записи, поэтому склейка
    // идёт ПО СЕГМЕНТУ (повторный счёт одного объекта внутри ячейки — то, от чего порог защищает).
    const unique = dedupeListings(bucket);
    const first = unique[0];
    const enough = unique.length >= MIN_SAMPLE;
    const perSqm = unique.map((r) => r.pricePerSqmTjs).filter((v): v is number => v != null && v > 0).sort((a, b) => a - b);
    const prices = unique.map((r) => r.priceTjs).sort((a, b) => a - b);
    // Число за м² считаем только если оно известно у достаточного числа объявлений: иначе подпись
    // «медиана по 8» была бы неправдой про 3.
    const perSqmOk = enough && perSqm.length >= MIN_SAMPLE;
    out.push({
      key,
      districtName: first.districtName,
      rooms: first.rooms,
      repair: asRepair(first.repair),
      count: unique.length,
      enough,
      medianPerSqmTjs: perSqmOk ? Math.round(median(perSqm)) : null,
      averagePerSqmTjs: perSqmOk ? Math.round(trimmedMean(perSqm)) : null,
      medianPriceTjs: enough ? Math.round(median(prices)) : null,
      averagePriceTjs: enough ? Math.round(trimmedMean(prices)) : null,
      freshestSeenAt: new Date(Math.max(...unique.map((r) => r.lastSeenAt.getTime()))).toISOString(),
      newLast7Days: unique.filter((r) => r.firstSeenAt.getTime() >= weekAgo).length,
    });
  }
  // Сначала сегменты с данными, внутри — крупные первыми; ключ — чтобы порядок был стабильным.
  return out.sort((a, b) => Number(b.enough) - Number(a.enough) || b.count - a.count || a.key.localeCompare(b.key, "ru"));
}

export function segmentsWhere(q: MarketSegmentsQuery, now = Date.now()): Prisma.MarketListingWhereInput {
  const freshSince = new Date(now - WINDOW_DAYS * DAY_MS);
  const oldest = new Date(now - MAX_AGE_YEARS * 365 * DAY_MS);
  return {
    dealType: "SALE",
    propertyType: "APARTMENT",
    city: q.city,
    isActive: true,
    lastSeenAt: { gte: freshSince },
    rooms: q.rooms ?? { not: null },
    districtName: q.districtName ?? { not: null },
    ...(q.repair ? { repair: q.repair } : {}),
    ...(q.building ? { isNewBuilding: q.building === "new" } : {}),
    AND: [{ OR: [{ publishedAt: null }, { publishedAt: { gte: oldest } }] }, ...plausibleSaleWhere("APARTMENT"), marketCatalogWhere()],
  };
}

/** Загрузка строк сегментов ОДНИМ запросом с пределом (общая для таблицы, строки покупателя и списка «дороже рынка»). */
export async function loadSegmentRows(q: MarketSegmentsQuery): Promise<{ rows: SegmentRow[]; sources: { source: string; count: number }[]; truncated: boolean }> {
  const found = await prisma.marketListing.findMany({
    where: segmentsWhere(q),
    select: {
      source: true, districtName: true, rooms: true, repair: true, areaSqm: true, priceTjs: true, pricePerSqmTjs: true,
      floor: true, firstSeenAt: true, lastSeenAt: true, sellerId: true,
    },
    orderBy: { lastSeenAt: "desc" },
    take: SEGMENTS_FETCH_LIMIT,
  });
  const sources = new Map<string, number>();
  for (const r of found) sources.set(r.source, (sources.get(r.source) ?? 0) + 1);
  return {
    sources: [...sources].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    truncated: found.length >= SEGMENTS_FETCH_LIMIT,
    rows: found.map((r) => ({
      source: r.source,
      districtName: r.districtName as string,
      rooms: r.rooms as number,
      repair: r.repair,
      areaSqm: r.areaSqm != null ? Number(r.areaSqm) : null,
      priceTjs: Number(r.priceTjs),
      pricePerSqmTjs: r.pricePerSqmTjs != null ? Number(r.pricePerSqmTjs) : null,
      floor: r.floor,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
      sellerId: r.sellerId,
    })),
  };
}

export async function findSegments(q: MarketSegmentsQuery): Promise<MarketSegmentsResponse> {
  const { rows, sources, truncated } = await loadSegmentRows(q);
  return { minSample: MIN_SAMPLE, windowDays: WINDOW_DAYS, city: q.city, sources, truncated, segments: buildSegments(rows) };
}

/**
 * ИНДЕКС РЫНКА ДЛЯ СРАВНЕНИЯ В ПАМЯТИ (14.11.2026): статистика района × комнаты «по всем ремонтам» и
 * района × комнаты × ремонт. Строится ОДНИМ проходом по строкам, поэтому список «дороже рынка» не
 * считает рынок заново на каждый объект (N+1 нет). Правила те же, что у buildSegments: порог, выбросы,
 * склейка дублей, медианы.
 */
export interface MarketIndex {
  all: Map<string, MarketSegmentStat>;
  byRepair: Map<string, MarketSegmentStat>;
}

export function buildMarketIndex(rows: SegmentRow[], now = Date.now()): MarketIndex {
  const all = new Map<string, MarketSegmentStat>();
  // Ремонт обнуляем: сегмент «все ремонты» — это тот же расчёт, но без разделения по ремонту.
  for (const s of buildSegments(rows.map((r) => ({ ...r, repair: null })), now)) all.set(`${s.districtName}|${s.rooms}`, s);
  const byRepair = new Map<string, MarketSegmentStat>();
  for (const s of buildSegments(rows, now)) if (s.repair) byRepair.set(`${s.districtName}|${s.rooms}|${s.repair}`, s);
  return { all, byRepair };
}

/**
 * Сегмент для объекта: сначала с его ремонтом (если там достаточно объявлений), иначе «все ремонты».
 * null — сегмента нет или в нём меньше порога: числа показывать нельзя.
 */
export function lookupMarketSegment(
  index: MarketIndex,
  districtName: string,
  rooms: number,
  repair: string | null
): { stat: MarketSegmentStat; byRepair: boolean } | null {
  if (repair) {
    const exact = index.byRepair.get(`${districtName}|${rooms}|${repair}`);
    if (exact?.enough && exact.medianPerSqmTjs != null) return { stat: exact, byRepair: true };
  }
  const any = index.all.get(`${districtName}|${rooms}`);
  return any?.enough && any.medianPerSqmTjs != null ? { stat: any, byRepair: false } : null;
}

/** Статистика ОДНОГО района и числа комнат (все ремонты) — строка рынка под запросом покупателя. */
export async function findDistrictRoomsStat(city: string, districtName: string, rooms: number): Promise<MarketSegmentStat | null> {
  const { rows } = await loadSegmentRows({ city, districtName, rooms });
  return buildMarketIndex(rows).all.get(`${districtName}|${rooms}`) ?? null;
}

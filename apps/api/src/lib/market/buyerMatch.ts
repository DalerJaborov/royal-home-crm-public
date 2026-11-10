/**
 * ПОДБОР ПОКУПАТЕЛЮ ИЗ ОБЪЯВЛЕНИЙ НА ПЛОЩАДКАХ (10.11.2026).
 *
 * Рядом с нашими объектами агент видит, что на Somon/Paydo продаётся под запрос покупателя:
 * район, комнаты, тип, бюджет. Это ЧУЖИЕ объявления, а не наши объекты — экран подписывает это
 * явно, а здесь мы не даём им стать «нашими»: объявление, которое lib/market/ownMatch.ts признал
 * нашим объектом (CONFIRMED или CANDIDATE, DISMISSED — чужое), в подбор не попадает.
 *
 * Деньги: бюджет клиента хранится в его валюте (TJS/USD) и приводится к сомони ОДНОЙ общей
 * функцией (lib/money.ts toTjs → convertToTjs пакета shared), потому что цена объявления уже
 * в сомони (MarketListing.priceTjs). Сравнивать можно только сомони с сомони.
 *
 * Те же правила честности, что в similarComps.ts: свежие (45 дней), цена известна, один объект на
 * двух площадках — одно объявление (dedupeAcrossSources), порядок по близости к запросу.
 */

import type { MarketBuyerListing } from "@royal-home/shared";
import { prisma } from "../../db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { loadMoneyContext, toTjs } from "../money.js";
import type { MatchingBuyerCriteria } from "../clientPropertyMatching.js";
import { dedupeAcrossSources, WINDOW_DAYS } from "./similarComps.js";

/** Предел выборки из базы: подбор показывает десять, остальное нужно только для склейки дублей. */
export const BUYER_FETCH_LIMIT = 500;
const MAX_AGE_YEARS = 2;
/** Если нижней границы бюджета нет, «центром» запроса считаем эту долю от верхней (только для порядка, не для отбора). */
const CENTER_SHARE_WITHOUT_MIN = 0.8;

export interface BuyerWants {
  /** Район из карточки клиента (название как в справочнике и в каталоге объявлений). */
  districtName: string | null;
  city: string;
  rooms: number | null;
  propertyType: "APARTMENT" | "HOUSE" | "COMMERCIAL" | "LAND";
  areaMin: number | null;
  /** Бюджет уже в сомони. */
  budgetMinTjs: number | null;
  budgetMaxTjs: number | null;
}

/** Есть ли за что зацепиться: без района и без потолка бюджета выборка была бы случайной. */
export function hasBuyerCriteria(w: BuyerWants): boolean {
  return w.districtName != null || w.budgetMaxTjs != null;
}

/** Слова о том, что реально применено к выборке (показывает экран). */
export function describeBuyerCriteria(w: BuyerWants): string[] {
  const out: string[] = [];
  if (w.districtName) out.push(`район ${w.districtName}`);
  if (w.rooms) out.push(`${w.rooms}-комнатные`);
  if (w.areaMin) out.push(`от ${w.areaMin} м²`);
  if (w.budgetMinTjs != null && w.budgetMaxTjs != null) out.push(`бюджет ${fmt(w.budgetMinTjs)}–${fmt(w.budgetMaxTjs)} сомони`);
  else if (w.budgetMaxTjs != null) out.push(`бюджет до ${fmt(w.budgetMaxTjs)} сомони`);
  else if (w.budgetMinTjs != null) out.push(`бюджет от ${fmt(w.budgetMinTjs)} сомони`);
  return out;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("ru-RU").replace(/\u00a0/g, " ");
}

export interface BuyerRow {
  source: string;
  sourceUrl: string;
  title: string;
  priceTjs: number;
  pricePerSqmTjs: number | null;
  areaSqm: number | null;
  rooms: number | null;
  floor: number | null;
  totalFloors: number | null;
  districtName: string | null;
  firstSeenAt: Date;
  publishedAt: Date | null;
}

/** Чем меньше, тем ближе к запросу: цена к «центру» бюджета, площадь к желаемой. */
export function buyerDistance(row: BuyerRow, w: BuyerWants): number {
  let d = 0;
  if (w.budgetMaxTjs != null) {
    const lo = w.budgetMinTjs ?? w.budgetMaxTjs * CENTER_SHARE_WITHOUT_MIN;
    const center = (lo + w.budgetMaxTjs) / 2;
    d += Math.abs(row.priceTjs - center) / w.budgetMaxTjs;
  } else if (w.budgetMinTjs != null) {
    d += Math.abs(row.priceTjs - w.budgetMinTjs) / w.budgetMinTjs;
  }
  if (w.areaMin && row.areaSqm != null) d += Math.abs(row.areaSqm - w.areaMin) / w.areaMin / 2;
  return d;
}

function fitLabels(row: BuyerRow, w: BuyerWants): string[] {
  const out: string[] = [];
  if ((w.budgetMaxTjs != null || w.budgetMinTjs != null)) out.push("в бюджете");
  if (w.districtName && row.districtName === w.districtName) out.push(`район ${w.districtName}`);
  if (w.rooms && row.rooms === w.rooms) out.push(`${w.rooms}-комн.`);
  if (w.areaMin && row.areaSqm != null && row.areaSqm >= w.areaMin) out.push(`от ${w.areaMin} м²`);
  return out;
}

/** Чистая часть: порядок по близости, склейка дублей между площадками, предел. Без БД — тестируется отдельно. */
export function rankBuyerListings(
  rows: BuyerRow[],
  w: BuyerWants,
  limit: number
): { total: number; listings: MarketBuyerListing[] } {
  const ordered = rows
    .map((r) => ({ r, d: buyerDistance(r, w) }))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.r);
  // Ближайшие первыми: из пары дублей остаётся более близкая к запросу.
  const unique = dedupeAcrossSources(ordered);
  return {
    total: unique.length,
    listings: unique.slice(0, limit).map((r) => ({
      source: r.source,
      sourceUrl: r.sourceUrl,
      title: r.title,
      priceTjs: r.priceTjs,
      pricePerSqmTjs: r.pricePerSqmTjs,
      areaSqm: r.areaSqm,
      rooms: r.rooms,
      floor: r.floor,
      totalFloors: r.totalFloors,
      districtName: r.districtName,
      publishedAt: (r.publishedAt ?? r.firstSeenAt).toISOString(),
      fit: fitLabels(r, w),
    })),
  };
}

export function buyerListingsWhere(w: BuyerWants, now = Date.now()): Prisma.MarketListingWhereInput {
  const freshSince = new Date(now - WINDOW_DAYS * 24 * 3600_000);
  const oldest = new Date(now - MAX_AGE_YEARS * 365 * 24 * 3600_000);
  const price: Prisma.DecimalFilter = { gt: 0 };
  if (w.budgetMinTjs != null) price.gte = w.budgetMinTjs;
  if (w.budgetMaxTjs != null) price.lte = w.budgetMaxTjs;
  return {
    dealType: "SALE",
    propertyType: w.propertyType,
    city: w.city,
    isActive: true,
    lastSeenAt: { gte: freshSince },
    priceTjs: price,
    ...(w.districtName ? { districtName: w.districtName } : {}),
    ...(w.rooms ? { rooms: w.rooms } : {}),
    ...(w.areaMin ? { areaSqm: { gte: w.areaMin } } : {}),
    // Объявление, признанное нашим объектом (CONFIRMED/CANDIDATE), — не «с площадки», а наше: тот же
    // критерий, что у ownListingIds() в similarComps.ts, только по всем объектам сразу.
    ownMatches: { none: { status: { in: ["CONFIRMED", "CANDIDATE"] } } },
    AND: [{ OR: [{ publishedAt: null }, { publishedAt: { gte: oldest } }] }],
  };
}

export async function findBuyerListings(
  w: BuyerWants,
  limit: number
): Promise<{ total: number; listings: MarketBuyerListing[] }> {
  const rows = await prisma.marketListing.findMany({
    where: buyerListingsWhere(w),
    select: {
      source: true, sourceUrl: true, title: true, priceTjs: true, pricePerSqmTjs: true, areaSqm: true, rooms: true,
      floor: true, totalFloors: true, districtName: true, firstSeenAt: true, publishedAt: true,
    },
    // Свежие первыми: обрезка по цене или близости сдвинула бы выдачу.
    orderBy: { lastSeenAt: "desc" },
    take: BUYER_FETCH_LIMIT,
  });
  return rankBuyerListings(
    rows.map((r) => ({
      ...r,
      priceTjs: Number(r.priceTjs),
      pricePerSqmTjs: r.pricePerSqmTjs != null ? Number(r.pricePerSqmTjs) : null,
      areaSqm: r.areaSqm != null ? Number(r.areaSqm) : null,
    })),
    w,
    limit
  );
}

/** Желания покупателя → условия выборки: район по справочнику, бюджет в сомони общей функцией. */
export async function buyerWantsFromCriteria(criteria: MatchingBuyerCriteria): Promise<BuyerWants> {
  const [district, money] = await Promise.all([
    criteria.desiredDistrictId
      ? prisma.district.findUnique({ where: { id: criteria.desiredDistrictId }, select: { name: true, city: true } })
      : Promise.resolve(null),
    loadMoneyContext(),
  ]);
  const toBudget = (value: unknown): number | null => {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(toTjs(n, criteria.currency, money)) : null;
  };
  const type = criteria.desiredType;
  return {
    districtName: district?.name ?? null,
    city: district?.city ?? "Душанбе",
    rooms: criteria.desiredRooms && criteria.desiredRooms > 0 ? criteria.desiredRooms : null,
    propertyType: type === "HOUSE" || type === "COMMERCIAL" || type === "LAND" ? type : "APARTMENT",
    areaMin: criteria.desiredAreaMin && criteria.desiredAreaMin > 0 ? criteria.desiredAreaMin : null,
    budgetMinTjs: toBudget(criteria.budgetMin),
    budgetMaxTjs: toBudget(criteria.budgetMax),
  };
}

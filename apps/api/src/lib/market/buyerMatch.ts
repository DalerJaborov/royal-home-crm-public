/**
 * ПОДБОР ПОКУПАТЕЛЮ ИЗ ОБЪЯВЛЕНИЙ НА ПЛОЩАДКАХ (10.11.2026).
 *
 * Рядом с нашими объектами агент видит, что на Somon/Paydo продаётся под запрос покупателя:
 * район, комнаты, тип, площадь, бюджет. Это ЧУЖИЕ объявления, а не наши объекты — экран подписывает это
 * явно, а здесь мы не даём им стать «нашими»: объявление, которое lib/market/ownMatch.ts признал
 * нашим объектом (CONFIRMED или CANDIDATE, DISMISSED — чужое), в подбор не попадает.
 *
 * ОДНА ДВЕРЬ ДОПУСКОВ (ревью 10.11.2026). Допуски те же, что у подбора наших объектов, и берутся из
 * той же политики (Настройки → loadMatchPolicy): бюджет — budgetWindowTjs, комнаты — roomsWithinTolerance,
 * площадь — areaMeetsMinimum (lib/clientPropertyMatching.ts, их же зовёт evaluateClientProperty).
 * Поменяли допуск в Настройках — поменялось и здесь. Тип не задан (desiredType = null) — «любой тип».
 *
 * Деньги: бюджет клиента (TJS/USD) приводится к сомони ОДНОЙ общей функцией (lib/money.ts toTjs), цена
 * объявления уже в сомони (MarketListing.priceTjs). Выбросы цены отсекает plausible.ts.
 * Один объект (на двух площадках или выложенный дважды) — одно объявление (dedupeListings). Порядок — близость к запросу.
 */

import { isMarketRealtorListing, propertyFieldShown, type MarketBuyerListing, type MarketOwnersOnlyInfo } from "@royal-home/shared";
import { prisma } from "../../db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { areaMeetsMinimum, roomsWithinTolerance, type MatchingBuyerCriteria } from "../clientPropertyMatching.js";
import { budgetWindowTjs, loadMatchPolicy, type MatchPolicy } from "../matchPolicy.js";
import { loadMoneyContext, toTjs, type MoneyContext } from "../money.js";
import { isPlausibleSale, plausibleSaleWhere } from "./plausible.js";
import { dedupeListings, WINDOW_DAYS } from "./similarComps.js";
import { marketCatalogWhere } from "./somonRubrics.js";

/**
 * Предел выборки из базы. Все отборы (район, бюджет, комнаты, площадь) уже в запросе, поэтому
 * в предел упирается только очень широкий запрос; тогда ответ честно помечается «не меньше N».
 */
export const BUYER_FETCH_LIMIT = 2000;
const MAX_AGE_YEARS = 2;
/** Если нижней границы бюджета нет, «центром» запроса считаем эту долю от верхней (только для порядка, не для отбора). */
const CENTER_SHARE_WITHOUT_MIN = 0.8;
const LISTING_TYPES = ["APARTMENT", "HOUSE", "COMMERCIAL", "LAND"] as const;

export interface BuyerWants {
  /** Район из карточки клиента (название как в справочнике и в каталоге объявлений). */
  districtName: string | null;
  city: string;
  rooms: number | null;
  /** null — «любой тип». */
  propertyType: (typeof LISTING_TYPES)[number] | null;
  areaMin: number | null;
  /** Бюджет клиента, уже в сомони, БЕЗ допуска (допуск добавляет budgetWindowTjs). */
  budgetMinTjs: number | null;
  budgetMaxTjs: number | null;
  policy: Pick<MatchPolicy, "budgetToleranceRatio" | "roomsTolerance" | "areaToleranceRatio">;
}

/** Есть ли за что зацепиться: без района и без потолка бюджета выборка была бы случайной. */
export function hasBuyerCriteria(w: BuyerWants): boolean {
  return w.districtName != null || w.budgetMaxTjs != null;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("ru-RU").replace(/ /g, " ");
}

/** Слова о том, что реально применено к выборке (показывает экран). */
export function describeBuyerCriteria(w: BuyerWants): string[] {
  const out: string[] = [];
  out.push(w.districtName ? `район ${w.districtName}` : w.city);
  if (w.rooms) out.push(`${w.rooms}-комнатные`);
  if (w.areaMin) out.push(`от ${w.areaMin} м²`);
  if (w.budgetMinTjs != null && w.budgetMaxTjs != null) out.push(`бюджет ${fmt(w.budgetMinTjs)}–${fmt(w.budgetMaxTjs)} сомони`);
  else if (w.budgetMaxTjs != null) out.push(`бюджет до ${fmt(w.budgetMaxTjs)} сомони`);
  else if (w.budgetMinTjs != null) out.push(`бюджет от ${fmt(w.budgetMinTjs)} сомони`);
  return out;
}

export interface BuyerRow {
  source: string;
  sourceUrl: string;
  title: string;
  propertyType?: string;
  priceTjs: number;
  pricePerSqmTjs: number | null;
  areaSqm: number | null;
  rooms: number | null;
  floor: number | null;
  totalFloors: number | null;
  districtName: string | null;
  firstSeenAt: Date;
  publishedAt: Date | null;
  /** Продавец на площадке (для склейки повторов одной площадки); наружу не отдаётся. */
  sellerId?: string | null;
  /** Площадка пометила продавца агентством (для фильтра «только собственники»); наружу не отдаётся. */
  isAgency?: boolean | null;
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
  if (w.rooms && row.rooms != null) d += Math.abs(row.rooms - w.rooms) * 0.2;
  return d;
}

/** Точная проверка в памяти теми же функциями политики, что у подбора наших объектов (страховка после запроса). */
export function matchesBuyer(row: BuyerRow, w: BuyerWants): boolean {
  const type = row.propertyType ?? w.propertyType ?? "APARTMENT";
  if (!isPlausibleSale(row, type)) return false;
  const window = budgetWindowTjs(w.budgetMinTjs, w.budgetMaxTjs, w.policy);
  if ((window.min != null && row.priceTjs < window.min) || (window.max != null && row.priceTjs > window.max)) return false;
  if (w.rooms != null && propertyFieldShown(type, "rooms") && row.rooms != null && !roomsWithinTolerance(row.rooms, w.rooms, w.policy)) return false;
  if (w.areaMin != null && row.areaSqm != null && !areaMeetsMinimum(row.areaSqm, w.areaMin, w.policy)) return false;
  return true;
}

/** Чистая часть: отбор, порядок по близости, склейка дублей между площадками, предел. Без БД. */
export function rankBuyerListings(
  rows: BuyerRow[],
  w: BuyerWants,
  limit: number
): { total: number; listings: MarketBuyerListing[] } {
  const ordered = rows
    .filter((r) => matchesBuyer(r, w))
    .map((r) => ({ r, d: buyerDistance(r, w) }))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.r);
  // Ближайшие первыми: из пары дублей остаётся более близкая к запросу.
  const unique = dedupeListings(ordered);
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
    })),
  };
}

export function buyerListingsWhere(w: BuyerWants, now = Date.now()): Prisma.MarketListingWhereInput {
  const freshSince = new Date(now - WINDOW_DAYS * 24 * 3600_000);
  const oldest = new Date(now - MAX_AGE_YEARS * 365 * 24 * 3600_000);
  const window = budgetWindowTjs(w.budgetMinTjs, w.budgetMaxTjs, w.policy);
  const price: Prisma.DecimalFilter = {};
  if (window.min != null) price.gte = window.min;
  if (window.max != null) price.lte = window.max;
  const and: Prisma.MarketListingWhereInput[] = [
    { OR: [{ publishedAt: null }, { publishedAt: { gte: oldest } }] },
    ...plausibleSaleWhere(w.propertyType),
    marketCatalogWhere(),
  ];
  if (w.rooms != null) {
    // Комнаты имеют смысл не у каждого типа (участок): им допуск не применяется. Неизвестное число — тоже подходит (как у наших).
    const noRooms = LISTING_TYPES.filter((t) => !propertyFieldShown(t, "rooms"));
    and.push({
      OR: [
        ...(noRooms.length ? [{ propertyType: { in: [...noRooms] } }] : []),
        { rooms: null },
        { rooms: { gte: w.rooms - w.policy.roomsTolerance, lte: w.rooms + w.policy.roomsTolerance } },
      ],
    });
  }
  if (w.areaMin != null) and.push({ OR: [{ areaSqm: null }, { areaSqm: { gte: w.areaMin * (1 - w.policy.areaToleranceRatio) } }] });
  return {
    dealType: "SALE",
    city: w.city,
    isActive: true,
    lastSeenAt: { gte: freshSince },
    ...(w.propertyType ? { propertyType: w.propertyType } : {}),
    ...(Object.keys(price).length ? { priceTjs: price } : {}),
    ...(w.districtName ? { districtName: w.districtName } : {}),
    // Объявление, признанное нашим объектом (CONFIRMED/CANDIDATE), — не «с площадки», а наше: тот же
    // критерий, что у ownListingIds() в similarComps.ts, только по всем объектам сразу.
    ownMatches: { none: { status: { in: ["CONFIRMED", "CANDIDATE"] } } },
    AND: and,
  };
}

/**
 * `realtors` — ключи продавцов-риелторов (ownerFilter.ts); null — фильтр «только собственники» выключен.
 * Объявления риелторов отсекаются ДО порядка и склейки дублей, а в ответе честно сказано, сколько было до фильтра.
 */
export async function findBuyerListings(
  w: BuyerWants,
  limit: number,
  realtors: ReadonlySet<string> | null = null
): Promise<{ total: number; totalIsLowerBound: boolean; listings: MarketBuyerListing[]; ownersOnly: MarketOwnersOnlyInfo }> {
  const rows = await prisma.marketListing.findMany({
    where: buyerListingsWhere(w),
    select: {
      source: true, sourceUrl: true, title: true, propertyType: true, priceTjs: true, pricePerSqmTjs: true, areaSqm: true,
      rooms: true, floor: true, totalFloors: true, districtName: true, firstSeenAt: true, publishedAt: true, sellerId: true, isAgency: true,
    },
    // Свежие первыми: если запрос так широк, что упёрся в предел, теряются самые старые, а не самые дорогие.
    orderBy: { lastSeenAt: "desc" },
    take: BUYER_FETCH_LIMIT,
  });
  const mapped = rows.map((r) => ({
    ...r,
    priceTjs: Number(r.priceTjs),
    pricePerSqmTjs: r.pricePerSqmTjs != null ? Number(r.pricePerSqmTjs) : null,
    areaSqm: r.areaSqm != null ? Number(r.areaSqm) : null,
  }));
  const all = rankBuyerListings(mapped, w, limit);
  const kept = realtors ? rankBuyerListings(mapped.filter((r) => !isMarketRealtorListing(r, realtors)), w, limit) : all;
  return {
    ...kept,
    totalIsLowerBound: rows.length >= BUYER_FETCH_LIMIT,
    ownersOnly: { enabled: realtors != null, kept: kept.total, total: all.total },
  };
}

/** Чистая часть: желания покупателя → условия выборки (район и общие деньги/политика уже загружены). */
export function buildBuyerWants(
  criteria: MatchingBuyerCriteria,
  district: { name: string; city: string } | null,
  money: MoneyContext,
  policy: MatchPolicy
): BuyerWants {
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
    propertyType: (LISTING_TYPES as readonly string[]).includes(type ?? "") ? (type as (typeof LISTING_TYPES)[number]) : null,
    areaMin: criteria.desiredAreaMin && criteria.desiredAreaMin > 0 ? criteria.desiredAreaMin : null,
    budgetMinTjs: toBudget(criteria.budgetMin),
    budgetMaxTjs: toBudget(criteria.budgetMax),
    policy,
  };
}

/** Желания покупателя → условия выборки: район по справочнику, бюджет в сомони общей функцией, допуски из политики. */
export async function buyerWantsFromCriteria(criteria: MatchingBuyerCriteria): Promise<BuyerWants> {
  const [district, money, policy] = await Promise.all([
    criteria.desiredDistrictId
      ? prisma.district.findUnique({ where: { id: criteria.desiredDistrictId }, select: { name: true, city: true } })
      : Promise.resolve(null),
    loadMoneyContext(),
    loadMatchPolicy(),
  ]);
  return buildBuyerWants(criteria, district, money, policy);
}

/**
 * Район совпадает, тип совпадает, и точная проверка допусков (matchesBuyer): то же, что делает запрос
 * buyerListingsWhere в базе, но для строки в памяти. Нужна там, где объявления выбираются одним запросом
 * для многих покупателей сразу (оповещение агентов, lib/market/buyerAlerts.ts): допуски остаются теми же.
 */
export function listingFitsBuyer(row: BuyerRow & { city?: string | null }, w: BuyerWants): boolean {
  if (row.city != null && row.city !== w.city) return false;
  if (w.districtName != null && row.districtName !== w.districtName) return false;
  if (w.propertyType != null && row.propertyType != null && row.propertyType !== w.propertyType) return false;
  return matchesBuyer(row, w);
}

/**
 * ПОДБОР ПОКУПАТЕЛЮ ИЗ ОБЪЯВЛЕНИЙ НА ПЛОЩАДКАХ (10.11.2026; узкий подбор — 17.11.2026).
 *
 * Рядом с нашими объектами агент видит, что на Somon/Paydo продаётся под запрос покупателя. Это ЧУЖИЕ
 * объявления, а не наши объекты — экран подписывает это явно, а здесь мы не даём им стать «нашими»:
 * объявление, которое lib/market/ownMatch.ts признал нашим объектом (CONFIRMED или CANDIDATE), в подбор не попадает.
 *
 * ОДНО ПРАВИЛО ОТБОРА — ЗДЕСЬ. Его зовут блок «С площадок» в карточке клиента (routes/clients/matching.ts),
 * пуш агенту (buyerAlerts.ts) и помощница (ai/assistant/tools/marketTools.ts). Своего отбора у них нет.
 *
 * УЗКИЙ ПОДБОР (владелец 17.11.2026: «лучшие 5–10 вместо сотен»; до этого медиана — ~198 объявлений на клиента):
 *  · район клиента. Объявления без района (площадка не назвала, мы не вывели) не выбрасываются, а идут НИЖЕ
 *    всех с районом и подписаны «район не указан» (districtUnknown). Района нет у клиента — не выдумываем:
 *    подбор по городу, экран пишет «район не указан в пожеланиях»;
 *  · комнаты как в запросе (допуск — настройка, по умолчанию 0);
 *  · цена в пределах ±N% бюджета (настройка, по умолчанию 10%): вилка «от–до» — [от−N%, до+N%], одна граница —
 *    ±N% от неё. Бюджета нет — по комнатам и району;
 *  · только объявления, которые сбор видел за последние N суток (настройка, по умолчанию 3): «активное» в каталоге,
 *    но давно не виденное — скорее всего уже продано;
 *  · только собственники (рубильник marketOwnersOnly, ownerFilter.ts);
 *  · порядок — близость к запросу и свежесть (marketBuyerScore); первые 10, остальные — «Показать ещё» (offset).
 * Пороги — Настройки → Подбор → «Подбор с площадок» (loadMarketBuyerRules), не константы. Площадь — общий допуск
 * подбора (matchAreaTolerancePct).
 *
 * Деньги: бюджет клиента (TJS/USD) приводится к сомони ОДНОЙ общей функцией (lib/money.ts toTjs), цена
 * объявления уже в сомони (MarketListing.priceTjs). Выбросы цены отсекает plausible.ts.
 * Один объект (на двух площадках или выложенный дважды) — одно объявление (dedupeListings).
 */

import {
  isMarketRealtorListing, MARKET_BUYER_RULE_DEFAULTS, propertyFieldShown, type MarketBuyerListing, type MarketOwnersOnlyInfo,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { areaMeetsMinimum, roomsWithinTolerance, type MatchingBuyerCriteria } from "../clientPropertyMatching.js";
import { DEFAULT_MATCH_POLICY, loadMatchPolicy, type MatchPolicy } from "../matchPolicy.js";
import { loadMoneyContext, toTjs, type MoneyContext } from "../money.js";
import { isPlausibleSale, plausibleSaleWhere } from "./plausible.js";
import { dedupeListings } from "./similarComps.js";
import { marketCatalogWhere } from "./somonRubrics.js";

/**
 * Предел выборки из базы. Все отборы (район, бюджет, комнаты, площадь, свежесть) уже в запросе, поэтому
 * в предел упирается только очень широкий запрос; тогда ответ честно помечается «не меньше N».
 */
export const BUYER_FETCH_LIMIT = 2000;
const MAX_AGE_YEARS = 2;
const DAY_MS = 24 * 3600_000;
const LISTING_TYPES = ["APARTMENT", "HOUSE", "COMMERCIAL", "LAND"] as const;
/** Порядок: объявление без района ниже любого с районом (дистанция по цене, площади и свежести меньше этого). */
const DISTRICT_UNKNOWN_PENALTY = 10;
/** Число комнат неизвестно — чуть ниже названных. */
const ROOMS_UNKNOWN_PENALTY = 0.3;
/** Свежесть: сутки с публикации весят как 0,5% отклонения цены; дальше 90 суток не штрафуем. */
const AGE_PENALTY_PER_DAY = 0.005;
const AGE_PENALTY_MAX_DAYS = 90;

/** Пороги узкого подбора (Настройки) плюс общий допуск площади. */
export interface MarketBuyerRules {
  freshDays: number;
  budgetToleranceRatio: number;
  roomsTolerance: number;
  areaToleranceRatio: number;
  alertsPerDay: number;
}

type RulesSettings = {
  marketBuyerFreshDays?: number | null;
  marketBuyerBudgetTolerancePct?: number | null;
  marketBuyerRoomsTolerance?: number | null;
  marketBuyerAlertsPerDay?: number | null;
} | null;

/** Чистая часть: строка Настроек → пороги. Нет строки или поля — значения по умолчанию (MARKET_BUYER_RULE_DEFAULTS). */
export function marketBuyerRulesFrom(s: RulesSettings, policy: Pick<MatchPolicy, "areaToleranceRatio">): MarketBuyerRules {
  return {
    freshDays: s?.marketBuyerFreshDays ?? MARKET_BUYER_RULE_DEFAULTS.freshDays,
    budgetToleranceRatio: (s?.marketBuyerBudgetTolerancePct ?? MARKET_BUYER_RULE_DEFAULTS.budgetTolerancePct) / 100,
    roomsTolerance: s?.marketBuyerRoomsTolerance ?? MARKET_BUYER_RULE_DEFAULTS.roomsTolerance,
    areaToleranceRatio: policy.areaToleranceRatio,
    alertsPerDay: s?.marketBuyerAlertsPerDay ?? MARKET_BUYER_RULE_DEFAULTS.alertsPerDay,
  };
}

export const DEFAULT_MARKET_BUYER_RULES: MarketBuyerRules = marketBuyerRulesFrom(null, DEFAULT_MATCH_POLICY);

/** Пороги из Настроек одним запросом. Зовут все три потребителя (через buyerWantsFromCriteria или напрямую — пуш). */
export async function loadMarketBuyerRules(): Promise<MarketBuyerRules> {
  const [s, policy] = await Promise.all([
    prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { marketBuyerFreshDays: true, marketBuyerBudgetTolerancePct: true, marketBuyerRoomsTolerance: true, marketBuyerAlertsPerDay: true },
    }),
    loadMatchPolicy(),
  ]);
  return marketBuyerRulesFrom(s, policy);
}

export interface BuyerWants {
  /** Район из карточки клиента (название как в справочнике и в каталоге объявлений). */
  districtName: string | null;
  city: string;
  rooms: number | null;
  /** null — «любой тип». */
  propertyType: (typeof LISTING_TYPES)[number] | null;
  areaMin: number | null;
  /** Бюджет клиента, уже в сомони, БЕЗ допуска (допуск добавляет marketBudgetWindowTjs). */
  budgetMinTjs: number | null;
  budgetMaxTjs: number | null;
  rules: MarketBuyerRules;
}

/** Есть ли за что зацепиться: без района и без бюджета выборка была бы случайной. */
export function hasBuyerCriteria(w: BuyerWants): boolean {
  return w.districtName != null || w.budgetMaxTjs != null || w.budgetMinTjs != null;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("ru-RU").replace(/ /g, " ");
}

/** Слова о том, что реально применено к выборке (показывает экран). */
export function describeBuyerCriteria(w: BuyerWants): string[] {
  const out: string[] = [];
  out.push(w.districtName ? `район ${w.districtName}` : `${w.city}, район не указан`);
  if (w.rooms) out.push(`${w.rooms}-комнатные`);
  if (w.areaMin) out.push(`от ${w.areaMin} м²`);
  if (w.budgetMinTjs != null && w.budgetMaxTjs != null) out.push(`бюджет ${fmt(w.budgetMinTjs)}–${fmt(w.budgetMaxTjs)} сомони`);
  else if (w.budgetMaxTjs != null || w.budgetMinTjs != null) out.push(`бюджет около ${fmt((w.budgetMaxTjs ?? w.budgetMinTjs)!)} сомони`);
  return out;
}

/** Окно цены: вилка — [от−N%, до+N%]; одна граница — ±N% от неё; бюджета нет — без окна. */
export function marketBudgetWindowTjs(
  minTjs: number | null,
  maxTjs: number | null,
  rules: Pick<MarketBuyerRules, "budgetToleranceRatio">
): { min: number | null; max: number | null } {
  const t = rules.budgetToleranceRatio;
  const lo = minTjs ?? maxTjs;
  const hi = maxTjs ?? minTjs;
  return { min: lo != null ? lo * (1 - t) : null, max: hi != null ? hi * (1 + t) : null };
}

/** Видел ли сбор объявление за последние N суток. Одно правило для запроса в базу и для строки в памяти. */
export function seenRecently(lastSeenAt: Date, rules: Pick<MarketBuyerRules, "freshDays">, now = Date.now()): boolean {
  return lastSeenAt.getTime() >= now - rules.freshDays * DAY_MS;
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
  /** Когда сбор последний раз видел объявление. */
  lastSeenAt: Date;
  /** Продавец на площадке (для склейки повторов одной площадки); наружу не отдаётся. */
  sellerId?: string | null;
  /** Площадка пометила продавца агентством (для фильтра «только собственники»); наружу не отдаётся. */
  isAgency?: boolean | null;
}

/** Чем меньше, тем ближе к запросу: цена к «центру» бюджета, площадь к желаемой, комнаты к запросу. */
export function buyerDistance(row: BuyerRow, w: BuyerWants): number {
  let d = 0;
  const hi = w.budgetMaxTjs ?? w.budgetMinTjs;
  if (hi != null) {
    const lo = w.budgetMinTjs ?? hi;
    d += Math.abs(row.priceTjs - (lo + hi) / 2) / hi;
  }
  if (w.areaMin && row.areaSqm != null) d += Math.abs(row.areaSqm - w.areaMin) / w.areaMin / 2;
  if (w.rooms) d += row.rooms != null ? Math.abs(row.rooms - w.rooms) * 0.2 : ROOMS_UNKNOWN_PENALTY;
  return d;
}

/** Порядок в подборе: близость к запросу + свежесть; объявление без района — ниже всех с районом. */
export function marketBuyerScore(row: BuyerRow, w: BuyerWants, now = Date.now()): number {
  const placedAt = (row.publishedAt ?? row.firstSeenAt).getTime();
  const ageDays = Math.min(Math.max(0, (now - placedAt) / DAY_MS), AGE_PENALTY_MAX_DAYS);
  const unknownDistrict = w.districtName != null && row.districtName == null;
  return buyerDistance(row, w) + ageDays * AGE_PENALTY_PER_DAY + (unknownDistrict ? DISTRICT_UNKNOWN_PENALTY : 0);
}

/** Точная проверка строки в памяти: свежесть, цена, комнаты, площадь — те же пороги, что в запросе. */
export function matchesBuyer(row: BuyerRow, w: BuyerWants, now = Date.now()): boolean {
  const type = row.propertyType ?? w.propertyType ?? "APARTMENT";
  if (!isPlausibleSale(row, type)) return false;
  if (!seenRecently(row.lastSeenAt, w.rules, now)) return false;
  const window = marketBudgetWindowTjs(w.budgetMinTjs, w.budgetMaxTjs, w.rules);
  if ((window.min != null && row.priceTjs < window.min) || (window.max != null && row.priceTjs > window.max)) return false;
  if (w.rooms != null && propertyFieldShown(type, "rooms") && row.rooms != null && !roomsWithinTolerance(row.rooms, w.rooms, w.rules)) return false;
  if (w.areaMin != null && row.areaSqm != null && !areaMeetsMinimum(row.areaSqm, w.areaMin, w.rules)) return false;
  return true;
}

function toPublic(r: BuyerRow): MarketBuyerListing {
  return {
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
    districtUnknown: r.districtName == null,
    publishedAt: (r.publishedAt ?? r.firstSeenAt).toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
  };
}

/** Чистая часть: отбор, порядок (близость + свежесть), склейка дублей между площадками, страница. Без БД. */
export function rankBuyerListings(
  rows: BuyerRow[],
  w: BuyerWants,
  limit: number,
  offset = 0,
  now = Date.now()
): { total: number; listings: MarketBuyerListing[] } {
  const ordered = rows
    .filter((r) => matchesBuyer(r, w, now))
    .map((r) => ({ r, d: marketBuyerScore(r, w, now) }))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.r);
  // Ближайшие первыми: из пары дублей остаётся более близкая к запросу.
  const unique = dedupeListings(ordered);
  return { total: unique.length, listings: unique.slice(offset, offset + limit).map(toPublic) };
}

export function buyerListingsWhere(w: BuyerWants, now = Date.now()): Prisma.MarketListingWhereInput {
  const freshSince = new Date(now - w.rules.freshDays * DAY_MS);
  const oldest = new Date(now - MAX_AGE_YEARS * 365 * DAY_MS);
  const window = marketBudgetWindowTjs(w.budgetMinTjs, w.budgetMaxTjs, w.rules);
  const price: Prisma.DecimalFilter = {};
  if (window.min != null) price.gte = window.min;
  if (window.max != null) price.lte = window.max;
  const and: Prisma.MarketListingWhereInput[] = [
    { OR: [{ publishedAt: null }, { publishedAt: { gte: oldest } }] },
    ...plausibleSaleWhere(w.propertyType),
    marketCatalogWhere(),
  ];
  if (w.rooms != null) {
    // Комнаты имеют смысл не у каждого типа (участок): им допуск не применяется. Неизвестное число — подходит, но ниже.
    const noRooms = LISTING_TYPES.filter((t) => !propertyFieldShown(t, "rooms"));
    and.push({
      OR: [
        ...(noRooms.length ? [{ propertyType: { in: [...noRooms] } }] : []),
        { rooms: null },
        { rooms: { gte: w.rooms - w.rules.roomsTolerance, lte: w.rooms + w.rules.roomsTolerance } },
      ],
    });
  }
  if (w.areaMin != null) and.push({ OR: [{ areaSqm: null }, { areaSqm: { gte: w.areaMin * (1 - w.rules.areaToleranceRatio) } }] });
  // Район клиента — или район не указан (такие идут ниже и подписаны на экране).
  if (w.districtName) and.push({ OR: [{ districtName: w.districtName }, { districtName: null }] });
  return {
    dealType: "SALE",
    city: w.city,
    isActive: true,
    lastSeenAt: { gte: freshSince },
    ...(w.propertyType ? { propertyType: w.propertyType } : {}),
    ...(Object.keys(price).length ? { priceTjs: price } : {}),
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
  realtors: ReadonlySet<string> | null = null,
  offset = 0
): Promise<{ total: number; totalIsLowerBound: boolean; listings: MarketBuyerListing[]; ownersOnly: MarketOwnersOnlyInfo }> {
  const now = Date.now();
  const rows = await prisma.marketListing.findMany({
    where: buyerListingsWhere(w, now),
    select: {
      source: true, sourceUrl: true, title: true, propertyType: true, priceTjs: true, pricePerSqmTjs: true, areaSqm: true,
      rooms: true, floor: true, totalFloors: true, districtName: true, firstSeenAt: true, publishedAt: true, lastSeenAt: true,
      sellerId: true, isAgency: true,
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
  const all = rankBuyerListings(mapped, w, limit, offset, now);
  const kept = realtors ? rankBuyerListings(mapped.filter((r) => !isMarketRealtorListing(r, realtors)), w, limit, offset, now) : all;
  return {
    ...kept,
    totalIsLowerBound: rows.length >= BUYER_FETCH_LIMIT,
    ownersOnly: { enabled: realtors != null, kept: kept.total, total: all.total },
  };
}

/** Чистая часть: желания покупателя → условия выборки (район, общие деньги и пороги уже загружены). */
export function buildBuyerWants(
  criteria: MatchingBuyerCriteria,
  district: { name: string; city: string } | null,
  money: MoneyContext,
  rules: MarketBuyerRules
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
    rules,
  };
}

/** Желания покупателя → условия выборки: район по справочнику, бюджет в сомони общей функцией, пороги из Настроек. */
export async function buyerWantsFromCriteria(criteria: MatchingBuyerCriteria): Promise<BuyerWants> {
  const [district, money, rules] = await Promise.all([
    criteria.desiredDistrictId
      ? prisma.district.findUnique({ where: { id: criteria.desiredDistrictId }, select: { name: true, city: true } })
      : Promise.resolve(null),
    loadMoneyContext(),
    loadMarketBuyerRules(),
  ]);
  return buildBuyerWants(criteria, district, money, rules);
}

/**
 * Для пуша (lib/market/buyerAlerts.ts): объявления выбираются одним запросом для многих покупателей, поэтому
 * город, район и тип проверяются здесь, а свежесть, цена, комнаты и площадь — той же matchesBuyer.
 * Пуш строже карточки: объявление без района покупателю с районом не шлём (на экране оно подписано, в пуше — нет).
 */
export function listingFitsBuyer(row: BuyerRow & { city?: string | null }, w: BuyerWants, now = Date.now()): boolean {
  if (row.city != null && row.city !== w.city) return false;
  if (w.districtName != null && row.districtName !== w.districtName) return false;
  if (w.propertyType != null && row.propertyType != null && row.propertyType !== w.propertyType) return false;
  return matchesBuyer(row, w, now);
}

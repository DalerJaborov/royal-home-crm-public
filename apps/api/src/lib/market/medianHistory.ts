/**
 * ИСТОРИЯ МЕДИАН РЫНКА (14.11.2026): раз в сутки пишем «сколько стоит м² и квартира» по сегментам.
 *
 * Зачем. Каталог знает только сегодняшнюю цену; прошлую медиану района из него не восстановить.
 * Без записи вперёд «динамика по городу» пуста навсегда. Запись по строке на сегмент и сутки
 * (таблица MarketMedianDaily) копит ряд, который потом станет графиком.
 *
 * Сегмент = район × комнаты × тип дома (NEW новостройка / SECONDARY вторичка / ANY любой) ×
 * аудитория (ALL весь рынок / OWNERS только собственники). Для рядов «по району» комнаты = 0
 * (любое), для рядов «по городу» район = «*». Объявление без района в сегменты не попадает.
 *
 * Правила (те же, что у цен по сегментам — segments.ts, берутся оттуда, а не пишутся заново):
 *  · выборка — segmentsWhere (продажа квартир, активные, свежие, правдоподобная цена, marketCatalogWhere);
 *  · дубли между площадками склеиваются (dedupeListings), иначе пять квартир выглядят как десять;
 *  · порог MIN_SAMPLE (8): меньше — строка не пишется вовсе, цифры нет;
 *  · «среднее» — усечённое (trimmedMean), рядом медиана.
 *
 * Собственник = не агентство И у продавца (площадка + id; без id — по телефону) меньше
 * OWNER_MAX_ACTIVE_LISTINGS активных объявлений продажи в ВСЁМ каталоге, а не в районе: риелтор
 * с 40 объявлениями по городу остаётся риелтором, даже если в сегменте у него два.
 * TODO: в ветке «подбор покупателю / список дороже рынка» (PR #177) может появиться общая функция
 * того же правила — после вливания перевести сюда на неё и удалить локальную копию.
 *
 * Идемпотентность: суточный прогон удаляет строки этих суток и города и вставляет новые В ОДНОЙ
 * транзакции; второй запуск в те же сутки даёт ровно те же строки (не дубли). Пустой результат
 * (каталог пуст) ничего не удаляет: утренний снимок не стирается ночной аварией.
 * Границы суток — только через lib/dushanbeTime.ts.
 */

import { prisma } from "../../db.js";
import { dushanbeDateString } from "../dushanbeTime.js";
import { MIN_SAMPLE } from "./comps.js";
import { isPlausibleSale, trimmedMean } from "./plausible.js";
import { dedupeListings } from "./similarComps.js";
import { median, SEGMENTS_FETCH_LIMIT, segmentsWhere } from "./segments.js";
import { marketCatalogWhere } from "./somonRubrics.js";

/** Собственник — у продавца МЕНЬШЕ стольких активных объявлений продажи в каталоге. */
export const OWNER_MAX_ACTIVE_LISTINGS = 3;
export const ALL_DISTRICTS = "*";
export const ANY_ROOMS = 0;
export const BUILDING_KEYS = ["NEW", "SECONDARY", "ANY"] as const;
export type HistoryBuilding = (typeof BUILDING_KEYS)[number];
export const AUDIENCES = ["ALL", "OWNERS"] as const;
export type HistoryAudience = (typeof AUDIENCES)[number];

export interface HistoryInputRow {
  source: string;
  districtName: string;
  rooms: number;
  areaSqm: number | null;
  priceTjs: number;
  pricePerSqmTjs: number | null;
  floor: number | null;
  repair: string | null;
  sellerId: string | null;
  sellerPhone: string | null;
  isNewBuilding: boolean | null;
  isOwner: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface MedianHistoryRow {
  districtName: string;
  rooms: number;
  building: HistoryBuilding;
  audience: HistoryAudience;
  count: number;
  medianPerSqmTjs: number | null;
  averagePerSqmTjs: number | null;
  medianPriceTjs: number | null;
  averagePriceTjs: number | null;
}

/** Ключ продавца для счёта объявлений: площадка+id, иначе телефон; нет ни того ни другого — null. */
export function sellerKey(r: { source: string; sellerId: string | null; sellerPhone: string | null }): string | null {
  if (r.sellerId) return `${r.source}:${r.sellerId}`;
  if (r.sellerPhone) return `ph:${r.sellerPhone}`;
  return null;
}

/** Чистое правило «собственник»: не агентство и у продавца активных объявлений меньше порога (неизвестный продавец — собственник). */
export function isOwnerSeller(isAgency: boolean, activeCount: number | null): boolean {
  if (isAgency) return false;
  return activeCount == null || activeCount < OWNER_MAX_ACTIVE_LISTINGS;
}

function buildingKeys(r: HistoryInputRow): HistoryBuilding[] {
  if (r.isNewBuilding === true) return ["NEW", "ANY"];
  if (r.isNewBuilding === false) return ["SECONDARY", "ANY"];
  return ["ANY"];
}

/** Чистая часть: сегменты из строк, только те, что набрали MIN_SAMPLE уникальных объявлений. Без БД. */
export function buildMedianHistory(rows: HistoryInputRow[]): MedianHistoryRow[] {
  const plausible = rows.filter((r) => r.districtName && isPlausibleSale(r, "APARTMENT"));
  // Склейка один раз на всю выборку: дубли ищутся внутри района, делить на сегменты незачем.
  const unique = dedupeListings(plausible);
  const groups = new Map<string, HistoryInputRow[]>();
  for (const r of unique) {
    for (const district of [r.districtName, ALL_DISTRICTS]) {
      for (const rooms of [r.rooms, ANY_ROOMS]) {
        for (const building of buildingKeys(r)) {
          for (const audience of AUDIENCES) {
            if (audience === "OWNERS" && !r.isOwner) continue;
            const key = `${district}\u0000${rooms}\u0000${building}\u0000${audience}`;
            const bucket = groups.get(key);
            if (bucket) bucket.push(r);
            else groups.set(key, [r]);
          }
        }
      }
    }
  }
  const out: MedianHistoryRow[] = [];
  for (const [key, bucket] of groups) {
    if (bucket.length < MIN_SAMPLE) continue;
    const [districtName, rooms, building, audience] = key.split("\u0000");
    const perSqm = bucket.map((r) => r.pricePerSqmTjs).filter((v): v is number => v != null && v > 0).sort((a, b) => a - b);
    const prices = bucket.map((r) => r.priceTjs).sort((a, b) => a - b);
    const perSqmOk = perSqm.length >= MIN_SAMPLE;
    out.push({
      districtName,
      rooms: Number(rooms),
      building: building as HistoryBuilding,
      audience: audience as HistoryAudience,
      count: bucket.length,
      medianPerSqmTjs: perSqmOk ? Math.round(median(perSqm)) : null,
      averagePerSqmTjs: perSqmOk ? Math.round(trimmedMean(perSqm)) : null,
      medianPriceTjs: Math.round(median(prices)),
      averagePriceTjs: Math.round(trimmedMean(prices)),
    });
  }
  return out.sort(
    (a, b) =>
      a.districtName.localeCompare(b.districtName, "ru") || a.rooms - b.rooms || a.building.localeCompare(b.building) || a.audience.localeCompare(b.audience)
  );
}

export interface RecordHistoryResult {
  day: string;
  fetched: number;
  written: number;
  skipped: "no-data" | null;
}

/**
 * Снимок суток: читает каталог, считает сегменты, пишет в MarketMedianDaily. `now` — момент прогона;
 * сутки — по Душанбе. Вызывает cron «market-median-history» (cron.ts).
 */
export async function recordMedianHistory(city = "Душанбе", now: Date = new Date()): Promise<RecordHistoryResult> {
  const day = dushanbeDateString(now);
  const listings = await prisma.marketListing.findMany({
    where: { AND: [segmentsWhere({ city }, now.getTime()), marketCatalogWhere()] },
    select: {
      source: true, districtName: true, rooms: true, repair: true, areaSqm: true, priceTjs: true, pricePerSqmTjs: true,
      floor: true, firstSeenAt: true, lastSeenAt: true, sellerId: true, sellerPhone: true, isAgency: true, isNewBuilding: true,
    },
    orderBy: { lastSeenAt: "desc" },
    take: SEGMENTS_FETCH_LIMIT,
  });

  // Сколько активных объявлений у продавцов выборки — по ВСЕМУ каталогу продаж (как в dynamics.ts).
  const ids = [...new Set(listings.map((r) => r.sellerId).filter((v): v is string => !!v))];
  const phones = [...new Set(listings.filter((r) => !r.sellerId).map((r) => r.sellerPhone).filter((v): v is string => !!v))];
  const counts = new Map<string, number>();
  const [byId, byPhone] = await Promise.all([
    ids.length
      ? prisma.marketListing.groupBy({
          by: ["source", "sellerId"],
          where: { isActive: true, dealType: "SALE", sellerId: { in: ids }, AND: [marketCatalogWhere()] },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    phones.length
      ? prisma.marketListing.groupBy({
          by: ["sellerPhone"],
          where: { isActive: true, dealType: "SALE", sellerId: null, sellerPhone: { in: phones }, AND: [marketCatalogWhere()] },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);
  for (const g of byId) if (g.sellerId) counts.set(`${g.source}:${g.sellerId}`, g._count._all);
  for (const g of byPhone) if (g.sellerPhone) counts.set(`ph:${g.sellerPhone}`, g._count._all);

  const rows: HistoryInputRow[] = listings.map((r) => {
    const key = sellerKey(r);
    return {
      source: r.source,
      districtName: r.districtName as string,
      rooms: r.rooms as number,
      areaSqm: r.areaSqm != null ? Number(r.areaSqm) : null,
      priceTjs: Number(r.priceTjs),
      pricePerSqmTjs: r.pricePerSqmTjs != null ? Number(r.pricePerSqmTjs) : null,
      floor: r.floor,
      repair: r.repair,
      sellerId: r.sellerId,
      sellerPhone: r.sellerPhone,
      isNewBuilding: r.isNewBuilding,
      isOwner: isOwnerSeller(r.isAgency, key ? (counts.get(key) ?? null) : null),
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
    };
  });

  const built = buildMedianHistory(rows);
  if (built.length === 0) return { day, fetched: listings.length, written: 0, skipped: "no-data" };

  await prisma.$transaction([
    prisma.marketMedianDaily.deleteMany({ where: { day, city } }),
    prisma.marketMedianDaily.createMany({ data: built.map((b) => ({ day, city, ...b })) }),
  ]);
  return { day, fetched: listings.length, written: built.length, skipped: null };
}

export interface MedianHistoryQuery {
  city: string;
  districtName: string;
  rooms: number;
  building: HistoryBuilding;
  audience: HistoryAudience;
  /** Сколько суток назад (по Душанбе) начинать ряд. */
  days: number;
  limit: number;
}

/** Ряд по дням для сегмента, старые первыми; предел — `limit` самых свежих суток. */
export async function readMedianHistory(q: MedianHistoryQuery, now: Date = new Date()) {
  const since = dushanbeDateString(new Date(now.getTime() - q.days * 24 * 3600_000));
  const rows = await prisma.marketMedianDaily.findMany({
    where: { city: q.city, districtName: q.districtName, rooms: q.rooms, building: q.building, audience: q.audience, day: { gte: since } },
    orderBy: { day: "desc" },
    take: q.limit,
    select: { day: true, count: true, medianPerSqmTjs: true, averagePerSqmTjs: true, medianPriceTjs: true, averagePriceTjs: true },
  });
  return rows.reverse();
}

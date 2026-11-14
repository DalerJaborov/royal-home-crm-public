/**
 * СОХРАНЕНИЕ РЫНОЧНЫХ ОБЪЯВЛЕНИЙ И ИСТОРИИ ЦЕН.
 *
 * Ключевое решение: объявление НЕ перезаписывается на месте, а обновляется с
 * сохранением следов. Цена изменилась — пишем снимок в MarketPriceSnapshot;
 * объявление пропало из выдачи — не удаляем, а помечаем. Это ровно то, чего
 * нельзя восстановить задним числом: сайт всегда показывает только «сейчас»,
 * и всё, что мы не записали сегодня, потеряно навсегда.
 *
 * Ради этого же здесь хранится сырой JSON объявления: если завтра понадобится
 * поле, которое сегодня не разбирали, его достанут из сырья, а не из повторного
 * обхода (которого для прошлого не бывает).
 */

import { prisma } from "../../db.js";
import { loadMoneyContext, toTjs } from "../money.js";
import { resolveDistrict } from "./districtInference.js";
import type { ParsedListing } from "./somonParser.js";

export interface SaveStats {
  created: number;
  updated: number;
  priceChanges: number;
  skipped: number;
}

/** Недельный полный обход; порог исчезновения — 1,5 интервала (≈ 11 суток). */
export const CRAWL_INTERVAL_HOURS = 7 * 24;
export const DISAPPEAR_AFTER_HOURS = Math.ceil(CRAWL_INTERVAL_HOURS * 1.5 / 24) * 24; // 264 ч
/**
 * Paydo обходится целиком КАЖДУЮ НОЧЬ (03.11.2026), поэтому порог «исчезло» короче: 3 суток =
 * мимо трёх ночных обходов подряд. Меньше нельзя — одна неудачная ночь (блок, обрыв, занятый
 * замок) не должна гасить живые объявления; больше не нужно — сутки обхода уже дают запас.
 */
export const PAYDO_CRAWL_INTERVAL_HOURS = 24;
export const PAYDO_DISAPPEAR_AFTER_HOURS = PAYDO_CRAWL_INTERVAL_HOURS * 3; // 72 ч

/**
 * Ниже этого цена за квадрат — не рынок, а мусор: «1 сомони», «договорная»,
 * потерянные разряды. Выше — тоже: обычно приписан лишний ноль. Пороги грубые
 * нарочно, они отсекают опечатки, а не дорогие или дешёвые варианты.
 */
export const MIN_PRICE_PER_SQM_TJS = 500;
export const MAX_PRICE_PER_SQM_TJS = 100_000;

/** Цена за квадрат, если она правдоподобна; иначе null — считать по ней нельзя. */
export function pricePerSqm(priceTjs: number | null, areaSqm: number | null): number | null {
  if (!priceTjs || !areaSqm || areaSqm <= 0) return null;
  const value = priceTjs / areaSqm;
  if (value < MIN_PRICE_PER_SQM_TJS || value > MAX_PRICE_PER_SQM_TJS) return null;
  return Math.round(value);
}

/**
 * Поля, которые источник может НЕ отдать (Somon не даёт ремонт и координаты, Paydo —
 * телефон и дату). При обновлении null из свежей записи не затирает уже сохранённое:
 * номер, который агент достал кликом, и признаки от другого источника живут дальше.
 */
const PRESERVED_WHEN_EMPTY = [
  "districtName",
  "landmark",
  "totalFloors",
  "landSotki",
  "sellerPhone",
  "publishedAt",
  "repair",
  "buildingType",
  "isNewBuilding",
  "buildingReady",
  "exchangePossible",
  "latitude",
  "longitude",
] as const;

/** Поля, по которым решаем, нужно ли вообще писать строку (raw нарочно не сравниваем). */
const COMPARED_FIELDS = [
  "sourceUrl",
  "dealType",
  "propertyType",
  "city",
  "rooms",
  "areaSqm",
  "floor",
  "price",
  "currency",
  "priceTjs",
  "pricePerSqmTjs",
  "negotiable",
  "sellerId",
  "sellerName",
  "isAgency",
  "title",
  "photoCount",
  "hasVideo",
  "isPromoted",
  "publishedText",
] as const;

/** Сомони после пересчёта по курсу и цена в исходной валюте сравниваются с допуском копейки. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date || b instanceof Date) return new Date(a as never).getTime() === new Date(b as never).getTime();
  if (typeof a === "string" && typeof b === "string") return a === b;
  const x = Number(a as never);
  const y = Number(b as never);
  if (Number.isFinite(x) && Number.isFinite(y)) return Math.abs(x - y) < 0.005;
  return a === b;
}

/**
 * Записывает пачку объявлений одного обхода.
 *
 * Пачкой, а не по одному: обход даёт 60 объявлений на страницу, и запрос на
 * каждое превратил бы обычный обход в десять тысяч походов в базу.
 */
async function districtOf(l: ParsedListing): Promise<string | null> {
  if (l.districtName) return l.districtName;
  // Лестница знает справочники Душанбе: для других городов район не выводим.
  if (l.city && !/душанбе/i.test(l.city)) return null;
  return (
    await resolveDistrict({
      sourceDistrict: l.districtName,
      latitude: l.latitude,
      longitude: l.longitude,
      address: l.landmark,
      title: l.title,
      description: l.description,
    })
  ).name;
}

export async function saveListings(source: string, listings: ParsedListing[]): Promise<SaveStats> {
  const stats: SaveStats = { created: 0, updated: 0, priceChanges: 0, skipped: 0 };
  if (listings.length === 0) return stats;

  const money = await loadMoneyContext();
  const now = new Date();

  const existing = await prisma.marketListing.findMany({
    where: { source, sourceId: { in: listings.map((l) => l.sourceId) } },
    select: {
      id: true, sourceId: true,
      sourceUrl: true, dealType: true, propertyType: true, city: true, rooms: true, areaSqm: true, floor: true,
      price: true, currency: true, priceTjs: true, pricePerSqmTjs: true, negotiable: true, sellerId: true,
      sellerName: true, isAgency: true, title: true, photoCount: true, hasVideo: true, isPromoted: true, publishedText: true,
      districtName: true, landmark: true, totalFloors: true, landSotki: true, sellerPhone: true, publishedAt: true, repair: true,
      buildingType: true, isNewBuilding: true, buildingReady: true, exchangePossible: true, latitude: true, longitude: true,
    },
  });
  const bySourceId = new Map(existing.map((e) => [e.sourceId, e]));
  const touchIds: string[] = [];

  for (const l of listings) {
    const priceTjs = l.price != null ? toTjs(l.price, l.currency as never, money) : null;
    const perSqm = pricePerSqm(priceTjs, l.areaSqm);

    const data = {
      source,
      sourceId: l.sourceId,
      sourceUrl: l.sourceUrl,
      dealType: l.dealType,
      propertyType: l.propertyType,
      city: l.city,
      // Источник район не назвал — выводим по лестнице (координаты, подпись в тексте, улица, место); не знаем — null.
      districtName: await districtOf(l),
      landmark: l.landmark,
      rooms: l.rooms,
      areaSqm: l.areaSqm,
      floor: l.floor,
      totalFloors: l.totalFloors ?? null,
      landSotki: l.landSotki ?? null,
      price: l.price,
      currency: l.currency,
      priceTjs,
      pricePerSqmTjs: perSqm,
      negotiable: l.negotiable,
      sellerId: l.sellerId,
      sellerName: l.sellerName,
      sellerPhone: l.sellerPhone ?? null,
      isAgency: l.isAgency,
      title: l.title,
      photoCount: l.photoCount,
      hasVideo: l.hasVideo,
      isPromoted: l.isPromoted,
      publishedText: l.publishedText,
      publishedAt: l.publishedAt ?? null,
      repair: l.repair ?? null,
      buildingType: l.buildingType ?? null,
      isNewBuilding: l.isNewBuilding ?? null,
      buildingReady: l.buildingReady ?? null,
      exchangePossible: l.exchangePossible ?? null,
      latitude: l.latitude ?? null,
      longitude: l.longitude ?? null,
      raw: l.raw as never,
      lastSeenAt: now,
      isActive: true,
      disappearedAt: null,
    };

    const prev = bySourceId.get(l.sourceId);
    try {
      if (!prev) {
        const created = await prisma.marketListing.create({ data });
        stats.created++;
        if (priceTjs) {
          await prisma.marketPriceSnapshot.create({
            data: { listingId: created.id, priceTjs, seenAt: now },
          });
        }
        continue;
      }

      // Обновление: поля, которых источник не дал, не трогаем (см. PRESERVED_WHEN_EMPTY).
      const update: Record<string, unknown> = { ...data };
      for (const key of PRESERVED_WHEN_EMPTY) {
        if (update[key] == null) delete update[key];
      }
      // Район, уже записанный в строке (из источника или прошлого вывода), выведенным заново не перебиваем.
      if (!l.districtName && prev.districtName) delete update.districtName;
      const prevRow = prev as Record<string, unknown>;
      const unchanged =
        COMPARED_FIELDS.every((key) => sameValue(prevRow[key], update[key])) &&
        PRESERVED_WHEN_EMPTY.every((key) => update[key] == null || sameValue(prevRow[key], update[key]));
      if (unchanged) {
        // Минутный парсер лидов гоняет одни и те же страницы: без изменений пишем только «видели».
        touchIds.push(prev.id);
        stats.updated++;
        continue;
      }

      await prisma.marketListing.update({ where: { id: prev.id }, data: update as typeof data });
      stats.updated++;

      // Снимок пишем ТОЛЬКО при изменении цены: строка на каждый обход раздула бы
      // историю в сотни раз, ничего к ней не добавив. Изменение определяем по ИСХОДНЫМ
      // price и currency: смена курса доллара пересчитывает priceTjs у всех долларовых
      // объявлений, но цена продавца не менялась — «снижения» тут нет.
      const priceChanged =
        l.price != null &&
        (prev.price == null || !sameValue(prev.price, l.price) || prev.currency !== l.currency);
      if (priceTjs != null && priceChanged) {
        await prisma.marketPriceSnapshot.create({
          data: { listingId: prev.id, priceTjs, seenAt: now },
        });
        stats.priceChanges++;
      }
    } catch {
      // Одно кривое объявление не должно останавливать обход всего раздела.
      stats.skipped++;
    }
  }

  if (touchIds.length > 0) {
    try {
      await prisma.marketListing.updateMany({
        where: { id: { in: touchIds } },
        data: { lastSeenAt: now, isActive: true, disappearedAt: null },
      });
    } catch {
      stats.updated -= touchIds.length;
      stats.skipped += touchIds.length;
    }
  }

  return stats;
}

/**
 * Помечает пропавшие объявления.
 *
 * Не удаляем: исчезновение из выдачи — это, скорее всего, ПРОДАНО, и вместе с
 * последней ценой это самый близкий к правде сигнал о реальной цене сделки,
 * какой вообще можно получить снаружи. Удалив запись, мы выбросили бы именно то,
 * ради чего всё и затевалось.
 *
 * Порог — защита от ложной тревоги: страница могла не открыться, обход мог прерваться,
 * сайт мог моргнуть, а у Somon выдача страницами по смещению и за 1–2 часа обхода
 * объявление «перепрыгивает» через страницу. Поэтому «пропало» — это не «не встретили
 * в последнем обходе», а «не видели дольше 1,5 интервала недельного обхода», то есть
 * мимо ДВУХ полных обходов подряд (вызывать только после успешного ПОЛНОГО обхода).
 * Порог у каждого источника свой (Somon — недельный обход, Paydo — ночной), поэтому он
 * обязательный параметр: молчаливое умолчание однажды погасило бы чужой каталог не по сроку.
 */
export async function markDisappeared(source: string, olderThanHours: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3600_000);
  const res = await prisma.marketListing.updateMany({
    where: { source, isActive: true, lastSeenAt: { lt: cutoff } },
    data: { isActive: false, disappearedAt: new Date() },
  });
  return res.count;
}

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
import type { ParsedListing } from "./somonParser.js";

export interface SaveStats {
  created: number;
  updated: number;
  priceChanges: number;
  skipped: number;
}

/**
 * Ниже этого цена за квадрат — не рынок, а мусор: «1 сомони», «договорная»,
 * потерянные разряды. Выше — тоже: обычно приписан лишний ноль. Пороги грубые
 * нарочно, они отсекают опечатки, а не дорогие или дешёвые варианты.
 */
const MIN_PRICE_PER_SQM_TJS = 500;
const MAX_PRICE_PER_SQM_TJS = 100_000;

/** Цена за квадрат, если она правдоподобна; иначе null — считать по ней нельзя. */
export function pricePerSqm(priceTjs: number | null, areaSqm: number | null): number | null {
  if (!priceTjs || !areaSqm || areaSqm <= 0) return null;
  const value = priceTjs / areaSqm;
  if (value < MIN_PRICE_PER_SQM_TJS || value > MAX_PRICE_PER_SQM_TJS) return null;
  return Math.round(value);
}

/**
 * Записывает пачку объявлений одного обхода.
 *
 * Пачкой, а не по одному: обход даёт 60 объявлений на страницу, и запрос на
 * каждое превратил бы обычный обход в десять тысяч походов в базу.
 */
export async function saveListings(source: string, listings: ParsedListing[]): Promise<SaveStats> {
  const stats: SaveStats = { created: 0, updated: 0, priceChanges: 0, skipped: 0 };
  if (listings.length === 0) return stats;

  const money = await loadMoneyContext();
  const now = new Date();

  const existing = await prisma.marketListing.findMany({
    where: { source, sourceId: { in: listings.map((l) => l.sourceId) } },
    select: { id: true, sourceId: true, priceTjs: true },
  });
  const bySourceId = new Map(existing.map((e) => [e.sourceId, e]));

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
      districtName: l.districtName,
      landmark: l.landmark,
      rooms: l.rooms,
      areaSqm: l.areaSqm,
      floor: l.floor,
      totalFloors: l.totalFloors ?? null,
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

      await prisma.marketListing.update({ where: { id: prev.id }, data });
      stats.updated++;

      // Снимок пишем ТОЛЬКО при изменении цены: строка на каждый обход раздула бы
      // историю в сотни раз, ничего к ней не добавив.
      const prevPrice = prev.priceTjs != null ? Number(prev.priceTjs) : null;
      if (priceTjs != null && prevPrice !== priceTjs) {
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
 * Порог в сутки — защита от ложной тревоги: страница могла не открыться, обход
 * мог прерваться, сайт мог моргнуть.
 */
export async function markDisappeared(source: string, olderThanHours = 24): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3600_000);
  const res = await prisma.marketListing.updateMany({
    where: { source, isActive: true, lastSeenAt: { lt: cutoff } },
    data: { isActive: false, disappearedAt: new Date() },
  });
  return res.count;
}

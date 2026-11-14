/**
 * ФИЛЬТР «ТОЛЬКО СОБСТВЕННИКИ» ДЛЯ ПОДБОРА ПОКУПАТЕЛЮ (14.11.2026).
 *
 * Правило живёт в packages/shared (isMarketRealtorListing, MARKET_REALTOR_MIN_LISTINGS), здесь только данные:
 * ключи продавцов, у которых MARKET_REALTOR_MIN_LISTINGS и больше активных объявлений продажи. Это ОДИН запрос
 * с group by по (площадка, продавец) и having, без N+1; в памяти остаются только такие продавцы (на замере 14.11
 * около тысячи ключей на весь каталог). Подбор в карточке клиента (buyerMatch.ts), пуш агенту (buyerAlerts.ts) и
 * инструмент помощницы зовут эту одну функцию. Рубильник: Настройки, Подбор, «Только собственники в подборе»,
 * по умолчанию ВКЛЮЧЁН (решение владельца).
 */
import { MARKET_REALTOR_MIN_LISTINGS, marketSellerKey } from "@royal-home/shared";
import { prisma } from "../../db.js";

export async function loadRealtorSellerKeys(): Promise<Set<string>> {
  const groups = await prisma.marketListing.groupBy({
    by: ["source", "sellerId"],
    where: { isActive: true, dealType: "SALE", sellerId: { not: null } },
    _count: { _all: true },
    having: { id: { _count: { gte: MARKET_REALTOR_MIN_LISTINGS } } },
  });
  return new Set(groups.flatMap((g) => (g.sellerId ? [marketSellerKey(g.source, g.sellerId)] : [])));
}

/** Включён ли фильтр. Нет строки настроек или поля: по умолчанию ВКЛЮЧЁН. */
export async function ownersOnlyEnabled(): Promise<boolean> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { marketOwnersOnly: true } });
  return s?.marketOwnersOnly ?? true;
}

/** Фильтр для подбора: null — выключен (показываются все). */
export async function loadOwnersFilter(): Promise<ReadonlySet<string> | null> {
  return (await ownersOnlyEnabled()) ? loadRealtorSellerKeys() : null;
}

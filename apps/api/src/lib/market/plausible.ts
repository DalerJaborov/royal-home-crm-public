/**
 * ПРАВДОПОДОБНАЯ ЦЕНА ПРОДАЖИ (10.11.2026, ревью подбора с площадок и цен по сегментам).
 *
 * В каталоге лежат и опечатки: «1 сомони», «123» вместо 123 000, потерянные разряды, цена аренды
 * в объявлении продажи. Такая запись тянет вниз и подбор покупателю («за 500 сомони»), и среднее
 * сегмента. Отсекается ОДНОЙ дверью — здесь, и для подбора, и для сегментов.
 *
 *  · MIN_SALE_PRICE_TJS = 50 000 сомони (≈ 4,5 тыс. $ по курсу 2026): самая дешёвая реальная
 *    квартира или комната в Душанбе стоит заметно дороже; всё ниже — опечатка, доля или аренда.
 *    Порог грубый нарочно, как и пороги за м² в marketStore: он убирает мусор, а не дешёвые варианты.
 *  · У квартиры при известной площади цена за м² обязана лежать в тех же 500–100 000, что и в
 *    marketStore (pricePerSqm: вне границ там записывается null — значит «площадь известна, а
 *    цена за м² null» — это и есть выброс).
 */

import type { Prisma } from "../../generated/prisma/client.js";
import { MAX_PRICE_PER_SQM_TJS, MIN_PRICE_PER_SQM_TJS } from "./marketStore.js";

export const MIN_SALE_PRICE_TJS = 50_000;

export interface PlausibleRow {
  priceTjs: number | null;
  areaSqm: number | null;
  pricePerSqmTjs: number | null;
}

/** Та же проверка в памяти — для чистых функций и страховки после запроса. */
export function isPlausibleSale(row: PlausibleRow, propertyType: string): boolean {
  if (row.priceTjs == null || row.priceTjs < MIN_SALE_PRICE_TJS) return false;
  if (propertyType === "APARTMENT" && row.areaSqm != null && row.areaSqm > 0) {
    if (row.pricePerSqmTjs == null || row.pricePerSqmTjs < MIN_PRICE_PER_SQM_TJS || row.pricePerSqmTjs > MAX_PRICE_PER_SQM_TJS) return false;
  }
  return true;
}

/**
 * Условие запроса. "APARTMENT" — цена не ниже порога и цена за м² в границах (при известной площади);
 * null — тип не задан («любой тип»): граница за м² действует только на квартиры, остальным — порог цены.
 */
export function plausibleSaleWhere(propertyType: string | null): Prisma.MarketListingWhereInput[] {
  const base: Prisma.MarketListingWhereInput = { priceTjs: { gte: MIN_SALE_PRICE_TJS } };
  const perSqm = { OR: [{ areaSqm: null }, { pricePerSqmTjs: { gte: MIN_PRICE_PER_SQM_TJS, lte: MAX_PRICE_PER_SQM_TJS } }] };
  if (propertyType === "APARTMENT") return [base, perSqm];
  if (propertyType === null) return [base, { OR: [{ propertyType: { not: "APARTMENT" } }, perSqm] }];
  return [base];
}

/** Среднее без крайних 10% с каждой стороны: два-три дорогих объекта не должны сдвигать «среднее». */
export const TRIM_SHARE = 0.1;
export function trimmedMean(sorted: number[], share = TRIM_SHARE): number {
  if (sorted.length === 0) return 0;
  const k = Math.floor(sorted.length * share);
  const kept = sorted.slice(k, sorted.length - k);
  return kept.reduce((s, v) => s + v, 0) / kept.length;
}

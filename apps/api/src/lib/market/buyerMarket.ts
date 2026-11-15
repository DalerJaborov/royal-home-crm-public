/**
 * РЫНОК ПОД ЗАПРОС ПОКУПАТЕЛЯ (14.11.2026): типичная цена объявлений в районе покупателя с его числом
 * комнат и как бюджет к ней относится. Для строки над списком «С площадок» в карточке клиента и для
 * инструмента помощницы «рынок под запрос клиента».
 *
 * ОДНА ДВЕРЬ. Сегмент считает segments.ts (порог MIN_SAMPLE = 8, выбросы, склейка дублей, медиана), условия
 * покупателя и бюджет в сомони — buyerMatch.ts (BuyerWants). Здесь только сопоставление: чисел НЕТ, пока
 * объявлений меньше порога, и сравнение бюджета с медианой — в процентах, округлённых по модулю
 * (как verdictFor), чтобы «+10%» не выглядел ошибкой рядом со словом «выше».
 * Объявления — не цены сделок: подпись остаётся на экране и в ответе помощницы.
 */
import type { MarketBuyerSummary } from "@royal-home/shared";
import type { BuyerWants } from "./buyerMatch.js";
import { MIN_SAMPLE } from "./comps.js";
import { findDistrictRoomsStat } from "./segments.js";

/** Бюджет для сравнения: середина вилки, если названы обе границы, иначе та, что есть. */
export function buyerBudgetForComparison(w: Pick<BuyerWants, "budgetMinTjs" | "budgetMaxTjs">): number | null {
  if (w.budgetMinTjs != null && w.budgetMaxTjs != null) return Math.round((w.budgetMinTjs + w.budgetMaxTjs) / 2);
  return w.budgetMaxTjs ?? w.budgetMinTjs ?? null;
}

/** Процент отклонения, округление по модулю: граница симметрична. */
export function percentVs(value: number, base: number): number {
  const raw = ((value - base) * 100) / base;
  return Math.sign(raw) * Math.round(Math.abs(raw)) + 0;
}

function emptySummary(w: BuyerWants, status: MarketBuyerSummary["status"], count: number): MarketBuyerSummary {
  return {
    status, districtName: w.districtName, rooms: w.rooms, count, minSample: MIN_SAMPLE,
    medianPerSqmTjs: null, medianPriceTjs: null, budgetTjs: buyerBudgetForComparison(w), budgetVsMedianPercent: null,
  };
}

/**
 * Рынок по желаниям покупателя. Сегменты считаются по квартирам (как таблица цен): желание другого типа
 * (дом, участок, коммерция) или без района/комнат — no_segment, без чисел.
 */
export async function findBuyerMarketSummary(w: BuyerWants): Promise<MarketBuyerSummary> {
  const apartmentWanted = w.propertyType == null || w.propertyType === "APARTMENT";
  if (!apartmentWanted || !w.districtName || !w.rooms) return emptySummary(w, "no_segment", 0);
  const stat = await findDistrictRoomsStat(w.city, w.districtName, w.rooms);
  if (!stat || !stat.enough || stat.medianPriceTjs == null) return emptySummary(w, "insufficient", stat?.count ?? 0);
  const budgetTjs = buyerBudgetForComparison(w);
  return {
    status: "ok",
    districtName: w.districtName,
    rooms: w.rooms,
    count: stat.count,
    minSample: MIN_SAMPLE,
    medianPerSqmTjs: stat.medianPerSqmTjs,
    medianPriceTjs: stat.medianPriceTjs,
    budgetTjs,
    budgetVsMedianPercent: budgetTjs != null && stat.medianPriceTjs > 0 ? percentVs(budgetTjs, stat.medianPriceTjs) : null,
  };
}

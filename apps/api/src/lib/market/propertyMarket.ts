/**
 * «ЦЕНА ОБЪЕКТА ПРОТИВ РЫНКА» — ОДНО МЕСТО СБОРКИ (14.11.2026).
 *
 * Раньше предмет сравнения (ремонт из состояния, признак новостройки, цена в сомони) собирался прямо в
 * routes/market.ts. Теперь тот же расчёт нужен помощнице Шабнам (инструмент «цена объекта против рынка»),
 * поэтому он живёт здесь, и роут, и инструмент зовут одну функцию: правило «одна дверь» — вердикт
 * (verdictFor), подбор похожих (findSimilar) и перевод в сомони (toTjs) остаются единственными.
 */
import type { MoneyContext } from "../money.js";
import { toTjs } from "../money.js";
import { emptyResult, findSimilar, verdictFor, type Repair, type SimilarResult } from "./similarComps.js";

/**
 * Состояние объекта → ремонт для подбора. NEW_BUILDING здесь НЕТ: «новостройка» в РТ —
 * признак дома (владелец 02.11.2026), а не ремонт; ремонт в этом случае неизвестен (null),
 * и подбор не режет по нему.
 */
export const CONDITION_TO_REPAIR: Record<string, Repair> = {
  NEEDS_REPAIR: "SHELL",
  GOOD: "PARTIAL",
  EXCELLENT: "RENOVATED",
};

/** Поля объекта, нужные для сравнения с рынком (подходит и строка Prisma, и запись поиска помощницы). */
export interface MarketPropertyFacts {
  id: string;
  type: string;
  rooms: number | null;
  areaSqm: unknown;
  floor: number | null;
  totalFloors: number | null;
  price: unknown;
  currency: string | null;
  condition: string | null;
  marketType: string | null;
  district: { name: string } | null;
}

/** Колонки Prisma под MarketPropertyFacts (для запросов, которые читают объект сами). */
export const PROPERTY_MARKET_SELECT = {
  id: true, type: true, rooms: true, areaSqm: true, floor: true, totalFloors: true, price: true, currency: true,
  condition: true, marketType: true, deletedAt: true, district: { select: { name: true } },
} as const;

export interface MarketSubjectBase {
  districtName: string | null;
  rooms: number | null;
  areaSqm: number;
  floor: number | null;
  totalFloors: number | null;
  repair: Repair | null;
  isNewBuilding: boolean | null;
  askingPriceTjs: number | null;
}

/** Предмет сравнения из объекта. Цена приводится к сомони общей функцией (lib/money.ts). */
export function buildMarketSubjectBase(p: MarketPropertyFacts, money: MoneyContext): MarketSubjectBase {
  const askingPriceTjs = p.price != null ? Math.round(toTjs(p.price as never, p.currency, money)) : null;
  return {
    districtName: p.district?.name ?? null,
    rooms: p.rooms,
    areaSqm: Number(p.areaSqm),
    floor: p.floor,
    totalFloors: p.totalFloors,
    repair: CONDITION_TO_REPAIR[p.condition ?? ""] ?? null,
    // «Новостройка» в РТ — признак дома (владелец 02.11.2026). Тип рынка не задан, а состояние
    // «новостройка» — значит новостройка; иначе не задано — не фильтруем.
    isNewBuilding: p.marketType != null ? p.marketType !== "SECONDARY" : p.condition === "NEW_BUILDING" ? true : null,
    askingPriceTjs,
  };
}

export interface PropertyMarketEvaluation extends Omit<SimilarResult, "status"> {
  status: SimilarResult["status"] | "unsupported";
  subject: MarketSubjectBase & { propertyType: string };
  comparison: ReturnType<typeof verdictFor> | null;
}

/**
 * Оценка объекта по аналогам: то же тело, что отдаёт GET /market/property/:id. Тип объекта без оценки
 * (не квартира и не дом, нет площади) — статус unsupported без чисел.
 */
export async function evaluatePropertyAgainstMarket(p: MarketPropertyFacts, money: MoneyContext): Promise<PropertyMarketEvaluation> {
  const base = buildMarketSubjectBase(p, money);
  if ((p.type !== "APARTMENT" && p.type !== "HOUSE") || !(base.areaSqm > 0)) {
    return {
      subject: { ...base, propertyType: p.type },
      ...emptyResult("для этого типа объекта рыночная оценка не считается"),
      status: "unsupported",
      comparison: null,
    };
  }
  const subject = { ...base, propertyType: p.type as "APARTMENT" | "HOUSE" };
  const result = await findSimilar(subject, { propertyId: p.id });
  return {
    subject,
    ...result,
    comparison: result.status === "ok" ? verdictFor(base.askingPriceTjs, result.estimatedPriceTjs) : null,
  };
}

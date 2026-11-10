import { z } from "zod";

/**
 * РЫНОК: ПОДБОР С ПЛОЩАДОК ПОКУПАТЕЛЮ И ЦЕНЫ ПО СЕГМЕНТАМ (10.11.2026).
 *
 * Общий договор сервера и экранов: схемы входа (Zod) и формы ответа. Правило «порог 8» живёт на
 * сервере (lib/market/comps.ts, MIN_SAMPLE) и приходит сюда числом `minSample` в ответе —
 * экран его не дублирует.
 */

/** Сколько объявлений с площадок показываем в подборе покупателя. */
export const MARKET_BUYER_LISTINGS_MAX = 10;

export const marketBuyerListingsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MARKET_BUYER_LISTINGS_MAX).default(MARKET_BUYER_LISTINGS_MAX),
  })
  .strict();
export type MarketBuyerListingsQuery = z.infer<typeof marketBuyerListingsQuerySchema>;

export interface MarketBuyerListing {
  /** Домен площадки: "somon.tj", "paydo.tj"… */
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
  /** Когда объявление опубликовано (если площадка отдаёт) иначе — когда мы его впервые увидели. */
  publishedAt: string;
  /** Чем оно близко к запросу: короткие подписи для строки («в бюджете», «2 комн.»). */
  fit: string[];
}

export type MarketBuyerListingsStatus = "ok" | "no_criteria" | "not_buyer" | "pending_acceptance";

export interface MarketBuyerListingsResponse {
  status: MarketBuyerListingsStatus;
  /** Что из запроса покупателя реально применено к выборке — сервер говорит словами. */
  criteria: string[];
  /** Сколько подходящих объявлений нашлось всего (после склейки дублей между площадками). */
  total: number;
  /** Бюджет, приведённый к сомони общим курсом, — чтобы экран не пересчитывал сам. */
  budgetMaxTjs: number | null;
  listings: MarketBuyerListing[];
}

export const MARKET_SEGMENT_REPAIRS = ["SHELL", "WHITE", "PARTIAL", "RENOVATED", "DESIGNER"] as const;
export type MarketSegmentRepair = (typeof MARKET_SEGMENT_REPAIRS)[number];

/** Ремонт словами — одно место для сервера (подбор похожих) и экрана «цены по сегментам». */
export const MARKET_REPAIR_LABEL: Record<MarketSegmentRepair, string> = {
  SHELL: "коробка",
  WHITE: "предчистовая",
  PARTIAL: "средний ремонт",
  RENOVATED: "с ремонтом",
  DESIGNER: "дизайнерский",
};

export const marketSegmentsQuerySchema = z
  .object({
    city: z.string().trim().min(1).max(60).default("Душанбе"),
    districtName: z.string().trim().min(1).max(80).optional(),
    rooms: z.coerce.number().int().min(1).max(10).optional(),
    repair: z.enum(MARKET_SEGMENT_REPAIRS).optional(),
    /** new — новостройка, secondary — вторичка; без параметра — оба. */
    building: z.enum(["new", "secondary"]).optional(),
  })
  .strict();
export type MarketSegmentsQuery = z.infer<typeof marketSegmentsQuerySchema>;

export interface MarketSegmentStat {
  /** Стабильный ключ строки: район|комнаты|ремонт. */
  key: string;
  districtName: string;
  rooms: number;
  /** null — в объявлениях ремонт не указан: это отдельный сегмент, а не «любой». */
  repair: MarketSegmentRepair | null;
  /** Число УНИКАЛЬНЫХ объявлений (один объект на двух площадках считается раз). */
  count: number;
  /** false — меньше minSample: чисел нет, экран пишет «Данных мало». */
  enough: boolean;
  medianPerSqmTjs: number | null;
  averagePerSqmTjs: number | null;
  medianPriceTjs: number | null;
  averagePriceTjs: number | null;
  /** Когда мы последний раз видели объявление этого сегмента. */
  freshestSeenAt: string;
  /** Сколько объявлений сегмента появилось за последние 7 дней. */
  newLast7Days: number;
}

export interface MarketSegmentsResponse {
  minSample: number;
  windowDays: number;
  city: string;
  /** Источники, по которым считали, с числом объявлений (до склейки дублей). */
  sources: { source: string; count: number }[];
  /** true — выборка упёрлась в предел: цифры по самым свежим объявлениям, а не по всем. */
  truncated: boolean;
  segments: MarketSegmentStat[];
}

import { z } from "zod";
import { CURRENCIES, MARKET_TYPES, PROPERTY_CONDITIONS, PROPERTY_TYPES } from "./enums.js";

/**
 * ФАКТЫ ОБ ОБЪЕКТЕ ПРОДАВЦА (владелец 21.09.2026: «всё, что продавец присылает и
 * говорит, само попадает в объект»).
 *
 * Отличие от `propertyDraft.ts` (PropertyDraftSuggestion): то — разовая подсказка
 * ИИ, собираемая платным вызовом при открытии формы. Здесь — накопленный снимок,
 * который фоновое задание обновляет по мере новых сообщений и расшифровок, а
 * мастер, чат и полоса продавца только ЧИТАЮТ из базы. ИИ при открытии экрана не
 * зовётся никогда — в этом вся экономия.
 *
 * Все поля nullable: «продавец этого не говорил» — нормальное состояние, и пустое
 * поле честнее догадки. Схема же — граница: JSON в базе писала прошлая версия
 * кода, поэтому при чтении он проходит safeParse, а не приведение типа.
 */
export const sellerObjectFactsSchema = z.object({
  type: z.enum(PROPERTY_TYPES).nullable(),
  rooms: z.number().int().nullable(),
  areaSqm: z.number().nullable(),
  /** Сотки — у дома и участка. */
  landAreaSotka: z.number().nullable(),
  floor: z.number().int().nullable(),
  totalFloors: z.number().int().nullable(),
  windowCount: z.number().int().nullable(),
  price: z.number().nullable(),
  currency: z.enum(CURRENCIES).nullable(),
  condition: z.enum(PROPERTY_CONDITIONS).nullable(),
  marketType: z.enum(MARKET_TYPES).nullable(),
  documents: z.string().nullable(),
  districtId: z.string().nullable(),
  /** «82 мкр., дом 14» / ориентир словами продавца. */
  address: z.string().nullable(),
  /** Из ориентира (lib/geoResolve.ts::resolveGeoText) или EXIF снимка. */
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  /** Что продавец сам рассказал об объекте, коротко. */
  description: z.string().nullable(),
});

export type SellerObjectFacts = z.infer<typeof sellerObjectFactsSchema>;

/** Пустой набор — точка отсчёта первого разбора и значение «ничего не известно». */
export const EMPTY_SELLER_OBJECT_FACTS: SellerObjectFacts = {
  type: null,
  rooms: null,
  areaSqm: null,
  landAreaSotka: null,
  floor: null,
  totalFloors: null,
  windowCount: null,
  price: null,
  currency: null,
  condition: null,
  marketType: null,
  documents: null,
  districtId: null,
  address: null,
  lat: null,
  lng: null,
  description: null,
};

/** Ответ GET /clients/:id/seller-object — полоса «Объект продавца» в чате. */
export interface SellerObjectSummary {
  clientId: string;
  isSeller: boolean;
  photoCount: number;
  planCount: number;
  videoCount: number;
  facts: SellerObjectFacts | null;
  /** Объекты, уже заведённые из этого продавца (без удалённых). */
  properties: { id: string; shortId: number; title: string }[];
}

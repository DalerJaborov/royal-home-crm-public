/**
 * РУБРИКИ SOMON — ОДНО МЕСТО ПРАВИЛА «ЭТО НЕДВИЖИМОСТЬ» (12.11.2026).
 *
 * Что случилось. Ручной полный обход 11.11.2026 записал в каталог ~13,5 тыс. чужих объявлений
 * (автозапчасти, окна-двери, ноутбуки, услуги сантехника) с типом «квартира/дом, продажа».
 * Причина (ФАКТ, живая страница 12.11.2026): адрес `/nedvizhimost/prodazha-domov/dushanbe/`
 * у Somon больше не раздел домов — сайт отдаёт по нему ОБЩУЮ ленту «Все объявления»
 * (`"rubric":{}`, `"url":"/search/dushanbe/"`, 9 326 страниц), и сборщик честно шёл по ней,
 * пока Somon не перестал отвечать. Раздел домов теперь
 * `/nedvizhimost/prodazha-domov-havli-i-dach/dushanbe/` (рубрика 218, 24 страницы).
 * Тип объекта при этом брался из ПРЕДКОВ рубрики по словам («kvartir», «dom»), а у чужой
 * рубрики не совпадало ничего — и всё падало в «по умолчанию квартира».
 *
 * Правило теперь: тип сделки и объекта даёт ТОЛЬКО номер рубрики из этого списка. Нет
 * рубрики в списке — объявление не наше: не пишется (сборщик, парсер лидов) и не читается
 * (оценка, сегменты, подбор, динамика, сверка с нашими объектами — `marketCatalogWhere`).
 *
 * Номера сверены 12.11.2026: 216/2829–2839 и 218 — по живым страницам разделов Somon,
 * остальные — по сырью объявлений, уже лежащих в каталоге (SQL прода, только чтение).
 */

import type { Prisma } from "../../generated/prisma/client.js";

export const SOMON_SOURCE = "somon.tj";

export type SomonDealType = "SALE" | "RENT";
export type SomonPropertyType = "APARTMENT" | "HOUSE" | "COMMERCIAL" | "LAND";

export interface SomonRubric {
  id: number;
  label: string;
  dealType: SomonDealType;
  propertyType: SomonPropertyType;
}

/** Все рубрики недвижимости Somon, которые каталог признаёт своими. Новая рубрика — строкой сюда. */
export const SOMON_REAL_ESTATE_RUBRICS: readonly SomonRubric[] = [
  { id: 2829, label: "Продажа квартир: 1 комната", dealType: "SALE", propertyType: "APARTMENT" },
  { id: 2831, label: "Продажа квартир: 2 комнаты", dealType: "SALE", propertyType: "APARTMENT" },
  { id: 2833, label: "Продажа квартир: 3 комнаты", dealType: "SALE", propertyType: "APARTMENT" },
  { id: 2835, label: "Продажа квартир: 4 комнаты", dealType: "SALE", propertyType: "APARTMENT" },
  { id: 2837, label: "Продажа квартир: 5 комнат", dealType: "SALE", propertyType: "APARTMENT" },
  { id: 2839, label: "Продажа квартир: 6 и больше комнат", dealType: "SALE", propertyType: "APARTMENT" },
  { id: 218, label: "Продажа домов (хавли) и дач", dealType: "SALE", propertyType: "HOUSE" },
  { id: 219, label: "Продажа земельных участков", dealType: "SALE", propertyType: "LAND" },
  { id: 326, label: "Продажа офисов и помещений", dealType: "SALE", propertyType: "COMMERCIAL" },
  { id: 2843, label: "Аренда квартир: 1 комната", dealType: "RENT", propertyType: "APARTMENT" },
  { id: 2845, label: "Аренда квартир: 2 комнаты", dealType: "RENT", propertyType: "APARTMENT" },
  { id: 2847, label: "Аренда квартир: 3 комнаты", dealType: "RENT", propertyType: "APARTMENT" },
  { id: 2849, label: "Аренда квартир: 4 комнаты", dealType: "RENT", propertyType: "APARTMENT" },
  { id: 2851, label: "Аренда квартир: 5 и больше комнат", dealType: "RENT", propertyType: "APARTMENT" },
  { id: 2394, label: "Аренда комнат", dealType: "RENT", propertyType: "APARTMENT" },
  { id: 325, label: "Аренда домов", dealType: "RENT", propertyType: "HOUSE" },
  { id: 3891, label: "Аренда дач", dealType: "RENT", propertyType: "HOUSE" },
  { id: 220, label: "Аренда офисов", dealType: "RENT", propertyType: "COMMERCIAL" },
];

const BY_ID = new Map(SOMON_REAL_ESTATE_RUBRICS.map((r) => [r.id, r]));

/** Рубрики продажи квартир (раздел 216 на сайте). */
export const SOMON_APARTMENT_SALE_RUBRIC_IDS: readonly number[] = SOMON_REAL_ESTATE_RUBRICS.filter(
  (r) => r.dealType === "SALE" && r.propertyType === "APARTMENT"
).map((r) => r.id);

/** Номер рубрики из сырого объявления Somon (`raw.rubric.id`); нет или не число — null. */
export function somonRubricId(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const rubric = (raw as { rubric?: unknown }).rubric;
  if (!rubric || typeof rubric !== "object") return null;
  const id = (rubric as { id?: unknown }).id;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : null;
}

/** Рубрика недвижимости объявления или null — объявление не из недвижимости (или рубрика неизвестна). */
export function somonRubricOf(raw: unknown): SomonRubric | null {
  const id = somonRubricId(raw);
  return id == null ? null : (BY_ID.get(id) ?? null);
}

export interface CatalogRowLike {
  source: string;
  raw?: unknown;
  dealType: string;
  propertyType: string;
}

/**
 * То же правило в памяти: строку каталога можно читать. Чужие площадки — да (у них свой разбор);
 * Somon — только рубрика из списка И записанные тип сделки/объекта совпадают с рубрикой (дом,
 * записанный старым разбором «квартирой», в цены квартир не попадает, пока его не перепишет обход).
 */
export function isReadableCatalogRow(row: CatalogRowLike): boolean {
  if (row.source !== SOMON_SOURCE) return true;
  const rubric = somonRubricOf(row.raw);
  return rubric != null && rubric.dealType === row.dealType && rubric.propertyType === row.propertyType;
}

/**
 * Условие запроса для КАЖДОГО чтения каталога (оценка, сегменты, подбор покупателю, динамика,
 * сверка с нашими объектами, счёт для защиты обхода от обрыва). Сторож —
 * tests/market-catalog-read-guard.test.ts: новый `prisma.marketListing.findMany/count/groupBy`
 * без этого условия не проходит проверку.
 *
 * Класть в `AND: [...]` запроса, а не разворачивать в корень: у условия свой `OR`.
 */
export function marketCatalogWhere(): Prisma.MarketListingWhereInput {
  const groups = new Map<string, SomonRubric[]>();
  for (const r of SOMON_REAL_ESTATE_RUBRICS) {
    const key = `${r.dealType}|${r.propertyType}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return {
    OR: [
      { source: { not: SOMON_SOURCE } },
      ...[...groups.values()].map((rubrics) => ({
        source: SOMON_SOURCE,
        dealType: rubrics[0].dealType,
        propertyType: rubrics[0].propertyType,
        OR: rubrics.map((r) => ({ raw: { path: ["rubric", "id"], equals: r.id } })),
      })),
    ],
  };
}

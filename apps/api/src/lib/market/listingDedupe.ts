/**
 * «ЭТО НОВОЕ ИЛИ УЖЕ ЕСТЬ?» — ПОИСК ТОГО ЖЕ ОБЪЯВЛЕНИЯ В БАЗЕ.
 *
 * У объявлений с сайтов дубль ловится ключом `source + sourceId`: сайт сам даёт
 * идентификатор. У объявления, присланного сотрудником, такого ключа нет вовсе —
 * один и тот же пост он может переслать дважды, а тот же объект другой сотрудник
 * увидит на somon.tj под чужим номером. Поэтому дубль здесь ищется по СМЫСЛУ.
 *
 * ПОРЯДОК ПРАВИЛ — ПО НАДЁЖНОСТИ, А НЕ ПО УДОБСТВУ.
 *
 * 1. Телефон. Номер — единственное, что действительно принадлежит объявлению, а
 *    не его описанию: площадь округляют, цену пишут «950» и «950000», район
 *    называют по-разному, а номер один. Совпал номер — это тот же продавец; если
 *    при этом сходятся площадь и цена, это то же самое объявление.
 * 2. Район + комнаты + площадь + цена. Работает без телефона (его в посте часто
 *    нет), но слабее: две одинаковые квартиры в одном доме различить нельзя. Здесь
 *    ответ и звучит осторожнее — «похоже, уже есть».
 *
 * ПОЧЕМУ ДОПУСКИ УЗКИЕ. ±3 м² и ±5% — это разные записи ОДНОГО объекта (округлили
 * площадь, скинули на торге), а не «похожие квартиры». Расширить их значило бы
 * склеивать разные объекты в один, а это ошибка необратимая: второе объявление
 * просто не будет создано, и в медиане района его не окажется.
 */

import { prisma } from "../../db.js";
import { marketCatalogWhere } from "./somonRubrics.js";

/** Насколько может разойтись площадь одного и того же объекта в двух записях. */
const AREA_TOLERANCE_SQM = 3;
/** И цена — торг и округление до «красивого» числа укладываются в эти проценты. */
const PRICE_TOLERANCE = 0.05;

/** Предел выборки кандидатов: их единицы, а массив без предела — это рано или поздно вся таблица. */
const CANDIDATE_LIMIT = 50;

export interface DedupeQuery {
  sellerPhone: string | null;
  areaSqm: number | null;
  /** Цена ОБЯЗАТЕЛЬНО в сомони: сравнивать доллары с сомони напрямую нельзя. */
  priceTjs: number | null;
  districtName: string | null;
  rooms: number | null;
  city?: string;
  dealType?: string;
}

export interface DuplicateMatch {
  id: string;
  source: string;
  sourceUrl: string;
  firstSeenAt: Date;
  priceTjs: number | null;
  /** По какому правилу совпало — уходит прямо в ответ сотруднику. */
  reason: "phone" | "params";
}

/** Совпадают ли два числа с точностью до допуска. Пропуск с любой стороны — это НЕ совпадение:
 *  «неизвестно» нельзя засчитывать в пользу склейки, иначе разные объекты сольются в один. */
function within(a: number | null, b: number | null, tolerance: number): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= tolerance;
}

function withinPercent(a: number | null, b: number | null, share: number): boolean {
  if (a == null || b == null || a <= 0 || b <= 0) return false;
  return Math.abs(a - b) / Math.max(a, b) <= share;
}

export async function findDuplicateListing(query: DedupeQuery): Promise<DuplicateMatch | null> {
  const city = query.city ?? "Душанбе";

  // Правило 1: тот же телефон. Поле проиндексировано, поэтому это самый дешёвый
  // из двух запросов — и самый надёжный, потому он и первый.
  if (query.sellerPhone) {
    const bySeller = await prisma.marketListing.findMany({
      where: { sellerPhone: query.sellerPhone, AND: [marketCatalogWhere()] },
      select: { id: true, source: true, sourceUrl: true, firstSeenAt: true, priceTjs: true, areaSqm: true },
      orderBy: { lastSeenAt: "desc" },
      take: CANDIDATE_LIMIT,
    });
    for (const row of bySeller) {
      const area = row.areaSqm != null ? Number(row.areaSqm) : null;
      const price = row.priceTjs != null ? Number(row.priceTjs) : null;
      if (within(area, query.areaSqm, AREA_TOLERANCE_SQM) && withinPercent(price, query.priceTjs, PRICE_TOLERANCE)) {
        return { ...row, priceTjs: price, reason: "phone" };
      }
    }
  }

  // Правило 2: те же параметры. Диапазоны считаем в запросе, а не перебором в
  // памяти: иначе на район с тысячей объявлений это превратилось бы в выгрузку
  // всего района ради двух строк.
  if (query.districtName && query.rooms != null && query.areaSqm != null && query.priceTjs != null) {
    const byParams = await prisma.marketListing.findMany({
      where: {
        city,
        districtName: query.districtName,
        rooms: query.rooms,
        ...(query.dealType ? { dealType: query.dealType } : {}),
        areaSqm: { gte: query.areaSqm - AREA_TOLERANCE_SQM, lte: query.areaSqm + AREA_TOLERANCE_SQM },
        priceTjs: {
          gte: query.priceTjs * (1 - PRICE_TOLERANCE),
          lte: query.priceTjs * (1 + PRICE_TOLERANCE),
        },
        AND: [marketCatalogWhere()],
      },
      select: { id: true, source: true, sourceUrl: true, firstSeenAt: true, priceTjs: true },
      orderBy: { lastSeenAt: "desc" },
      take: CANDIDATE_LIMIT,
    });
    const row = byParams[0];
    if (row) return { ...row, priceTjs: row.priceTjs != null ? Number(row.priceTjs) : null, reason: "params" };
  }

  return null;
}

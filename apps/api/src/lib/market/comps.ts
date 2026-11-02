/**
 * ОЦЕНКА ПО АНАЛОГАМ: сколько стоит такая квартира на рынке.
 *
 * ТРИ ПРАВИЛА, БЕЗ КОТОРЫХ ЭТИМ НИКТО НЕ СТАНЕТ ПОЛЬЗОВАТЬСЯ.
 *
 * 1. МЕДИАНА, А НЕ СРЕДНЕЕ. Одна элитка за два миллиона или одна опечатка в
 *    разрядах сдвигают среднее так, что число перестаёт что-либо значить.
 *    Медиана — «столько стоит типичная такая квартира», и её не жалко показать
 *    собственнику на встрече.
 *
 * 2. МАЛО ДАННЫХ — МОЛЧИМ. Показав агенту уверенную цифру, посчитанную по трём
 *    объявлениям, мы теряем доверие ко всей функции навсегда: он один раз
 *    увидит чушь и больше не откроет. Поэтому есть порог, и ниже него ответ —
 *    честное «данных мало», без числа.
 *
 * 3. ВИДНО, НА ЧЁМ СЧИТАЛИ. Вместе с числом всегда возвращается основание
 *    («медиана по 14 объявлениям: Сино, 3-комнатные, 70–90 м²») и сами
 *    объявления со ссылками. Цифра, которую нельзя проверить, — это чёрный
 *    ящик, а не инструмент (требование владельца 21.08.2026).
 */

import { prisma } from "../../db.js";

/** Ниже этого числа сопоставимых объявлений цифру не показываем вовсе. */
export const MIN_SAMPLE = 8;

/** Порог вердикта «в рынке», % к середине рынка (владелец 02.11.2026). */
export const VERDICT_THRESHOLD_PERCENT = 10;

export interface CompsQuery {
  districtName?: string | null;
  rooms?: number | null;
  areaSqm?: number | null;
  city?: string;
}

export interface CompListing {
  sourceUrl: string;
  source: string;
  title: string;
  rooms: number | null;
  areaSqm: number | null;
  floor: number | null;
  districtName: string | null;
  landmark: string | null;
  priceTjs: number | null;
  pricePerSqmTjs: number | null;
  isAgency: boolean;
  negotiable: boolean;
  photoCount: number;
}

export interface CompsResult {
  /** null — сопоставимых объявлений слишком мало, число показывать нельзя. */
  medianPerSqm: number | null;
  p25PerSqm: number | null;
  p75PerSqm: number | null;
  /** Оценка полной стоимости для заданной площади (медиана × площадь). */
  estimatedPriceTjs: number | null;
  sampleSize: number;
  /** Человеческое описание выборки — показывается рядом с числом. */
  basis: string;
  /** Ступень, на которой удалось набрать выборку (для отладки и подписи). */
  level: "exact" | "district_rooms" | "district" | "city_rooms" | "none";
  /** Сами объявления со ссылками — чтобы агент мог проверить и позвонить. */
  listings: CompListing[];
}

/** Свежесть: объявление, которого не видели месяц, — это уже не рынок. */
const FRESH_DAYS = 45;

/**
 * Сколько лет объявление ещё считается рынком.
 *
 * Отдельно от FRESH_DAYS, потому что это про РАЗНОЕ. FRESH_DAYS — «мы его давно
 * не видели в выдаче». А это — «объявление до сих пор висит, но опубликовано
 * пять лет назад». Живой случай: в ленте rg.tj вперемешку лежат объявления с
 * февраля 2021 года, они прекрасно отдаются сегодня и по FRESH_DAYS проходят
 * как свежие — но цены в них позапрошлые, и медиану они тянут вниз.
 *
 * Где даты нет (somon.tj отдаёт её словами «Вчера»), объявление не отбрасываем:
 * там лента и так состоит из активных, а выбросить всё без даты значило бы
 * остаться без основного источника.
 */
const MAX_AGE_YEARS = 2;

interface Level {
  name: CompsResult["level"];
  describe: (q: CompsQuery) => string;
  where: (q: CompsQuery) => Record<string, unknown> | null;
}

/**
 * ЛЕСТНИЦА РАСШИРЕНИЯ. Идём сверху вниз и останавливаемся на первой ступени,
 * где набралось достаточно объявлений: чем выше ступень, тем ближе аналоги.
 *
 * Площадь ±15%, а не «точно такая»: квартир ровно в 82 м² на рынке единицы, а
 * 70–95 м² — это те же самые квартиры по сути.
 */
const LEVELS: Level[] = [
  {
    name: "exact",
    describe: (q) =>
      `${q.districtName}, ${q.rooms}-комнатные, ${Math.round((q.areaSqm ?? 0) * 0.85)}–${Math.round((q.areaSqm ?? 0) * 1.15)} м²`,
    where: (q) =>
      q.districtName && q.rooms && q.areaSqm
        ? {
            districtName: q.districtName,
            rooms: q.rooms,
            areaSqm: { gte: q.areaSqm * 0.85, lte: q.areaSqm * 1.15 },
          }
        : null,
  },
  {
    name: "district_rooms",
    describe: (q) => `${q.districtName}, ${q.rooms}-комнатные (площадь любая)`,
    where: (q) => (q.districtName && q.rooms ? { districtName: q.districtName, rooms: q.rooms } : null),
  },
  {
    name: "district",
    describe: (q) => `${q.districtName}, квартиры любой комнатности`,
    where: (q) => (q.districtName ? { districtName: q.districtName } : null),
  },
  {
    name: "city_rooms",
    describe: (q) => `весь город, ${q.rooms}-комнатные`,
    where: (q) => (q.rooms ? { rooms: q.rooms } : null),
  },
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Считает рыночную оценку по аналогам.
 *
 * Только ПРОДАЖА КВАРТИР: аренду и дома в расчёт не берём. Смешивать месячную
 * плату с ценой покупки нельзя вовсе, а дома несопоставимы между собой —
 * участок и постройка гуляют так, что медиана врёт (решение владельца).
 */
export async function estimateFromComps(query: CompsQuery): Promise<CompsResult> {
  const city = query.city ?? "Душанбе";
  const freshSince = new Date(Date.now() - FRESH_DAYS * 24 * 3600_000);
  const oldestAllowed = new Date(Date.now() - MAX_AGE_YEARS * 365 * 24 * 3600_000);

  for (const level of LEVELS) {
    const extra = level.where(query);
    if (!extra) continue;

    const rows = await prisma.marketListing.findMany({
      where: {
        dealType: "SALE",
        propertyType: "APARTMENT",
        city,
        isActive: true,
        lastSeenAt: { gte: freshSince },
        pricePerSqmTjs: { not: null },
        // Либо дата публикации свежая, либо её у источника нет вовсе.
        OR: [{ publishedAt: null }, { publishedAt: { gte: oldestAllowed } }],
        ...extra,
      },
      select: {
        sourceUrl: true,
        source: true,
        title: true,
        rooms: true,
        areaSqm: true,
        floor: true,
        districtName: true,
        landmark: true,
        priceTjs: true,
        pricePerSqmTjs: true,
        isAgency: true,
        negotiable: true,
        photoCount: true,
      },
      orderBy: { pricePerSqmTjs: "asc" },
      // Предел выборки: медиане больше и не нужно, а тащить в память весь район незачем.
      take: 500,
    });

    if (rows.length < MIN_SAMPLE) continue;

    /**
     * ОБЪЕКТ ДОЛЖЕН БЫТЬ СОПОСТАВИМ С ВЫБОРКОЙ, А НЕ ПРОСТО ПОПАСТЬ В НЕЁ.
     *
     * Живой случай при проверке: для 9-комнатной в 400 м² точных аналогов нет,
     * лестница расширилась до «любые квартиры Сино» — и выдала уверенную оценку,
     * посчитанную по типовым двушкам 60–80 м². Цена за квадрат у дворца и у
     * типовой квартиры разная, так что число получилось убедительным и неверным
     * — ровно то, что убивает доверие к функции навсегда.
     *
     * Поэтому на расширенных ступенях проверяем: площадь объекта должна попадать
     * в основной диапазон выборки. Не попадает — эта ступень не годится, идём
     * дальше, а если не годится ни одна, честно отвечаем «данных мало».
     */
    if (level.name !== "exact" && query.areaSqm) {
      const areas = rows
        .map((r) => (r.areaSqm != null ? Number(r.areaSqm) : NaN))
        .filter((v) => Number.isFinite(v))
        .sort((a, b) => a - b);
      if (areas.length >= MIN_SAMPLE) {
        const lo = percentile(areas, 0.1);
        const hi = percentile(areas, 0.9);
        if (query.areaSqm < lo || query.areaSqm > hi) continue;
      }
    }

    const values = rows
      .map((r) => Number(r.pricePerSqmTjs))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);

    const median = Math.round(percentile(values, 0.5));
    const listings: CompListing[] = rows.map((r) => ({
      ...r,
      areaSqm: r.areaSqm != null ? Number(r.areaSqm) : null,
      priceTjs: r.priceTjs != null ? Number(r.priceTjs) : null,
      pricePerSqmTjs: r.pricePerSqmTjs != null ? Number(r.pricePerSqmTjs) : null,
    }));

    return {
      medianPerSqm: median,
      p25PerSqm: Math.round(percentile(values, 0.25)),
      p75PerSqm: Math.round(percentile(values, 0.75)),
      estimatedPriceTjs: query.areaSqm ? Math.round(median * query.areaSqm) : null,
      sampleSize: values.length,
      basis: `медиана по ${values.length} объявлениям: ${level.describe(query)}`,
      level: level.name,
      listings,
    };
  }

  return {
    medianPerSqm: null,
    p25PerSqm: null,
    p75PerSqm: null,
    estimatedPriceTjs: null,
    sampleSize: 0,
    basis: "данных для честной оценки мало — похожих объявлений на рынке почти нет",
    level: "none",
    listings: [],
  };
}

/**
 * Насколько названная цена отличается от рынка.
 *
 * Отдельной функцией, потому что вопрос «дорого или дёшево» задают в двух местах
 * с разных сторон: на карточке лида — про то, что назвал клиент, на карточке
 * объекта — про то, что просит собственник.
 */
export function comparePrice(
  priceTjs: number,
  comps: CompsResult
): { verdict: "below" | "market" | "above" | "unknown"; diffPercent: number | null } {
  if (!comps.estimatedPriceTjs) return { verdict: "unknown", diffPercent: null };
  const diff = ((priceTjs - comps.estimatedPriceTjs) / comps.estimatedPriceTjs) * 100;
  // ±10% (владелец 02.11.2026) — это торг, а не «дорого»: внутри вилки объявления стоят вперемешку.
  const verdict = diff < -VERDICT_THRESHOLD_PERCENT ? "below" : diff > VERDICT_THRESHOLD_PERCENT ? "above" : "market";
  return { verdict, diffPercent: Math.round(diff) };
}

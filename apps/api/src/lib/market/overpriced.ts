/**
 * «НАШИ ОБЪЕКТЫ ДОРОЖЕ РЫНКА» (14.11.2026): список для директора и маркетолога — какие квартиры в продаже
 * просят больше, чем в среднем просят на площадках. Это повод поговорить с собственником о цене.
 *
 * КАК СЧИТАЕМ. Сегменты рынка (район × комнаты, при известном ремонте — ещё и ремонт) строятся ОДНИМ
 * запросом на город (segments.ts, buildMarketIndex), дальше сравнение идёт в памяти: N+1 нет. Ориентир
 * объекта = медианная цена за м² сегмента × площадь объекта; вердикт — тот же verdictFor, что в карточке
 * (порог ±10%, одно место). Сегмент меньше порога (MIN_SAMPLE = 8) — объект в списке не участвует и
 * считается «без данных»: числа по трём объявлениям не показываем.
 *
 * ЧЕСТНО О ТОЧНОСТИ. Карточка объекта считает точнее: подбирает похожие по площади, этажу и признаку
 * новостройки (findSimilar). Здесь — быстрая прикидка по сегменту, поэтому экран отправляет за точным
 * разбором в карточку. Цены объявлений — не цены сделок.
 */
import type { MarketOverpricedItem, MarketOverpricedResponse } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { loadMoneyContext, toTjs, type MoneyContext } from "../money.js";
import { MIN_SAMPLE, VERDICT_THRESHOLD_PERCENT } from "./comps.js";
import { CONDITION_TO_REPAIR } from "./propertyMarket.js";
import { buildMarketIndex, loadSegmentRows, lookupMarketSegment, type MarketIndex } from "./segments.js";
import { MARKET_REPAIR_LABEL } from "@royal-home/shared";
import { verdictFor } from "./similarComps.js";

/** Предел выборки наших объектов; сверх него — самые свежие, ответ помечается truncated. */
export const OVERPRICED_PROPERTY_LIMIT = 2000;
/** Сколько строк списка отдаём (самые дорогие относительно рынка). */
export const OVERPRICED_MAX_ITEMS = 100;

export interface OverpricedCandidate {
  id: string;
  shortId: number;
  title: string;
  rooms: number;
  areaSqm: number;
  askingPriceTjs: number;
  condition: string | null;
  districtName: string;
}

/** Чистая часть: кандидаты + индекс рынка → строки списка. Без БД — тестируется отдельно. */
export function pickOverpriced(
  candidates: OverpricedCandidate[],
  index: MarketIndex
): { items: MarketOverpricedItem[]; withoutData: number } {
  const items: MarketOverpricedItem[] = [];
  let withoutData = 0;
  for (const c of candidates) {
    const repair = CONDITION_TO_REPAIR[c.condition ?? ""] ?? null;
    const hit = lookupMarketSegment(index, c.districtName, c.rooms, repair);
    if (!hit || hit.stat.medianPerSqmTjs == null) {
      withoutData++;
      continue;
    }
    const estimated = Math.round(hit.stat.medianPerSqmTjs * c.areaSqm);
    const { verdict, diffPercent } = verdictFor(c.askingPriceTjs, estimated);
    if (verdict !== "above" || diffPercent == null) continue;
    items.push({
      propertyId: c.id,
      shortId: c.shortId,
      title: c.title,
      districtName: c.districtName,
      rooms: c.rooms,
      areaSqm: c.areaSqm,
      askingPriceTjs: c.askingPriceTjs,
      estimatedPriceTjs: estimated,
      diffPercent,
      sampleSize: hit.stat.count,
      basis: `${c.districtName}, ${c.rooms}-комнатные${hit.byRepair && repair ? `, ${MARKET_REPAIR_LABEL[repair]}` : ""}`,
    });
  }
  // Сначала самые завышенные; при равенстве — свежий номер выше, чтобы порядок был стабильным.
  items.sort((a, b) => b.diffPercent - a.diffPercent || b.shortId - a.shortId);
  return { items, withoutData };
}

export function toOverpricedCandidate(
  p: { id: string; shortId: number; title: string; rooms: number | null; areaSqm: unknown; price: unknown; currency: string | null; condition: string | null; district: { name: string } | null },
  money: MoneyContext
): OverpricedCandidate | null {
  const area = Number(p.areaSqm);
  if (p.rooms == null || p.rooms < 1 || !(area > 0) || p.price == null || !p.district) return null;
  const asking = Math.round(toTjs(p.price as never, p.currency, money));
  if (!(asking > 0)) return null;
  return { id: p.id, shortId: p.shortId, title: p.title, rooms: p.rooms, areaSqm: area, askingPriceTjs: asking, condition: p.condition, districtName: p.district.name };
}

export async function findOverpricedProperties(): Promise<MarketOverpricedResponse> {
  const [props, money] = await Promise.all([
    prisma.property.findMany({
      where: { status: "AVAILABLE", deletedAt: null, type: "APARTMENT" },
      select: {
        id: true, shortId: true, title: true, rooms: true, areaSqm: true, price: true, currency: true, condition: true,
        district: { select: { name: true, city: true } },
      },
      orderBy: { createdAt: "desc" },
      take: OVERPRICED_PROPERTY_LIMIT,
    }),
    loadMoneyContext(),
  ]);

  // Один запрос рынка на город (обычно один): сравнение дальше — только в памяти.
  const byCity = new Map<string, OverpricedCandidate[]>();
  for (const p of props) {
    const c = toOverpricedCandidate(p, money);
    if (!c) continue;
    const city = p.district?.city ?? "Душанбе";
    byCity.set(city, [...(byCity.get(city) ?? []), c]);
  }
  const all: MarketOverpricedItem[] = [];
  let withoutData = 0;
  let checked = 0;
  for (const [city, candidates] of byCity) {
    const { rows } = await loadSegmentRows({ city });
    const picked = pickOverpriced(candidates, buildMarketIndex(rows));
    all.push(...picked.items);
    withoutData += picked.withoutData;
    checked += candidates.length;
  }
  all.sort((a, b) => b.diffPercent - a.diffPercent || b.shortId - a.shortId);
  return {
    minSample: MIN_SAMPLE,
    thresholdPercent: VERDICT_THRESHOLD_PERCENT,
    checked,
    withoutData,
    truncated: props.length >= OVERPRICED_PROPERTY_LIMIT,
    items: all.slice(0, OVERPRICED_MAX_ITEMS),
  };
}

/**
 * Кэш на сервере: список считается по всему каталогу (до 20 000 строк на город), а меняется он медленно, поэтому
 * открытие страницы «Рынок» разными сотрудниками не должно каждый раз заново проходить весь каталог. Один ответ
 * на всех (в нём нет данных, зависящих от человека), живёт OVERPRICED_CACHE_MS; свежее значение берёт первый запрос после срока.
 */
export const OVERPRICED_CACHE_MS = 10 * 60_000;
let cache: { at: number; body: MarketOverpricedResponse } | null = null;
let inflight: Promise<MarketOverpricedResponse> | null = null;

export function resetOverpricedCache(): void {
  cache = null;
  inflight = null;
}

export async function findOverpricedPropertiesCached(now: number = Date.now()): Promise<MarketOverpricedResponse> {
  if (cache && now - cache.at < OVERPRICED_CACHE_MS) return cache.body;
  // Параллельные запросы в момент протухания делят один расчёт.
  inflight ??= findOverpricedProperties()
    .then((body) => {
      cache = { at: now, body };
      return body;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

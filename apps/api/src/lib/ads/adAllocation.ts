import type { AdMatchSource } from "../../generated/prisma/client.js";
import { prisma, type TxClient } from "../../db.js";
import { splitCents } from "../money.js";

/**
 * ОДИН ИСТОЧНИК ПРАВДЫ: КАКОЙ ОБЪЕКТ СКОЛЬКО ИЗ ОБЪЯВЛЕНИЯ ЗАБИРАЕТ (03.10.2026).
 *
 * Объявление Meta в «гибком» формате несёт несколько роликов про разные квартиры, и
 * деньги объявления надо делить между объектами. Деление и запись доли живут ТОЛЬКО
 * здесь, чтобы отчёт по объектам, доска объявлений, плашка в карточке и сторож
 * сверки считали одно и то же:
 *
 *   — `setAdProperties` — единственное место, где пишутся AdProperty и Ad.propertyId
 *     (в одной транзакции, иначе два источника правды разойдутся);
 *   — `detachPropertyFromAds` — то же при удалении объекта навсегда;
 *   — `allocateCents`  — деление суммы по весам без потери цента;
 *   — `loadAdAllocations` — доли списка объявлений одним запросом.
 *
 * ЗАПАСНОЙ ПУТЬ. Строка Ad, у которой есть propertyId, но нет ни одной AdProperty
 * (заведена до миграции или напрямую, мимо хелпера), читается как одна доля с
 * весом 1: деньги не теряются, пока бэкфилл не догнал.
 */

export interface AllocationItem {
  propertyId: string;
  /** Относительный вес (> 0). */
  weight: number;
}

export interface AllocatedShare {
  propertyId: string;
  weight: number;
  /** Доля в целых сотых от разделённой суммы. */
  cents: number;
}

/**
 * Делит `totalCents` по весам методом наибольшего остатка: сумма долей РАВНА входу
 * при любых весах и суммах. Работает и с целыми счётчиками (показы, обращения) —
 * это те же «сотые», просто единицы.
 *
 * Порядок результата — порядок `items`. Некорректные веса (≤ 0, NaN) не получают
 * ничего; если корректных весов нет вовсе, делим поровну — деньги нельзя потерять
 * из-за кривого веса. Пустой список — пустой результат.
 */
export function allocateCents(totalCents: number, items: readonly AllocationItem[]): AllocatedShare[] {
  if (items.length === 0) return [];
  const valid = items.map((i) => Number.isFinite(i.weight) && i.weight > 0);
  const weights = valid.some(Boolean) ? items.map((i, k) => (valid[k] ? i.weight : 0)) : items.map(() => 1);
  const parts = splitCents(totalCents, weights);
  // Страховка от двоичной арифметики: при «почти целом» точном значении пол мог
  // округлиться вверх, и сумма долей разошлась бы с входом на цент. Остаток
  // относим самой тяжёлой доле — инвариант «сумма = вход» держится безусловно.
  const drift = Math.round(totalCents) - parts.reduce((acc, v) => acc + v, 0);
  if (drift !== 0) {
    let heaviest = 0;
    weights.forEach((w, k) => {
      if (w > weights[heaviest]) heaviest = k;
    });
    parts[heaviest] += drift;
  }
  return items.map((i, k) => ({ propertyId: i.propertyId, weight: weights[k], cents: parts[k] }));
}

/** Основной объект — первый по весу; при равных весах — первый в списке. */
export function primaryOf<T extends { weight: number }>(items: readonly T[]): T | null {
  let best: T | null = null;
  for (const item of items) if (!best || item.weight > best.weight) best = item;
  return best;
}

export interface SetAdPropertiesOptions {
  /**
   * Режим «неполных данных» (откат синхронизации на базовые поля креатива, когда Meta
   * отказала на asset_feed_spec): связи ТОЛЬКО ДОБАВЛЯЮТСЯ, ничего не удаляется и у
   * существующих не меняется вес. Иначе «гибкое» объявление с четырьмя связями теряло
   * три из них — по неполному ответу нельзя заключить, что остальные ролики пропали.
   */
  additive?: boolean;
  /**
   * Машинная запись (синхронизация): перечитать matchSource внутри транзакции и выйти,
   * ничего не меняя, если там MANUAL. Ручные вызовы (PATCH маркетолога, тесты) этот флаг
   * не ставят и пишут всегда — решение человека сильнее.
   */
  respectManual?: boolean;
}

/**
 * Единственная запись связи «объявление → объекты». Разность с текущим состоянием:
 * лишнее удаляется, изменившееся обновляется, совпавшее не трогается — синхронизация
 * идёт каждые 15 минут по сотням объявлений, и переписывать неизменное значило бы
 * гонять базу вхолостую и ломать createdAt.
 *
 * Пустой список снимает привязку (и matchSource — возвращает объявление машине).
 * Повторяющийся объект в списке схлопывается, веса складываются.
 *
 * ГОНКИ. Запись идёт под блокировкой строки объявления (`FOR UPDATE`): ручная правка
 * маркетолога и фоновая синхронизация не пишут связи одного объявления одновременно.
 * Машинная запись с `respectManual` (синхронизация) перечитывает matchSource ВНУТРИ транзакции и
 * выходит, если за время матчинга человек успел привязать объявление руками — решение
 * «трогать ли ручное» принимается здесь, а не по значению, прочитанному до долгого
 * `await matcher.matchAll`. Создание связи — upsert: параллельный прогон не падает на
 * уникальном ключе (объявление, объект).
 */
export async function setAdProperties(
  adId: string,
  items: readonly (AllocationItem & { source?: AdMatchSource })[],
  source: AdMatchSource,
  options: SetAdPropertiesOptions = {}
): Promise<{ propertyId: string | null }> {
  const merged = new Map<string, number>();
  /** Чем доказана каждая связь: у каждой строки свой источник (ролик — по посту, соседний — по названию). */
  const sourceOf = new Map<string, AdMatchSource>();
  for (const item of items) {
    if (!Number.isFinite(item.weight) || item.weight <= 0) continue;
    merged.set(item.propertyId, (merged.get(item.propertyId) ?? 0) + item.weight);
    if (!sourceOf.has(item.propertyId)) sourceOf.set(item.propertyId, item.source ?? source);
  }
  // Колонка хранит три знака после запятой: приводим заранее, иначе сравнение
  // «изменился ли вес» вечно видело бы двоичный хвост.
  for (const [propertyId, weight] of merged) {
    const rounded = Math.round(weight * 1000) / 1000;
    if (rounded > 0) merged.set(propertyId, rounded);
    else merged.delete(propertyId);
  }
  const desired = Array.from(merged, ([propertyId, weight]) => ({
    propertyId,
    weight,
    source: sourceOf.get(propertyId) ?? source,
  }));
  const additive = options.additive === true;

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ propertyId: string | null; matchSource: AdMatchSource | null }[]>`
      SELECT "propertyId", "matchSource" FROM "Ad" WHERE id = ${adId} FOR UPDATE`;
    const ad = locked[0];
    if (!ad) return { propertyId: null };
    // Машина не перезаписывает руку человека — проверка ВНУТРИ блокировки.
    if (options.respectManual && source !== "MANUAL" && ad.matchSource === "MANUAL") {
      return { propertyId: ad.propertyId };
    }

    const current = await tx.adProperty.findMany({
      where: { adId },
      select: { id: true, propertyId: true, weight: true, source: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const byProperty = new Map(current.map((r) => [r.propertyId, r]));

    if (!additive) {
      const dropIds = current.filter((r) => !merged.has(r.propertyId)).map((r) => r.id);
      if (dropIds.length > 0) await tx.adProperty.deleteMany({ where: { id: { in: dropIds } } });
    }

    for (const d of desired) {
      const row = byProperty.get(d.propertyId);
      if (!row) {
        await tx.adProperty.upsert({
          where: { adId_propertyId: { adId, propertyId: d.propertyId } },
          create: { adId, propertyId: d.propertyId, weight: d.weight, source: d.source },
          update: additive ? {} : { weight: d.weight, source: d.source },
        });
      } else if (!additive && (Number(row.weight) !== d.weight || row.source !== d.source)) {
        await tx.adProperty.update({ where: { id: row.id }, data: { weight: d.weight, source: d.source } });
      }
    }

    // Итоговый набор связей — от него зависит основной объект.
    const finalRows = additive
      ? [
          ...current.map((r) => ({ propertyId: r.propertyId, weight: Number(r.weight), source: r.source })),
          ...desired.filter((d) => !byProperty.has(d.propertyId)),
        ]
      : desired;
    const primaryRow = primaryOf(finalRows);
    const primary = primaryRow?.propertyId ?? null;

    // Ad.propertyId / matchSource — только отсюда. Пишем всегда: это один UPDATE по
    // ключу, а проверка «изменилось ли» стоила бы такого же запроса.
    await tx.ad.update({
      where: { id: adId },
      data: { propertyId: primary, matchSource: primaryRow ? primaryRow.source : null },
    });
    return { propertyId: primary };
  });
}

/** Что случилось с одним объявлением, когда из него пропал объект (удаление объекта навсегда). */
export interface DetachedAd {
  adId: string;
  /** Сколько связей осталось у объявления. */
  remaining: number;
  /** Новый основной объект (по весу) или null, если связей не осталось. */
  propertyId: string | null;
  /** Ручная ли была привязка: такое объявление сторож сверки «решённым» считает, значит о нём пишем в аудит. */
  manual: boolean;
}

/**
 * ОБЪЕКТ УДАЛЯЕТСЯ НАВСЕГДА — что делать с его объявлениями (ревью 03.10.2026, п. 3).
 *
 * Каскад базы (AdProperty.onDelete = Cascade) молча стирал строку, а Ad.propertyId
 * обнулялся (SetNull) даже при живых связях: доля удалённого объекта навсегда
 * перекладывалась на соседей, а «основной» объект пропадал. Здесь, В ТОЙ ЖЕ транзакции
 * до `property.delete`, для каждого затронутого объявления:
 *   — строка удаляемого объекта убирается, остальные связи СОХРАНЯЮТСЯ как были;
 *   — Ad.propertyId пересчитывается в основной по весу из оставшихся (одно место
 *     записи, как и в setAdProperties);
 *   — assetCount НЕ уменьшается (и подтягивается до «осталось + 1»), поэтому
 *     объявление встаёт в «нужна проверка» (adNeedsReview), а не тихо переписывает
 *     деньги на соседей. Ручная привязка (MANUAL) остаётся решённым вопросом для
 *     сторожа сверки — о ней вызывающий пишет запись в журнал аудита.
 */
export async function detachPropertyFromAds(tx: TxClient, propertyId: string): Promise<DetachedAd[]> {
  const links = await tx.adProperty.findMany({
    where: { propertyId },
    select: { adId: true, ad: { select: { assetCount: true, matchSource: true } } },
    take: 5000,
  });
  const out: DetachedAd[] = [];
  for (const link of links) {
    await tx.$queryRaw`SELECT id FROM "Ad" WHERE id = ${link.adId} FOR UPDATE`;
    await tx.adProperty.deleteMany({ where: { adId: link.adId, propertyId } });
    const rest = await tx.adProperty.findMany({
      where: { adId: link.adId },
      select: { propertyId: true, weight: true, source: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const primaryRow = primaryOf(
      rest.map((r) => ({ propertyId: r.propertyId, weight: Number(r.weight), source: r.source }))
    );
    const manual = link.ad.matchSource === "MANUAL";
    await tx.ad.update({
      where: { id: link.adId },
      data: {
        propertyId: primaryRow?.propertyId ?? null,
        // Ручное решение человека остаётся ручным: синхронизация его по-прежнему не трогает.
        matchSource: manual ? "MANUAL" : primaryRow ? primaryRow.source : null,
        // Не уменьшаем: «материалов больше, чем объектов» и есть признак «нужна проверка».
        ...(rest.length > 0 ? { assetCount: Math.max(link.ad.assetCount, rest.length + 1) } : {}),
      },
    });
    out.push({ adId: link.adId, remaining: rest.length, propertyId: primaryRow?.propertyId ?? null, manual });
  }
  return out;
}

/**
 * Доли списка объявлений одним-двумя запросами (без N+1). Результат: id объявления →
 * список долей (веса как числа), по убыванию веса. Объявления без объекта в карте
 * отсутствуют. Запасной путь по Ad.propertyId описан в шапке файла.
 */
export async function loadAdAllocations(adIds: readonly string[]): Promise<Map<string, AllocationItem[]>> {
  const out = new Map<string, AllocationItem[]>();
  if (adIds.length === 0) return out;
  const ids = Array.from(new Set(adIds));

  const rows = await prisma.adProperty.findMany({
    where: { adId: { in: ids } },
    select: { adId: true, propertyId: true, weight: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  for (const r of rows) {
    const list = out.get(r.adId) ?? [];
    list.push({ propertyId: r.propertyId, weight: Number(r.weight) });
    out.set(r.adId, list);
  }

  const missing = ids.filter((id) => !out.has(id));
  if (missing.length > 0) {
    const legacy = await prisma.ad.findMany({
      where: { id: { in: missing }, propertyId: { not: null } },
      select: { id: true, propertyId: true },
    });
    for (const a of legacy) out.set(a.id, [{ propertyId: a.propertyId!, weight: 1 }]);
  }

  // Стабильная сортировка: по убыванию веса, при равных — порядок создания связи.
  for (const [adId, list] of out) {
    out.set(
      adId,
      list
        .map((item, index) => ({ item, index }))
        .sort((a, b) => b.item.weight - a.item.weight || a.index - b.index)
        .map((x) => x.item)
    );
  }
  return out;
}

/**
 * Условие Prisma «объявление платит за один из этих объектов» — с запасным путём
 * (Ad.propertyId без строк AdProperty). Общее для всех выборок «объявления
 * объекта», чтобы ни одна не потеряла старые строки.
 */
export function adsOfPropertiesWhere(propertyIds: readonly string[]) {
  const ids = Array.from(propertyIds);
  return {
    OR: [{ properties: { some: { propertyId: { in: ids } } } }, { propertyId: { in: ids } }],
  };
}

/**
 * Нужен ли объявлению взгляд человека: объекта нет вовсе или материалов больше,
 * чем найденных объектов. Реклама агентства (brand) и ручная привязка — решённый
 * вопрос: человек уже сказал, что это за объявление.
 */
export function adNeedsReview(
  ad: { assetCount: number; matchSource: AdMatchSource | null; brand: boolean },
  linkedCount: number
): boolean {
  if (ad.brand || ad.matchSource === "MANUAL") return false;
  return linkedCount === 0 || ad.assetCount > linkedCount;
}

/** Доля одного объекта в сумме объявления (в целых сотых/единицах). 0, если объект не в списке. */
export function shareOf(totalCents: number, items: readonly AllocationItem[], propertyId: string): number {
  return allocateCents(totalCents, items).find((s) => s.propertyId === propertyId)?.cents ?? 0;
}

import type { AdLeadStats } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { dushanbeInputToDate } from "../dushanbeTime.js";
import { centsToTjs, fromCents, loadMoneyContext, toCents, type MoneyContext } from "../money.js";
import { COUNTED_SHOWING_WHERE } from "../tasks.js";
import { allocateCents, type AllocationItem } from "./adAllocation.js";

/**
 * РЕАЛЬНАЯ ЦЕНА КЛИЕНТА ПО ОБЪЯВЛЕНИЮ И ПО ОБЪЕКТУ (03.10.2026, «Реклама, волна 1»).
 *
 * До этого цена «обращения» была только по версии Meta («Результат» = начатые
 * переписки), а Client.sourceAdId — id объявления, которое ПРИВЕЛО клиента, —
 * писалась с 26.08.2026 и не читалась ни одним отчётом. Здесь замыкается цепочка
 *
 *   объявление → обращение → клиент (sourceAdId) → показ → сделка → комиссия компании
 *
 * и считается то, что директор на самом деле хочет знать: сколько стоит клиент,
 * который дошёл до CRM, до показа и до сделки, и окупилось ли объявление.
 *
 * КОГОРТА, А НЕ СНИМОК. Клиенты берутся по дате создания карточки в выбранном
 * периоде, а их показы и сделки — за ВСЁ время: клиент мог прийти в конце месяца, а
 * купить в следующем. Так цена клиента сопоставима с расходом периода, а «дошёл до
 * показа/сделки» не теряет тех, у кого воронка просто ещё не доехала до конца периода.
 *
 * ДЕНЬГИ И КЛИЕНТОВ НА ОБЪЕКТЫ ДЕЛИТ ОДНА ФУНКЦИЯ — allocateCents из adAllocation.ts
 * (единственный источник правды): расход объявления и его клиенты распределяются по
 * ТЕМ ЖЕ весам, поэтому цена клиента объекта согласована с расходом объекта, который
 * показывают остальные отчёты, а сумма клиентов и показов по объектам равна итогу
 * объявления. Клиенты и показы в разбивке — ДОЛИ (число с двумя знаками, 0.25 клиента),
 * а не целые: иначе у последних объектов вечно «клиентов нет». СДЕЛКИ И КОМИССИЯ в
 * разбивке — по объекту самой сделки (см. attributeLeads).
 *
 * ИСКЛЮЧЕНИЕ — «ПРИКОЛОТЫЙ» КЛИЕНТ. Если по логике бота клиент уже связан с одним
 * конкретным объектом объявления (BotConversation.adPropertyId — объект, по рекламе
 * которого человек написал), он отдаётся этому объекту ЦЕЛИКОМ, со своими показами,
 * сделкой и комиссией. Приколотым считается только объект, который входит в
 * объявление: иначе клиент уехал бы на объект, чьи деньги из этого объявления не
 * берутся, и цена разошлась бы с расходом. Остальные клиенты делятся по весам.
 *
 * ГРАНИЦЫ. Выборка клиентов ограничена MAX_CLIENTS (пагинация по правилам проекта);
 * при обрезке вызывающий получает truncated и честно говорит, что цифры неполные.
 */

/** Предел клиентов, участвующих в одном расчёте. */
export const MAX_ATTRIBUTION_CLIENTS = 5000;

/** Один клиент объявления и то, докуда он дошёл. */
export interface LeadFact {
  /** Внешний id объявления Meta (Client.sourceAdId). */
  adExternalId: string;
  /** Объект, к которому клиента привязывает логика бота; null — привязки нет. */
  pinnedPropertyId: string | null;
  /** Дошёл до показа (или сразу до закрытой сделки: сделка без записанного показа — тоже «дошёл»). */
  showed: boolean;
  /** Закрытых сделок клиента (всех — в итог объявления). */
  deals: number;
  /** Доля компании в комиссии этих сделок, сотые сомони (всех — в итог объявления). */
  commissionCents: number;
  /**
   * Те же сделки, разложенные по ОБЪЕКТУ СДЕЛКИ (Deal.propertyId). Нужны разбивке по
   * объектам: сделка по №55 не должна попасть в окупаемость №107 только потому, что
   * клиент пришёл с объявления, где есть и №107.
   */
  dealLines: { propertyId: string; count: number; commissionCents: number }[];
}

/** Воронка одного клиентского «ведра» в целых единицах (клиенты) и сотых (комиссия). */
export interface LeadCounts {
  leads: number;
  showings: number;
  deals: number;
  commissionCents: number;
}

export interface AttributionAd {
  /** Наш id объявления (Ad.id). */
  adId: string;
  /** Внешний id объявления в Meta (Ad.externalId) — по нему сопоставляется Client.sourceAdId. */
  externalId: string;
  /** Расход объявления за период в сотых сомони — ТО ЖЕ число, что показано в отчёте. */
  spendCents: number;
  /** Доли объектов объявления (loadAdAllocations); пусто — объявление без объекта. */
  items: readonly AllocationItem[];
}

export interface AdAttribution {
  total: LeadCounts;
  /** Клиенты объявления по объектам; пусто, если у объявления нет объектов. */
  byProperty: Map<string, LeadCounts>;
}

export interface AttributionResult {
  byAd: Map<string, AdAttribution>;
  /**
   * По объекту поверх всех объявлений: клиенты, их воронка и расход, который объявления
   * на него тратят (та же аллокация, что и у клиентов).
   */
  byProperty: Map<string, LeadCounts & { spendCents: number }>;
}

const emptyCounts = (): LeadCounts => ({ leads: 0, showings: 0, deals: 0, commissionCents: 0 });

/** Доли клиентов — число с двумя знаками: без «0.30000000000000004» после сложения. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

function addCounts(into: LeadCounts, add: LeadCounts): void {
  into.leads = round2(into.leads + add.leads);
  into.showings = round2(into.showings + add.showings);
  into.deals += add.deals;
  into.commissionCents += add.commissionCents;
}

function countsOf(facts: readonly LeadFact[]): LeadCounts {
  const out = emptyCounts();
  for (const f of facts) {
    out.leads += 1;
    if (f.showed) out.showings += 1;
    out.deals += f.deals;
    out.commissionCents += f.commissionCents;
  }
  return out;
}

/**
 * ЧИСТАЯ ЛОГИКА: раскладывает клиентов по объявлениям и объектам. Без базы — чтобы
 * инвариант «сумма по объектам = итог объявления» проверялся на фикстурах.
 *
 * Клиенты с объявлением, которого нет в `ads` (чужое, исключённое, удалённое), не
 * считаются нигде: у них нет ни расхода, ни объекта, и цена клиента из них не
 * складывается.
 */
export function attributeLeads(ads: readonly AttributionAd[], facts: readonly LeadFact[]): AttributionResult {
  const byExternalId = new Map<string, LeadFact[]>();
  for (const f of facts) {
    const list = byExternalId.get(f.adExternalId) ?? [];
    list.push(f);
    byExternalId.set(f.adExternalId, list);
  }

  const byAd = new Map<string, AdAttribution>();
  const byProperty = new Map<string, LeadCounts & { spendCents: number }>();
  const propertyBucket = (id: string) => {
    let b = byProperty.get(id);
    if (!b) {
      b = { ...emptyCounts(), spendCents: 0 };
      byProperty.set(id, b);
    }
    return b;
  };

  for (const ad of ads) {
    const adFacts = byExternalId.get(ad.externalId) ?? [];
    const total = countsOf(adFacts);
    const perProperty = new Map<string, LeadCounts>();

    if (ad.items.length > 0) {
      const inAd = new Set(ad.items.map((i) => i.propertyId));
      const pinned = adFacts.filter((f) => f.pinnedPropertyId != null && inAd.has(f.pinnedPropertyId));
      const pool = countsOf(adFacts.filter((f) => !(f.pinnedPropertyId != null && inAd.has(f.pinnedPropertyId))));

      // Клиенты и показы «общей кучи» делятся по весам в СОТЫХ ДОЛЯХ клиента (число с двумя
      // знаками): целыми людей делить нельзя, и методом остатка последние объекты всегда
      // оставались бы с «клиентов нет». Сумма долей РАВНА входу (allocateCents по
      // pool × 100), итог объявления не меняется.
      const leadShares = allocateCents(pool.leads * 100, ad.items);
      const showingShares = allocateCents(pool.showings * 100, ad.items);
      ad.items.forEach((item, i) => {
        perProperty.set(item.propertyId, {
          leads: leadShares[i].cents / 100,
          showings: showingShares[i].cents / 100,
          deals: 0,
          commissionCents: 0,
        });
      });
      for (const f of pinned) {
        const target = perProperty.get(f.pinnedPropertyId!);
        if (target) addCounts(target, { leads: 1, showings: f.showed ? 1 : 0, deals: 0, commissionCents: 0 });
      }
      // СДЕЛКИ И КОМИССИЯ — ТОЛЬКО НА ОБЪЕКТЕ СДЕЛКИ (Deal.propertyId). Правило такое:
      //   — в разбивке по объектам сделка идёт объекту, по которому она закрыта, если он
      //     входит в объявление; сделка по объекту вне объявления в разбивку не попадает
      //     вовсе (раньше её комиссия делилась между объектами объявления, и в окупаемость
      //     №107 уходила комиссия сделки по №55);
      //   — в ИТОГ объявления идёт всё, что закрыл клиент объявления: деньги принесло оно,
      //     как и в adSpendReport.enrichRows (доля компании со снапшота, у старых сделок —
      //     вся комиссия; перевод валюты по одной сделке).
      // Поэтому сумма сделок/комиссии по объектам может быть МЕНЬШЕ итога объявления.
      for (const f of adFacts) {
        for (const line of f.dealLines) {
          const target = perProperty.get(line.propertyId);
          if (target) {
            target.deals += line.count;
            target.commissionCents += line.commissionCents;
          }
        }
      }

      const spendShares = allocateCents(ad.spendCents, ad.items);
      ad.items.forEach((item, i) => {
        const bucket = propertyBucket(item.propertyId);
        addCounts(bucket, perProperty.get(item.propertyId) ?? emptyCounts());
        bucket.spendCents += spendShares[i].cents;
      });
    }

    byAd.set(ad.adId, { total, byProperty: perProperty });
  }

  return { byAd, byProperty };
}

const ratio = (spendCents: number, count: number): number | null =>
  spendCents > 0 && count > 0 ? fromCents(Math.round(spendCents / count)) : null;

/**
 * Производные числа воронки. Деления на ноль нет нигде: нулевой знаменатель — null, и
 * экран пишет «клиентов в CRM нет», а не «0 с. за клиента» (ноль цены читался бы как
 * «бесплатно»). Нулевой расход — тоже null: у органики цены нет.
 */
export function leadStatsOf(
  spendCents: number,
  counts: LeadCounts,
  metaConversations: number,
  options: { shares?: boolean } = {}
): AdLeadStats {
  return {
    ...(options.shares ? { leadsAreShares: true } : {}),
    leads: counts.leads,
    showings: counts.showings,
    deals: counts.deals,
    commissionTjs: fromCents(counts.commissionCents),
    costPerLeadTjs: ratio(spendCents, counts.leads),
    costPerShowingTjs: ratio(spendCents, counts.showings),
    costPerLeadMeta: ratio(spendCents, metaConversations),
    // Окупаемость в долях от расхода: 0,5 = +50 %, −1 = ничего не вернулось.
    romi: spendCents > 0 ? Math.round(((counts.commissionCents - spendCents) / spendCents) * 1000) / 1000 : null,
  };
}

/** Календарные дни периода (UTC-полночи колонки DATE) → границы по Душанбе: [start, end). */
export function periodInstants(from: Date, to: Date): { start: Date; end: Date } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const next = new Date(to.getTime() + 86_400_000);
  return { start: dushanbeInputToDate(iso(from), "00:00"), end: dushanbeInputToDate(iso(next), "00:00") };
}

export interface LeadFactsRange {
  /** Включительно; null — с начала времён. */
  start: Date | null;
  /** Не включительно; null — до сегодня. */
  end: Date | null;
}

/**
 * Клиенты объявлений за период и то, докуда они дошли: четыре запроса на ВСЕХ, без
 * N+1 (клиенты → показы, сделки и диалоги одним заходом по списку id).
 */
export async function loadLeadFacts(
  externalIds: readonly string[],
  range: LeadFactsRange,
  money?: MoneyContext
): Promise<{ facts: LeadFact[]; truncated: boolean }> {
  const ids = Array.from(new Set(externalIds.filter(Boolean)));
  if (ids.length === 0) return { facts: [], truncated: false };

  const createdAt =
    range.start || range.end
      ? { ...(range.start ? { gte: range.start } : {}), ...(range.end ? { lt: range.end } : {}) }
      : undefined;
  const found = await prisma.client.findMany({
    where: { sourceAdId: { in: ids }, deletedAt: null, ...(createdAt ? { createdAt } : {}) },
    select: { id: true, sourceAdId: true },
    orderBy: { createdAt: "desc" },
    take: MAX_ATTRIBUTION_CLIENTS + 1,
  });
  const truncated = found.length > MAX_ATTRIBUTION_CLIENTS;
  const clients = truncated ? found.slice(0, MAX_ATTRIBUTION_CLIENTS) : found;
  if (clients.length === 0) return { facts: [], truncated: false };

  const clientIds = clients.map((c) => c.id);
  const [showings, deals, conversations, ctx] = await Promise.all([
    prisma.interaction.findMany({
      // Тот же предикат «показ засчитывается», что и в «Отчётах», воронке и доске
      // почёта: отменённые показы и клиенты из Корзины в счёт не идут.
      where: { clientId: { in: clientIds }, type: "SHOWING", ...COUNTED_SHOWING_WHERE },
      select: { clientId: true },
      distinct: ["clientId"],
    }),
    prisma.deal.findMany({
      where: { clientId: { in: clientIds }, stage: "COMPLETED" },
      select: {
        clientId: true,
        propertyId: true,
        commissionAmount: true,
        commissionCompanyAmount: true,
        currency: true,
      },
      take: MAX_ATTRIBUTION_CLIENTS * 2,
    }),
    prisma.botConversation.findMany({
      where: { clientId: { in: clientIds }, adPropertyId: { not: null } },
      select: { clientId: true, adPropertyId: true, adExternalId: true },
      take: MAX_ATTRIBUTION_CLIENTS,
    }),
    money ? Promise.resolve(money) : loadMoneyContext(),
  ]);

  const showedSet = new Set(showings.map((s) => s.clientId));
  const dealsBy = new Map<string, { count: number; cents: number; lines: Map<string, { count: number; cents: number }> }>();
  for (const d of deals) {
    // Доля компании (снапшот при закрытии); у старых сделок без снапшота — вся
    // комиссия, ровно как в adSpendReport.ts.
    const cents = centsToTjs(toCents(d.commissionCompanyAmount ?? d.commissionAmount ?? 0), d.currency, ctx);
    const prev = dealsBy.get(d.clientId) ?? { count: 0, cents: 0, lines: new Map() };
    prev.count += 1;
    prev.cents += cents;
    const line = prev.lines.get(d.propertyId) ?? { count: 0, cents: 0 };
    line.count += 1;
    line.cents += cents;
    prev.lines.set(d.propertyId, line);
    dealsBy.set(d.clientId, prev);
  }

  // Объект клиента: диалог, начатый именно с ЭТОГО объявления, важнее любого другого.
  const sourceOf = new Map(clients.map((c) => [c.id, c.sourceAdId]));
  const pinnedBy = new Map<string, { propertyId: string; sameAd: boolean }>();
  for (const conv of conversations) {
    if (!conv.clientId || !conv.adPropertyId) continue;
    const sameAd = conv.adExternalId != null && conv.adExternalId === sourceOf.get(conv.clientId);
    const prev = pinnedBy.get(conv.clientId);
    if (!prev || (sameAd && !prev.sameAd)) pinnedBy.set(conv.clientId, { propertyId: conv.adPropertyId, sameAd });
  }

  const facts: LeadFact[] = clients.map((c) => {
    const deal = dealsBy.get(c.id);
    return {
      adExternalId: c.sourceAdId!,
      pinnedPropertyId: pinnedBy.get(c.id)?.propertyId ?? null,
      showed: showedSet.has(c.id) || !!deal,
      deals: deal?.count ?? 0,
      commissionCents: deal?.cents ?? 0,
      dealLines: deal
        ? Array.from(deal.lines, ([propertyId, l]) => ({ propertyId, count: l.count, commissionCents: l.cents }))
        : [],
    };
  });
  return { facts, truncated };
}

/** Клиенты + раскладка одним вызовом — то, что нужно роутам. */
export async function loadAdAttribution(
  ads: readonly AttributionAd[],
  range: LeadFactsRange,
  money?: MoneyContext
): Promise<AttributionResult & { truncated: boolean }> {
  const { facts, truncated } = await loadLeadFacts(
    ads.map((a) => a.externalId),
    range,
    money
  );
  return { ...attributeLeads(ads, facts), truncated };
}

import type { AdPlatform } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { dushanbeWallClock } from "../dushanbeTime.js";
import { adSpendToTjsCents, centsToTjs, fromCents, loadMoneyContext, toCents, type MoneyContext } from "../money.js";
import type { AdSpendSharedAds } from "@royal-home/shared";
import { adsOfPropertiesWhere, allocateCents, loadAdAllocations } from "./adAllocation.js";

/**
 * ОТЧЁТ «СКОЛЬКО ВЛОЖЕНО В КАЖДЫЙ ОБЪЕКТ».
 *
 * Считается из дневных строк расхода (AdSpendDaily), а не из готовых итогов: любой
 * срез — месяц, объект, система — это одна и та же выборка с разной группировкой,
 * и расхождений между «итого» и «по строкам» быть не может по построению.
 *
 * ДЕНЬГИ приводятся к сомони тем же lib/money.ts, что и сделки, комиссии и расходы:
 * курс один на всю CRM и берётся из Настроек. Хранится расход в валюте кабинета
 * (у Meta это доллар), поэтому исходная сумма тоже отдаётся — иначе в отчёте
 * нельзя было бы сверить цифру с Ads Manager, а сверять её будут.
 *
 * ОБЪЯВЛЕНИЯ БЕЗ ОБЪЕКТА не выбрасываются, а собираются отдельной строкой. В живом
 * кабинете агентства рядом с рекламой квартир крутится реклама совсем других
 * бизнесов — спрятать её значило бы показать владельцу неправду о том, сколько
 * стоит недвижимость.
 */

/** Предел выборки: столько объявлений максимум участвует в одном отчёте. */
const MAX_ADS = 1000;
/** Статусы комментариев, которые считаются «откликом» на публикацию объекта. */
const COUNTED_COMMENT_STATUSES = ["REPLIED", "ESCALATED"];

export interface AdSpendPropertyRow extends AdSpendSharedAds {
  property: {
    id: string;
    shortId: number;
    title: string;
    status: string;
    /** Обложка — первое фото карточки. null, если фотографий нет. */
    coverUrl: string | null;
    instagramUrl: string | null;
  } | null;
  /** Расход в отчётной валюте (сомони), точно до дирама. */
  spendTjs: number;
  /** Он же в валюте кабинета — для сверки с Ads Manager. null, если объект
   *  рекламировался из кабинетов с РАЗНОЙ валютой: складывать доллары с сомони
   *  один к одному нельзя, а честной «исходной суммы» у такой строки нет. */
  spendOriginal: number | null;
  /** Валюта исходной суммы; null — в строке смешаны валюты. */
  currency: string | null;
  impressions: number;
  clicks: number;
  conversations: number;
  adsCount: number;
  /** Названия кампаний — то, что владелец называет «таргет». */
  campaigns: string[];
  platforms: AdPlatform[];
  /** Картинка объявления — показываем только у строк без объекта. */
  thumbnailUrl: string | null;
  /** Комментарии Instagram под публикациями этого объекта — живой отклик рядом с
   *  платными показами. null у строки «без объекта». */
  comments: number | null;
  /** ПРИБЫЛЬ ПО ПРОДАННОМУ ОБЪЕКТУ: доля компании в комиссии закрытой сделки минус
   *  ВСЯ реклама объекта за всё время (не только за выбранный месяц — квартиру
   *  рекламировали и до месяца продажи). null — объект не продан или сделка ещё
   *  не закрыта: считать «прибыль» до денег на руках значит врать. */
  profitTjs: number | null;
  /** Слагаемые прибыли — чтобы цифре можно было верить, не открывая сделку. */
  commissionTjs: number | null;
  lifetimeSpendTjs: number | null;
}

export interface AdSpendReport {
  /** YYYY-MM периода (для произвольного отрезка — месяц его последнего дня). */
  month: string;
  /** Границы отчёта как есть — их же показывает шапка раздела. */
  from: string;
  to: string;
  rows: AdSpendPropertyRow[];
  totals: {
    /** Ровно сумма колонки «Потрачено» по строкам — сходится до дирама. */
    spendTjs: number;
    spendOriginal: number | null;
    currency: string | null;
    impressions: number;
    clicks: number;
    conversations: number;
    adsCount: number;
  };
  /** true — объявлений в периоде больше предела выборки, отчёт неполный. */
  truncated: boolean;
}

/** Первый и последний день месяца «YYYY-MM» как границы для колонки DATE. */
function monthBounds(month: string): { from: Date; to: Date } {
  const [year, mon] = month.split("-").map(Number);
  return {
    from: new Date(Date.UTC(year, mon - 1, 1)),
    to: new Date(Date.UTC(year, mon, 0)),
  };
}

/** Отчёт строится за ЛЮБОЙ отрезок, не только за месяц: у раздела один
 *  переключатель периода на все вкладки, и «по объектам» слушается его же. */
export type AdSpendRange = string | { from: Date; to: Date };

function rangeBounds(range: AdSpendRange): { from: Date; to: Date } {
  return typeof range === "string" ? monthBounds(range) : range;
}

/** «YYYY-MM» дня — под этим ключом кэшируется ИИ-разбор. */
function monthOf(day: Date): string {
  return `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Текущий месяц по Душанбе — тот же приём, что в Финансах (routes/expenses.ts). */
export function currentMonth(): string {
  const wall = dushanbeWallClock();
  return `${wall.getUTCFullYear()}-${String(wall.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function buildAdSpendReport(range: AdSpendRange): Promise<AdSpendReport> {
  const { from, to } = rangeBounds(range);
  const month = typeof range === "string" ? range : monthOf(to);
  const bounds = { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };

  // Сумма по объявлению за период считается базой, а не в JS: строк «объявление ×
  // день» за месяц бывают тысячи, и тащить их все в память ради сложения незачем.
  const totalsByAd = await prisma.adSpendDaily.groupBy({
    by: ["adId", "currency"],
    // Чужая реклама из общего кабинета подрядчика в отчёт не входит вовсе — ни
    // строкой, ни в итог: считать её нашими расходами на квартиры нельзя.
    where: { date: { gte: from, lte: to }, ad: { excluded: false } },
    _sum: { spend: true, impressions: true, clicks: true, conversations: true },
    orderBy: { _sum: { spend: "desc" } },
    take: MAX_ADS + 1,
  });

  const truncated = totalsByAd.length > MAX_ADS;
  const page = truncated ? totalsByAd.slice(0, MAX_ADS) : totalsByAd;
  if (page.length === 0) {
    return {
      month,
      ...bounds,
      rows: [],
      totals: { spendTjs: 0, spendOriginal: 0, currency: null, impressions: 0, clicks: 0, conversations: 0, adsCount: 0 },
      truncated: false,
    };
  }

  const ads = await prisma.ad.findMany({
    where: { id: { in: page.map((r) => r.adId) } },
    select: {
      id: true,
      platform: true,
      campaignName: true,
      name: true,
      thumbnailUrl: true,
    },
  });
  const adById = new Map(ads.map((a) => [a.id, a]));

  /**
   * ДОЛИ ОБЪЕКТОВ В ОБЪЯВЛЕНИЯХ (03.10.2026). Одно объявление может платить за
   * несколько объектов; его деньги делятся по весам (lib/ads/adAllocation.ts) так,
   * что сумма долей равна расходу объявления до дирама. Объекты читаются одним
   * запросом на все объявления отчёта.
   */
  const allocations = await loadAdAllocations(page.map((r) => r.adId));
  const propertyIds = Array.from(new Set(Array.from(allocations.values()).flatMap((items) => items.map((i) => i.propertyId))));
  const propertyRows =
    propertyIds.length > 0
      ? await prisma.property.findMany({
          where: { id: { in: propertyIds } },
          select: {
            id: true,
            shortId: true,
            title: true,
            status: true,
            instagramUrl: true,
            photos: { select: { thumbUrl: true }, orderBy: { order: "asc" }, take: 1 },
          },
        })
      : [];
  const propertyById = new Map(propertyRows.map((p) => [p.id, p]));

  const money = await loadMoneyContext();

  /**
   * Черновик строки: деньги копятся ЦЕЛЫМИ СОТЫМИ, а исходная сумма — отдельно
   * по каждой валюте кабинета. Иначе объект, который рекламировали и из
   * долларового кабинета, и из сомонёвого, получил бы «исходную сумму», где
   * доллары сложены с сомони один к одному.
   */
  interface Draft {
    row: AdSpendPropertyRow;
    tjsCents: number;
    originalCents: Map<string, number>;
    /** Разные объявления строки: объявление с двумя валютами — всё равно одно объявление. */
    adIds: Set<string>;
    /** Из них общие (на ≥ 2 объекта) — для подписи «деньги — доля объекта». */
    sharedAdIds: Set<string>;
  }
  const byKey = new Map<string, Draft>();
  const UNMATCHED = "__unmatched__";
  const allAdIds = new Set<string>();

  for (const row of page) {
    const ad = adById.get(row.adId);
    if (!ad) continue;
    allAdIds.add(ad.id);

    // Сложение уже произошло в базе (groupBy по объявлению и валюте) — здесь
    // складываются десятки целых чисел, а не тысячи дробных.
    const cents = toCents(row._sum.spend ?? 0);
    const tjsCents = centsToTjs(cents, row.currency, money);
    const impressions = row._sum.impressions ?? 0;
    const clicks = row._sum.clicks ?? 0;
    const conversations = row._sum.conversations ?? 0;

    // Без объекта — одна «доля» в куче «Не привязано» на всю сумму.
    const items = allocations.get(ad.id) ?? [];
    const keys = items.length > 0 ? items : [{ propertyId: UNMATCHED, weight: 1 }];
    const byTjs = allocateCents(tjsCents, keys);
    const byOriginal = allocateCents(cents, keys);
    const byImpressions = allocateCents(impressions, keys);
    const byClicks = allocateCents(clicks, keys);
    const byConversations = allocateCents(conversations, keys);

    keys.forEach((share, i) => {
      const property = share.propertyId === UNMATCHED ? null : propertyById.get(share.propertyId) ?? null;
      // Объект мог исчезнуть из выборки (удалён между запросами) — деньги не
      // теряем, а кладём в «Не привязано»: сумма отчёта обязана сходиться.
      const key = property ? property.id : UNMATCHED;
      const draft: Draft = byKey.get(key) ?? {
        tjsCents: 0,
        originalCents: new Map<string, number>(),
        adIds: new Set<string>(),
        sharedAdIds: new Set<string>(),
        row: {
          property: property
            ? {
                id: property.id,
                shortId: property.shortId,
                title: property.title,
                status: property.status,
                coverUrl: property.photos[0]?.thumbUrl ?? null,
                instagramUrl: property.instagramUrl,
              }
            : null,
          spendTjs: 0,
          spendOriginal: 0,
          currency: row.currency,
          impressions: 0,
          clicks: 0,
          conversations: 0,
          adsCount: 0,
          sharedAdsCount: 0,
          campaigns: [],
          platforms: [],
          thumbnailUrl: null,
          comments: null,
          profitTjs: null,
          commissionTjs: null,
          lifetimeSpendTjs: null,
        },
      };
      const target = draft.row;

      draft.tjsCents += byTjs[i].cents;
      draft.originalCents.set(row.currency, (draft.originalCents.get(row.currency) ?? 0) + byOriginal[i].cents);
      target.impressions += byImpressions[i].cents;
      target.clicks += byClicks[i].cents;
      target.conversations += byConversations[i].cents;
      draft.adIds.add(ad.id);
      if (items.length >= 2) draft.sharedAdIds.add(ad.id);
      // Название кампании у бустов Instagram бессмысленное («Новое объявление с целью
      // …»), поэтому в качестве «таргета» берём его же, но без дублей: пусть владелец
      // видит, что кампания одна, даже если объявлений в ней пять.
      const campaign = ad.campaignName?.trim() || ad.name;
      if (campaign && !target.campaigns.includes(campaign)) target.campaigns.push(campaign);
      if (!target.platforms.includes(ad.platform)) target.platforms.push(ad.platform);
      if (!target.property && !target.thumbnailUrl) target.thumbnailUrl = ad.thumbnailUrl;

      byKey.set(key, draft);
    });
  }

  const drafts = Array.from(byKey.values());
  for (const draft of drafts) {
    draft.row.adsCount = draft.adIds.size;
    draft.row.sharedAdsCount = draft.sharedAdIds.size;
    draft.row.spendTjs = fromCents(draft.tjsCents);
    const currencies = Array.from(draft.originalCents.keys());
    const single = currencies.length === 1 ? currencies[0] : null;
    draft.row.currency = single;
    draft.row.spendOriginal = single ? fromCents(draft.originalCents.get(single) ?? 0) : null;
  }

  await enrichRows(drafts.map((d) => d.row), money);

  const rows = drafts
    .map((d) => d.row)
    .sort((a, b) => {
      // «Не привязано» всегда внизу: это не объект, а остаток, и мешать его в общий
      // рейтинг трат по квартирам нельзя.
      if (!a.property) return 1;
      if (!b.property) return -1;
      return b.spendTjs - a.spendTjs;
    });

  /**
   * ИТОГ — РОВНО СУММА КОЛОНКИ. Складываем те же целые сотые, из которых
   * сложены показанные строки: столбец сходится с итогом по построению, и
   * «в отчёте 2 401, а по строкам 2 400» не случается в принципе.
   */
  const totalTjsCents = drafts.reduce((acc, d) => acc + d.tjsCents, 0);
  const totalOriginal = new Map<string, number>();
  for (const draft of drafts) {
    for (const [currency, cents] of draft.originalCents) {
      totalOriginal.set(currency, (totalOriginal.get(currency) ?? 0) + cents);
    }
  }
  const totalCurrencies = Array.from(totalOriginal.keys());
  const singleCurrency = totalCurrencies.length === 1 ? totalCurrencies[0] : null;

  const totals = {
    spendTjs: fromCents(totalTjsCents),
    spendOriginal: singleCurrency ? fromCents(totalOriginal.get(singleCurrency) ?? 0) : null,
    currency: singleCurrency,
    impressions: rows.reduce((acc, r) => acc + r.impressions, 0),
    clicks: rows.reduce((acc, r) => acc + r.clicks, 0),
    conversations: rows.reduce((acc, r) => acc + r.conversations, 0),
    // Разные объявления, а не сумма по строкам: объявление про несколько объектов
    // стоит в нескольких строках, но в итоге оно одно.
    adsCount: allAdIds.size,
  };

  return { month, ...bounds, rows, totals, truncated };
}

/** Комментарии и прибыль — одним заходом на все строки отчёта, без N+1. */
async function enrichRows(rows: AdSpendPropertyRow[], money: MoneyContext): Promise<void> {
  const ids = rows.filter((r) => r.property).map((r) => r.property!.id);
  if (ids.length === 0) return;

  const [comments, deals, lifetimeAds] = await Promise.all([
    prisma.instagramComment.groupBy({
      by: ["propertyId"],
      // Только содержательные: ответили (REPLIED) или передали человеку (ESCALATED). Раньше
      // считались ВСЕ строки с propertyId, а после ветки «голос рынка» propertyId получают и
      // комментарии SKIPPED/DELETED/HIDDEN (спам, мат, чужая реклама) — отклик раздувался.
      where: { propertyId: { in: ids }, status: { in: COUNTED_COMMENT_STATUSES } },
      _count: { _all: true },
    }),
    // Закрытая сделка по объекту: доля компании зафиксирована снапшотом при
    // закрытии (см. schema.prisma) — прибыль не переписывается сменой настроек.
    prisma.deal.findMany({
      where: { propertyId: { in: ids }, stage: "COMPLETED" },
      select: { propertyId: true, commissionAmount: true, commissionCompanyAmount: true, currency: true },
    }),
    /**
     * Расход за ВСЁ ВРЕМЯ по каждому объекту отчёта — одним запросом на всех.
     * Раньше здесь стоял groupBy по валюте, результат которого выбрасывался
     * (`void lifetime`), а настоящая сумма считалась запросом ВНУТРИ цикла по
     * строкам — тот самый N+1, который в этом репозитории велено ловить
     * глазами. Прибыль считается по пожизненной рекламе, поэтому период здесь
     * не сужаем. Объявление про несколько объектов даёт каждому его ДОЛЮ
     * (adAllocation.ts), а не весь расход.
     */
    prisma.ad.findMany({
      where: { excluded: false, ...adsOfPropertiesWhere(ids) },
      select: { id: true, spend: { select: { spend: true, currency: true } } },
      take: MAX_ADS,
    }),
  ]);

  /** Пожизненный расход по объекту в целых сотых сомони. */
  const lifetimeByProperty = new Map<string, number>();
  const lifetimeAllocations = await loadAdAllocations(lifetimeAds.map((a) => a.id));
  const wanted = new Set(ids);
  for (const ad of lifetimeAds) {
    // Курс — к сумме объявления по валюте, один раз (money.ts::adSpendToTjsCents): как в основном отчёте и на доске.
    const adCents = adSpendToTjsCents(ad.spend, money);
    for (const share of allocateCents(adCents, lifetimeAllocations.get(ad.id) ?? [])) {
      if (!wanted.has(share.propertyId)) continue;
      lifetimeByProperty.set(share.propertyId, (lifetimeByProperty.get(share.propertyId) ?? 0) + share.cents);
    }
  }

  const commentsById = new Map(comments.map((c) => [c.propertyId as string, c._count._all]));
  /** Доля компании по объекту — тоже в целых сотых сомони. */
  const dealByProperty = new Map<string, { companyCents: number }>();
  for (const d of deals) {
    // Доля компании; у старых сделок без снапшота — вся комиссия (переоценка
    // честнее нуля, и это видно по слагаемым).
    const cents = toCents(d.commissionCompanyAmount ?? d.commissionAmount ?? 0);
    const prev = dealByProperty.get(d.propertyId) ?? { companyCents: 0 };
    prev.companyCents += centsToTjs(cents, d.currency, money);
    dealByProperty.set(d.propertyId, prev);
  }

  for (const row of rows) {
    if (!row.property) continue;
    row.comments = commentsById.get(row.property.id) ?? 0;

    const deal = dealByProperty.get(row.property.id);
    if (deal && row.property.status === "SOLD") {
      const lifetimeCents = lifetimeByProperty.get(row.property.id) ?? 0;
      row.commissionTjs = fromCents(deal.companyCents);
      row.lifetimeSpendTjs = fromCents(lifetimeCents);
      // Вычитание целых сотых: «прибыль» сходится с разностью показанных чисел.
      row.profitTjs = fromCents(deal.companyCents - lifetimeCents);
    }
  }
}

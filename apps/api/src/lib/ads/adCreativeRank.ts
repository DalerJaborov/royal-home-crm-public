import type {
  AdCreativeDelivery,
  AdCreativeLowDataReason,
  AdCreativeMark,
  AdCreativeRankBasis,
  AdCreativeRow,
  AdCreativesResponse,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";
import { adSpendToTjsCents, fromCents, loadMoneyContext } from "../money.js";
import { loadAdAllocations } from "./adAllocation.js";
import { adDelivery, deliveryAsOf, lastSpendByAd } from "./adDelivery.js";
import { loadAdAttribution, periodInstants } from "./adLeadAttribution.js";
import { firstLine } from "./adSubject.js";

/**
 * КАКИЕ КРЕАТИВЫ РАБОТАЮТ (03.10.2026): рейтинг платных объявлений по цене клиента.
 *
 * ЕДИНИЦА СЧЁТА — ОБЪЯВЛЕНИЕ, а не объект. Объявление на четыре квартиры — это ОДНА
 * строка с ОДНИМ расходом: размножить его по объектам значило бы учетверить деньги в
 * рейтинге. Делить деньги между объектами умеет только adAllocation.ts, и здесь это
 * не нужно: рейтинг отвечает «какой ролик/креатив работает», а не «какая квартира».
 * Число объектов объявления подписывается (`objectsCount`), деньги не трогает.
 *
 * ДЕНЬГИ переводятся в сомони единым правилом money.ts::adSpendToTjsCents — курс
 * применяется к сумме объявления по валюте ровно один раз, как на доске и в отчёте,
 * поэтому расход строки совпадает с доской до дирама.
 *
 * ЧЕМ РАНЖИРУЕМ. Главное число — цена клиента в CRM (расход ÷ клиенты с
 * Client.sourceAdId): клиент дошёл до дела, обращение Meta — нет. Но клиентов с
 * рекламы в CRM пока немного, и ранжировать по трём клиентам на весь кабинет значит
 * ранжировать шум. Поэтому, пока объявлений с клиентами меньше порога, ранжируем по
 * цене обращения Meta и ГОВОРИМ ОБ ЭТОМ (`rankedByNote`) — а не молча подменяем.
 * Не хватает и обращений — рейтинга нет, и это тоже сказано.
 */

/**
 * ПОРОГ ЗНАЧИМОСТИ: ниже него объявление в рейтинг не идёт («мало данных»).
 *
 * 100 сомони (≈ 10 долларов по курсу CRM) — на меньшей сумме цена обращения
 * определяется одним-двумя чатами: потратили 40 с., пришла одна переписка — «40 с. за
 * обращение», потратили 40 с., пришло две — «20 с.», и рейтинг прыгает вдвое от
 * случайности. 1000 показов — нижняя граница, на которой Meta вообще выходит из
 * «обучения» и аудитория объявления становится устойчивой: до неё цена за обращение
 * отражает ещё не охват, а разгон. Оба условия сразу: дорогое объявление с парой
 * показов (ошибка таргета) и дешёвое с тысячами показов одинаково ничего не доказывают.
 */
export const CREATIVE_MIN_SPEND_TJS = 100;
export const CREATIVE_MIN_IMPRESSIONS = 1000;

/**
 * Когда цена клиента вообще осмысленна: не меньше стольких значимых объявлений, у
 * которых есть хотя бы один клиент CRM, и не меньше стольких клиентов всего. Четыре —
 * потому что «три лучших и три худших» на трёх объявлениях с клиентами — это весь
 * список, а не рейтинг; пять клиентов — чтобы цена не определялась одним человеком.
 */
export const CREATIVE_CLIENT_BASIS_MIN_ADS = 4;
export const CREATIVE_CLIENT_BASIS_MIN_LEADS = 5;
/** Для запасного пути по обращениям — хотя бы два значимых объявления с обращениями (сравнивать есть с чем). */
export const CREATIVE_CONVERSATION_BASIS_MIN_ADS = 2;
/** Сколько лучших и худших метим. */
export const CREATIVE_TOP_N = 3;
/** Предел строк в ответе (по расходу): рейтинг по десяткам объявлений читать некому. */
export const CREATIVE_MAX_ROWS = 100;
/** Предел объявлений, которые вообще разбираем (по расходу). Хвост — копейки и «мало данных». */
const MAX_RANKED_ADS = 300;

/** Всё, что нужно свёртке про одно объявление. Деньги — целые сотые сомони. */
export interface CreativeInput {
  adId: string;
  title: string;
  campaignName: string | null;
  thumbnailUrl: string | null;
  postUrl: string | null;
  delivery: AdCreativeDelivery;
  activeDays: number;
  spendCents: number;
  impressions: number;
  /** Сумма дневных охватов (приблизительна, см. AdCreativeRow.frequencyApprox). */
  reach: number;
  conversations: number;
  leads: number;
  showings: number;
  objectsCount: number;
  brand: boolean;
}

const ratio = (cents: number, count: number): number | null =>
  cents > 0 && count > 0 ? fromCents(Math.round(cents / count)) : null;

function lowDataReasonOf(spendCents: number, impressions: number): AdCreativeLowDataReason | null {
  const lowSpend = spendCents < CREATIVE_MIN_SPEND_TJS * 100;
  const lowImpressions = impressions < CREATIVE_MIN_IMPRESSIONS;
  if (lowSpend && lowImpressions) return "both";
  if (lowSpend) return "spend";
  if (lowImpressions) return "impressions";
  return null;
}

function toRow(input: CreativeInput): AdCreativeRow {
  return {
    adId: input.adId,
    title: input.title,
    campaignName: input.campaignName,
    thumbnailUrl: input.thumbnailUrl,
    postUrl: input.postUrl,
    delivery: input.delivery,
    activeDays: input.activeDays,
    spendTjs: fromCents(input.spendCents),
    impressions: input.impressions,
    conversations: input.conversations,
    leads: input.leads,
    showings: input.showings,
    costPerConversationTjs: ratio(input.spendCents, input.conversations),
    costPerLeadTjs: ratio(input.spendCents, input.leads),
    frequencyApprox: input.reach > 0 ? Math.round((input.impressions / input.reach) * 100) / 100 : null,
    objectsCount: input.objectsCount,
    brand: input.brand,
    mark: "middle",
    rankPosition: null,
    lowDataReason: null,
  };
}

export interface CreativeRanking {
  rankedBy: AdCreativeRankBasis;
  rankedByNote: string;
  rows: AdCreativeRow[];
  brand: AdCreativeRow[];
}

/**
 * ЧИСТАЯ СВЁРТКА: объявления → рейтинг. Без базы, чтобы пороги и ранги проверялись на
 * фикстурах. Порядок `rows` на выходе: лучшие (по месту) → середина (по цене) →
 * худшие (по месту, худшее первым) → «мало данных» (по расходу). Реклама агентства
 * идёт отдельным списком по расходу и в рейтинге не участвует.
 */
export function rankCreatives(inputs: readonly CreativeInput[]): CreativeRanking {
  const brand = inputs
    .filter((i) => i.brand)
    .sort((a, b) => b.spendCents - a.spendCents || a.adId.localeCompare(b.adId))
    .map(toRow);

  const ranked = inputs.filter((i) => !i.brand);
  const significant: CreativeInput[] = [];
  const lowData: AdCreativeRow[] = [];
  for (const input of ranked) {
    const reason = lowDataReasonOf(input.spendCents, input.impressions);
    if (reason) {
      lowData.push({ ...toRow(input), mark: "lowData", lowDataReason: reason });
    } else {
      significant.push(input);
    }
  }
  lowData.sort((a, b) => b.spendTjs - a.spendTjs || a.adId.localeCompare(b.adId));

  const withClients = significant.filter((i) => i.leads > 0);
  const totalLeads = withClients.reduce((acc, i) => acc + i.leads, 0);
  const withConversations = significant.filter((i) => i.conversations > 0);

  let rankedBy: AdCreativeRankBasis;
  let rankedByNote: string;
  if (withClients.length >= CREATIVE_CLIENT_BASIS_MIN_ADS && totalLeads >= CREATIVE_CLIENT_BASIS_MIN_LEADS) {
    rankedBy = "client";
    rankedByNote =
      "Ранжируем по цене клиента в CRM: расход ÷ клиенты, которые пришли с объявления. Объявления с расходом и без единого клиента — среди худших.";
  } else if (withConversations.length >= CREATIVE_CONVERSATION_BASIS_MIN_ADS) {
    rankedBy = "conversation";
    rankedByNote =
      `Клиентов в CRM с рекламы пока мало (нужны хотя бы ${CREATIVE_CLIENT_BASIS_MIN_ADS} объявления с клиентами и ${CREATIVE_CLIENT_BASIS_MIN_LEADS} клиентов), поэтому ранжируем по цене обращения Meta. Обращение — это начатая переписка, не обязательно клиент.`;
  } else {
    rankedBy = "none";
    rankedByNote =
      "Для рейтинга данных не хватает: нужны хотя бы два объявления, у которых и расход, и показы выше порога и есть результат. Цифры ниже — без мест.";
  }

  const rows = significant.map(toRow);
  const costOf = (r: AdCreativeRow): number | null =>
    rankedBy === "client" ? r.costPerLeadTjs : r.costPerConversationTjs;

  if (rankedBy === "none") {
    // Без основания для мест: метка «середина», порядок — по расходу.
    rows.sort((a, b) => b.spendTjs - a.spendTjs || a.adId.localeCompare(b.adId));
    return { rankedBy, rankedByNote, rows: [...rows, ...lowData], brand };
  }

  // Цена известна — по возрастанию (при равной цене сначала тот, у кого больше результата: ему
  // доверия больше). Цены нет (расход есть, результата нет) — в самый конец, по возрастанию
  // расхода: чем больше денег ушло впустую, тем ближе к «хуже всего».
  const costed = rows.filter((r) => costOf(r) != null);
  const resultOf = (r: AdCreativeRow) => (rankedBy === "client" ? r.leads : r.conversations);
  costed.sort(
    (a, b) => costOf(a)! - costOf(b)! || resultOf(b) - resultOf(a) || a.adId.localeCompare(b.adId)
  );
  const empty = rows.filter((r) => costOf(r) == null);
  empty.sort((a, b) => a.spendTjs - b.spendTjs || a.adId.localeCompare(b.adId));
  const ordered = [...costed, ...empty];

  // «Лучшие» берутся только из тех, у кого есть цена (объявление без результата лучшим быть не
  // может); «худшие» — с хвоста. Половина списка — предел для лучших, чтобы на двух-трёх
  // объявлениях одно и то же не оказалось и в лучших, и в худших.
  const n = ordered.length;
  // Одно значимое объявление рейтинга не образует: сравнивать не с чем, метить «худшим» нечестно.
  const bestCount = n < 2 ? 0 : Math.min(CREATIVE_TOP_N, Math.floor(n / 2), costed.length);
  const worstCount = n < 2 ? 0 : Math.min(CREATIVE_TOP_N, n - bestCount);
  const mark = (row: AdCreativeRow, m: AdCreativeMark, position: number | null) => {
    row.mark = m;
    row.rankPosition = position;
  };
  ordered.slice(0, bestCount).forEach((r, i) => mark(r, "best", i + 1));
  ordered.slice(n - worstCount).reverse().forEach((r, i) => mark(r, "worst", i + 1));

  const best = ordered.filter((r) => r.mark === "best");
  const worst = ordered.filter((r) => r.mark === "worst").sort((a, b) => a.rankPosition! - b.rankPosition!);
  const middle = ordered.filter((r) => r.mark === "middle");
  return { rankedBy, rankedByNote, rows: [...best, ...middle, ...worst, ...lowData], brand };
}

/**
 * Из дневных строк периода — рейтинг. Четыре запроса на ВСЕХ (дневные суммы, дни с
 * тратами, объявления, объекты/состояние), без N+1; клиенты — общий хелпер
 * adLeadAttribution (ещё четыре запроса по списку id). Все выборки с пределом.
 */
/**
 * Заголовок креатива при ОДИНАКОВОЙ первой строке подписи у нескольких объявлений:
 * строка + « · №<номер объекта>», а без объекта — строка + « · <название кампании>».
 */
export function creativeTitle(line: string, shortId: number | undefined, campaignName: string): string {
  return `${line} · ${shortId != null ? `№${shortId}` : campaignName}`;
}

export async function buildCreativeRanking(period: {
  from: Date;
  to: Date;
  label: string;
}): Promise<AdCreativesResponse> {
  const { from, to, label } = period;
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaAdsSyncedAt: true, metaAdsEnabled: true },
  });
  const base = {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    label,
    thresholds: { minSpendTjs: CREATIVE_MIN_SPEND_TJS, minImpressions: CREATIVE_MIN_IMPRESSIONS },
    syncedAt: settings?.metaAdsSyncedAt ? settings.metaAdsSyncedAt.toISOString() : null,
    enabled: !!settings?.metaAdsEnabled,
  };

  const [sums, foreignCount, money] = await Promise.all([
    // «Объявление × валюта» схлопнуто базой: строк на порядок меньше, чем дневных.
    prisma.adSpendDaily.groupBy({
      by: ["adId", "currency"],
      where: { date: { gte: from, lte: to }, ad: { excluded: false } },
      _sum: { spend: true, impressions: true, reach: true, conversations: true },
      orderBy: [{ adId: "asc" }, { currency: "asc" }],
      take: 5000,
    }),
    prisma.ad.count({ where: { excluded: true } }),
    loadMoneyContext(),
  ]);

  // Свёртка по объявлению: валюты складываются СУММОЙ по валюте, перевод — один раз.
  const byAd = new Map<
    string,
    { rows: { spend: number; currency: string }[]; impressions: number; reach: number; conversations: number }
  >();
  for (const s of sums) {
    const acc = byAd.get(s.adId) ?? { rows: [], impressions: 0, reach: 0, conversations: 0 };
    acc.rows.push({ spend: Number(s._sum.spend ?? 0), currency: s.currency });
    acc.impressions += s._sum.impressions ?? 0;
    acc.reach += s._sum.reach ?? 0;
    acc.conversations += s._sum.conversations ?? 0;
    byAd.set(s.adId, acc);
  }
  const spentAds = Array.from(byAd, ([adId, acc]) => ({ adId, acc, spendCents: adSpendToTjsCents(acc.rows, money) }))
    .filter((a) => a.spendCents > 0)
    .sort((a, b) => b.spendCents - a.spendCents || a.adId.localeCompare(b.adId));
  const truncated = spentAds.length > MAX_RANKED_ADS;
  const picked = truncated ? spentAds.slice(0, MAX_RANKED_ADS) : spentAds;

  if (picked.length === 0) {
    const ranking = rankCreatives([]);
    return { ...base, ...ranking, foreignCount, truncated: false, leadsTruncated: false };
  }

  const adIds = picked.map((a) => a.adId);
  const [ads, activeDays, allocations, lastSpend, asOf] = await Promise.all([
    prisma.ad.findMany({
      where: { id: { in: adIds } },
      select: {
        id: true,
        externalId: true,
        name: true,
        campaignName: true,
        status: true,
        stopTime: true,
        postUrl: true,
        thumbnailUrl: true,
        caption: true,
        brand: true,
      },
    }),
    // Дни с реальными тратами: строка «объявление × день» одна, значит счёт строк = счёт дней.
    prisma.adSpendDaily.groupBy({
      by: ["adId"],
      where: { adId: { in: adIds }, date: { gte: from, lte: to }, spend: { gt: 0 } },
      _count: { _all: true },
    }),
    loadAdAllocations(adIds),
    lastSpendByAd(adIds),
    deliveryAsOf(),
  ]);
  const adById = new Map(ads.map((a) => [a.id, a]));
  const daysByAd = new Map(activeDays.map((d) => [d.adId, d._count._all]));

  // Клиенты CRM по объявлениям периода — тот же расчёт, что на доске и в карточке объекта.
  let leadsTruncated = false;
  const leadsOf = new Map<string, { leads: number; showings: number }>();
  try {
    const attribution = await loadAdAttribution(
      picked.flatMap((p) => {
        const ad = adById.get(p.adId);
        return ad
          ? [{ adId: ad.id, externalId: ad.externalId, spendCents: p.spendCents, items: allocations.get(ad.id) ?? [] }]
          : [];
      }),
      periodInstants(from, to),
      money
    );
    leadsTruncated = attribution.truncated;
    for (const [adId, found] of attribution.byAd) leadsOf.set(adId, found.total);
  } catch (err) {
    // Сбой расчёта клиентов рейтинг не роняет: цены клиента не будет, останутся обращения Meta.
    // Но и не молчит: отказ попадает в журнал (как у доски, routes/ads.ts).
    void logSystemError("ads", `Клиенты объявлений не посчитаны (рейтинг креативов): ${describeError(err)}`, {
      dedupKey: "ads-creatives-lead-attribution",
    });
  }

  // Одинаковая первая строка подписи у нескольких объявлений («Продаётся квартира:») —
  // заголовки неотличимы, поэтому к ним дописывается номер объекта (или кампания).
  const captionLines = new Map<string, number>();
  for (const ad of ads) {
    const line = firstLine(ad.caption);
    if (line) captionLines.set(line, (captionLines.get(line) ?? 0) + 1);
  }
  const primaryIds = Array.from(
    new Set(
      ads.flatMap((ad) => {
        const line = firstLine(ad.caption);
        const primary = allocations.get(ad.id)?.[0]?.propertyId;
        return line && (captionLines.get(line) ?? 0) > 1 && primary ? [primary] : [];
      })
    )
  );
  const shortIdOf = new Map(
    primaryIds.length > 0
      ? (
          await prisma.property.findMany({ where: { id: { in: primaryIds } }, select: { id: true, shortId: true } })
        ).map((pr) => [pr.id, pr.shortId] as const)
      : []
  );
  const titleOf = (ad: (typeof ads)[number]): string => {
    const line = firstLine(ad.caption);
    if (!line) return ad.campaignName ?? ad.name;
    if ((captionLines.get(line) ?? 0) <= 1) return line;
    return creativeTitle(line, shortIdOf.get(allocations.get(ad.id)?.[0]?.propertyId ?? ""), ad.campaignName ?? ad.name);
  };

  const inputs: CreativeInput[] = picked.flatMap((p) => {
    const ad = adById.get(p.adId);
    if (!ad) return [];
    return [
      {
        adId: ad.id,
        title: titleOf(ad),
        campaignName: ad.campaignName,
        thumbnailUrl: ad.thumbnailUrl,
        postUrl: ad.postUrl,
        delivery: adDelivery({
          status: ad.status,
          stopTime: ad.stopTime,
          lastSpendAt: lastSpend.get(ad.id) ?? null,
          asOf,
        }),
        activeDays: daysByAd.get(ad.id) ?? 0,
        spendCents: p.spendCents,
        impressions: p.acc.impressions,
        reach: p.acc.reach,
        conversations: p.acc.conversations,
        leads: leadsOf.get(ad.id)?.leads ?? 0,
        showings: leadsOf.get(ad.id)?.showings ?? 0,
        objectsCount: allocations.get(ad.id)?.length ?? 0,
        brand: ad.brand,
      },
    ];
  });

  const ranking = rankCreatives(inputs);
  const cut = ranking.rows.length > CREATIVE_MAX_ROWS;
  return {
    ...base,
    rankedBy: ranking.rankedBy,
    rankedByNote: ranking.rankedByNote,
    rows: cut ? ranking.rows.slice(0, CREATIVE_MAX_ROWS) : ranking.rows,
    brand: ranking.brand.slice(0, CREATIVE_MAX_ROWS),
    foreignCount,
    truncated: truncated || cut,
    leadsTruncated,
  };
}

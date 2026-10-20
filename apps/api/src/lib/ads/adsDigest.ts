import { pluralizeRu, type AdsDigestSummary } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { dushanbeDateString } from "../dushanbeTime.js";
import { centsToTjs, fromCents, loadMoneyContext, toCents } from "../money.js";
import { periodInstants } from "./adLeadAttribution.js";

/**
 * РЕКЛАМА В УТРЕННЕЙ СВОДКЕ ДИРЕКТОРУ (волна 1, 03.10.2026).
 *
 * До этого в утреннем срезе (lib/morningNumbers.ts → пуш «Утренняя сводка» из cron.ts)
 * про рекламу не было ни слова, хотя деньги на неё — вторая по размеру статья после
 * зарплат. Одна строка: сколько потратили вчера, сколько обращений насчитала Meta,
 * сколько клиентов реально попало в CRM и сколько стоит клиент — с отметкой «дороже /
 * дешевле» против предыдущей недели.
 *
 * СТРОКА ПОЯВЛЯЕТСЯ, ТОЛЬКО КОГДА ЕСТЬ О ЧЁМ СКАЗАТЬ: кабинет подключён и вчера были
 * траты. Выключенная реклама — не новость, а «потрачено 0 с.» в тихий день — шум.
 * Честного «нет данных» вместо выдуманных цифр: тренд молчит, пока в любой из недель
 * меньше MIN_LEADS_FOR_TREND клиентов — по двум клиентам «цена выросла вдвое» ничего
 * не значит.
 */

/** Меньше стольких клиентов за неделю — сравнивать цену клиента нельзя (случайность сильнее сигнала). */
export const MIN_LEADS_FOR_TREND = 3;
/** Изменение цены клиента меньше этого процента не считаем движением. */
export const TREND_FLAT_PCT = 10;
/** Предел списка объявлений для подсчёта клиентов: больше в кабинете агентства не бывает. */
const MAX_ADS = 2000;

export interface WindowTotals {
  /** Расход, сотые сомони. */
  spendCents: number;
  /** Обращения по версии Meta. */
  conversations: number;
  /** Клиенты CRM, пришедшие с объявлений. */
  leads: number;
}

/**
 * ЧИСТАЯ ЛОГИКА: цена клиента этой недели против предыдущей. null — данных не хватает
 * (в любой из недель мало клиентов или нет расхода).
 */
export function compareCostPerLead(
  week: Pick<WindowTotals, "spendCents" | "leads">,
  prev: Pick<WindowTotals, "spendCents" | "leads">
): { trend: "up" | "down" | "flat"; pct: number } | null {
  if (week.leads < MIN_LEADS_FOR_TREND || prev.leads < MIN_LEADS_FOR_TREND) return null;
  if (week.spendCents <= 0 || prev.spendCents <= 0) return null;
  const now = week.spendCents / week.leads;
  const before = prev.spendCents / prev.leads;
  const pct = Math.round(((now - before) / before) * 100);
  if (Math.abs(pct) < TREND_FLAT_PCT) return { trend: "flat", pct: Math.abs(pct) };
  return { trend: pct > 0 ? "up" : "down", pct: Math.abs(pct) };
}

/** Строка сводки. Чистая функция: формат живёт здесь, cron.ts только вставляет её. */
export function formatAdsDigestLine(s: AdsDigestSummary): string {
  const fmt = (n: number) => new Intl.NumberFormat("ru-RU").format(Math.round(n));
  const leadsPart =
    s.leads > 0
      ? `клиентов в CRM ${s.leads}` + (s.costPerLeadTjs != null ? `, цена клиента ${fmt(s.costPerLeadTjs)} с.` : "")
      : "клиентов в CRM нет";
  const trendPart =
    s.trend === "up"
      ? ` (дороже на ${s.trendPct}% к прошлой неделе)`
      : s.trend === "down"
        ? ` (дешевле на ${s.trendPct}% к прошлой неделе)`
        : s.trend === "flat"
          ? " (как на прошлой неделе)"
          : "";
  return (
    `📢 Реклама вчера: потрачено ${fmt(s.spendTjs)} с., ` +
    `${s.conversations} ${pluralizeRu(s.conversations, ["обращение", "обращения", "обращений"])} по Meta, ${leadsPart}${trendPart}`
  );
}

/** Сутки по Душанбе «ГГГГ-ММ-ДД» → UTC-полночь (так хранится колонка DATE расхода). */
const dayStart = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const shiftDays = (d: Date, days: number): Date => new Date(d.getTime() + days * 86_400_000);

/** Расход, обращения и клиенты за окно дней [from, to] включительно: три запроса на окно. */
async function loadWindow(from: Date, to: Date, adExternalIds: string[]): Promise<WindowTotals> {
  const { start, end } = periodInstants(from, to);
  const [spendRows, leads, money] = await Promise.all([
    // «Объявление × валюта»: курс применяется к сумме объявления по валюте (money.ts::adSpendToTjsCents),
    // как в отчёте по объектам и на доске, — сводка и экран не расходятся на цент.
    prisma.adSpendDaily.groupBy({
      by: ["adId", "currency"],
      where: { date: { gte: from, lte: to }, ad: { excluded: false } },
      _sum: { spend: true, conversations: true },
      orderBy: { _sum: { spend: "desc" } },
      take: 5000,
    }),
    adExternalIds.length > 0
      ? prisma.client.count({
          where: { sourceAdId: { in: adExternalIds }, deletedAt: null, createdAt: { gte: start, lt: end } },
        })
      : Promise.resolve(0),
    loadMoneyContext(),
  ]);
  return {
    spendCents: spendRows.reduce((acc, r) => acc + centsToTjs(toCents(r._sum.spend ?? 0), r.currency, money), 0),
    // (каждая строка — уже сумма одного объявления в одной валюте: правило курса соблюдено)
    conversations: spendRows.reduce((acc, r) => acc + (r._sum.conversations ?? 0), 0),
    leads,
  };
}

/**
 * Рекламные цифры за вчера для утренней сводки. null — рекламу не показываем:
 * кабинет не подключён или вчера трат не было.
 */
export async function loadAdsYesterdaySummary(now: Date = new Date()): Promise<AdsDigestSummary | null> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaAdsEnabled: true },
  });
  if (!settings?.metaAdsEnabled) return null;

  // Вчера — по Душанбе: контейнер живёт в UTC, и «вчера» по UTC с 00:00 до 05:00 было бы позавчера.
  const yesterday = dayStart(dushanbeDateString(new Date(now.getTime() - 86_400_000)));
  const ads = await prisma.ad.findMany({
    where: { excluded: false },
    select: { externalId: true },
    take: MAX_ADS,
  });
  const externalIds = ads.map((a) => a.externalId);

  const [day, week, prevWeek] = await Promise.all([
    loadWindow(yesterday, yesterday, externalIds),
    loadWindow(shiftDays(yesterday, -6), yesterday, externalIds),
    loadWindow(shiftDays(yesterday, -13), shiftDays(yesterday, -7), externalIds),
  ]);
  if (day.spendCents <= 0) return null;

  const trend = compareCostPerLead(week, prevWeek);
  return {
    spendTjs: fromCents(day.spendCents),
    conversations: day.conversations,
    leads: day.leads,
    costPerLeadTjs: day.leads > 0 ? fromCents(Math.round(day.spendCents / day.leads)) : null,
    trend: trend?.trend ?? null,
    trendPct: trend?.pct ?? null,
  };
}

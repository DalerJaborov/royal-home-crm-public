import type { ClientSource } from "../generated/prisma/client.js";
import { CLIENT_SOURCE_LABELS } from "@royal-home/shared";
import { prisma } from "../db.js";
import { expenseCentsToTjs, fromCents } from "./money.js";
import { loadMoneyContext, roundMoney, toTjs, type MoneyContext } from "./money.js";
import { dushanbeStartOfMonth, dushanbeStartOfToday, dushanbeWallClock } from "./dushanbeTime.js";
import { COUNTED_SHOWING_WHERE } from "./tasks.js";

/**
 * СКВОЗНАЯ ВОРОНКА МАРКЕТИНГА (mission-control, фаза 3, план §6 п.5): расход →
 * лиды → показы → сделки → комиссия, по каналу (`Client.source` — та же
 * таксономия, что уже использует «Стоимость лида» в `routes/expenses.ts` и
 * `Client.source`-группировка в отчётах; новый список каналов не вводим).
 *
 * ТОЧНОСТЬ — КАК У ОСТАЛЬНОГО ДАШБОРДА, НЕ БОЛЬШЕ. Все пять чисел за канал —
 * это снапшот ОДНОГО календарного месяца по Душанбе, а не когортный анализ:
 * «лиды месяца» и «сделки месяца» — разные клиенты (лид от 30-го числа может
 * закрыться только в следующем месяце, а сделка, закрытая 1-го, могла прийти
 * от лида прошлого квартала). Это тот же уровень точности, что уже есть у
 * costPerLead в `routes/expenses.ts:323` — там ровно то же допущение. Полная
 * когортная воронка (привязка каждой сделки к месяцу ЕЁ лида) потребовала бы
 * трекать путь клиента по времени, чего сейчас нигде в дашборде нет —
 * не строим ради одной плитки то, чего нет и в остальной системе.
 *
 * ДЕНЬГИ (spend/commission/costPerLead) — только когда seesMoney: то же
 * право `finance.view`, которым уже гейтится каждая денежная секция
 * mission-control (см. dashboardMissionControl.ts). Счётчики (лиды/показы/
 * сделки) — не деньги, видны всем, кому открыт `dashboard.analytics`.
 *
 * АНОМАЛИЯ — ПОРОГ, НЕ СТАТИСТИКА. Как и весь остальной первый-линейный
 * детектор в этом кодовой базе (sellerPropertyMissingAntifraud.ts,
 * adAlerts.ts: «неделя к неделе вдвое дороже»), без z-score и прочей
 * статистики: лидов сегодня меньше половины среднего за предыдущие 7 дней —
 * флаг. Средний должен быть заметным (>=2/день), иначе канал с 1 лидом в
 * неделю мигал бы тревогой на пустом месте.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const TRAILING_DAYS = 7;
/** Ниже этого среднего в день сравнение считаем шумом (канал и так почти без лидов). */
const MIN_TRAILING_AVG_FOR_ANOMALY = 2;
/** «Сегодня» ниже этой доли среднего — тревога (тот же порог 50%, что в задании). */
const ANOMALY_RATIO = 0.5;
/** Сколько каналов показываем в зоне — «свободных побед» здесь не тысяча строк. */
const CHANNEL_CAP = 12;

function currentMonthKey(now: Date): string {
  const wall = dushanbeWallClock(now);
  return `${wall.getUTCFullYear()}-${String(wall.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "2026-08" → первый день месяца (UTC) — тот же формат, каким Expense.month
 *  заводят routes/expenses.ts и lib/ads/adExpenseSync.ts (не смешивать с
 *  dushanbeStartOfMonth: та возвращает офсетнутый instant, а Expense.month
 *  хранится плоской UTC-полночью первого числа). */
function monthToDate(month: string): Date {
  return new Date(`${month}-01T00:00:00.000Z`);
}

export interface ChannelFunnel {
  source: ClientSource;
  label: string;
  leadsMonth: number;
  showingsMonth: number;
  dealsClosedMonth: number;
  spendMonthTjs: number | null;
  commissionMonthTjs: number | null;
  costPerLeadTjs: number | null;
  leadsToday: number;
  leadsTrailing7Avg: number;
  anomalyLeadsDown: boolean;
}

export interface MarketingFunnelResult {
  month: string;
  channels: ChannelFunnel[];
}

function toCount(arr: { source: ClientSource; _count: { _all: number } }[]): Map<ClientSource, number> {
  return new Map(arr.map((r) => [r.source, r._count._all]));
}

export async function buildMarketingFunnel(seesMoney: boolean, now: Date): Promise<MarketingFunnelResult> {
  const month = currentMonthKey(now);
  /** Ключ месяца у Expense.month — плоская UTC-полночь 1-го (только для расходов). */
  const expenseMonth = monthToDate(month);
  // ГРАНИЦЫ МЕСЯЦА ДЛЯ МОМЕНТОВ ВРЕМЕНИ — ПО ДУШАНБЕ (C8, 02.10.2026). Раньше лиды,
  // показы и сделки резались UTC-полночью = 05:00 по Душанбе: ночные лиды 1-го не
  // попадали ни в один месяц, а с 00:00 до 05:00 1-го всё было по нулям.
  const monthStart = dushanbeStartOfMonth(now);
  const monthEnd = dushanbeStartOfMonth(new Date(monthStart.getTime() + 32 * DAY_MS));
  const startOfDay = dushanbeStartOfToday(now);
  const trailingFrom = new Date(startOfDay.getTime() - TRAILING_DAYS * DAY_MS);

  const [leadsMonthRows, leadsTodayRows, leadsTrailingRows, showingRows, dealRows, expenseRows, money] =
    await Promise.all([
      prisma.client.groupBy({
        by: ["source"],
        where: { createdAt: { gte: monthStart, lt: monthEnd }, deletedAt: null },
        _count: { _all: true },
      }),
      prisma.client.groupBy({
        by: ["source"],
        where: { createdAt: { gte: startOfDay }, deletedAt: null },
        _count: { _all: true },
      }),
      prisma.client.groupBy({
        by: ["source"],
        where: { createdAt: { gte: trailingFrom, lt: startOfDay }, deletedAt: null },
        _count: { _all: true },
      }),
      // Показ — Interaction type=SHOWING (отдельной модели Showing в схеме нет,
      // тот же источник, что у findSilentAfterShowing/oversight.ts). Группировки
      // по полю связанной модели Prisma не умеет — берём source клиента и
      // считаем сами, как costPerLead в routes/expenses.ts.
      prisma.interaction.findMany({
        // Отменённые показы и клиенты из Корзины не в счёт — как в «Отчётах» (C8).
        where: {
          type: "SHOWING",
          ...COUNTED_SHOWING_WHERE,
          createdAt: { gte: monthStart, lt: monthEnd },
          client: { deletedAt: null },
        },
        select: { client: { select: { source: true } } },
        take: 5000,
      }),
      prisma.deal.findMany({
        where: { stage: "COMPLETED", closedAt: { gte: monthStart, lt: monthEnd } },
        select: { commissionAmount: true, currency: true, client: { select: { source: true } } },
        take: 5000,
      }),
      // Расход по каналу — уже посчитан и лежит в Финансах (Expense, category
      // ADVERTISING, автоматически заводится upsertAdExpenses); не дублируем
      // агрегацию по AdSpendDaily, а читаем готовую строку, как costPerLead.
      seesMoney
        ? prisma.expense.findMany({
            where: { category: "ADVERTISING", deletedAt: null,status:"PAID", month: expenseMonth, source: { not: null } },
            select: { amount: true, currency: true, source: true,exchangeRate:true },
          })
        : Promise.resolve([]),
      seesMoney ? loadMoneyContext() : Promise.resolve(null as MoneyContext | null),
    ]);

  const leadsMonth = toCount(leadsMonthRows);
  const leadsToday = toCount(leadsTodayRows);
  const leadsTrailing = toCount(leadsTrailingRows);

  const showingsMonth = new Map<ClientSource, number>();
  for (const row of showingRows) {
    const source = row.client?.source;
    if (!source) continue;
    showingsMonth.set(source, (showingsMonth.get(source) ?? 0) + 1);
  }

  const dealsClosedMonth = new Map<ClientSource, number>();
  const commissionMonth = new Map<ClientSource, number>();
  for (const deal of dealRows) {
    const source = deal.client?.source;
    if (!source) continue;
    dealsClosedMonth.set(source, (dealsClosedMonth.get(source) ?? 0) + 1);
    if (money) {
      const tjs = toTjs(deal.commissionAmount, deal.currency, money);
      commissionMonth.set(source, (commissionMonth.get(source) ?? 0) + tjs);
    }
  }

  const spendMonth = new Map<ClientSource, number>();
  if (money) {
    for (const e of expenseRows) {
      if (!e.source) continue;
      const tjs = fromCents(expenseCentsToTjs(e,money));
      spendMonth.set(e.source, (spendMonth.get(e.source) ?? 0) + tjs);
    }
  }

  const allSources = new Set<ClientSource>([
    ...leadsMonth.keys(),
    ...showingsMonth.keys(),
    ...dealsClosedMonth.keys(),
    ...spendMonth.keys(),
  ]);

  const channels: ChannelFunnel[] = [...allSources].map((source) => {
    const leads = leadsMonth.get(source) ?? 0;
    const today = leadsToday.get(source) ?? 0;
    const trailingTotal = leadsTrailing.get(source) ?? 0;
    const trailingAvg = trailingTotal / TRAILING_DAYS;
    const spend = money ? (spendMonth.get(source) ?? 0) : null;
    const commission = money ? (commissionMonth.get(source) ?? 0) : null;
    return {
      source,
      label: CLIENT_SOURCE_LABELS[source] ?? source,
      leadsMonth: leads,
      showingsMonth: showingsMonth.get(source) ?? 0,
      dealsClosedMonth: dealsClosedMonth.get(source) ?? 0,
      spendMonthTjs: spend == null ? null : roundMoney(spend),
      commissionMonthTjs: commission == null ? null : roundMoney(commission),
      // Стоимость лида — до копейки: при 3 лидах и 100 с. это 33,33, а не 33.
      costPerLeadTjs: spend != null && leads > 0 ? roundMoney(spend / leads) : null,
      leadsToday: today,
      leadsTrailing7Avg: Math.round(trailingAvg * 10) / 10,
      anomalyLeadsDown: trailingAvg >= MIN_TRAILING_AVG_FOR_ANOMALY && today < trailingAvg * ANOMALY_RATIO,
    };
  });

  // Сортировка по расходу (если деньги видны) или по лидам — самый заметный
  // канал сверху, «пустые» источники (0 везде) не занимают строку.
  channels.sort((a, b) => (b.spendMonthTjs ?? b.leadsMonth) - (a.spendMonthTjs ?? a.leadsMonth));

  return { month, channels: channels.slice(0, CHANNEL_CAP) };
}

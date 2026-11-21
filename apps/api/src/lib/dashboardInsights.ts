import { prisma } from "../db.js";
import { loadMoneyContext, roundMoney, toTjs } from "./money.js";
import { dushanbeStartOfMonth, dushanbeWallClock } from "./dushanbeTime.js";
import { BUYERS_IN_WORK_WHERE } from "./agentLoad.js";
import {
  computeRoyalScoreBreakdownBatch,
  ROYAL_SCORE_CATEGORIES,
  type RoyalScoreCategoryKey,
} from "./scoreJournal.js";
import { RATED_ROLES } from "@royal-home/shared";

/**
 * Четыре инсайт-виджета дашборда (владелец 05.08.2026, кусок 3): «слабое звено
 * недели», «где застревают сделки», «прогноз плана», «кто перегружен/недогружен».
 * Один эндпоинт на все четыре — иначе дашборд открывает 4 запроса вместо одного.
 */

export interface WeakLinkInsight {
  agentId: string;
  agentName: string;
  category: string;
  categoryLabel: string;
  sum: number;
}

/** У какого агента какая категория Royal Score просела сильнее всего за окно. */
export async function computeWeakLink(): Promise<WeakLinkInsight | null> {
  const agents = await prisma.agent.findMany({
    where: { role: { in: [...RATED_ROLES] }, isActive: true },
    select: { id: true, fullName: true },
  });
  if (!agents.length) return null;

  // Раньше здесь был Promise.all по агентам, и каждый звал computeRoyalScoreBreakdown:
  // на N активных агентов — 2×N запросов к базе при КАЖДОМ открытии главной (запрос
  // настроек и запрос событий дублировались на каждого). Батч ниже делает два запроса
  // на весь список — тот же приём, что у соседних виджетов этого файла.
  const breakdownByAgent = await computeRoyalScoreBreakdownBatch(agents.map((a) => a.id));

  let worst: WeakLinkInsight | null = null;
  for (const agent of agents) {
    // Батч возвращает запись на каждый переданный id, даже с нулями, — список тот же.
    const breakdown = breakdownByAgent.get(agent.id)!;
    for (const c of ROYAL_SCORE_CATEGORIES) {
      const sum = breakdown[c.key];
      if (worst === null || sum < worst.sum) {
        worst = { agentId: agent.id, agentName: agent.fullName, category: c.key, categoryLabel: c.label, sum };
      }
    }
  }
  return worst;
}

// «Где застревают клиенты» по статусам (computeStalledStages) снято 17.11.2026:
// статусы клиента не показываются нигде (владелец).

export interface PlanForecastInsight {
  commissionMonth: number;
  plan: number;
  /** Прогноз к концу месяца при текущем темпе. */
  forecastEndOfMonth: number;
  forecastPercent: number;
  daysElapsed: number;
  daysInMonth: number;
  /** План равен значению по умолчанию из схемы (8000) — вероятно, его никто не задавал. */
  planIsDefault?: boolean;
}

/** Значение Settings.monthlyCommissionPlan по умолчанию (schema.prisma). */
export const DEFAULT_COMMISSION_PLAN = 8000;

/** Колонка плана NOT NULL с умолчанием 8000: совпадение с умолчанием — «план не задан». Одна функция для главной и дашборда. */
export function isDefaultCommissionPlan(plan: number): boolean {
  return plan === DEFAULT_COMMISSION_PLAN;
}

/** Экстраполяция текущего темпа продаж на весь месяц — «умная» версия плитки «Цель месяца». */
export async function computePlanForecast(): Promise<PlanForecastInsight> {
  const [settings, money] = await Promise.all([
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { monthlyCommissionPlan: true } }),
    loadMoneyContext(),
  ]);
  const monthStart = dushanbeStartOfMonth();
  const now = new Date();
  const deals = await prisma.deal.findMany({
    where: { stage: "COMPLETED", closedAt: { gte: monthStart, lte: now } },
    select: { commissionAmount: true, currency: true },
  });
  const commissionMonth = roundMoney(deals.reduce((sum, d) => sum + toTjs(d.commissionAmount, d.currency, money), 0));

  // Граница месяца для выборки уже взята по Душанбе (dushanbeStartOfMonth) — день/дни
  // месяца для «день X из Y» на плитке считаем тем же настенным временем, иначе у
  // границы месяца (после 19:00 UTC) выборка уже за новый месяц, а подпись — за старый.
  const wall = dushanbeWallClock(now);
  const daysInMonth = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 0)).getUTCDate();
  const daysElapsed = Math.max(1, wall.getUTCDate());
  const forecastEndOfMonth = Math.round((commissionMonth / daysElapsed) * daysInMonth);
  const plan = Number(settings?.monthlyCommissionPlan ?? DEFAULT_COMMISSION_PLAN);
  // Колонка NOT NULL с default 8000: «не задан» от «задан 8000» в базе не отличить —
  // честно помечаем совпадение с умолчанием, фронт не выдаёт его за настоящий план.
  const planIsDefault = isDefaultCommissionPlan(plan);
  const forecastPercent = plan ? Math.round((forecastEndOfMonth / plan) * 100) : 0;

  return { commissionMonth, plan, forecastEndOfMonth, forecastPercent, daysElapsed, daysInMonth, planIsDefault };
}

export interface PreviousMonthCommission {
  /** Комиссия прошлого месяца с 1-го числа по ту же точку месяца, что сейчас (честное сравнение). */
  toDate: number;
  /** Комиссия прошлого месяца целиком. */
  total: number;
}

/**
 * КОМИССИЯ ПРОШЛОГО МЕСЯЦА ДЛЯ СРАВНЕНИЯ (главная руководителя, 20.11.2026).
 *
 * «15 510 с. за ноябрь» без сравнения не говорит, хорошо это или плохо. Сравнивать
 * неполный месяц с полным прошлым нечестно (20 дней против 31), поэтому основное
 * сравнение — с прошлым месяцем на ту же точку: прошло 19 дней 14 часов ноября —
 * берём октябрь с 1-го по 20-е 14:00. Если прошлый месяц короче (31 марта против
 * февраля), точка упирается в его конец. Полный прошлый месяц — отдельным числом.
 *
 * Те же правила денег, что у computePlanForecast: закрытые сделки (COMPLETED) по
 * closedAt, суммы в сомони через toTjs, границы месяцев по Душанбе.
 */
/** Потолок выборки сделок прошлого месяца (защита от аварии). */
export const PREVIOUS_MONTH_DEALS_CAP = 5000;

export async function computePreviousMonthCommission(now: Date = new Date()): Promise<PreviousMonthCommission> {
  const thisStart = dushanbeStartOfMonth(now);
  const prevStart = dushanbeStartOfMonth(new Date(thisStart.getTime() - 1));
  const cut = new Date(Math.min(prevStart.getTime() + (now.getTime() - thisStart.getTime()), thisStart.getTime()));
  const [money, deals] = await Promise.all([
    loadMoneyContext(),
    prisma.deal.findMany({
      where: { stage: "COMPLETED", closedAt: { gte: prevStart, lt: thisStart } },
      select: { commissionAmount: true, currency: true, closedAt: true },
      // Сделок за месяц у агентства десятки; потолок — от аварии, а не рабочий режим.
      // Порядок по дате закрытия — чтобы при упоре в потолок отрезались поздние сделки
      // месяца, а сравнение «на ту же точку» оставалось полным.
      orderBy: [{ closedAt: "asc" }, { id: "asc" }],
      take: PREVIOUS_MONTH_DEALS_CAP,
    }),
  ]);
  let toDate = 0;
  let total = 0;
  for (const d of deals) {
    const tjs = toTjs(d.commissionAmount, d.currency, money);
    total += tjs;
    if (d.closedAt && d.closedAt < cut) toDate += tjs;
  }
  return { toDate: roundMoney(toDate), total: roundMoney(total) };
}

export interface WorkloadInsight {
  agentId: string;
  agentName: string;
  activeClients: number;
}

/**
 * Распределение активных лидов по агентам — для визуальной балансировки нагрузки.
 *
 * «Активный» здесь означает РОВНО ТО ЖЕ, что и в лимите лидов
 * (OCCUPIES_SLOT_WHERE, см. lib/leadLimits.ts). Иначе на одном экране получалось
 * три разных числа про одного человека: «Команда сейчас» считала
 * NEW/CONTACTED/HOT/COLD, «Кто перегружен» — NEW/CONTACTED/HOT, а «Агенты у
 * лимита» в «Контроле руководителя» — по занятым слотам. Первый же остывший
 * клиент разводил их между собой, и понять, у кого сколько работы, было нельзя.
 *
 * Правило владельца от 12.08.2026: слот держит ДЕЙСТВИЕ агента (workStatus),
 * а не то, до какой степени клиент остыл сам по себе.
 */
export async function computeWorkloadBalance(): Promise<WorkloadInsight[]> {
  const agents = await prisma.agent.findMany({
    where: { role: { in: [...RATED_ROLES] }, isActive: true },
    select: {
      id: true,
      fullName: true,
      _count: {
        select: {
          clients: { where: { deletedAt: null, ...BUYERS_IN_WORK_WHERE } },
        },
      },
    },
  });
  return agents
    .map((a) => ({ agentId: a.id, agentName: a.fullName, activeClients: a._count.clients }))
    .sort((a, b) => b.activeClients - a.activeClients);
}

export interface DashboardInsights {
  weakLink: WeakLinkInsight | null;
  /** Деньги компании (комиссия месяца, план) — `null`, если у спрашивающего нет
   *  права finance.view. Тот же приём, что у commission в /dashboard/charts. */
  planForecast: PlanForecastInsight | null;
  workload: WorkloadInsight[];
}

/**
 * `seesMoney` обязателен и без значения по умолчанию намеренно (28.09.2026):
 * роут открыт правом dashboard.analytics, которое есть и у менеджера, а прогноз
 * плана — это комиссия компании за месяц. Раньше он уходил всем с аналитикой без
 * проверки денег; обязательный аргумент не даёт новому вызову забыть о проверке.
 */
export async function buildDashboardInsights(opts: { seesMoney: boolean }): Promise<DashboardInsights> {
  const [weakLink, planForecast, workload] = await Promise.all([
    computeWeakLink(),
    opts.seesMoney ? computePlanForecast() : Promise.resolve(null),
    computeWorkloadBalance(),
  ]);
  return { weakLink, planForecast, workload };
}

export type { RoyalScoreCategoryKey };

import { prisma } from "../db.js";
import type { ClientStatus } from "../generated/prisma/client.js";
import { loadMoneyContext, roundMoney, toTjs } from "./money.js";
import { dushanbeStartOfMonth, dushanbeWallClock } from "./dushanbeTime.js";
import { OCCUPIES_SLOT_WHERE } from "./leadLimits.js";
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

export interface StalledStageInsight {
  status: string;
  label: string;
  count: number;
  /** Средний возраст записей на этой стадии, в часах — по updatedAt, приближённо
   *  (нет истории переходов статуса для точного расчёта времени НА стадии). */
  avgAgeHours: number;
}

const STATUS_LABELS: Record<string, string> = {
  NEW: "Новые",
  CONTACTED: "На контакте",
  HOT: "Горячие",
  COLD: "Остывшие",
  UNRESPONSIVE: "Не отвечают",
};

/** Среднее время нахождения на стадии — грубое приближение по updatedAt, не точная аналитика. */
export async function computeStalledStages(): Promise<StalledStageInsight[]> {
  const statuses = Object.keys(STATUS_LABELS) as ClientStatus[];
  // Нет отдельной метки времени смены статуса — берём lastContactAt (последний
  // раз, когда с клиентом реально что-то происходило) как ближайшую доступную
  // замену: приближение, не точная аналитика по времени НА стадии.
  const clients = await prisma.client.findMany({
    where: { status: { in: statuses }, deletedAt: null },
    select: { status: true, lastContactAt: true },
    // Потолок, как в routes/ai.ts: плитка считается при каждом заходе на главную,
    // а выборка читала ВСЕХ активных клиентов агентства целиком. Пять тысяч самых
    // свежих — это заведомо больше, чем «сейчас в работе», а показатель и так
    // объявлен приближением: клиенты, которых не касались годами, среднее время
    // на стадии только искажают.
    orderBy: { lastContactAt: "desc" },
    take: 5000,
  });
  const now = Date.now();
  const byStatus = new Map<string, { count: number; ageSum: number }>();
  for (const c of clients) {
    const entry = byStatus.get(c.status) ?? { count: 0, ageSum: 0 };
    entry.count += 1;
    entry.ageSum += (now - c.lastContactAt.getTime()) / 3_600_000;
    byStatus.set(c.status, entry);
  }
  return statuses
    .map((status) => {
      const entry = byStatus.get(status);
      return {
        status,
        label: STATUS_LABELS[status],
        count: entry?.count ?? 0,
        avgAgeHours: entry && entry.count ? Math.round(entry.ageSum / entry.count) : 0,
      };
    })
    .filter((s) => s.count > 0)
    .sort((a, b) => b.avgAgeHours - a.avgAgeHours);
}

export interface PlanForecastInsight {
  commissionMonth: number;
  plan: number;
  /** Прогноз к концу месяца при текущем темпе. */
  forecastEndOfMonth: number;
  forecastPercent: number;
  daysElapsed: number;
  daysInMonth: number;
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
  const plan = Number(settings?.monthlyCommissionPlan ?? 8000);
  const forecastPercent = plan ? Math.round((forecastEndOfMonth / plan) * 100) : 0;

  return { commissionMonth, plan, forecastEndOfMonth, forecastPercent, daysElapsed, daysInMonth };
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
          clients: { where: { deletedAt: null, ...OCCUPIES_SLOT_WHERE } },
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
  stalledStages: StalledStageInsight[];
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
  const [weakLink, stalledStages, planForecast, workload] = await Promise.all([
    computeWeakLink(),
    computeStalledStages(),
    opts.seesMoney ? computePlanForecast() : Promise.resolve(null),
    computeWorkloadBalance(),
  ]);
  return { weakLink, stalledStages, planForecast, workload };
}

export type { RoyalScoreCategoryKey };

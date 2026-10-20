import { prisma } from "../db.js";
import { loadMoneyContext, roundMoney, toTjs } from "./money.js";
import { computePlanForecast } from "./dashboardInsights.js";
import { buildFinancePulse } from "./financePulse.js";
import { buildMarketingFunnel } from "./marketingFunnel.js";
import { dushanbeStartOfToday, dushanbeStartOfMonth } from "./dushanbeTime.js";
import { givenUpVisibleWhere } from "./stuckWork.js";
import { RATED_ROLES } from "@royal-home/shared";

/**
 * «Вопрос к данным» (план §6, фаза 4, п.8) — собирает СНИМОК данных, который
 * дальше уходит модели в ai/missionControlQa.ts как единственный источник
 * правды (промт там запрещает отвечать чем-либо, кроме этого JSON).
 *
 * НЕ НОВАЯ ВЫБОРКА НА КАЖДОЕ ПОЛЕ — переиспользуем те же агрегаты, что и
 * mission control (`buildFinancePulse`, `computePlanForecast`,
 * `buildMarketingFunnel`), плюс то, чего там нет: разбивку по агенту
 * (сделки/лиды/активные клиенты за месяц) — вопросы вида «сколько сделок у
 * Фарруха» без неё не отвечаемы, а зонная сетка mission control такой
 * детализации по агенту не считает (там только нагрузка/БК).
 *
 * ДЕНЬГИ — ТОЛЬКО ПРИ seesMoney, тот же гейт (`finance.view`), что и у
 * остального дашборда — иначе ответ модели раскрыл бы комиссии тому, кому
 * дашборд их не показывает.
 */

interface AskAgentRow {
  fullName: string;
  activeLoad: number;
  noContact: number;
  dealsThisMonth: number;
  leadsThisMonth: number;
  activeClients: number;
}

export interface AskContext {
  generatedAtDushanbe: string;
  seesMoney: boolean;
  finance: {
    commissionMonthFactTjs: number;
    commissionMonthPlanTjs: number;
    forecastEndOfMonthTjs: number;
    forecastPercent: number;
  } | null;
  leadsToday: number;
  missedCallsToday: number;
  callsToday: { incoming: number; outgoing: number; missed: number };
  agents: AskAgentRow[];
  marketingChannels: {
    label: string;
    leadsMonth: number;
    showingsMonth: number;
    dealsClosedMonth: number;
    spendMonthTjs: number | null;
    costPerLeadTjs: number | null;
  }[];
  properties: { available: number; reserved: number; portfolioValueTjs: number | null };
  system: { cronsHealthy: number; cronsTotal: number; jobsGivenUp: number; errorsToday: number };
}

const ACTIVE_NOT_TERMINAL = {
  workStatus: "ACTIVE" as const,
  status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] as ("LOST" | "DEAL_CLOSED" | "ARCHIVED")[] },
  deletedAt: null,
};

export async function buildAskContext(seesMoney: boolean, now: Date = new Date()): Promise<AskContext> {
  const startOfDay = dushanbeStartOfToday(now);
  const startOfMonth = dushanbeStartOfMonth(now);

  const [
    forecast,
    pulse,
    leadsToday,
    incomingToday,
    outgoingToday,
    missedToday,
    agents,
    funnel,
    available,
    reserved,
    heartbeats,
    jobsGivenUp,
    errorsToday,
  ] = await Promise.all([
    seesMoney ? computePlanForecast() : null,
    seesMoney ? buildFinancePulse() : null,
    prisma.client.count({ where: { createdAt: { gte: startOfDay }, deletedAt: null } }),
    prisma.incomingCall.count({ where: { startedAt: { gte: startOfDay } } }),
    prisma.interaction.count({ where: { type: "CALL", createdAt: { gte: startOfDay } } }),
    prisma.incomingCall.count({ where: { startedAt: { gte: startOfDay }, answered: false } }),
    prisma.agent.findMany({
      where: { role: { in: [...RATED_ROLES] }, isActive: true },
      select: { id: true, fullName: true },
      orderBy: { fullName: "asc" },
      take: 200,
    }),
    buildMarketingFunnel(seesMoney, now),
    prisma.property.count({ where: { deletedAt: null, status: "AVAILABLE" } }),
    prisma.property.count({ where: { deletedAt: null, status: "RESERVED" } }),
    prisma.cronHeartbeat.findMany({ select: { lastRunAt: true, lastOkAt: true } }),
    prisma.backgroundJob.count({ where: givenUpVisibleWhere() }),
    prisma.errorLog.count({ where: { createdAt: { gte: startOfDay }, resolvedAt: null } }),
  ]);

  const ids = agents.map((a) => a.id);
  const [activeLoad, noContact, dealsThisMonth, leadsThisMonth, activeClients] = await Promise.all([
    prisma.client.groupBy({
      by: ["assignedAgentId"],
      where: { assignedAgentId: { in: ids }, ...ACTIVE_NOT_TERMINAL },
      _count: { _all: true },
    }),
    prisma.client.groupBy({
      by: ["assignedAgentId"],
      where: { assignedAgentId: { in: ids }, firstContactAt: null, ...ACTIVE_NOT_TERMINAL },
      _count: { _all: true },
    }),
    prisma.deal.groupBy({
      by: ["agentId"],
      where: { agentId: { in: ids }, stage: "COMPLETED", closedAt: { gte: startOfMonth } },
      _count: { _all: true },
    }),
    prisma.client.groupBy({
      by: ["assignedAgentId"],
      where: { assignedAgentId: { in: ids }, assignedAt: { gte: startOfMonth }, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.client.groupBy({
      by: ["assignedAgentId"],
      where: { assignedAgentId: { in: ids }, deletedAt: null, status: { in: ["NEW", "CONTACTED", "HOT"] } },
      _count: { _all: true },
    }),
  ]);
  const toMap = (arr: { [k: string]: unknown; _count: { _all: number } }[], key: string) =>
    new Map(arr.map((x) => [x[key] as string | null, x._count._all]));
  const load = toMap(activeLoad, "assignedAgentId");
  const noC = toMap(noContact, "assignedAgentId");
  const deals = toMap(dealsThisMonth, "agentId");
  const leads = toMap(leadsThisMonth, "assignedAgentId");
  const active = toMap(activeClients, "assignedAgentId");

  const agentRows: AskAgentRow[] = agents.map((a) => ({
    fullName: a.fullName,
    activeLoad: load.get(a.id) ?? 0,
    noContact: noC.get(a.id) ?? 0,
    dealsThisMonth: deals.get(a.id) ?? 0,
    leadsThisMonth: leads.get(a.id) ?? 0,
    activeClients: active.get(a.id) ?? 0,
  }));

  let portfolioValueTjs: number | null = null;
  if (seesMoney) {
    const money = await loadMoneyContext();
    const priced = await prisma.property.findMany({
      where: { deletedAt: null, status: "AVAILABLE" },
      select: { price: true, currency: true },
      take: 5000,
    });
    portfolioValueTjs = roundMoney(priced.reduce((s, p) => s + toTjs(p.price, p.currency, money), 0));
  }

  const pulseToday = pulse?.find((p) => p.period === "today") ?? null;

  return {
    generatedAtDushanbe: now.toISOString(),
    seesMoney,
    finance:
      forecast && pulseToday
        ? {
            commissionMonthFactTjs: forecast.commissionMonth,
            commissionMonthPlanTjs: forecast.plan,
            forecastEndOfMonthTjs: forecast.forecastEndOfMonth,
            forecastPercent: forecast.forecastPercent,
          }
        : null,
    leadsToday,
    missedCallsToday: missedToday,
    callsToday: { incoming: incomingToday, outgoing: outgoingToday, missed: missedToday },
    agents: agentRows,
    marketingChannels: funnel.channels.map((c) => ({
      label: c.label,
      leadsMonth: c.leadsMonth,
      showingsMonth: c.showingsMonth,
      dealsClosedMonth: c.dealsClosedMonth,
      spendMonthTjs: c.spendMonthTjs,
      costPerLeadTjs: c.costPerLeadTjs,
    })),
    properties: { available, reserved, portfolioValueTjs },
    system: {
      cronsHealthy: heartbeats.filter((h) => !!h.lastOkAt && (!h.lastRunAt || h.lastOkAt >= h.lastRunAt)).length,
      cronsTotal: heartbeats.length,
      jobsGivenUp,
      errorsToday,
    },
  };
}

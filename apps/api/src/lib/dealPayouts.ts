import { prisma } from "../db.js";
import { dealSalaryAutoKey } from "./companyProfit.js";
import { dushanbeMonthRange, dushanbeWallClock } from "./dushanbeTime.js";
import { fromCents, toCents } from "./money.js";

/**
 * ДОЛИ АГЕНТОВ ПО СДЕЛКАМ И ИХ ВЫПЛАТА — ОДНО ПРАВИЛО (10.11.2026).
 *
 * Кому сколько причитается по закрытой сделке, решает одна функция —
 * `dealShareEntries`: доля агента сделки (commissionRealtorAmount) и доля за приём
 * объекта (commissionIntakeAmount → commissionIntakeAgentId). По ней же ночной
 * тик заводит строки «Зарплата из сделок» (lib/financeAutomation.ts,
 * upsertSalaryExpenses), и по ней же отвечает отчёт выплат ниже — REST
 * `GET /deals/payouts` и ИИ-помощница зовут один `agentPayoutsReport`.
 *
 * ДЕНЬГИ В СОМОНИ. Доли хранятся в валюте сделки и здесь отдаются в ней же, до
 * копейки. Итог месяца в сомони — сумма строки «Зарплата» из Финансов, если она
 * уже заведена: та строка заморожена (курс дня, когда её завели, правку курса
 * она не догоняет), и отчёт обязан сходиться с Финансами. Пока строки нет (текущий
 * месяц), итога в сомони нет — пересчёт по курсу делает тот, кто показывает, и
 * подписывает его «по курсу сегодня».
 *
 * ВЫПЛАТА. Отметку выплаты в CRM имеет только доля агента сделки (realtorPayoutAt).
 * У доли за приём объекта отметки нет вовсе — она отдаётся отдельной строкой
 * «выплата приёмщику в CRM не отмечается», а не «ждёт» навсегда.
 */

export interface DealShareEntry {
  agentId: string;
  kind: "realtor" | "intake";
  cents: number;
  currency: string;
}

export interface DealShareSource {
  agentId: string | null;
  currency: string;
  commissionRealtorAmount: unknown;
  commissionIntakeAgentId: string | null;
  commissionIntakeAmount: unknown;
}

/**
 * Кому и сколько по одной закрытой сделке (в сотых валюты сделки). Записанная
 * нулевая доля тоже отдаётся (обнулённая сделка обнуляет строку зарплаты), пустая
 * (null) — нет.
 */
export function dealShareEntries(deal: DealShareSource): DealShareEntry[] {
  const out: DealShareEntry[] = [];
  const has = (v: unknown) => v !== null && v !== undefined;
  if (deal.agentId && has(deal.commissionRealtorAmount)) {
    out.push({ agentId: deal.agentId, kind: "realtor", cents: toCents(deal.commissionRealtorAmount), currency: deal.currency });
  }
  if (deal.commissionIntakeAgentId && has(deal.commissionIntakeAmount)) {
    out.push({ agentId: deal.commissionIntakeAgentId, kind: "intake", cents: toCents(deal.commissionIntakeAmount), currency: deal.currency });
  }
  return out;
}

/** Суммы по валютам, в сотых. */
export type CentsByCurrency = Record<string, number>;

export interface PayoutDealLine {
  dealId: string;
  propertyShortId: number;
  closedAt: string | null;
  currency: string;
  /** Доля агента сделки, в валюте сделки (сотые). */
  realtorCents: number;
  paidAt: string | null;
}

export interface AgentMonthPayout {
  month: string;
  /** Доля агента: всего, выплачено, ждёт выплаты — по валютам. */
  earned: CentsByCurrency;
  paid: CentsByCurrency;
  due: CentsByCurrency;
  /** Доля за приём объекта: выплату в CRM не отмечают. */
  intakeNotTracked: CentsByCurrency;
  /** Строка «Зарплата из сделок» в Финансах (сомони, заморожена), если заведена. */
  salaryRowTjs: number | null;
  unpaidDeals: PayoutDealLine[];
}

export interface AgentPayouts {
  agentId: string;
  agentName: string;
  months: AgentMonthPayout[];
}

export type PayoutScope =
  /** Сделки, закрытые в месяце («кому сколько за октябрь»). */
  | { month: string }
  /** Всё, что ещё не выплачено, за все месяцы («сколько должны агентам»). */
  | { open: true };

const MAX_DEALS = 2000;
const UNPAID_LINES_PER_MONTH = 30;

export function monthKeyOfInstant(at: Date): string {
  return dushanbeWallClock(at).toISOString().slice(0, 7);
}

const addTo = (bag: CentsByCurrency, currency: string, cents: number) => {
  bag[currency] = (bag[currency] ?? 0) + cents;
};

/**
 * Отчёт выплат. `agentId` — только этот сотрудник (свои доли), иначе вся команда.
 * Права решает вызывающий: чужие доли — finance.view (как деньги в «Финансах»).
 */
export async function agentPayoutsReport(scope: PayoutScope, opts: { agentId?: string } = {}): Promise<{
  agents: AgentPayouts[];
  truncated: boolean;
}> {
  const mine = opts.agentId
    ? { OR: [{ agentId: opts.agentId }, { commissionIntakeAgentId: opts.agentId }] }
    : {};
  const where =
    "month" in scope
      ? (() => {
          const { from, to } = dushanbeMonthRange(scope.month);
          return { stage: "COMPLETED" as const, closedAt: { gte: from, lt: to }, ...mine };
        })()
      : {
          stage: "COMPLETED" as const,
          realtorPayoutAt: null,
          commissionRealtorAmount: { gt: 0 },
          ...(opts.agentId ? { agentId: opts.agentId } : {}),
        };
  const deals = await prisma.deal.findMany({
    where,
    select: {
      id: true,
      agentId: true,
      currency: true,
      closedAt: true,
      commissionRealtorAmount: true,
      commissionIntakeAgentId: true,
      commissionIntakeAmount: true,
      realtorPayoutAt: true,
      property: { select: { shortId: true } },
    },
    orderBy: { closedAt: "asc" },
    take: MAX_DEALS + 1,
  });
  const truncated = deals.length > MAX_DEALS;
  const rows = deals.slice(0, MAX_DEALS);

  const byAgent = new Map<string, Map<string, AgentMonthPayout>>();
  const monthOf = (agentId: string, month: string) => {
    let months = byAgent.get(agentId);
    if (!months) byAgent.set(agentId, (months = new Map()));
    let m = months.get(month);
    if (!m) months.set(month, (m = { month, earned: {}, paid: {}, due: {}, intakeNotTracked: {}, salaryRowTjs: null, unpaidDeals: [] }));
    return m;
  };

  for (const d of rows) {
    const month = d.closedAt ? monthKeyOfInstant(d.closedAt) : "—";
    for (const share of dealShareEntries(d)) {
      if (share.cents === 0) continue;
      if (opts.agentId && share.agentId !== opts.agentId) continue;
      // «Должны» за все месяцы — только доля агента: у доли приёмщика отметки выплаты нет.
      if (!("month" in scope) && share.kind === "intake") continue;
      const m = monthOf(share.agentId, month);
      if (share.kind === "intake") {
        addTo(m.intakeNotTracked, share.currency, share.cents);
        continue;
      }
      addTo(m.earned, share.currency, share.cents);
      if (d.realtorPayoutAt) addTo(m.paid, share.currency, share.cents);
      else {
        addTo(m.due, share.currency, share.cents);
        if (m.unpaidDeals.length < UNPAID_LINES_PER_MONTH) {
          m.unpaidDeals.push({
            dealId: d.id,
            propertyShortId: d.property.shortId,
            closedAt: d.closedAt ? dushanbeWallClock(d.closedAt).toISOString().slice(0, 10) : null,
            currency: d.currency,
            realtorCents: share.cents,
            paidAt: null,
          });
        }
      }
    }
  }

  const agentIds = [...byAgent.keys()];
  const keys = agentIds.flatMap((id) => [...byAgent.get(id)!.keys()].map((month) => dealSalaryAutoKey(id, month)));
  const [agents, salaryRows] = await Promise.all([
    prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, fullName: true } }),
    keys.length
      ? prisma.expense.findMany({ where: { autoKey: { in: keys }, deletedAt: null }, select: { autoKey: true, amount: true } })
      : Promise.resolve([]),
  ]);
  const salary = new Map(salaryRows.map((r) => [r.autoKey!, Number(r.amount)]));
  const names = new Map(agents.map((a) => [a.id, a.fullName]));

  return {
    truncated,
    agents: agentIds
      .map((agentId) => ({
        agentId,
        agentName: names.get(agentId) ?? "Сотрудник",
        months: [...byAgent.get(agentId)!.values()]
          .map((m) => ({ ...m, salaryRowTjs: salary.get(dealSalaryAutoKey(agentId, m.month)) ?? null }))
          .sort((a, b) => a.month.localeCompare(b.month)),
      }))
      .sort((a, b) => a.agentName.localeCompare(b.agentName, "ru")),
  };
}

const amounts = (bag: CentsByCurrency) => Object.fromEntries(Object.entries(bag).map(([c, cents]) => [c, fromCents(cents)]));

/** Тот же отчёт суммами (а не сотыми) — для ответа REST. */
export function payoutsReportAmounts(report: Awaited<ReturnType<typeof agentPayoutsReport>>) {
  return {
    truncated: report.truncated,
    agents: report.agents.map((a) => ({
      ...a,
      months: a.months.map((m) => ({
        month: m.month,
        earned: amounts(m.earned),
        paid: amounts(m.paid),
        due: amounts(m.due),
        intakeNotTracked: amounts(m.intakeNotTracked),
        salaryRowTjs: m.salaryRowTjs,
        unpaidDeals: m.unpaidDeals.map(({ realtorCents, ...d }) => ({ ...d, realtorShare: fromCents(realtorCents) })),
      })),
    })),
  };
}

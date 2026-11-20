import { buildExpenseSummary } from "./expenseQueries.js";
import { prisma } from "../db.js";
import { loadMoneyContext, roundMoney, toTjs, expenseCentsToTjs, fromCents } from "./money.js";
import { dushanbeStartOfMonth } from "./dushanbeTime.js";
import { sendPushToAgent } from "../push.js";
import { findAgentsWithPermission, partitionByPermission } from "./recipients.js";
import { COUNTED_SHOWING_WHERE } from "./tasks.js";
import { districtDemandForMonth } from "./propertyInterest.js";
import { computeAgentSilenceStats, findMostProvableCase, type AgentSilenceStat, type ProvableCase } from "./postShowingSilencePattern.js";
import { RATED_ROLES, type PostShowingCohortView } from "@royal-home/shared";
import { collectPostShowingCohort } from "./postShowingCohort.js";

/**
 * Месячный отчёт директору и админу (примечание владельца от 30.07: «сделать формулу
 * отчёта, чтобы каждый месяц они мне приходили и я имел возможность добавлять инфу»).
 *
 * Цифры СОХРАНЯЮТСЯ снапшотом 1-го числа: воронка, агенты, источники — каким месяц был.
 * ДЕНЬГИ (комиссия, расходы, прибыль) с 17.11.2026 показываются живыми — той же функцией,
 * что «Финансы» (liveMonthlyMoney ниже), а снимок денег отдаётся справкой «*AtClose»:
 * расходы, внесённые задним числом, иначе не попадали в отчёт вовсе (аудит денег 17.11).
 *
 * Заметки владельца живут отдельным полем поверх цифр и правятся когда угодно.
 */
export interface MonthlyMetrics {
  publicInteractionScopeVersion: 1;
  postShowingCohort?: PostShowingCohortView | { version: 2; evaluation: "DATA_UNAVAILABLE" };
  /** Воронка месяца: сколько лидов дошло до каждого шага. */
  funnel: { key: string; label: string; count: number }[];
  /** Деньги месяца в сомони. */
  commission: number;
  dealsCompleted: number;
  /** Расходы месяца в сомони — чтобы отчёт отвечал не только «сколько заработали». */
  expenses: number;
  /** По агентам: кто сколько привёл, показал и закрыл. */
  agents: { agentId: string; fullName: string; leads: number; showings: number; deals: number; commission: number }[];
  /** Откуда пришли клиенты. */
  sources: { source: string; count: number }[];
  /** Объекты: сколько завели и сколько продали за месяц. */
  propertiesAdded: number;
  propertiesSold: number;
  /**
   * СПРОС ПО РАЙОНАМ ЗА МЕСЯЦ (владелец 09.09.2026): «какими объектами чаще всего
   * интересуются, чтобы делать упор именно на такие объекты, на такие районы».
   *
   * Это ответ не про рекламу сегодня (для неё есть GET /reports/hot-properties с
   * коротким окном), а про то, какие объекты вообще брать в работу в следующем
   * месяце. Считается по событиям интереса, см. lib/propertyInterest.ts.
   */
  districtDemand: { districtName: string; score: number; events: number; properties: number }[];
  /**
   * ТИШИНА ПОСЛЕ ПОКАЗА ПО АГЕНТАМ (порог 4 воронки, просьба владельца 12.09.2026:
   * «обе цифры рядом» — своя доля и доля ОСТАЛЬНЫХ, без него самого).
   *
   * Отдельно от `agents` выше намеренно: там цифры про результат (привёл,
   * показал, закрыл), здесь — про то, чем кончились показы. Склеенные в одну
   * таблицу, они читаются как оценка работы, а это не оценка работы.
   *
   * `undefined` в старых отчётах — их пересчитывать задним числом нельзя
   * (снапшот), и это нормально: раздела просто не было.
   */
  postShowingSilence?: {
    agents: AgentSilenceStat[];
    /** Самый ДОКАЗУЕМЫЙ случай месяца, кликабельный на карточку клиента. */
    provableCase: ProvableCase | null;
  };
}

/** Границы отчётного месяца по Душанбе: [начало, начало следующего). */
export function monthRange(periodStart: Date): { from: Date; to: Date } {
  const from = periodStart;
  const wall = new Date(from.getTime() + 5 * 60 * 60 * 1000);
  const nextMonth = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 1) - 5 * 60 * 60 * 1000);
  return { from, to: nextMonth };
}

/**
 * Календарный месяц отчёта, приведённый к тому же виду, в каком он записан у
 * расходов: UTC-полночь первого числа.
 *
 * Отчёт живёт по Душанбе (periodStart — 19:00 предыдущего дня), расходы — по UTC.
 * Пока эти две формы сравнивали напрямую, они не совпадали ни разу.
 */
function expenseMonthKey(periodStart: Date): Date {
  const wall = new Date(periodStart.getTime() + 5 * 60 * 60 * 1000);
  return new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), 1));
}

/**
 * ДЕНЬГИ ОТЧЁТА — ЖИВЫЕ (аудит денег 17.11.2026, D1).
 *
 * Отчёт собирается 1-го числа и хранит снимок. Раньше этот снимок денег и показывался как итог
 * месяца: расходы, внесённые задним числом (11 строк октября заведены 11.11), правки и смена курса
 * в отчёт не попадали — октябрь в отчёте 8 786,32 с., в «Финансах», PDF и у Шабнам 16 608,32 с.
 * Теперь комиссия, расходы и прибыль считаются при каждом открытии той же функцией, что «Финансы»
 * (buildExpenseSummary), а снимок отдаётся справкой `*AtClose` — «было при закрытии месяца».
 */
export interface LiveMonthlyMoney { commission: number; expenses: number; profit: number }
const VALID_MONTH = /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/;

/** Живые деньги нескольких месяцев ОДНОЙ сводкой (список отчётов — 12 месяцев, не 12 сводок). */
export async function liveMonthlyMoneyMap(months: string[]): Promise<Map<string, LiveMonthlyMoney>> {
  // Месяц вне диапазона «Финансов» (1900–2199) живых денег не имеет — отчёт показывает снимок.
  const valid = [...new Set(months.filter((m) => VALID_MONTH.test(m)))].sort();
  const out = new Map<string, LiveMonthlyMoney>();
  if (!valid.length) return out;
  const first = valid[0]!, last = valid[valid.length - 1]!;
  const span = (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(last.slice(5)) - Number(first.slice(5)) + 1;
  const summary = await buildExpenseSummary({ months: Math.min(span, 60), through: last });
  for (const m of summary.months) {
    if (valid.includes(m.month)) out.set(m.month, { commission: m.revenue, expenses: m.totalExpenses, profit: m.profit });
  }
  return out;
}

export async function liveMonthlyMoney(month: string): Promise<LiveMonthlyMoney | null> {
  return (await liveMonthlyMoneyMap([month])).get(month) ?? null;
}

export function withLiveMoney(metrics: Record<string, unknown>, live: LiveMonthlyMoney | null): Record<string, unknown> {
  if (!live) return metrics;
  const atClose = (key: string) => (typeof metrics[`${key}AtClose`] === "number" ? metrics[`${key}AtClose`] : typeof metrics[key] === "number" ? metrics[key] : null);
  return {
    ...metrics,
    commissionAtClose: atClose("commission"),
    expensesAtClose: atClose("expenses"),
    commission: live.commission,
    expenses: live.expenses,
    profit: live.profit,
  };
}

/** Метка месяца «2026-07» — по настенному календарю Душанбе, а не по periodStart:
 *  срез ISO-строки от 19:00 30 июня давал «2026-06», то есть чужой месяц. */
export function monthKeyLabel(periodStart: Date): string {
  const wall = new Date(periodStart.getTime() + 5 * 60 * 60 * 1000);
  return `${wall.getUTCFullYear()}-${String(wall.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function buildMonthlyMetrics(periodStart: Date): Promise<MonthlyMetrics> {
  const { from, to } = monthRange(periodStart);
  const period = { gte: from, lt: to };

  // Отдельным запросом, а не в Promise.all ниже: срез спроса — дополнение к отчёту,
  // и его отказ не имеет права оставить руководство вообще без цифр месяца.
  const districtDemand = await districtDemandForMonth(periodStart).catch((err) => {
    console.error("[отчёт] спрос по районам:", err instanceof Error ? err.message : err);
    return [];
  });

  const [newLeads, contacted, showings, negotiations, completedDeals, expenses, agents, sources, propsAdded, money] =
    await Promise.all([
      prisma.client.count({ where: { createdAt: period, deletedAt: null } }),
      prisma.interaction.findMany({
        where: { investigationOnly: false, archiveReview: false, type: { in: ["CALL", "MESSAGE", "MEETING"] }, createdAt: period, client: { deletedAt: null } },
        distinct: ["clientId"],
        select: { clientId: true },
      }),
      prisma.interaction.findMany({
        // Отменённый показ в снапшот месяца не идёт: цифры фиксируются навсегда, и
        // встреча, которой не было, осталась бы в отчёте до конца времён.
        where: { investigationOnly: false, type: "SHOWING", ...COUNTED_SHOWING_WHERE, createdAt: period, client: { deletedAt: null } },
        // subjectAgentId (П-10, 17.09.2026): показ ботом/системой от лица клиента
        // (agentId: null) по-прежнему на счету держателя карточки — см. ниже,
        // где agentId и subjectAgentId сведены в holderAgentId.
        select: { clientId: true, agentId: true, subjectAgentId: true },
      }),
      prisma.deal.count({ where: { startedAt: period, client: { deletedAt: null } } }),
      prisma.deal.findMany({
        where: { stage: "COMPLETED", closedAt: period },
        select: { agentId: true, commissionAmount: true, currency: true },
      }),
      // Расход привязан к МЕСЯЦУ (Expense.month — первое число), а не к дате траты:
      // зарплата за март, проведённая в апреле, относится к марту.
      //
      // КЛЮЧ МЕСЯЦА У РАСХОДОВ — UTC-полночь первого числа (routes/expenses.ts), а
      // periodStart отчёта — начало месяца ПО ДУШАНБЕ, то есть 19:00 предыдущего дня.
      // Разница ровно пять часов, и точное равенство не выполнялось НИКОГДА: в
      // отчёте каждый месяц стояло «Расходы 0 с.», а владелец считал по этой цифре
      // прибыль. Сборка молчала — расходы не проверял ни один тест.
      prisma.expense.findMany({where:{month:expenseMonthKey(periodStart),deletedAt:null,status:"PAID"},select:{amount:true,currency:true,exchangeRate:true},take:20001}),
      prisma.agent.findMany({ where: { role: { in: [...RATED_ROLES] }, isActive: true }, select: { id: true, fullName: true } }),
      prisma.client.groupBy({ by: ["source"], where: { createdAt: period, deletedAt: null }, _count: { _all: true } }),
      prisma.property.count({ where: { createdAt: period, deletedAt: null } }),
      loadMoneyContext(),
    ]);

  const leadsByAgent = await prisma.client.groupBy({
    by: ["assignedAgentId"],
    where: { createdAt: period, deletedAt: null, assignedAgentId: { not: null } },
    _count: { _all: true },
  });

  // roundMoney на итогах: каждое слагаемое уже ровно до копейки (toTjs), но
  // сложение полусотни чисел с плавающей точкой оставляет хвост в последних
  // знаках — в отчёт, который читает директор, он попадать не должен.
  const commission = roundMoney(completedDeals.reduce((s, d) => s + toTjs(d.commissionAmount, d.currency, money), 0));
  if(expenses.length>20000)throw new Error("Месячный отчёт: более 20 000 расходов, итог не усечён");
  const expensesTjs = fromCents(expenses.reduce((s,e)=>s+expenseCentsToTjs(e,money),0));

  // Показы считаем по КЛИЕНТАМ, а не по записям: три показа одному человеку — это
  // один дошедший до шага, иначе воронка «расширяется» и перестаёт что-либо значить.
  const showingClients = new Set(showings.map((s) => s.clientId));
  // Держатель показа для разбивки по агентам ниже: subjectAgentId ?? agentId
  // (П-10, 17.09.2026) — раньше agentId всегда был держателем, после Б1/Б2 у
  // записей бота/системы он null, а держатель лежит в subjectAgentId.
  const showingHolderId = (s: { agentId: string | null; subjectAgentId: string | null }) => s.agentId ?? s.subjectAgentId;

  // Порог 4 воронки: доля тишины по агентам против ОСТАЛЬНЫХ и самый доказуемый
  // случай месяца (см. lib/postShowingSilencePattern.ts). Отказ этой части не
  // должен ронять весь отчёт — деньги и воронка важнее.
  const postShowingSilence = await Promise.all([computeAgentSilenceStats(from, to), findMostProvableCase(from, to)])
    .then(([agentsSilence, provableCase]) => ({ agents: agentsSilence, provableCase }))
    .catch((err) => {
      console.error("[monthly-report] тишина после показа не посчиталась:", err instanceof Error ? err.message : err);
      return { agents: [] as AgentSilenceStat[], provableCase: null };
    });
  const postShowingCohort = await collectPostShowingCohort(from, to).catch((error) => {
    console.error("[monthly-report] cohort data unavailable:", error instanceof Error ? error.message : error);
    return { version: 2 as const, evaluation: "DATA_UNAVAILABLE" as const };
  });

  return {
    publicInteractionScopeVersion: 1,
    funnel: [
      { key: "leads", label: "Новые заявки", count: newLeads },
      { key: "contacted", label: "На контакте", count: contacted.length },
      { key: "showings", label: "Показы", count: showingClients.size },
      { key: "negotiations", label: "Переговоры", count: negotiations },
      { key: "deals", label: "Сделки", count: completedDeals.length },
    ],
    commission,
    postShowingSilence,
    postShowingCohort,
    dealsCompleted: completedDeals.length,
    expenses: expensesTjs,
    agents: agents
      .map((a) => ({
        agentId: a.id,
        fullName: a.fullName,
        leads: leadsByAgent.find((l) => l.assignedAgentId === a.id)?._count._all ?? 0,
        showings: showings.filter((s) => showingHolderId(s) === a.id).length,
        deals: completedDeals.filter((d) => d.agentId === a.id).length,
        commission: roundMoney(
          completedDeals.filter((d) => d.agentId === a.id).reduce((s, d) => s + toTjs(d.commissionAmount, d.currency, money), 0)
        ),
      }))
      // Пустые строки в отчёт не идут: агент без единого действия за месяц — это
      // разговор с руководителем, а не строка таблицы с нулями.
      .filter((a) => a.leads || a.showings || a.deals)
      .sort((a, b) => b.commission - a.commission || b.deals - a.deals),
    sources: sources.map((s) => ({ source: s.source, count: s._count._all })).sort((a, b) => b.count - a.count),
    propertiesAdded: propsAdded,
    propertiesSold: completedDeals.length,
    districtDemand,
  };
}

/**
 * Первого числа собирает отчёт за прошедший месяц и уведомляет руководство.
 * Идемпотентно: повторный запуск в тот же месяц ничего не дублирует и не перетирает
 * уже написанные заметки — иначе перезапуск контейнера стирал бы работу владельца.
 */
export async function generateMonthlyReport(now: Date = new Date()): Promise<{ created: boolean; periodStart: Date }> {
  const thisMonthStart = dushanbeStartOfMonth(now);
  const wall = new Date(thisMonthStart.getTime() + 5 * 60 * 60 * 1000);
  const periodStart = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - 1, 1) - 5 * 60 * 60 * 1000);

  const existing = await prisma.monthlyReport.findUnique({ where: { periodStart } });
  if (existing) return { created: false, periodStart };

  const metrics = await buildMonthlyMetrics(periodStart);
  await prisma.monthlyReport.create({ data: { periodStart, metrics: metrics as never } });

  const monthLabel = new Date(periodStart.getTime() + 5 * 60 * 60 * 1000).toLocaleDateString("ru-RU", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  // Отчёт — управленческий документ: уходит тем, кто видит аналитику (директор, админ).
  const recipients = await findAgentsWithPermission("dashboard.analytics");
  // Общая комиссия компании в тексте — только тем, у кого открыт finance.view: в самом
  // отчёте она закрыта тем же правом (GET /reports/monthly), а пуш отдавал её всем
  // аналитикам (аудит Codex 04.10.2026, ACCESS-04).
  const { granted: seesMoney } = await partitionByPermission(recipients, "finance.view");
  for (const agentId of recipients) {
    const commissionPart = seesMoney.includes(agentId)
      ? `, комиссия: ${Math.round(metrics.commission).toLocaleString("ru-RU")} с`
      : "";
    await sendPushToAgent(agentId, {
      title: `🗂️ Отчёт за ${monthLabel}`,
      body: `Сделок: ${metrics.dealsCompleted}${commissionPart}. Откройте, чтобы дополнить.`,
      url: "/reports",
      tag: `monthly-report-${monthKeyLabel(periodStart)}`,
    }).catch(() => {});
  }

  return { created: true, periodStart };
}

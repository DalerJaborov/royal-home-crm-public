import { z } from "zod";
import {
  CLIENT_SOURCE_LABELS,
  CLIENT_STATUS_LABELS,
  DEAL_STAGE_LABELS,
  RATED_ROLES,
  REFUSAL_REASON_LABELS,
  reportDateRangeError,
  type ClientSource,
  type DirectorAgentRow,
  type DirectorDashboardQuery,
  type DirectorDashboardResponse,
  type DirectorDrillItem,
  type DirectorDrillKey,
  type DirectorDrillResponse,
  type DirectorKpi,
  type DirectorKpiKey,
  type DirectorPeriodPreset,
  type RefusalReason,
} from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { DUSHANBE_OFFSET_MS, dushanbeDayRange, dushanbeEndOfDay, dushanbeInputToDate, dushanbeWallClock } from "./dushanbeTime.js";
import { currentDushanbeMonth, dushanbeMonthBounds } from "./financeForecast.js";
import { visibleInteractionWhere } from "./investigationPrivacy.js";
import { loadMoneyContext, roundMoney, toTjs, type MoneyContext } from "./money.js";
import { COUNTED_SHOWING_WHERE, countOverdueTasksByAgent, overdueTasksOfAgentsWhere, overdueTasksWhere } from "./tasks.js";
import { buildFunnelCohort, funnelCohortStepWhere } from "./teamReports.js";
import { logSystemError } from "./systemError.js";
import { phoneSafeText } from "./clientPhone.js";
import { isDefaultCommissionPlan } from "./dashboardInsights.js";
import { createLimiter } from "./queryGate.js";

/**
 * ДАШБОРД ДИРЕКТОРА (ТЗ владельца, 21.11.2026). Один расчёт на сводку, список под
 * плиткой и выгрузку в Excel: условие каждой цифры живёт в `drillWhere` ниже, и
 * плитка считается `count` по ТОМУ ЖЕ условию, по которому список отдаёт записи, —
 * поэтому «сумма записей = цифра плитки» (критерий приёмки ТЗ №1) держится
 * построением, а не совпадением.
 *
 * Определения (ТЗ, лист «Показатели и формулы»):
 *  - Новые заявки — карточки, созданные за период (дубли сливаются в исходную
 *    карточку, поэтому повторное обращение новой заявкой не считается).
 *  - Обработанные — из новых заявок периода те, с кем сотрудник связался (на
 *    сегодня), это тот же шаг «Связались», что в воронке. Само назначение — не
 *    обработка. Необработанные = новые − обработанные.
 *  - Показы, встречи — записи периода, отменённые не считаются.
 *  - Переговоры — сделки, начатые за период; Сделки — закрытые за период
 *    (отменённые не считаются); Выручка — комиссия агентства по ним в сомони,
 *    не цена объекта.
 *  - Просроченные задачи — на сейчас, не за период.
 */

export interface DirectorViewer {
  /** Роль для служебных записей проверки; undefined — только публичные. */
  investigationRole: string | undefined;
  /** finance.view: без него деньги — null. */
  seesMoney: boolean;
  /** clients.viewPhone: без него цифры номера в именах скрыты. */
  seesPhone: boolean;
  /** clients.viewOrigin: без него ник и источник клиента в списке скрыты. */
  seesOrigin: boolean;
  /** archive.view: без него клиенты из Корзины в списке под плиткой не показываются. */
  seesArchive?: boolean;
}

export interface DirectorRange {
  from: Date;
  to: Date;
}

export interface DirectorPeriod extends DirectorRange {
  preset: DirectorPeriodPreset;
  prev: DirectorRange;
}

export interface DirectorFilters {
  agentId?: string;
  source?: ClientSource;
  kind?: "BUYER" | "SELLER";
}

/** Тот же потолок ширины периода, что у отчётов (lib/teamReports.ts). */
const MAX_RANGE_MS = 60 * 31 * 24 * 60 * 60 * 1000;
/** Потолок строк для выборок, которые считаются в памяти (скорость, сделки по источникам). */
export const DIRECTOR_ROW_LIMIT = 20_000;
const CACHE_TTL_MS = 60_000;
/** Давняя активность сотрудника в «Был активен» не ищем: только последние 90 дней, старше — «давно». */
export const LAST_ACTIVITY_DAYS = 90;
/** Сколько запросов сводки к базе идут одновременно (остальные в очереди). */
const DB_PARALLEL = 5;
const dbGate = createLimiter(DB_PARALLEL);
const CACHE_MAX_ENTRIES = 200;

/** Полночь даты (по Душанбе), заданной числами настенного календаря. */
function dushanbeMidnight(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d) - DUSHANBE_OFFSET_MS);
}

/**
 * Период по пресету — границы суток по Душанбе (UTC+5), конец — конец сегодняшних
 * суток. Неделя — с понедельника. Предыдущий период — той же длины сразу перед.
 */
export function resolveDirectorPeriod(
  q: Pick<DirectorDashboardQuery, "preset" | "from" | "to">,
  now: Date = new Date()
): DirectorPeriod {
  const wall = dushanbeWallClock(now);
  const y = wall.getUTCFullYear();
  const m = wall.getUTCMonth();
  const d = wall.getUTCDate();
  let to = dushanbeEndOfDay(now);
  let from: Date;
  switch (q.preset) {
    case "day":
      from = dushanbeMidnight(y, m, d);
      break;
    case "week":
      from = dushanbeMidnight(y, m, d - ((wall.getUTCDay() + 6) % 7));
      break;
    case "quarter":
      from = dushanbeMidnight(y, m - (m % 3), 1);
      break;
    case "year":
      from = dushanbeMidnight(y, 0, 1);
      break;
    case "custom": {
      from = q.from ? dushanbeDayRange(dushanbeInputToDate(q.from)).start : dushanbeMidnight(y, m, 1);
      if (q.to) to = dushanbeEndOfDay(dushanbeInputToDate(q.to));
      const rangeError = reportDateRangeError(from, to);
      if (rangeError) throw new z.ZodError([{ code: "custom", path: ["from"], message: rangeError }]);
      if (to.getTime() - from.getTime() > MAX_RANGE_MS) from = new Date(to.getTime() - MAX_RANGE_MS);
      break;
    }
    case "month":
    default:
      from = dushanbeMidnight(y, m, 1);
  }
  const length = to.getTime() - from.getTime() + 1;
  const prevTo = new Date(from.getTime() - 1);
  return { preset: q.preset, from, to, prev: { from: new Date(from.getTime() - length), to: prevTo } };
}

// ── условия ─────────────────────────────────────────────────────────────────

/** Фильтр по карточке без признака удаления: сделки и отказы считаются и у карточек в Корзине. */
function clientFilter(f: DirectorFilters): Prisma.ClientWhereInput {
  return { ...(f.source ? { source: f.source } : {}), ...(f.kind ? { kind: f.kind } : {}) };
}

/** Новые заявки периода с фильтрами — когорта воронки. */
function cohortWhere(r: DirectorRange, f: DirectorFilters): Prisma.ClientWhereInput {
  return { ...cohortScope(f), createdAt: { gte: r.from, lte: r.to }, deletedAt: null };
}

/** Фильтры когорты без периода — то, что передаётся в buildFunnelCohort как scope. */
function cohortScope(f: DirectorFilters): Prisma.ClientWhereInput {
  return { ...clientFilter(f), ...(f.agentId ? { assignedAgentId: f.agentId } : {}) };
}

/** Чьё действие: исполнитель, а для записи бота/системы — держатель карточки (П-10). */
function interactionOfAgent(agentId: string): Prisma.InteractionWhereInput {
  return { OR: [{ agentId }, { agentId: null, subjectAgentId: agentId }] };
}

function eventWhere(type: "SHOWING" | "MEETING", r: DirectorRange, f: DirectorFilters, viewer: Pick<DirectorViewer, "investigationRole">): Prisma.InteractionWhereInput {
  return {
    AND: [
      visibleInteractionWhere(viewer.investigationRole),
      f.agentId ? interactionOfAgent(f.agentId) : {},
      { type, ...COUNTED_SHOWING_WHERE, createdAt: { gte: r.from, lte: r.to }, client: { ...clientFilter(f), deletedAt: null } },
    ],
  };
}

function dealsWhere(kind: "started" | "closed", r: DirectorRange, f: DirectorFilters): Prisma.DealWhereInput {
  const scope: Prisma.DealWhereInput = {
    ...(f.agentId ? { agentId: f.agentId } : {}),
    ...(f.source || f.kind ? { client: clientFilter(f) } : {}),
  };
  // Начатые переговоры — без карточек из Корзины, как шаг воронки (lib/teamReports.ts): удалённый клиент
  // не должен раздувать цифру. Закрытые сделки и выручка считаются и у них: деньги уже получены.
  return kind === "started"
    ? { ...scope, client: { ...clientFilter(f), deletedAt: null }, startedAt: { gte: r.from, lte: r.to } }
    : { ...scope, stage: "COMPLETED", closedAt: { gte: r.from, lte: r.to } };
}

/** Оформленный отказ за период (одна дверь — lib/clientRefuse.ts). Агент — кто отказал. */
function lostWhere(r: DirectorRange, f: DirectorFilters): Prisma.ClientWhereInput {
  return {
    ...clientFilter(f),
    ...(f.agentId ? { assignmentRefusedByAgentId: f.agentId } : {}),
    assignmentRefusedAt: { gte: r.from, lte: r.to },
  };
}

function overdueWhere(now: Date, f: DirectorFilters, viewer: Pick<DirectorViewer, "investigationRole">): Prisma.InteractionWhereInput {
  const scope: Prisma.InteractionWhereInput = {
    AND: [visibleInteractionWhere(viewer.investigationRole), f.source || f.kind ? { client: clientFilter(f) } : {}],
  };
  return f.agentId ? overdueTasksOfAgentsWhere(now, [f.agentId], scope) : { AND: [overdueTasksWhere(now), scope] };
}

type DrillSpec =
  | { model: "client"; where: Prisma.ClientWhereInput; dateField: "createdAt" | "assignmentRefusedAt"; agentField: "assignedAgentId" | "assignmentRefusedByAgentId" }
  | { model: "interaction"; where: Prisma.InteractionWhereInput; dateField: "createdAt" | "nextActionDate" }
  | { model: "deal"; where: Prisma.DealWhereInput; dateField: "startedAt" | "closedAt" };

/** ЕДИНСТВЕННОЕ место, где задано, из каких записей сложилась цифра. */
export function drillWhere(key: DirectorDrillKey, r: DirectorRange, f: DirectorFilters, viewer: Pick<DirectorViewer, "investigationRole">, now: Date): DrillSpec {
  const cohort = cohortWhere(r, f);
  switch (key) {
    case "newLeads":
      return { model: "client", where: cohort, dateField: "createdAt", agentField: "assignedAgentId" };
    case "contacted":
      return { model: "client", where: { AND: [cohort, funnelCohortStepWhere("contacted", viewer)] }, dateField: "createdAt", agentField: "assignedAgentId" };
    case "noContact":
      return { model: "client", where: { AND: [cohort, { NOT: funnelCohortStepWhere("contacted", viewer) }] }, dateField: "createdAt", agentField: "assignedAgentId" };
    case "showings":
      return { model: "interaction", where: eventWhere("SHOWING", r, f, viewer), dateField: "createdAt" };
    case "meetings":
      return { model: "interaction", where: eventWhere("MEETING", r, f, viewer), dateField: "createdAt" };
    case "negotiations":
      return { model: "deal", where: dealsWhere("started", r, f), dateField: "startedAt" };
    case "deals":
      return { model: "deal", where: dealsWhere("closed", r, f), dateField: "closedAt" };
    case "lost":
      return { model: "client", where: lostWhere(r, f), dateField: "assignmentRefusedAt", agentField: "assignmentRefusedByAgentId" };
    case "overdueTasks":
      return { model: "interaction", where: overdueWhere(now, f, viewer), dateField: "nextActionDate" };
  }
}

function countSpec(spec: DrillSpec): Promise<number> {
  if (spec.model === "client") return dbGate(() => prisma.client.count({ where: spec.where }));
  if (spec.model === "interaction") return dbGate(() => prisma.interaction.count({ where: spec.where }));
  return dbGate(() => prisma.deal.count({ where: spec.where }));
}

async function revenue(r: DirectorRange, f: DirectorFilters, money: MoneyContext): Promise<number> {
  const rows = await dbGate(() =>
    prisma.deal.groupBy({
      by: ["currency"],
      where: dealsWhere("closed", r, f),
      _sum: { commissionAmount: true },
    })
  );
  return roundMoney(rows.reduce((sum, row) => sum + toTjs(row._sum.commissionAmount, row.currency, money), 0));
}

const KPI_META: Record<DirectorKpiKey, { label: string; unit: DirectorKpi["unit"]; goodWhen: DirectorKpi["goodWhen"]; drillKey: DirectorDrillKey }> = {
  newLeads: { label: "Новые заявки", unit: "count", goodWhen: "up", drillKey: "newLeads" },
  contacted: { label: "Обработанные", unit: "count", goodWhen: "up", drillKey: "contacted" },
  noContact: { label: "Без контакта", unit: "count", goodWhen: "down", drillKey: "noContact" },
  showings: { label: "Показы", unit: "count", goodWhen: "up", drillKey: "showings" },
  meetings: { label: "Встречи", unit: "count", goodWhen: "up", drillKey: "meetings" },
  negotiations: { label: "Начато переговоров за период", unit: "count", goodWhen: "up", drillKey: "negotiations" },
  deals: { label: "Сделки", unit: "count", goodWhen: "up", drillKey: "deals" },
  revenue: { label: "Выручка (комиссия)", unit: "tjs", goodWhen: "up", drillKey: "deals" },
};
/** «Без контакта» отдельным запросом не считается: новые − обработанные (обработанные — часть новых). */
const COUNT_KPIS = ["newLeads", "contacted", "showings", "meetings", "negotiations", "deals"] as const;

function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

// ── сводка ──────────────────────────────────────────────────────────────────

async function kpisFor(r: DirectorRange, f: DirectorFilters, viewer: DirectorViewer, now: Date, money: MoneyContext) {
  const [counts, rev] = await Promise.all([
    Promise.all(COUNT_KPIS.map((key) => countSpec(drillWhere(key, r, f, viewer, now)))),
    viewer.seesMoney ? revenue(r, f, money) : Promise.resolve(null),
  ]);
  const out = Object.fromEntries(COUNT_KPIS.map((key, i) => [key, counts[i]])) as Record<DirectorKpiKey, number | null>;
  out.noContact = Math.max(0, (out.newLeads ?? 0) - (out.contacted ?? 0));
  out.revenue = rev;
  return out;
}

async function speedFor(r: DirectorRange, f: DirectorFilters) {
  // Личные заявки агент заводит сам — ответа «клиенту, который ждал» там нет
  // (то же правило, что lib/responseSpeed.ts).
  const rows = await dbGate(() =>
    prisma.client.findMany({
      where: { ...cohortWhere(r, f), isPersonalLead: false, firstContactAt: { not: null } },
      select: { createdAt: true, firstContactAt: true },
      orderBy: { createdAt: "desc" },
      take: DIRECTOR_ROW_LIMIT,
    })
  );
  if (rows.length >= DIRECTOR_ROW_LIMIT) {
    void logSystemError("api", `Дашборд директора: заявок с первым контактом больше ${DIRECTOR_ROW_LIMIT} — скорость посчитана по последним`);
  }
  const minutes = rows
    .map((row) => (row.firstContactAt!.getTime() - row.createdAt.getTime()) / 60_000)
    .filter((m) => m >= 0)
    .sort((a, b) => a - b);
  if (!minutes.length) return { medianMin: null, avgMin: null, answered: 0 };
  const mid = Math.floor(minutes.length / 2);
  const median = minutes.length % 2 ? minutes[mid] : (minutes[mid - 1] + minutes[mid]) / 2;
  const avg = minutes.reduce((s, m) => s + m, 0) / minutes.length;
  return { medianMin: Math.round(median * 10) / 10, avgMin: Math.round(avg * 10) / 10, answered: minutes.length };
}

async function agentsFor(r: DirectorRange, f: DirectorFilters, viewer: DirectorViewer, now: Date, money: MoneyContext): Promise<DirectorAgentRow[]> {
  const visible = visibleInteractionWhere(viewer.investigationRole);
  const cohort = cohortWhere(r, f);
  const interactionScope: Prisma.InteractionWhereInput = {
    AND: [
      visible,
      { createdAt: { gte: r.from, lte: r.to }, archiveReview: false, client: { ...clientFilter(f), deletedAt: null } },
      { OR: [{ type: { in: ["CALL", "MESSAGE"] } }, { type: { in: ["MEETING", "SHOWING"] }, ...COUNTED_SHOWING_WHERE }] },
    ],
  };
  const agentScope = f.agentId ? { in: [f.agentId] } : { not: null };
  // Все группировки — базой, по строке на агента (и тип/валюту), без await в цикле.
  const [leads, contacted, converted, byType, bySubject, deals] = await Promise.all([
    dbGate(() => prisma.client.groupBy({ by: ["assignedAgentId"], where: { ...cohort, assignedAgentId: agentScope }, _count: { _all: true } })),
    dbGate(() =>
      prisma.client.groupBy({
        by: ["assignedAgentId"],
        where: { AND: [cohort, { assignedAgentId: agentScope }, funnelCohortStepWhere("contacted", viewer)] },
        _count: { _all: true },
      })
    ),
    dbGate(() =>
      prisma.client.groupBy({
        by: ["assignedAgentId"],
        where: { AND: [cohort, { assignedAgentId: agentScope }, funnelCohortStepWhere("deals", viewer)] },
        _count: { _all: true },
      })
    ),
    dbGate(() => prisma.interaction.groupBy({ by: ["agentId", "type"], where: { AND: [interactionScope, { agentId: agentScope }] }, _count: { _all: true } })),
    // Показ/встреча, записанные ботом от лица держателя карточки (agentId: null, П-10).
    dbGate(() =>
      prisma.interaction.groupBy({
        by: ["subjectAgentId", "type"],
        where: { AND: [interactionScope, { agentId: null, subjectAgentId: agentScope, type: { in: ["MEETING", "SHOWING"] } }] },
        _count: { _all: true },
      })
    ),
    dbGate(() => prisma.deal.groupBy({ by: ["agentId", "currency"], where: dealsWhere("closed", r, f), _count: { _all: true }, _sum: { commissionAmount: true } })),
  ]);

  const activeIds = f.agentId
    ? []
    : (await prisma.agent.findMany({ where: { isActive: true, role: { in: [...RATED_ROLES] } }, select: { id: true }, take: 500 })).map((a) => a.id);
  const ids = new Set<string>([...activeIds, ...(f.agentId ? [f.agentId] : [])]);
  for (const row of [...leads, ...contacted, ...converted]) if (row.assignedAgentId) ids.add(row.assignedAgentId);
  for (const row of byType) if (row.agentId) ids.add(row.agentId);
  for (const row of bySubject) if (row.subjectAgentId) ids.add(row.subjectAgentId);
  for (const row of deals) ids.add(row.agentId);
  const agentIds = [...ids];

  const [agents, lastActivity, overdue] = await Promise.all([
    prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, fullName: true, isActive: true }, take: 500 }),
    // Только последние 90 дней: давнее на экране — «давно» (ревью #362: без границы группировка шла по всей истории).
    dbGate(() =>
      prisma.interaction.groupBy({
        by: ["agentId"],
        where: { AND: [visible, { agentId: { in: agentIds }, actorKind: "AGENT", createdAt: { gte: new Date(now.getTime() - LAST_ACTIVITY_DAYS * 86_400_000) } }] },
        _max: { createdAt: true },
      })
    ),
    countOverdueTasksByAgent(now, agentIds, { AND: [visible, f.source || f.kind ? { client: clientFilter(f) } : {}] }),
  ]);

  const countOf = (rows: { assignedAgentId: string | null; _count: { _all: number } }[]) =>
    new Map(rows.map((row) => [row.assignedAgentId, row._count._all]));
  const leadsBy = countOf(leads);
  const contactedBy = countOf(contacted);
  const convertedBy = countOf(converted);
  const typeBy = new Map<string, number>();
  for (const row of byType) if (row.agentId) typeBy.set(`${row.agentId}:${row.type}`, row._count._all);
  for (const row of bySubject) {
    if (!row.subjectAgentId) continue;
    const k = `${row.subjectAgentId}:${row.type}`;
    typeBy.set(k, (typeBy.get(k) ?? 0) + row._count._all);
  }
  const dealBy = new Map<string, { count: number; commission: number }>();
  for (const row of deals) {
    const e = dealBy.get(row.agentId) ?? { count: 0, commission: 0 };
    e.count += row._count._all;
    e.commission += toTjs(row._sum.commissionAmount, row.currency, money);
    dealBy.set(row.agentId, e);
  }
  const lastBy = new Map(lastActivity.map((row) => [row.agentId, row._max.createdAt]));

  return agents
    .map((a): DirectorAgentRow => {
      const leadsN = leadsBy.get(a.id) ?? 0;
      const deal = dealBy.get(a.id);
      return {
        id: a.id,
        name: a.isActive ? a.fullName : `${a.fullName} (не работает)`,
        isActive: a.isActive,
        leads: leadsN,
        contacted: contactedBy.get(a.id) ?? 0,
        calls: typeBy.get(`${a.id}:CALL`) ?? 0,
        messages: typeBy.get(`${a.id}:MESSAGE`) ?? 0,
        meetings: typeBy.get(`${a.id}:MEETING`) ?? 0,
        showings: typeBy.get(`${a.id}:SHOWING`) ?? 0,
        deals: deal?.count ?? 0,
        commission: viewer.seesMoney ? roundMoney(deal?.commission ?? 0) : null,
        // Конверсия когорты (ТЗ: «не смешивать лиды разных периодов»): из ЕГО заявок
        // периода — сколько дошли до закрытой сделки.
        conversion: pct(convertedBy.get(a.id) ?? 0, leadsN),
        overdueTasks: overdue.get(a.id) ?? 0,
        lastActivityAt: lastBy.get(a.id)?.toISOString() ?? null,
      };
    })
    .sort((x, y) => y.deals - x.deals || (y.commission ?? 0) - (x.commission ?? 0) || y.leads - x.leads || x.name.localeCompare(y.name));
}

async function sourcesFor(r: DirectorRange, f: DirectorFilters, viewer: DirectorViewer, money: MoneyContext) {
  const [leadRows, dealRows] = await Promise.all([
    dbGate(() => prisma.client.groupBy({ by: ["source"], where: cohortWhere(r, f), _count: { _all: true } })),
    dbGate(() =>
      prisma.deal.findMany({
        where: dealsWhere("closed", r, f),
        select: { currency: true, commissionAmount: true, client: { select: { source: true } } },
        orderBy: { id: "asc" },
        take: DIRECTOR_ROW_LIMIT,
      })
    ),
  ]);
  const by = new Map<string, { leads: number; deals: number; commission: number }>();
  const slot = (s: string) => by.get(s) ?? by.set(s, { leads: 0, deals: 0, commission: 0 }).get(s)!;
  for (const row of leadRows) slot(row.source).leads += row._count._all;
  for (const row of dealRows) {
    const e = slot(row.client.source);
    e.deals += 1;
    e.commission += toTjs(row.commissionAmount, row.currency, money);
  }
  return [...by.entries()]
    .map(([source, e]) => ({
      source,
      label: CLIENT_SOURCE_LABELS[source as ClientSource] ?? source,
      leads: e.leads,
      deals: e.deals,
      commission: viewer.seesMoney ? roundMoney(e.commission) : null,
    }))
    .sort((a, b) => b.leads - a.leads || b.deals - a.deals || a.source.localeCompare(b.source));
}

async function lossReasonsFor(r: DirectorRange, f: DirectorFilters) {
  const rows = await dbGate(() => prisma.client.groupBy({ by: ["refusalReason"], where: lostWhere(r, f), _count: { _all: true } }));
  return rows
    .map((row) => ({
      reason: row.refusalReason ?? "NONE",
      label: row.refusalReason ? (REFUSAL_REASON_LABELS[row.refusalReason as RefusalReason] ?? row.refusalReason) : "Причина не указана",
      count: row._count._all,
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/**
 * План — месячный и общий на компанию (Settings.monthlyCommissionPlan: личных
 * планов в CRM нет). Берётся месяц конца периода; факт — комиссия закрытых в нём
 * сделок по всей компании, фильтры дашборда к плану не применяются.
 */
async function planFor(r: DirectorRange, viewer: DirectorViewer, money: MoneyContext) {
  const month = currentDushanbeMonth(r.to);
  if (!viewer.seesMoney) return { commissionPlan: null, planIsDefault: false, fact: null, pct: null, left: null, month };
  const bounds = dushanbeMonthBounds(month);
  const [settings, fact] = await Promise.all([
    dbGate(() => prisma.settings.findUnique({ where: { id: "singleton" }, select: { monthlyCommissionPlan: true } })),
    revenue({ from: bounds.start, to: new Date(bounds.end.getTime() - 1) }, {}, money),
  ]);
  const stored = settings ? Number(settings.monthlyCommissionPlan) : null;
  // Колонка NOT NULL с умолчанием: «не задан» и «задан как умолчание» в базе не различить — та же
  // общая функция, что у главной руководителя (isDefaultCommissionPlan). Умолчание — «план не задан»,
  // а не «80% от 8000».
  const plan = stored !== null && !isDefaultCommissionPlan(stored) ? stored : null;
  return {
    commissionPlan: plan,
    planIsDefault: stored === null || isDefaultCommissionPlan(stored),
    fact,
    pct: plan ? pct(fact, plan) : null,
    left: plan != null ? roundMoney(Math.max(0, plan - fact)) : null,
    month,
  };
}

function filtersOf(q: DirectorDashboardQuery): DirectorFilters {
  return { agentId: q.agentId, source: q.source, kind: q.kind };
}

export async function buildDirectorDashboard(q: DirectorDashboardQuery, viewer: DirectorViewer, now: Date = new Date()): Promise<DirectorDashboardResponse> {
  const period = resolveDirectorPeriod(q, now);
  const f = filtersOf(q);
  const money = await loadMoneyContext();
  const [current, previous, cohort, lossReasons, speed, overdueTasks, agents, sources, plan] = await Promise.all([
    kpisFor(period, f, viewer, now, money),
    kpisFor(period.prev, f, viewer, now, money),
    buildFunnelCohort(period, { investigationRole: viewer.investigationRole, seesMoney: viewer.seesMoney }, cohortScope(f)),
    lossReasonsFor(period, f),
    speedFor(period, f),
    countSpec(drillWhere("overdueTasks", period, f, viewer, now)),
    agentsFor(period, f, viewer, now, money),
    sourcesFor(period, f, viewer, money),
    planFor(period, viewer, money),
  ]);

  const kpis: DirectorKpi[] = (Object.keys(KPI_META) as DirectorKpiKey[]).map((key) => ({
    key,
    ...KPI_META[key],
    value: current[key],
    prev: previous[key],
  }));
  const first = cohort[0]?.count ?? 0;

  return {
    period: { from: period.from.toISOString(), to: period.to.toISOString(), preset: period.preset },
    prevPeriod: { from: period.prev.from.toISOString(), to: period.prev.to.toISOString() },
    filters: { agentId: f.agentId ?? null, source: f.source ?? null, kind: f.kind ?? null },
    seesMoney: viewer.seesMoney,
    kpis,
    funnel: {
      method: "cohort",
      steps: cohort.map((step, i) => ({
        key: step.key,
        label: step.key === "negotiations" ? "Дошли до переговоров" : step.label,
        count: step.count,
        conversionFromPrev: i === 0 ? null : pct(step.count, cohort[i - 1].count),
        conversionFromFirst: i === 0 ? null : pct(step.count, first),
      })),
    },
    lossReasons,
    speed: {
      ...speed,
      noContactCount: current.noContact ?? 0,
      noContactDrillKey: "noContact",
      overdueTasks,
      overdueDrillKey: "overdueTasks",
    },
    agents,
    sources,
    plan,
    updatedAt: now.toISOString(),
    cacheSeconds: CACHE_TTL_MS / 1000,
  };
}

// ── кэш 60 секунд ───────────────────────────────────────────────────────────

const cache = new Map<string, { at: number; value: DirectorDashboardResponse }>();

/** Ключ — параметры и всё, что меняет ответ от зрителя (деньги, служебные записи). */
export function directorCacheKey(q: DirectorDashboardQuery, viewer: DirectorViewer): string {
  return JSON.stringify([q.preset, q.from ?? null, q.to ?? null, q.agentId ?? null, q.source ?? null, q.kind ?? null, viewer.seesMoney, viewer.investigationRole ?? null]);
}

/** Одинаковые запросы, пришедшие одновременно, ждут один расчёт, а не запускают каждый свой. */
const inflight = new Map<string, Promise<DirectorDashboardResponse>>();

export async function cachedDirectorDashboard(q: DirectorDashboardQuery, viewer: DirectorViewer): Promise<DirectorDashboardResponse> {
  const key = directorCacheKey(q, viewer);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const running = inflight.get(key);
  if (running) return running;
  const job = buildDirectorDashboard(q, viewer)
    .then((value) => {
      if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** Для тестов: сбросить кэш между сценариями. */
export function clearDirectorDashboardCache(): void {
  cache.clear();
  inflight.clear();
}

// ── список под плиткой ──────────────────────────────────────────────────────

const DRILL_LABELS: Record<DirectorDrillKey, string> = {
  newLeads: "Новые заявки",
  contacted: "Обработанные заявки",
  noContact: "Заявки без контакта",
  showings: "Показы",
  meetings: "Встречи",
  negotiations: "Начато переговоров",
  deals: "Закрытые сделки",
  overdueTasks: "Просроченные задачи",
  lost: "Отказы",
};

interface RawItem {
  id: string;
  entity: DirectorDrillItem["entity"];
  date: Date | null;
  agentId: string | null;
  client: { id: string; fullName: string; source: string; status: string };
  status: string;
  statusLabel: string;
  amount: number | null;
}

const CLIENT_SELECT = { id: true, fullName: true, source: true, status: true } as const;
const clientStatusLabel = (s: string) => CLIENT_STATUS_LABELS[s as keyof typeof CLIENT_STATUS_LABELS] ?? s;
const INTERACTION_LABELS: Record<string, string> = { SHOWING: "Показ", MEETING: "Встреча", CALL: "Звонок", MESSAGE: "Сообщение" };

async function drillRows(spec: DrillSpec, take: number, skip: number, viewer: DirectorViewer, money: MoneyContext): Promise<RawItem[]> {
  if (spec.model === "client") {
    const rows = await prisma.client.findMany({
      where: spec.where,
      select: { ...CLIENT_SELECT, createdAt: true, assignmentRefusedAt: true, assignedAgentId: true, assignmentRefusedByAgentId: true, refusalReason: true },
      orderBy: [{ [spec.dateField]: "desc" }, { id: "asc" }],
      take,
      skip,
    });
    return rows.map((c) => {
      const lost = spec.dateField === "assignmentRefusedAt";
      return {
        id: c.id,
        entity: "client" as const,
        date: lost ? c.assignmentRefusedAt : c.createdAt,
        agentId: c[spec.agentField],
        client: c,
        status: lost ? (c.refusalReason ?? "NONE") : c.status,
        statusLabel: lost
          ? c.refusalReason
            ? (REFUSAL_REASON_LABELS[c.refusalReason as RefusalReason] ?? c.refusalReason)
            : "Отказ без причины"
          : clientStatusLabel(c.status),
        amount: null,
      };
    });
  }
  if (spec.model === "interaction") {
    const rows = await prisma.interaction.findMany({
      where: spec.where,
      select: { id: true, type: true, createdAt: true, nextActionDate: true, agentId: true, subjectAgentId: true, nextAction: true, client: { select: CLIENT_SELECT } },
      orderBy: [{ [spec.dateField]: spec.dateField === "nextActionDate" ? "asc" : "desc" }, { id: "asc" }],
      take,
      skip,
    });
    return rows.map((i) => ({
      id: i.id,
      entity: "interaction" as const,
      date: spec.dateField === "nextActionDate" ? i.nextActionDate : i.createdAt,
      agentId: i.agentId ?? i.subjectAgentId,
      client: i.client,
      status: i.type,
      statusLabel: spec.dateField === "nextActionDate" ? `Задача: ${phoneSafeText(i.nextAction, viewer.seesPhone) ?? ""}`.trim() : (INTERACTION_LABELS[i.type] ?? i.type),
      amount: null,
    }));
  }
  const rows = await prisma.deal.findMany({
    where: spec.where,
    select: { id: true, stage: true, startedAt: true, closedAt: true, agentId: true, currency: true, commissionAmount: true, client: { select: CLIENT_SELECT } },
    orderBy: [{ [spec.dateField]: "desc" }, { id: "asc" }],
    take,
    skip,
  });
  return rows.map((d) => ({
    id: d.id,
    entity: "deal" as const,
    date: spec.dateField === "closedAt" ? d.closedAt : d.startedAt,
    agentId: d.agentId,
    client: d.client,
    status: d.stage,
    statusLabel: DEAL_STAGE_LABELS[d.stage] ?? d.stage,
    amount: viewer.seesMoney ? roundMoney(toTjs(d.commissionAmount, d.currency, money)) : null,
  }));
}

/** Без права archive.view клиенты из Корзины в списке не показываются (и не считаются в «Всего»). */
function withoutTrash(spec: DrillSpec, viewer: DirectorViewer): DrillSpec {
  if (viewer.seesArchive) return spec;
  if (spec.model === "client") return { ...spec, where: { AND: [spec.where, { deletedAt: null }] } };
  if (spec.model === "interaction") return { ...spec, where: { AND: [spec.where, { client: { deletedAt: null } }] } };
  return { ...spec, where: { AND: [spec.where, { client: { deletedAt: null } }] } };
}

/** Имя клиента для списка — по тем же правилам, что список клиентов (номер и происхождение). */
type PresentName = (client: { fullName: string; source: string }) => { name: string; source: string; sourceLabel: string };

export async function buildDirectorDrill(
  q: DirectorDashboardQuery & { key: DirectorDrillKey; limit: number; offset: number },
  viewer: DirectorViewer,
  presentName: PresentName,
  now: Date = new Date()
): Promise<DirectorDrillResponse> {
  const period = resolveDirectorPeriod(q, now);
  const spec = withoutTrash(drillWhere(q.key, period, filtersOf(q), viewer, now), viewer);
  const money = await loadMoneyContext();
  const [total, rows] = await Promise.all([countSpec(spec), drillRows(spec, q.limit, q.offset, viewer, money)]);
  const agentIds = [...new Set(rows.map((r) => r.agentId).filter((id): id is string => !!id))];
  const agents = agentIds.length
    ? await prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, fullName: true }, take: 100 })
    : [];
  const names = new Map(agents.map((a) => [a.id, a.fullName]));
  return {
    key: q.key,
    label: DRILL_LABELS[q.key],
    total,
    limit: q.limit,
    offset: q.offset,
    hasMore: q.offset + rows.length < total,
    items: rows.map((r) => {
      const shown = presentName(r.client);
      return {
        id: r.id,
        entity: r.entity,
        clientId: r.client.id,
        clientName: shown.name,
        agentId: r.agentId,
        agentName: r.agentId ? (names.get(r.agentId) ?? null) : null,
        date: (r.date ?? new Date(0)).toISOString(),
        source: shown.source,
        sourceLabel: shown.sourceLabel,
        status: r.status,
        statusLabel: r.statusLabel,
        amount: r.amount,
      };
    }),
  };
}

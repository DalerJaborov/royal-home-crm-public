import {
  AGENT_GLANCE_DAYS,
  type AgentGlance,
  type AgentGlanceDayPoint,
  type AgentGlanceDrill,
  type AgentGlanceDrillItem,
  type AgentGlanceDrillKey,
  type AgentGlanceIssue,
  type AgentGlancePeriod,
  type AgentIssueKind,
} from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { investigationRoleFor } from "../auth/investigations.js";
import { visibleInteractionWhere } from "./investigationPrivacy.js";
import { clientNamePhoneSafe, phoneSafeText } from "./clientPhone.js";
import { BUYERS_IN_WORK_WHERE } from "./agentLoad.js";
import { TERMINAL_CLIENT_STATUSES } from "./clientContact.js";
import { noContactWhere } from "./noContact.js";
import { overdueTasksOfAgentsWhere } from "./tasks.js";
import { findSellerPropertyMissing } from "./sellerPropertyMissingAntifraud.js";
import { loadMoneyContext, roundMoney, toTjs } from "./money.js";
import { dushanbeDateString, dushanbeStartOfToday } from "./dushanbeTime.js";
import { runLimited } from "./concurrency.js";
import type { StaffLiveViewer } from "./staffLive.js";

/**
 * КАРТОЧКА СОТРУДНИКА «ОДНИМ ВЗГЛЯДОМ» — ОДНА ДВЕРЬ (22.11.2026).
 *
 * Плитки за период, график по дням и замечания «покупатели / продавцы» считаются
 * здесь; список за плиткой (`loadAgentGlanceDrill`) берёт то же окно и те же условия,
 * поэтому число на плитке равно числу строк списка. Окно — последние N суток по
 * Душанбе, включая сегодняшние (7 или 30): та же граница у плиток и у столбиков.
 *
 * Деньги (комиссия) — только при finance.view, иначе null. Номера в именах и
 * заметках закрываются тем же правилом, что у /overview (lib/clientPhone.ts).
 */
const DAY_MS = 86_400_000;
/** Потолок строк любой выборки: карточка не вправе тянуть таблицу целиком. */
const ROW_CAP = 20_000;
const LIST_CAP = 100;
const WAITING_CAP = 200;
const DRILL_PAGE = 50;
const CONCURRENCY = 3;

export function glanceWindowStart(period: AgentGlancePeriod, now = new Date()): Date {
  return new Date(dushanbeStartOfToday(now).getTime() - (AGENT_GLANCE_DAYS[period] - 1) * DAY_MS);
}

const NOT_TERMINAL = { notIn: [...TERMINAL_CLIENT_STATUSES] };

const SELLERS_IN_WORK_WHERE = {
  assignmentCompletedAt: null,
  kind: "SELLER" as const,
  status: NOT_TERMINAL,
};

function viewerRoleOf(viewer: StaffLiveViewer) {
  return investigationRoleFor(viewer.role, viewer.can("clients.securityReview"));
}

function callWhere(id: string, since: Date, viewer: StaffLiveViewer): Prisma.InteractionWhereInput {
  return {
    agentId: id,
    type: "CALL",
    archiveReview: false,
    createdAt: { gte: since },
    client: { deletedAt: null },
    ...visibleInteractionWhere(viewerRoleOf(viewer)),
  };
}

function showingWhere(id: string, since: Date, viewer: StaffLiveViewer): Prisma.InteractionWhereInput {
  return {
    agentId: id,
    type: "SHOWING",
    createdAt: { gte: since },
    client: { deletedAt: null },
    ...visibleInteractionWhere(viewerRoleOf(viewer)),
  };
}

const missedWhere = (id: string, since: Date): Prisma.IncomingCallWhereInput => ({
  startedAt: { gte: since },
  answered: false,
  OR: [{ routedToId: id }, { callbackAgentId: id }],
});

const waitingWhere = (id: string): Prisma.ClientWhereInput => ({
  assignedAgentId: id,
  deletedAt: null,
  workStatus: "ACTIVE",
  status: NOT_TERMINAL,
  lastClientMessageAt: { not: null },
});

/** Prisma не сравнивает два столбца одной строки: «писал, а агент не отвечал после» — на месте. */
function stillWaiting<T extends { lastClientMessageAt: Date | null; lastAgentAttemptAt: Date | null }>(rows: T[]): T[] {
  return rows.filter((c) => c.lastClientMessageAt && (!c.lastAgentAttemptAt || c.lastAgentAttemptAt < c.lastClientMessageAt));
}

function kindOf(kind: string | null | undefined): AgentIssueKind {
  return kind === "BUYER" || kind === "SELLER" ? kind : "OTHER";
}

export async function loadAgentGlance(id: string, period: AgentGlancePeriod, viewer: StaffLiveViewer): Promise<AgentGlance> {
  const now = new Date();
  const days = AGENT_GLANCE_DAYS[period];
  const since = glanceWindowStart(period, now);
  const canSeePhone = viewer.can("clients.viewPhone");
  const seesMoney = viewer.can("finance.view");
  // Антифрод-находки («продавец без объекта») — только тому, кому открыты разборы СБ.
  const seesInvestigations = viewerRoleOf(viewer) !== undefined;
  const scope = visibleInteractionWhere(viewerRoleOf(viewer));
  const overdueWhere = overdueTasksOfAgentsWhere(now, [id], scope);
  const name = (n: string) => clientNamePhoneSafe(n, canSeePhone);

  const [buyers, sellers, interactions, missed, deals, kpi, waitingRows, overdueRows, noContactRows, sellerMissing] =
    await runLimited(
      [
        () => prisma.client.count({ where: { assignedAgentId: id, deletedAt: null, ...BUYERS_IN_WORK_WHERE } }),
        () => prisma.client.count({ where: { assignedAgentId: id, deletedAt: null, ...SELLERS_IN_WORK_WHERE } }),
        () =>
          prisma.interaction.findMany({
            where: { OR: [callWhere(id, since, viewer), showingWhere(id, since, viewer)] },
            select: { type: true, createdAt: true, callAttempt: true, recordingDurationSec: true },
            take: ROW_CAP,
          }),
        () => prisma.incomingCall.count({ where: missedWhere(id, since) }),
        () =>
          prisma.deal.findMany({
            where: { agentId: id, OR: [{ startedAt: { gte: since } }, { closedAt: { gte: since } }] },
            select: { stage: true, startedAt: true, closedAt: true, commissionAmount: true, currency: true, annulledAt: true },
            take: ROW_CAP,
          }),
        () => prisma.kpiDailyScore.findMany({ where: { agentId: id, date: { gte: since } }, select: { date: true, score: true } }),
        () =>
          prisma.client.findMany({
            where: waitingWhere(id),
            orderBy: { lastClientMessageAt: "desc" },
            take: WAITING_CAP,
            select: { shortId: true, fullName: true, kind: true, lastClientMessageAt: true, lastAgentAttemptAt: true },
          }),
        () =>
          prisma.interaction.findMany({
            where: overdueWhere,
            orderBy: { nextActionDate: "asc" },
            take: LIST_CAP,
            select: { nextAction: true, nextActionDate: true, client: { select: { shortId: true, fullName: true, kind: true } } },
          }),
        () =>
          prisma.client.findMany({
            where: { AND: [noContactWhere(), { assignedAgentId: id }] },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: LIST_CAP,
            select: { shortId: true, fullName: true, kind: true, createdAt: true },
          }),
        () => (seesInvestigations ? findSellerPropertyMissing(now) : Promise.resolve({ warnDays: 0, criticalDays: 0, items: [] })),
      ],
      CONCURRENCY
    );

  // Окно по дням: ключ — дата по Душанбе, пустые дни остаются нулями (столбик «0» честнее дыры).
  const points = new Map<string, AgentGlanceDayPoint>();
  for (let i = 0; i < days; i++) {
    const date = dushanbeDateString(new Date(since.getTime() + i * DAY_MS + DAY_MS / 2));
    points.set(date, { date, calls: 0, showings: 0, kpi: null });
  }
  let callsTotal = 0;
  let callsTalked = 0;
  let showings = 0;
  for (const row of interactions) {
    const point = points.get(dushanbeDateString(row.createdAt));
    if (row.type === "CALL") {
      callsTotal += 1;
      if (row.callAttempt === "TALKED" || (row.recordingDurationSec ?? 0) > 0) callsTalked += 1;
      if (point) point.calls += 1;
    } else if (row.type === "SHOWING") {
      showings += 1;
      if (point) point.showings += 1;
    }
  }
  for (const k of kpi) {
    const point = points.get(dushanbeDateString(k.date));
    if (point) point.kpi = k.score;
  }

  const completedDeals = deals.filter((d) => d.stage === "COMPLETED" && !d.annulledAt && d.closedAt && d.closedAt >= since);
  let commission: number | null = null;
  if (seesMoney) {
    const money = await loadMoneyContext();
    commission = roundMoney(completedDeals.reduce((s, d) => s + toTjs(d.commissionAmount, d.currency, money), 0));
  }

  const waiting = stillWaiting(waitingRows);
  const issues: AgentGlanceIssue[] = [
    ...waiting.map((c): AgentGlanceIssue => ({
      code: "waiting", kind: kindOf(c.kind), severity: "crit", clientShortId: c.shortId, clientName: name(c.fullName),
      sub: "Клиент ждёт ответа", at: c.lastClientMessageAt!.toISOString(),
    })),
    ...overdueRows.map((t): AgentGlanceIssue => ({
      code: "overdue", kind: kindOf(t.client.kind), severity: "crit", clientShortId: t.client.shortId, clientName: name(t.client.fullName),
      sub: `Просрочено: ${phoneSafeText(t.nextAction, canSeePhone) ?? "задача"}`, at: (t.nextActionDate ?? now).toISOString(),
    })),
    ...noContactRows.map((c): AgentGlanceIssue => ({
      code: "noContact", kind: kindOf(c.kind), severity: "warn", clientShortId: c.shortId, clientName: name(c.fullName),
      sub: "Не связывались", at: c.createdAt.toISOString(),
    })),
    ...sellerMissing.items
      .filter((s) => s.assignedAgent?.id === id)
      .map((s): AgentGlanceIssue => ({
        code: "sellerNoProperty", kind: "SELLER", severity: s.level === "CRITICAL" ? "crit" : "warn", clientShortId: s.shortId,
        clientName: name(s.fullName), sub: "Продавец без объекта", at: s.propertyAcceptedAt.toISOString(),
      })),
  ];
  // Срочное первым, внутри — самое давнее.
  issues.sort((a, b) => (a.severity === b.severity ? a.at.localeCompare(b.at) : a.severity === "crit" ? -1 : 1));

  const overdueTotal = overdueRows.length >= LIST_CAP ? await prisma.interaction.count({ where: overdueWhere }) : overdueRows.length;

  return {
    period,
    days,
    buyersInWork: buyers,
    sellersInWork: sellers,
    calls: { total: callsTotal, talked: callsTalked, missed },
    showings,
    deals: { total: deals.length, completed: completedDeals.length },
    commission,
    overdueTasks: overdueTotal,
    waitingForReply: waiting.length,
    series: [...points.values()],
    issues,
    issuesCapped: overdueRows.length >= LIST_CAP || noContactRows.length >= LIST_CAP || waitingRows.length >= WAITING_CAP,
  };
}

/** Список за плиткой: те же окно и условия, что у числа выше. До 50 строк, свежее первым. */
export async function loadAgentGlanceDrill(
  id: string,
  key: AgentGlanceDrillKey,
  period: AgentGlancePeriod,
  viewer: StaffLiveViewer
): Promise<AgentGlanceDrill | null> {
  const now = new Date();
  const since = glanceWindowStart(period, now);
  const canSeePhone = viewer.can("clients.viewPhone");
  const seesMoney = viewer.can("finance.view");
  const scope = visibleInteractionWhere(viewerRoleOf(viewer));
  const name = (n: string) => clientNamePhoneSafe(n, canSeePhone);
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

  if (key === "commission" && !seesMoney) return null;

  const clientItem = (
    c: { id: string; shortId: number; fullName: string },
    sub: string,
    at: Date | null,
    amount: number | null = null
  ): AgentGlanceDrillItem => ({
    id: c.id, clientShortId: c.shortId, propertyShortId: null, title: name(c.fullName), sub, at: iso(at), amount,
  });

  if (key === "buyers" || key === "sellers") {
    const where: Prisma.ClientWhereInput = {
      assignedAgentId: id,
      deletedAt: null,
      ...(key === "buyers" ? BUYERS_IN_WORK_WHERE : SELLERS_IN_WORK_WHERE),
    };
    const [total, rows] = await Promise.all([
      prisma.client.count({ where }),
      prisma.client.findMany({
        where,
        orderBy: [{ lastContactAt: "asc" }, { createdAt: "asc" }],
        take: DRILL_PAGE,
        select: { id: true, shortId: true, fullName: true, lastContactAt: true },
      }),
    ]);
    return {
      key, period, total,
      items: rows.map((c) => clientItem(c, "Последний контакт", c.lastContactAt)),
    };
  }

  if (key === "calls") {
    const where = callWhere(id, since, viewer);
    const [total, rows] = await Promise.all([
      prisma.interaction.count({ where }),
      prisma.interaction.findMany({
        where, orderBy: { createdAt: "desc" }, take: DRILL_PAGE,
        select: { id: true, createdAt: true, callAttempt: true, recordingDurationSec: true, client: { select: { id: true, shortId: true, fullName: true } } },
      }),
    ]);
    return {
      key, period, total,
      items: rows.map((r) => clientItem(r.client, r.callAttempt === "TALKED" || (r.recordingDurationSec ?? 0) > 0 ? "Поговорили" : "Не дозвонились", r.createdAt)),
    };
  }

  if (key === "showings") {
    const where = showingWhere(id, since, viewer);
    const [total, rows] = await Promise.all([
      prisma.interaction.count({ where }),
      prisma.interaction.findMany({
        where, orderBy: { createdAt: "desc" }, take: DRILL_PAGE,
        select: { id: true, createdAt: true, client: { select: { id: true, shortId: true, fullName: true } }, property: { select: { title: true } } },
      }),
    ]);
    return { key, period, total, items: rows.map((r) => clientItem(r.client, r.property?.title ?? "Показ", r.createdAt)) };
  }

  if (key === "missed") {
    const where = missedWhere(id, since);
    const [total, rows] = await Promise.all([
      prisma.incomingCall.count({ where }),
      prisma.incomingCall.findMany({ where, orderBy: { startedAt: "desc" }, take: DRILL_PAGE, select: { id: true, startedAt: true, phone: true } }),
    ]);
    return {
      key, period, total,
      items: rows.map((r) => ({
        id: r.id, clientShortId: null, propertyShortId: null,
        title: canSeePhone ? r.phone : "Номер скрыт", sub: "Пропущенный входящий", at: iso(r.startedAt), amount: null,
      })),
    };
  }

  if (key === "deals" || key === "commission") {
    const where: Prisma.DealWhereInput =
      key === "commission"
        ? { agentId: id, stage: "COMPLETED", annulledAt: null, closedAt: { gte: since } }
        : { agentId: id, OR: [{ startedAt: { gte: since } }, { closedAt: { gte: since } }] };
    const [total, rows, money] = await Promise.all([
      prisma.deal.count({ where }),
      prisma.deal.findMany({
        where, orderBy: { startedAt: "desc" }, take: DRILL_PAGE,
        select: {
          id: true, stage: true, startedAt: true, closedAt: true, commissionAmount: true, currency: true,
          client: { select: { fullName: true } }, property: { select: { shortId: true, title: true } },
        },
      }),
      seesMoney ? loadMoneyContext() : Promise.resolve(null),
    ]);
    return {
      key, period, total,
      items: rows.map((d) => ({
        id: d.id, clientShortId: null, propertyShortId: d.property.shortId, title: d.property.title,
        sub: `${name(d.client.fullName)} · ${d.stage === "COMPLETED" ? "закрыта" : d.stage === "CANCELLED" ? "отменена" : "в работе"}`,
        at: iso(d.closedAt ?? d.startedAt),
        amount: money && d.commissionAmount ? roundMoney(toTjs(d.commissionAmount, d.currency, money)) : null,
      })),
    };
  }

  if (key === "overdue") {
    const where = overdueTasksOfAgentsWhere(now, [id], scope);
    const [total, rows] = await Promise.all([
      prisma.interaction.count({ where }),
      prisma.interaction.findMany({
        where, orderBy: { nextActionDate: "asc" }, take: DRILL_PAGE,
        select: { id: true, nextAction: true, nextActionDate: true, client: { select: { id: true, shortId: true, fullName: true } } },
      }),
    ]);
    return {
      key, period, total,
      items: rows.map((t) => clientItem(t.client, `Просрочено: ${phoneSafeText(t.nextAction, canSeePhone) ?? "задача"}`, t.nextActionDate)),
    };
  }

  // waiting
  const rows = stillWaiting(
    await prisma.client.findMany({
      where: waitingWhere(id), orderBy: { lastClientMessageAt: "asc" }, take: WAITING_CAP,
      select: { id: true, shortId: true, fullName: true, lastClientMessageAt: true, lastAgentAttemptAt: true },
    })
  );
  return {
    key, period, total: rows.length,
    items: rows.slice(0, DRILL_PAGE).map((c) => clientItem(c, "Клиент ждёт ответа", c.lastClientMessageAt)),
  };
}

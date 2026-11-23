import {
  DELETE_REQUEST_REASON_LABELS,
  REFUSAL_REASON_LABELS,
  type DeleteRequestReason,
  type RefusalReason,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { CLIENT_IN_WORK_WHERE } from "./clientInWork.js";
import { pendingDeleteHideWhere } from "./clientSearchWhere.js";
import { dushanbeDateString, dushanbeDateTimeString } from "./dushanbeTime.js";
import { noContactWhere } from "./noContact.js";

/**
 * КЛИЕНТСКАЯ БАЗА ОДНИМ ОТВЕТОМ — ОДНА ДВЕРЬ ДЛЯ ЭКРАНА «КЛИЕНТЫ» И ШАБНАМ
 * (17.11.2026, директор дважды просил: «сколько клиентов, сколько активных,
 * почему неактивны — коротко подготовь»).
 *
 * ЧТО ЗНАЧИТ «АКТИВНЫЙ» С 16.11.2026. Статусов «Активный/Неактивный/Отложенный/
 * Потерянный» больше нет (решение владельца, PR #220/#222, сторож
 * tests/no-client-status-folders.test.ts): workStatus у всех ACTIVE и никем не
 * читается. Клиент либо В РАБОТЕ у агента (lib/clientInWork.ts,
 * CLIENT_IN_WORK_WHERE — то, что показывает список «Клиенты»), либо со сделкой,
 * либо в Архиве, либо работа по нему завершена и ждёт решения руководителя, либо
 * в Корзине. «Не активный» в разговоре директора — это всё, что не «в работе»,
 * плюс те, кто в работе, но с ними ни разу не связывались (lib/noContact.ts — то же
 * правило, что плитка «Не связывались»). Новых состояний здесь не придумывается: только счёт
 * по тем же условиям, что у экрана.
 *
 * Границы видимости — как у GET /clients/summary (routes/clients/summary.ts):
 * база `clientsScopeBaseWhere` отсюда, её зовут ОБА места. Агент без
 * clients.viewAll считает только своих покупателей и продавцов; карточки с
 * заявкой на удаление скрыты так же, как в списке.
 *
 * Запросы — только count/groupBy (без выборки строк клиентов), волнами по
 * несколько: пул соединений общий (см. brainReadTools.ts::get_day_snapshot).
 */

export interface ClientScopeParams {
  /** id агента, если он видит только своих (нет clients.viewAll); undefined — вся компания. */
  ownAgentId: string | undefined;
  /** clients.delete — решает заявки на удаление и видит такие карточки в списке. */
  canDelete: boolean;
}

/**
 * База экрана «Клиенты»: не в Корзине; агенту — только свои покупатели и
 * продавцы; без карточек с заявкой на удаление (как список). Та же база у сводки
 * над списком и у разбора базы помощницы.
 */
export async function clientsScopeBaseWhere(params: ClientScopeParams): Promise<Prisma.ClientWhereInput> {
  const hideWhere = await pendingDeleteHideWhere(params);
  return {
    ...(params.ownAgentId
      ? { deletedAt: null, assignedAgentId: params.ownAgentId, kind: { in: ["BUYER", "SELLER"] } }
      : { deletedAt: null }),
    ...hideWhere,
  };
}

/** Состояния, в которых карточка не ждёт принятия агентом (старые LOST читаются как прежде). */
const NOT_AWAITING: Prisma.ClientWhereInput = { status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] } };

/**
 * «Ждут принятия» — ровно срез `pendingAcceptance` списка (routes/clients/list.ts):
 * никем не принятые покупатели/продавцы без эскалации (эскалированных решает
 * руководитель, агенту их уже не принять).
 */
export function awaitingAcceptanceWhere(base: Prisma.ClientWhereInput): Prisma.ClientWhereInput {
  return {
    ...base,
    ...NOT_AWAITING,
    acceptedAt: null,
    escalatedAt: null,
    kind: { in: ["BUYER", "SELLER"] },
    workStatus: "ACTIVE",
  };
}

/** Окно для «почему уходят» (отказы и Корзина): последние 30 суток. */
export const OVERVIEW_WINDOW_DAYS = 30;
/** Сколько записей отказов читать за окно: причина лежит в JSON журнала, groupBy по ней нет. */
const REFUSAL_SCAN_LIMIT = 1000;
/** Строк «по агентам» в ответе; остальные — числом «ещё N». */
export const OVERVIEW_AGENT_ROWS = 12;

export interface ReasonCount {
  key: string;
  label: string;
  count: number;
}

export interface AgentBaseRow {
  agentId: string;
  name: string;
  inWork: number;
  noContact: number;
}

export interface ClientBaseOverview {
  /** «на сейчас», дата и время по Душанбе. */
  asOf: string;
  /** Окно отказов и Корзины словами: «ГГГГ-ММ-ДД — ГГГГ-ММ-ДД» по Душанбе. */
  windowLabel: string;
  scope: "own" | "all";
  /** Все карточки в пределах видимости, кроме Корзины. */
  total: number;
  inWork: {
    total: number;
    buyers: number;
    sellers: number;
    /** «Прочие обращения» (работа, аренда и т.п.); null — не видно этому человеку. */
    other: number | null;
    /** Из них ещё не принял агент. */
    awaitingAcceptance: number;
    /** Из них «не связывались» по общему правилу (плитка «Не связывались»). */
    noContact: number;
    /** Из них без агента (только при видимости всей компании). */
    withoutAgent: number | null;
  };
  /** Не в работе — по причинам. Сумма с inWork.total даёт total. */
  notInWork: {
    total: number;
    dealClosed: number;
    archived: number;
    /** Агент закончил работу (отказ на пределе передач и т.п.) — ждёт решения руководителя. */
    workCompleted: number;
  };
  /**
   * Карточки с поданной заявкой на удаление (ждут решения). Тому, кто решает
   * заявки, они видны и входят в total; агенту — скрыты из списка и из total.
   */
  pendingDelete: { count: number; includedInTotal: boolean };
  /** Отказы «Без сделки» за окно — по причинам (журнал CLIENT_REFUSE). */
  refusals: { total: number; reasons: ReasonCount[]; capped: boolean };
  trash: {
    total: number;
    lastWindow: number;
    /** Причины удалений за окно — по одобренным заявкам на удаление. */
    reasons: ReasonCount[];
    /** Удалены за окно без заявки (руководство удалило само, причина — в хронологии). */
    withoutRequest: number;
  };
  /** По агентам — только при видимости всей компании. */
  byAgent: { rows: AgentBaseRow[]; more: number } | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function sortReasons(counts: Map<string, number>, label: (key: string) => string): ReasonCount[] {
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, label: label(key), count }));
}

const refusalLabel = (key: string) => REFUSAL_REASON_LABELS[key as RefusalReason] ?? key;
const deleteReasonLabel = (key: string) => DELETE_REQUEST_REASON_LABELS[key as DeleteRequestReason] ?? key;

export async function loadClientBaseOverview(
  params: ClientScopeParams & {
    /** otherInquiries.view — «Прочие обращения» (как у сводки экрана). */
    canOther: boolean;
    now?: Date;
  },
): Promise<ClientBaseOverview> {
  const now = params.now ?? new Date();
  const own = params.ownAgentId;
  const screenBase = await clientsScopeBaseWhere(params);
  // «Прочие» — только тем, кому их показывает экран; иначе база без них, чтобы total
  // не включал то, что человек не видит отдельной строкой.
  const canOther = !own && params.canOther;
  const base: Prisma.ClientWhereInput = canOther ? screenBase : { AND: [screenBase, { kind: { in: ["BUYER", "SELLER"] } }] };
  const inWorkWhere: Prisma.ClientWhereInput = { AND: [base, CLIENT_IN_WORK_WHERE] };
  const since = new Date(now.getTime() - OVERVIEW_WINDOW_DAYS * DAY_MS);
  // Корзина своих — как «trashedMine» сводки: текущий или последний держатель — я.
  const trashScope: Prisma.ClientWhereInput = own
    ? { deletedAt: { not: null }, OR: [{ assignedAgentId: own }, { lastAgentId: own }] }
    : { deletedAt: { not: null } };
  const trashWindow: Prisma.ClientWhereInput = { ...trashScope, deletedAt: { gte: since } };

  // Волна 1: сама база.
  const [total, kindGroups, closedGroups, workCompleted, awaitingAcceptance, noContact] = await Promise.all([
    prisma.client.count({ where: base }),
    prisma.client.groupBy({ by: ["kind"], where: inWorkWhere, _count: { _all: true } }),
    // Закрытая сделка и Архив — их список прячет; остальные состояния — обычная работа.
    prisma.client.groupBy({
      by: ["status"],
      where: { AND: [base, { status: { in: ["DEAL_CLOSED", "ARCHIVED"] } }] },
      _count: { _all: true },
    }),
    prisma.client.count({
      where: { AND: [base, { assignmentCompletedAt: { not: null }, status: { notIn: ["DEAL_CLOSED", "ARCHIVED"] } }] },
    }),
    prisma.client.count({ where: awaitingAcceptanceWhere(base) }),
    prisma.client.count({ where: { AND: [base, noContactWhere()] } }),
  ]);

  // Волна 2: заявки на удаление, отказы, Корзина.
  const [pendingDelete, refusalRows, trashTotal, trashLast, trashWithRequest, deleteReasonGroups] = await Promise.all([
    prisma.client.count({
      where: {
        deletedAt: null,
        ...(own ? { assignedAgentId: own } : {}),
        deleteRequests: { some: { status: "PENDING" } },
      },
    }),
    prisma.auditLog.findMany({
      where: {
        action: "CLIENT_REFUSE",
        createdAt: { gte: since, lte: now },
        // Чей клиент — по meta.assignedAgentId (кнопку мог нажать руководитель), как сводка СБ.
        ...(own ? { meta: { path: ["assignedAgentId"], equals: own } } : {}),
      },
      select: { meta: true },
      orderBy: { createdAt: "desc" },
      take: REFUSAL_SCAN_LIMIT,
    }),
    prisma.client.count({ where: trashScope }),
    prisma.client.count({ where: trashWindow }),
    prisma.client.count({ where: { ...trashWindow, deleteRequests: { some: { status: "APPROVED" } } } }),
    prisma.clientDeleteRequest.groupBy({
      by: ["reason"],
      where: { status: "APPROVED", decidedAt: { gte: since }, client: trashScope },
      _count: { _all: true },
    }),
  ]);

  // Волна 3: по агентам — только при видимости всей компании.
  let byAgent: ClientBaseOverview["byAgent"] = null;
  let withoutAgent: number | null = null;
  if (!own) {
    const [inWorkByAgent, noContactByAgent, unassigned] = await Promise.all([
      prisma.client.groupBy({
        by: ["assignedAgentId"],
        where: { AND: [inWorkWhere, { assignedAgentId: { not: null } }] },
        _count: { _all: true },
      }),
      prisma.client.groupBy({
        by: ["assignedAgentId"],
        where: { AND: [base, noContactWhere()] },
        _count: { _all: true },
      }),
      prisma.client.count({ where: { AND: [inWorkWhere, { assignedAgentId: null }] } }),
    ]);
    withoutAgent = unassigned;
    const noContactBy = new Map<string, number>();
    for (const g of noContactByAgent) if (g.assignedAgentId) noContactBy.set(g.assignedAgentId, g._count._all);
    const sorted: { agentId: string; inWork: number }[] = [];
    for (const g of inWorkByAgent) if (g.assignedAgentId) sorted.push({ agentId: g.assignedAgentId, inWork: g._count._all });
    sorted.sort((a, b) => b.inWork - a.inWork);
    const top = sorted.slice(0, OVERVIEW_AGENT_ROWS);
    const names = new Map<string, string>();
    if (top.length > 0) {
      const agents = await prisma.agent.findMany({ where: { id: { in: top.map((r) => r.agentId) } }, select: { id: true, fullName: true } });
      for (const a of agents) names.set(a.id, a.fullName);
    }
    byAgent = {
      rows: top.map((r) => ({
        agentId: r.agentId,
        name: names.get(r.agentId) ?? "—",
        inWork: r.inWork,
        noContact: noContactBy.get(r.agentId) ?? 0,
      })),
      more: Math.max(0, sorted.length - top.length),
    };
  }

  const byKind = new Map(kindGroups.map((g) => [g.kind, g._count._all]));
  const buyers = byKind.get("BUYER") ?? 0;
  const sellers = byKind.get("SELLER") ?? 0;
  const other = byKind.get("OTHER") ?? 0;
  const byStatus = new Map(closedGroups.map((g) => [String(g.status), g._count._all]));
  const dealClosed = byStatus.get("DEAL_CLOSED") ?? 0;
  const archived = byStatus.get("ARCHIVED") ?? 0;

  const refusalCounts = new Map<string, number>();
  for (const row of refusalRows) {
    const reason = (row.meta as { reason?: unknown } | null)?.reason;
    const key = typeof reason === "string" && reason ? reason : "UNKNOWN";
    refusalCounts.set(key, (refusalCounts.get(key) ?? 0) + 1);
  }
  const deleteCounts = new Map(deleteReasonGroups.map((g) => [g.reason, g._count._all]));

  return {
    asOf: dushanbeDateTimeString(now),
    windowLabel: `${dushanbeDateString(since)} — ${dushanbeDateString(now)}`,
    scope: own ? "own" : "all",
    total,
    inWork: {
      total: buyers + sellers + other,
      buyers,
      sellers,
      other: canOther ? other : null,
      awaitingAcceptance,
      noContact,
      withoutAgent,
    },
    notInWork: {
      total: dealClosed + archived + workCompleted,
      dealClosed,
      archived,
      workCompleted,
    },
    pendingDelete: { count: pendingDelete, includedInTotal: params.canDelete },
    refusals: {
      total: refusalRows.length,
      reasons: sortReasons(refusalCounts, (key) => (key === "UNKNOWN" ? "Причина не указана" : refusalLabel(key))),
      capped: refusalRows.length >= REFUSAL_SCAN_LIMIT,
    },
    trash: {
      total: trashTotal,
      lastWindow: trashLast,
      reasons: sortReasons(deleteCounts, deleteReasonLabel),
      withoutRequest: Math.max(0, trashLast - trashWithRequest),
    },
    byAgent,
  };
}

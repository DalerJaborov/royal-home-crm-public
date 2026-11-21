import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  CLIENT_SOURCE_LABELS,
  CLIENT_STATUS_LABELS,
  WORK_STATUS_LABELS,
  directorDashboardQuerySchema,
  directorDrillQuerySchema,
  type ClientSource,
  type DirectorDashboardResponse,
} from "@royal-home/shared";
import { can } from "../auth/middleware.js";
import { investigationViewerRole } from "../auth/investigations.js";
import { prisma } from "../db.js";
import { clientNamePhoneSafe } from "../lib/clientPhone.js";
import { withHiddenOrigin } from "../lib/clientOrigin.js";
import { buildDirectorDrill, cachedDirectorDashboard, type DirectorViewer } from "../lib/directorDashboard.js";
import { dushanbeDateString, dushanbeDateTimeString } from "../lib/dushanbeTime.js";
import { logSystemError } from "../lib/systemError.js";
import { writeXlsx, type XlsxCell } from "../lib/xlsxWrite.js";

/**
 * ДАШБОРД ДИРЕКТОРА (ТЗ владельца, 21.11.2026). Монтируется внутрь reportsRouter,
 * поэтому вход и право reports.view уже проверены: агент без reports.view получает
 * 403 там. Отделов в CRM нет — у кого reports.view, тот видит всю компанию.
 * Деньги — только с finance.view (null, не 0). Расчёт — lib/directorDashboard.ts.
 */
export const reportsDirectorRouter = Router();

function viewerOf(req: Request): DirectorViewer {
  return {
    investigationRole: investigationViewerRole(req),
    seesMoney: can(req, "finance.view"),
    seesPhone: can(req, "clients.viewPhone"),
    seesOrigin: can(req, "clients.viewOrigin"),
    seesArchive: can(req, "archive.view"),
  };
}

function badRequest(res: Response, err: z.ZodError) {
  return res.status(400).json({ error: err.issues[0]?.message ?? "Некорректные параметры", details: err.flatten() });
}

/** Ошибка периода (с > по) приходит из resolveDirectorPeriod как ZodError — это 400, не 500. */
async function guarded(res: Response, what: string, run: () => Promise<unknown>) {
  try {
    return await run();
  } catch (err) {
    if (err instanceof z.ZodError) return badRequest(res, err);
    console.error(`[дашборд директора] ${what}:`, err instanceof Error ? err.message : err);
    void logSystemError("api", `Дашборд директора: ${what} — ${err instanceof Error ? err.message : String(err)}`);
    return res.status(500).json({ error: "Не удалось посчитать дашборд" });
  }
}

reportsDirectorRouter.get("/", async (req, res) => {
  const parsed = directorDashboardQuerySchema.safeParse(req.query);
  if (!parsed.success) return badRequest(res, parsed.error);
  return guarded(res, "сводка", async () => res.json(await cachedDirectorDashboard(parsed.data, viewerOf(req))));
});

/**
 * Право на список записей под плиткой. Сводка отдаёт только числа (reports.view), а список — имена и
 * статусы конкретных клиентов, поэтому нужно то же, что открывает список клиентов: clients.viewAll
 * (у маркетолога reports.view есть, а clients.viewAll нет — ревью #362). Сделки — ещё deals.viewAll.
 */
const DEAL_DRILL_KEYS: readonly string[] = ["negotiations", "deals"];
export function drillPermissionsMissing(req: Request, key: string): string | null {
  if (!can(req, "clients.viewAll")) return "Список записей доступен тем, кто видит всех клиентов";
  if (DEAL_DRILL_KEYS.includes(key) && !can(req, "deals.viewAll")) return "Список сделок доступен тем, кто видит все сделки";
  return null;
}

reportsDirectorRouter.get("/drill", async (req, res) => {
  const parsed = directorDrillQuerySchema.safeParse(req.query);
  if (!parsed.success) return badRequest(res, parsed.error);
  const denied = drillPermissionsMissing(req, parsed.data.key);
  if (denied) return res.status(403).json({ error: denied });
  const viewer = viewerOf(req);
  // Имя и источник — по правилам списка клиентов: без clients.viewOrigin ник и
  // источник скрыты, без clients.viewPhone цифры номера в имени закрыты.
  const presentName = (client: { fullName: string; source: string }) => {
    const shown = withHiddenOrigin({ fullName: client.fullName, source: client.source as string | null }, viewer.seesOrigin);
    const source = shown.source ?? "";
    return {
      name: clientNamePhoneSafe(shown.fullName, viewer.seesPhone),
      source,
      sourceLabel: source ? (CLIENT_SOURCE_LABELS[source as ClientSource] ?? source) : "",
    };
  };
  return guarded(res, "список", async () => res.json(await buildDirectorDrill(parsed.data, viewer, presentName)));
});

const money = (v: number | null) => (v === null ? "нет доступа" : v);
const ddmmyyyy = (iso: string) => dushanbeDateString(new Date(iso)).split("-").reverse().join(".");

function exportSheets(d: DirectorDashboardResponse): { name: string; rows: XlsxCell[][] }[] {
  const filters = [
    ["Период", `${ddmmyyyy(d.period.from)} – ${ddmmyyyy(d.period.to)}`],
    ["Сравнение с", `${ddmmyyyy(d.prevPeriod.from)} – ${ddmmyyyy(d.prevPeriod.to)}`],
    ["Сотрудник", d.filters.agentId ? (d.agents.find((a) => a.id === d.filters.agentId)?.name ?? d.filters.agentId) : "Все"],
    ["Источник", d.filters.source ? (CLIENT_SOURCE_LABELS[d.filters.source as ClientSource] ?? d.filters.source) : "Все"],
    ["Тип", d.filters.kind === "BUYER" ? "Покупатели" : d.filters.kind === "SELLER" ? "Продавцы" : "Все"],
    ["Выгружено", dushanbeDateTimeString(new Date(d.updatedAt))],
  ];
  return [
    {
      name: "KPI",
      rows: [
        ["Показатель", "За период", "Прошлый период", "Изменение"],
        ...d.kpis.map((k) => [
          k.unit === "tjs" ? `${k.label}, сомони` : k.label,
          k.unit === "tjs" ? money(k.value) : k.value,
          k.unit === "tjs" ? money(k.prev) : k.prev,
          k.value !== null && k.prev !== null ? k.value - k.prev : null,
        ]),
        [],
        ["Скорость первого контакта, медиана, мин", d.speed.medianMin],
        ["Скорость первого контакта, среднее, мин", d.speed.avgMin],
        ["Заявки без контакта", d.speed.noContactCount],
        ["Просроченные задачи (сейчас)", d.speed.overdueTasks],
        [],
        ["План комиссии на месяц", money(d.plan.commissionPlan)],
        ["Факт месяца", money(d.plan.fact)],
        ["Выполнение, %", d.plan.pct],
        ["Осталось до плана", money(d.plan.left)],
        [],
        ["Фильтры"],
        ...filters,
      ],
    },
    {
      name: "Воронка",
      rows: [
        ["Шаг", "Заявок", "% от предыдущего", "% от заявок"],
        ...d.funnel.steps.map((s) => [s.label, s.count, s.conversionFromPrev, s.conversionFromFirst]),
      ],
    },
    {
      name: "Агенты",
      rows: [
        ["Сотрудник", "Новые заявки", "Обработано", "Звонки", "Сообщения", "Встречи", "Показы", "Сделки", "Комиссия, сомони", "Конверсия, %", "Просрочено задач", "Последняя активность"],
        ...d.agents.map((a) => [
          a.name,
          a.leads,
          a.contacted,
          a.calls,
          a.messages,
          a.meetings,
          a.showings,
          a.deals,
          money(a.commission),
          a.conversion,
          a.overdueTasks,
          a.lastActivityAt ? dushanbeDateTimeString(new Date(a.lastActivityAt)) : "",
        ]),
      ],
    },
    {
      name: "Источники",
      rows: [["Источник", "Заявки", "Сделки", "Комиссия, сомони"], ...d.sources.map((s) => [s.label, s.leads, s.deals, money(s.commission)])],
    },
    {
      name: "Причины отказа",
      rows: [["Причина", "Отказов"], ...d.lossReasons.map((l) => [l.label, l.count])],
    },
  ];
}

/** Выгрузка — те же цифры, что на экране, с теми же фильтрами и правами (без денег без finance.view). */
reportsDirectorRouter.get("/export.xlsx", async (req, res) => {
  const parsed = directorDashboardQuerySchema.safeParse(req.query);
  if (!parsed.success) return badRequest(res, parsed.error);
  return guarded(res, "выгрузка", async () => {
    const data = await cachedDirectorDashboard(parsed.data, viewerOf(req));
    const file = writeXlsx(exportSheets(data));
    const name = `director-${dushanbeDateString(new Date(data.period.from))}_${dushanbeDateString(new Date(data.period.to))}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.setHeader("Cache-Control", "no-store");
    return res.send(file);
  });
});

/**
 * ИСТОРИЯ КЛЮЧЕВЫХ ПОЛЕЙ КАРТОЧКИ (ТЗ п.15): кто, когда, было → стало.
 * Статус, рабочее состояние и источник пишет перехват в db.ts (журнал StageEvent —
 * ловит все места записи, а не одно), смену ответственного — changeClientAgent
 * (AuditLog CLIENT_AGENT_CHANGE). Здесь они сведены в одну ленту.
 */
const historyQuerySchema = z.object({ clientId: z.guid(), limit: z.coerce.number().int().min(1).max(200).default(100) });

const FIELD_LABELS: Record<string, string> = { status: "Статус", workStatus: "Состояние работы", source: "Источник", assignedAgentId: "Ответственный" };

reportsDirectorRouter.get("/history", async (req, res) => {
  const parsed = historyQuerySchema.safeParse(req.query);
  if (!parsed.success) return badRequest(res, parsed.error);
  const { clientId, limit } = parsed.data;
  // История карточки — это карточка клиента: нужен тот же доступ, что к списку клиентов.
  if (!can(req, "clients.viewAll")) return res.status(403).json({ error: "История доступна тем, кто видит всех клиентов" });
  return guarded(res, "история", async () => {
    const [events, agentChanges] = await Promise.all([
      prisma.stageEvent.findMany({ where: { entityType: "CLIENT", entityId: clientId }, orderBy: { at: "desc" }, take: limit }),
      prisma.auditLog.findMany({
        where: { action: "CLIENT_AGENT_CHANGE", entityType: "Client", entityId: clientId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { createdAt: true, agentId: true, meta: true },
      }),
    ]);
    const metaOf = (m: unknown) => (m && typeof m === "object" ? (m as { fromAgentId?: string | null; toAgentId?: string | null }) : {});
    const agentIds = new Set<string>();
    for (const e of events) if (e.agentId) agentIds.add(e.agentId);
    for (const a of agentChanges) {
      const m = metaOf(a.meta);
      for (const id of [a.agentId, m.fromAgentId, m.toAgentId]) if (id) agentIds.add(id);
    }
    const agents = await prisma.agent.findMany({ where: { id: { in: [...agentIds] } }, select: { id: true, fullName: true }, take: 500 });
    const nameOf = (id: string | null | undefined) => (id ? (agents.find((a) => a.id === id)?.fullName ?? id) : null);
    const valueLabel = (field: string, v: string | null) =>
      v === null
        ? null
        : field === "status"
          ? (CLIENT_STATUS_LABELS[v as keyof typeof CLIENT_STATUS_LABELS] ?? v)
          : field === "source"
            ? (CLIENT_SOURCE_LABELS[v as ClientSource] ?? v)
            : field === "workStatus"
              ? (WORK_STATUS_LABELS[v as keyof typeof WORK_STATUS_LABELS] ?? v)
              : v;
    const items = [
      ...events.map((e) => ({
        at: e.at.toISOString(),
        field: e.field,
        fieldLabel: FIELD_LABELS[e.field] ?? e.field,
        from: e.from,
        to: e.to,
        fromLabel: valueLabel(e.field, e.from),
        toLabel: valueLabel(e.field, e.to),
        byAgentId: e.agentId,
        byName: nameOf(e.agentId) ?? "CRM",
      })),
      ...agentChanges.map((a) => {
        const m = metaOf(a.meta);
        return {
          at: a.createdAt.toISOString(),
          field: "assignedAgentId",
          fieldLabel: FIELD_LABELS.assignedAgentId,
          from: m.fromAgentId ?? null,
          to: m.toAgentId ?? null,
          fromLabel: nameOf(m.fromAgentId),
          toLabel: nameOf(m.toAgentId),
          byAgentId: a.agentId,
          byName: nameOf(a.agentId) ?? "CRM",
        };
      }),
    ]
      .sort((x, y) => y.at.localeCompare(x.at))
      .slice(0, limit);
    return res.json({ clientId, items });
  });
});

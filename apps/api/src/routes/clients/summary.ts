import { Router } from "express";
import type { ClientStatus } from "@royal-home/shared";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { can, requireAuth, scopeToOwnAgent } from "../../auth/middleware.js";
import { clientNamePhoneSafe } from "../../lib/clientPhone.js";
import { dushanbeDayRange } from "../../lib/dushanbeTime.js";
import { activeLeadCounts, loadLeadLimits, slotsTaken } from "../../lib/leadLimits.js";
import { RATED_ROLES } from "@royal-home/shared";

/**
 * GET /clients/summary — сводка над списком клиентов для экрана «Клиенты»
 * артефакта «Единый пульт директора» (шаблон tpl-clients): счётчики срезов
 * (Покупатели · Мои · Продавцы · Потерянные · Прочие), четыре плитки (Новые ·
 * Без агента · Без контакта · Показы), строка-предупреждение «X ждёт агента
 * N минут, свободны: …».
 *
 * Один запрос вместо шести списков с pageSize=1: экран открывается часто, а
 * счётчики нужны все сразу. Ничего не выдумывается — те же таблицы и те же
 * границы прав, что у GET /clients:
 *   - агент (scopeToOwnAgent) считает только своих покупателей и продавцов;
 *     «Потерянные», «Прочие» и свободные агенты ему не отдаются (null);
 *   - «Прочие» — только с правом otherInquiries.view, «Потерянные» и свободные
 *     агенты — только с clients.assign (та же граница, что у GET /clients/lost);
 *   - границы суток — по Душанбе (lib/dushanbeTime.ts), не setHours.
 *
 * Все запросы — count/groupBy, без выборки строк; единственная строка —
 * самый давний клиент без принятия (для предупреждения и плитки).
 */

const TERMINAL: Prisma.ClientWhereInput = { status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] } };

export interface ClientsSummary {
  buyers: number;
  sellers: number;
  /** Свои принятые карточки (любого вида) — срез «Мои»; null у ролей без своих клиентов. */
  mine: number | null;
  other: number | null;
  lost: number | null;
  /**
   * СЧЁТЧИКИ ДЛЯ ВКЛАДОК «НЕАКТИВНЫЕ» И «ВСЕ МОИ» (18.09.2026, задание В §f
   * п.1/4, §c разведки 17.09: «у Неактивных счётчика нет»). Своя область —
   * ownAgentId, как и у buyers/sellers; у руководства (ownAgentId пуст) те же
   * границы, что у остального ответа: null не возвращаем — эти счётчики не
   * управленческие, руководителю тоже нужны на своей вкладке «Клиенты».
   */
  inactive: number;
  /** Отложенные, свои (workStatus=DEFERRED) — тот же список, что у /deferred. */
  deferred: number;
  /**
   * Карточки в Корзине, где текущий или последний держатель — «я» (assignedAgentId
   * ИЛИ lastAgentId) — то, что покажет вкладка «Все мои» под фильтром «в Корзине».
   * null у ролей без своих клиентов (руководство и так видит всю Корзину).
   */
  trashedMine: number | null;
  newToday: number;
  newYesterday: number;
  /** Ждут агента: карточка никем не принята (acceptedAt = null), не терминальная. */
  awaitingAgent: {
    count: number;
    oldest: { id: string; shortId: number; fullName: string; kind: string; waitingMinutes: number } | null;
  };
  /** Активные покупатели и продавцы, у которых последний контакт старше суток. */
  noContactOverDay: number;
  showings: { today: number; tomorrow: number };
  /** Агенты с запасом по лимиту активных клиентов — кому можно передать; до трёх. */
  freeAgents: { id: string; fullName: string; slotsLeft: number }[] | null;
  /**
   * Лиды по стадиям воронки (экран «Воронка лидов», docs/agent-briefs/
   * mobile-c99db05f-step4-14-09.md, 14.09.2026) — те же покупатели/продавцы, что
   * и `buyers`+`sellers` выше (`kind IN (BUYER, SELLER)`, та же граница прав
   * `scopeToOwnAgent`), но по `ClientStatus`:
   *   new            — NEW;
   *   inProgress     — CONTACTED + HOT;
   *   awaitingDecision — COLD + UNRESPONSIVE;
   *   closed         — DEAL_CLOSED + LOST.
   * ARCHIVED сюда не входит — воронка не про архив.
   */
  stages: { new: number; inProgress: number; awaitingDecision: number; closed: number };
}

export const summaryRouter = Router();

summaryRouter.get("/summary", requireAuth, async (req, res) => {
  const now = new Date();
  const ownAgentId = scopeToOwnAgent(req);
  const base: Prisma.ClientWhereInput = ownAgentId
    ? { deletedAt: null, assignedAgentId: ownAgentId, kind: { in: ["BUYER", "SELLER"] } }
    : { deletedAt: null };
  const today = dushanbeDayRange(now);
  const yesterday = dushanbeDayRange(new Date(today.start.getTime() - 1));
  const tomorrow = dushanbeDayRange(new Date(today.end.getTime() + 1));
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const canOther = !ownAgentId && can(req, "otherInquiries.view");
  const canAssign = !ownAgentId && can(req, "clients.assign");
  const meId = req.agent?.id;

  /**
   * «Ждут принятия» — ровно то, что покажет срез `pendingAcceptance` списка
   * (routes/clients/list.ts): без эскалированных (их решает руководитель, агенту
   * уже не принять). Раньше они входили в число, и на кнопке было больше, чем
   * строк в списке по ней (24.09.2026, разбор раздачи, пункт 25).
   */
  const awaitingWhere: Prisma.ClientWhereInput = {
    ...base,
    ...TERMINAL,
    acceptedAt: null,
    escalatedAt: null,
    kind: { in: ["BUYER", "SELLER"] },
    workStatus: "ACTIVE",
  };
  const showingWhere = (range: { start: Date; end: Date }): Prisma.InteractionWhereInput => ({
    type: "SHOWING",
    completedAt: null,
    declinedAt: null,
    nextActionDate: { gte: range.start, lte: range.end },
    client: { deletedAt: null },
    ...(ownAgentId ? { agentId: ownAgentId } : {}),
  });

  const [
    buyers,
    sellers,
    mine,
    other,
    lost,
    newToday,
    newYesterday,
    awaitingCount,
    oldest,
    noContactOverDay,
    showToday,
    showTomorrow,
    stageGroups,
    inactive,
    deferred,
    trashedMine,
  ] = await Promise.all([
      prisma.client.count({ where: { ...base, kind: "BUYER" } }),
      prisma.client.count({ where: { ...base, kind: "SELLER" } }),
      /**
       * СОГЛАСОВАНО СО СПИСКОМ (18.09.2026, задание В §f п.4, §c разведки 17.09:
       * «Мои N» расходилось со списком agentId=me»). Раньше здесь стояли
       * acceptedAt≠null и TERMINAL — фильтры, которых нет в самом списке
       * (`GET /clients?agentId=me`, см. MobileClientsList.tsx «Мои»): список
       * показывает АБСОЛЮТНО ВСЁ, что назначено агенту, счётчик считал меньше.
       * Тот же buggy-набор условий, что и `base` для остальных счётчиков этой
       * сводки — просто по meId вместо ownAgentId (сводка доступна и
       * руководству, у которого ownAgentId пуст).
       */
      meId ? prisma.client.count({ where: { deletedAt: null, assignedAgentId: meId } }) : Promise.resolve(null),
      canOther ? prisma.client.count({ where: { deletedAt: null, kind: "OTHER" } }) : Promise.resolve(null),
      canAssign ? prisma.client.count({ where: { deletedAt: null, status: "LOST" } }) : Promise.resolve(null),
      prisma.client.count({ where: { ...base, createdAt: { gte: today.start, lte: today.end } } }),
      prisma.client.count({ where: { ...base, createdAt: { gte: yesterday.start, lte: yesterday.end } } }),
      prisma.client.count({ where: awaitingWhere }),
      prisma.client.findFirst({
        where: awaitingWhere,
        // Ждёт с момента, как лид достался агенту (assignedAt), а не с создания
        // карточки: переданный по кругу лид иначе «ждал» бы дни (24.09.2026,
        // пункт 25). Тот же порядок, что у среза в списке — старые первыми.
        orderBy: { assignedAt: "asc" },
        select: { id: true, shortId: true, fullName: true, kind: true, assignedAt: true },
      }),
      prisma.client.count({ where: { ...base, ...TERMINAL, workStatus: "ACTIVE", kind: { in: ["BUYER", "SELLER"] }, lastContactAt: { lt: dayAgo } } }),
      prisma.interaction.count({ where: showingWhere(today) }),
      prisma.interaction.count({ where: showingWhere(tomorrow) }),
      // groupBy/count, без выборки строк — тот же приём, что у остальных
      // счётчиков этого роута (см. комментарий над роутом).
      prisma.client.groupBy({
        by: ["status"],
        where: { ...base, kind: { in: ["BUYER", "SELLER"] } },
        _count: { _all: true },
      }),
      // «Неактивные»: своя область (ownAgentId), как buyers/sellers — kind не
      // ограничиваем (в отличие от base по умолчанию), карточка INACTIVE может
      // быть и продавцом, и покупателем — вкладка показывает оба вида разом.
      // status не LOST (23.09.2026) — то же условие, что у самого списка
      // (routes/clients/list.ts, workStatus=INACTIVE): потерянный через светофор
      // остаётся workStatus=INACTIVE, и счётчик вкладки расходился бы со списком.
      prisma.client.count({
        where: ownAgentId
          ? { deletedAt: null, assignedAgentId: ownAgentId, workStatus: "INACTIVE", ...TERMINAL }
          : { deletedAt: null, workStatus: "INACTIVE", ...TERMINAL },
      }),
      prisma.client.count({
        where: ownAgentId
          ? { deletedAt: null, assignedAgentId: ownAgentId, workStatus: "DEFERRED", ...TERMINAL }
          : { deletedAt: null, workStatus: "DEFERRED", ...TERMINAL },
      }),
      meId
        ? prisma.client.count({ where: { deletedAt: { not: null }, OR: [{ assignedAgentId: meId }, { lastAgentId: meId }] } })
        : Promise.resolve(null),
    ]);

  const stageCount = (statuses: ClientStatus[]) =>
    stageGroups.filter((g) => statuses.includes(g.status)).reduce((sum, g) => sum + g._count._all, 0);
  const stages: ClientsSummary["stages"] = {
    new: stageCount(["NEW"]),
    inProgress: stageCount(["CONTACTED", "HOT"]),
    awaitingDecision: stageCount(["COLD", "UNRESPONSIVE"]),
    closed: stageCount(["DEAL_CLOSED", "LOST"]),
  };

  let freeAgents: ClientsSummary["freeAgents"] = null;
  if (canAssign) {
    const [limits, agents] = await Promise.all([
      loadLeadLimits(),
      prisma.agent.findMany({
        where: { role: { in: [...RATED_ROLES] }, isActive: true, frozenAt: null },
        select: { id: true, fullName: true },
        orderBy: { fullName: "asc" },
      }),
    ]);
    const loads = await activeLeadCounts(agents.map((a) => a.id));
    freeAgents = agents
      // Свободные места — по занятым СЛОТАМ, тем же счётом, каким лимит
      // проверяется при раздаче: иначе строка «свободны: …» звала бы к агенту,
      // которому раздача лид всё равно не отдаст (или наоборот молчала бы про
      // свободного). Округление вниз — «полместа» местом не считается.
      .map((a) => ({
        id: a.id,
        fullName: a.fullName,
        slotsLeft: Math.floor(limits.activeLimit - slotsTaken(loads.get(a.id), limits)),
      }))
      .filter((a) => a.slotsLeft > 0)
      .sort((a, b) => b.slotsLeft - a.slotsLeft)
      .slice(0, 3);
  }

  const summary: ClientsSummary = {
    buyers,
    sellers,
    mine,
    other,
    lost,
    newToday,
    newYesterday,
    awaitingAgent: {
      count: awaitingCount,
      oldest: oldest
        ? {
            id: oldest.id,
            shortId: oldest.shortId,
            // Имя — тем же правом, что номер (глубокая проверка 02.10.2026, A11): у
            // старых карточек незнакомых звонивших номер лежит в самом имени.
            fullName: clientNamePhoneSafe(oldest.fullName, can(req, "clients.viewPhone")),
            kind: oldest.kind,
            waitingMinutes: Math.max(0, Math.round((now.getTime() - oldest.assignedAt.getTime()) / 60_000)),
          }
        : null,
    },
    noContactOverDay,
    showings: { today: showToday, tomorrow: showTomorrow },
    freeAgents,
    stages,
    inactive,
    deferred,
    trashedMine,
  };
  res.json(summary);
});

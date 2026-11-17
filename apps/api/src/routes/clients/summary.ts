import { investigationViewerRole } from "../../auth/investigations.js";
import { Router } from "express";
import { visibleInteractionWhere } from "../../lib/investigationPrivacy.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { can, requireAuth, scopeToOwnAgent } from "../../auth/middleware.js";
import { CLIENT_IN_WORK_WHERE } from "../../lib/clientInWork.js";
import { noContactWhere } from "../../lib/noContact.js";
import { pendingDeleteHideWhere } from "../../lib/clientSearchWhere.js";
import { clientNamePhoneSafe } from "../../lib/clientPhone.js";
import { dushanbeDayRange } from "../../lib/dushanbeTime.js";

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
  /** «Без контакта» — одно правило на всю CRM (packages/shared/src/clientNoContact.ts):
   *  клиенты в работе, у которых больше суток не было разговора по телефону и
   *  сообщения от самого клиента; новая карточка — от создания. */
  noContactOverDay: number;
  showings: { today: number; tomorrow: number };
}

export const summaryRouter = Router();

summaryRouter.get("/summary", requireAuth, async (req, res) => {
  const now = new Date();
  const ownAgentId = scopeToOwnAgent(req);
  // Карточки с заявкой на удаление список прячет от агента — сводка считает без них
  // (то же условие, что у списка: lib/clientSearchWhere.ts).
  const hideWhere = await pendingDeleteHideWhere({ ownAgentId, canDelete: can(req, "clients.delete") });
  const base: Prisma.ClientWhereInput = {
    ...(ownAgentId
      ? { deletedAt: null, assignedAgentId: ownAgentId, kind: { in: ["BUYER", "SELLER"] } }
      : { deletedAt: null }),
    ...hideWhere,
  };
  const today = dushanbeDayRange(now);
  const yesterday = dushanbeDayRange(new Date(today.start.getTime() - 1));
  const tomorrow = dushanbeDayRange(new Date(today.end.getTime() + 1));
  const canOther = !ownAgentId && can(req, "otherInquiries.view");
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
    ...visibleInteractionWhere(investigationViewerRole(req)),
    type: "SHOWING",
    completedAt: null,
    taskCancelledAt: null,
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
    newToday,
    newYesterday,
    awaitingCount,
    oldest,
    noContactOverDay,
    showToday,
    showTomorrow,
    trashedMine,
  ] = await Promise.all([
      prisma.client.count({ where: { ...base, ...CLIENT_IN_WORK_WHERE, kind: "BUYER" } }),
      prisma.client.count({ where: { ...base, ...CLIENT_IN_WORK_WHERE, kind: "SELLER" } }),
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
      // «Без контакта» — одно правило на всю CRM (lib/noContact.ts, packages/shared/src/clientNoContact.ts).
      prisma.client.count({ where: { AND: [base, noContactWhere(now)] } }),
      prisma.interaction.count({ where: showingWhere(today) }),
      prisma.interaction.count({ where: showingWhere(tomorrow) }),
      meId
        ? prisma.client.count({ where: { deletedAt: { not: null }, OR: [{ assignedAgentId: meId }, { lastAgentId: meId }] } })
        : Promise.resolve(null),
    ]);

  const summary: ClientsSummary = {
    buyers,
    sellers,
    mine,
    other,
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
    trashedMine,
  };
  res.json(summary);
});

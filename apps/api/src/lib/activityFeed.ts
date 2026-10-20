import type { Prisma } from "../generated/prisma/client.js";
import type { InteractionType } from "@royal-home/shared";
import { dushanbeDayRange, dushanbeEndOfDay } from "./dushanbeTime.js";

/**
 * Область выборки раздела «Активность» — ОДНА на ленту и на сводку.
 *
 * ПОЧЕМУ ОБЩАЯ ФУНКЦИЯ, А НЕ ДВА ПОХОЖИХ `where`. Плитки экрана считаются
 * сводкой, список под ними — лентой. Если условия соберут два разных места,
 * они разойдутся на первой же правке (границы суток, новое право, новый
 * фильтр), и человек увидит «звонков 12» над списком из четырнадцати. Ошибка
 * при этом ничего не ломает и ничем не сигналит — просто цифра врёт.
 *
 * ПРАВА. `ownAgentId` приходит из `scopeToOwnAgent(req)`: у кого нет права
 * clients.viewAll, тот жёстко сужается до самого себя, и переданный `agentId`
 * при этом ИГНОРИРУЕТСЯ (иначе `?agentId=<чужой>` выдавал бы заметки коллег).
 * Сводка обязана уважать ровно то же сужение: агрегат так же легко выдаёт
 * чужие числа, как список — чужие строки, только незаметнее.
 */
export interface ActivityScope {
  /** Не пусто — сотрудник видит только свои события (нет права clients.viewAll). */
  ownAgentId?: string;
  /** Фильтр руководителя по сотруднику. Действует только когда ownAgentId пуст. */
  agentId?: string;
  from?: Date;
  to?: Date;
  /** Фильтр по типу действия (шторка фильтров экрана «Активность»). Нет = все типы. */
  type?: InteractionType;
}

/**
 * Границы периода, выровненные по календарным суткам ДУШАНБЕ.
 *
 * Контейнер живёт в UTC, а Душанбе — UTC+5 круглый год. Сырая «2026-08-01»
 * разбирается как полночь UTC, то есть 05:00 по Душанбе: события первых пяти
 * часов суток выпадали из выборки, а `to` без сдвига обрезал весь последний
 * день. `setHours` здесь запрещён — он берёт пояс процесса; тот же приём, что в
 * routes/calendar.ts и routes/reports.ts.
 *
 * Выравнивается и `from`, хотя экран шлёт его мгновением («минус 30 дней от
 * сейчас»): период «за 30 дней» должен начинаться в полночь, а не в тот час,
 * когда человек открыл страницу, — иначе одно и то же число к вечеру уезжает.
 */
export function activityPeriodBounds(from?: Date, to?: Date): { start?: Date; end?: Date } {
  return {
    start: from ? dushanbeDayRange(from).start : undefined,
    end: to ? dushanbeEndOfDay(to) : undefined,
  };
}

export function activityWhere(scope: ActivityScope): Prisma.InteractionWhereInput {
  const where: Prisma.InteractionWhereInput = {};
  if (scope.ownAgentId) where.agentId = scope.ownAgentId;
  else if (scope.agentId) where.agentId = scope.agentId;
  if (scope.type) where.type = scope.type;

  const { start, end } = activityPeriodBounds(scope.from, scope.to);
  if (start || end) {
    where.createdAt = {};
    if (start) where.createdAt.gte = start;
    if (end) where.createdAt.lte = end;
  }
  return where;
}

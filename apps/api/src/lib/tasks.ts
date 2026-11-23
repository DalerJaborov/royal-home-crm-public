import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";

/**
 * Что считается задачей команды.
 *
 * Задача живёт внутри записи взаимодействия: `nextAction` — что сделать,
 * `nextActionDate` — когда. Отдельной модели задач в CRM нет.
 *
 * Клиент в корзине (`deletedAt`) задач за собой не оставляет. Без этого условия
 * удалённый клиент продолжал жить в системе призраком: его задачи попадали в
 * счётчик утренней сводки директору, в календарь, в вечернюю рассылку агентам,
 * а в KPI портили агенту метрику дисциплины — за просрочку по клиенту, которого
 * в CRM уже нет и связаться с которым невозможно. Фильтр стоял ровно в одном
 * месте из шести (виджет дашборда), поэтому одни и те же задачи в разных
 * экранах считались по-разному.
 *
 * Один источник правды: любое новое место, где считаются задачи, разворачивает
 * этот объект и добавляет свои условия.
 */
export const TASK_WHERE = {
  nextAction: { not: null },
  taskCancelledAt: null,
  client: { deletedAt: null },
  // Preserve completed history; an unfinished task cannot burden a closed assignment.
  NOT: { completedAt: null, client: { assignmentCompletedAt: { not: null } } },
} satisfies Prisma.InteractionWhereInput;

/**
 * Просроченная задача: срок прошёл, выполненной не отмечена. Одно условие на
 * «Контроль руководителя» (routes/oversight.ts), карточку сотрудника
 * (routes/team.ts) и помощницу Шабнам (get_unworked, get_day_snapshot) —
 * до 17.11.2026 жило в маршруте oversight.ts и импортировалось оттуда.
 */
export function overdueTasksWhere(now: Date): Prisma.InteractionWhereInput {
  return { ...TASK_WHERE, completedAt: null, nextActionDate: { lt: now } };
}

/**
 * ПРОСРОЧЕННЫЕ ЗАДАЧИ СОТРУДНИКОВ — ОДНО ПРАВИЛО НА КАРТОЧКУ СОТРУДНИКА И ГЛАВНУЮ
 * РУКОВОДИТЕЛЯ (20.11.2026). Задача «его», если он её исполнитель (`agentId`) ИЛИ её
 * записал бот/система от лица держателя карточки (`subjectAgentId`, П-10 17.09.2026).
 * `scope` — дополнительное условие видимости (visibleInteractionWhere), складывается
 * через AND, а не разворотом: у обоих условий может быть свой OR.
 */
export function overdueTasksOfAgentsWhere(now: Date, agentIds: readonly string[], scope?: Prisma.InteractionWhereInput): Prisma.InteractionWhereInput {
  const ids = [...agentIds];
  return {
    AND: [
      overdueTasksWhere(now),
      { OR: [{ agentId: { in: ids } }, { subjectAgentId: { in: ids } }] },
      ...(scope ? [scope] : []),
    ],
  };
}

/** Потолок строк для счёта по агентам: просроченных задач у агентства сотни; это защита от аварии. */
export const OVERDUE_BY_AGENT_CAP = 20_000;

/**
 * Сколько просроченных задач у каждого из агентов — тем же правилом, что
 * `overdueTasksOfAgentsWhere`: задача, где агент и исполнитель, и «от лица», считается
 * ему один раз; задача исполнителя A от лица B — и A, и B (как в карточке каждого).
 */
export async function countOverdueTasksByAgent(now: Date, agentIds: readonly string[], scope?: Prisma.InteractionWhereInput): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (agentIds.length === 0) return out;
  const wanted = new Set(agentIds);
  const rows = await prisma.interaction.findMany({
    where: overdueTasksOfAgentsWhere(now, agentIds, scope),
    select: { agentId: true, subjectAgentId: true },
    orderBy: { id: "asc" },
    take: OVERDUE_BY_AGENT_CAP,
  });
  for (const row of rows) {
    const owners = new Set([row.agentId, row.subjectAgentId].filter((id): id is string => !!id && wanted.has(id)));
    for (const id of owners) out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/**
 * Показ, который засчитывается в цифры: любой, кроме отменённого.
 *
 * Отдельной колонки «отменён» в схеме нет, и заводить её не за чем: отмена уже
 * описана двумя полями сразу (см. lib/showingBooking.ts, applyCancellation) —
 * снят `nextAction` (встреча ушла из календаря и напоминаний) и проставлен
 * `declinedAt` (показ не состоится). Порознь ни одно из них отмену не означает:
 *  - `nextAction: null` без declinedAt — обычная историческая запись показа,
 *    заведённая до появления задач или закрытая иначе;
 *  - `declinedAt` при живом nextAction — клиент сказал «не смогу», но встречу
 *    никто не снимал: решение за агентом, и показ вполне может состояться.
 *
 * Именно поэтому предикат составной, а не «declinedAt is null»: показы,
 * проведённые до появления отмены, отменёнными не помечены и обязаны считаться
 * дальше — иначе месячные и годовые цифры поменялись бы задним числом.
 *
 * Разворачивается в where рядом с `type: "SHOWING"` везде, где показы считают:
 * отчёты, месячный отчёт, доска почёта, дашборд, сводка по команде.
 */
export const COUNTED_SHOWING_WHERE = {
  taskCancelledAt: null,
  NOT: { nextAction: null, declinedAt: { not: null } },
} satisfies Prisma.InteractionWhereInput;

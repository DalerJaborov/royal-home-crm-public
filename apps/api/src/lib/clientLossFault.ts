/**
 * Классификация «по вине агента» для событий Royal Score `client_lost_agent_fault` /
 * `client_lost_no_fault` (docs/spec-compliance-03-08-2026.md, Этап 1, п. «Признак
 * «по вине агента» у причин закрытия»).
 *
 * РЕШЕНИЕ: не гадать по причине отказа (REFUSAL_REASONS/REFUSAL_INITIATORS) —
 * владелец явно не давал такой карты, а угадывать по спорному штрафу −5 нельзя.
 * Вместо этого — АВТОМАТИЧЕСКАЯ проверка по факту на момент потери клиента: если
 * по клиенту просрочена задача или встреча (Interaction.nextActionDate в прошлом
 * и не закрыта) — это объективный след того, что агент НЕ выполнил свою часть
 * работы вовремя. Ничего просроченного — клиента отпустили по объективной причине
 * (передумал, купил в другом месте, банк отказал), это не вина агента.
 *
 * ВТОРЫМ ПРИЗНАКОМ БЫЛО ПРОСРОЧЕННОЕ ОБЯЗАТЕЛЬНОЕ ОКНО. Механизм окон удалён
 * 13.09.2026 (владелец: «вообще убери»), и признак ушёл вместе с ним. Проверка
 * стала строже: раньше «виноват» ставили и за неотвеченное окно, теперь — только
 * за просроченную задачу. Держать первый признак было нельзя: окон больше никто
 * не заводит, и по ним все подряд оказывались невиновны.
 *
 * Ручное переопределение см. routes/royalScoreEvents.ts (право
 * `score.clientLossOverride`, директор и админ — с 14.09.2026 обычная
 * ASSIGNABLE-галочка, не владельческая) — для случаев, когда автоматика
 * ошиблась (просрочка была, но клиент всё равно ушёл по объективной причине, и
 * наоборот).
 */

import { prisma, type TxClient } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";

// Cancellation stops future deadlines; it does not erase an already missed one.
function overdueAtActiveDeadline(now: Date): Prisma.InteractionWhereInput {
  return {
    completedAt: null,
    nextActionDate: { lte: now, not: null },
    OR: [
      { taskCancelledAt: null },
      { nextActionDate: { lte: prisma.interaction.fields.taskCancelledAt } },
    ],
  };
}

export async function classifyClientLossFault(
  clientId: string,
  now: Date = new Date(),
  tx?: TxClient,
): Promise<"client_lost_agent_fault" | "client_lost_no_fault"> {
  /**
   * Просроченные обязательные окна из этой проверки ушли 13.09.2026 вместе с
   * самим механизмом. Осталась вторая половина того же вопроса и, по сути,
   * единственная честная: висит ли по клиенту просроченная задача агента.
   *
   * Это СУЖЕНИЕ, и о нём стоит знать: «виноват агент» теперь ставится строже.
   * Но альтернатива хуже — судить по окнам, которых больше никто не заводит,
   * значит навсегда выносить «не виноват» всем подряд.
   */
  const overdueTask = await (tx ?? prisma).interaction.findFirst({
    where: {
      clientId,
      ...overdueAtActiveDeadline(now),
    },
    select: { id: true },
  });
  return overdueTask ? "client_lost_agent_fault" : "client_lost_no_fault";
}

/**
 * То же самое сразу для страницы клиентов — одним запросом вместо запроса на
 * каждого.
 *
 * Кабинет СБ звал classifyClientLossFault внутри Promise.all по строкам страницы:
 * сорок клиентов превращались в сорок параллельных запросов к базе на одно
 * открытие раздела. Условие классификации то же самое — изменился только способ
 * спросить: один запрос про просроченные задачи, дальше группировка в памяти.
 *
 * Поштучная версия остаётся: её зовут routes/clients.ts и lib/scoreTransfer.ts для
 * одного клиента, и городить там батч не из чего.
 */
export async function classifyClientLossFaultBatch(
  clientIds: string[],
  now: Date = new Date()
): Promise<Map<string, "client_lost_agent_fault" | "client_lost_no_fault">> {
  const result = new Map<string, "client_lost_agent_fault" | "client_lost_no_fault">();
  if (clientIds.length === 0) return result;

  // Одним запросом на всю страницу: сорок клиентов в кабинете СБ иначе
  // превращались в сорок отдельных запросов на одно открытие раздела.
  const tasks = await prisma.interaction.findMany({
    where: {
      clientId: { in: clientIds },
      ...overdueAtActiveDeadline(now),
    },
    select: { clientId: true },
  });

  const guilty = new Set<string>(tasks.map((t) => t.clientId));
  for (const id of clientIds) {
    result.set(id, guilty.has(id) ? "client_lost_agent_fault" : "client_lost_no_fault");
  }
  return result;
}

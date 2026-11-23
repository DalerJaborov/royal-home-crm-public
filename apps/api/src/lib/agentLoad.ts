import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { TERMINAL_CLIENT_STATUSES } from "./clientContact.js";
import { TALKED_CALL_WHERE } from "./noContact.js";

/**
 * СКОЛЬКО ПОКУПАТЕЛЕЙ У АГЕНТА В РАБОТЕ — счётчик нагрузки, НЕ лимит.
 *
 * До 16.11.2026 здесь был lib/leadLimits.ts: предел активных лидов
 * (Settings.leadActiveLimit), взвешенные слоты и отсев агентов «на лимите» при
 * раздаче. Владелец 16.11.2026: «лимитов заявок больше нет и не будет» —
 * раздача больше ничего не отсекает по числу клиентов. Число осталось только
 * как НАГРУЗКА: справедливая очередь (стратегия fair) отдаёт лид тому, у кого
 * меньше покупателей, а экраны команды показывают «в работе: N».
 *
 * Продавец нагрузкой не считается (владелец 20.08.2026): он — работа по одному
 * объекту и не соревнуется с покупателями за время агента.
 */
export const BUYERS_IN_WORK_WHERE = {
  assignmentCompletedAt: null,
  kind: "BUYER" as const,
  status: { notIn: [...TERMINAL_CLIENT_STATUSES] },
};

/** За сколько дней клиент считается живой нагрузкой агента. */
export const ACTIVE_LOAD_DAYS = 30;

/**
 * ЖИВАЯ НАГРУЗКА — ПО ЧЕМУ ЧЕСТНАЯ РАЗДАЧА ВЫБИРАЕТ АГЕНТА (16.11.2026).
 *
 * После снятия «Неактивных», «Отложенных» и «Потерянных» все старые покупатели
 * вернулись в «в работе». Если считать нагрузку по ним, у опытного агента сотня
 * давно молчащих карточек, у новичка ноль — и новичок получал бы КАЖДУЮ заявку.
 * Поэтому нагрузка = покупатели в работе, с которыми за последние
 * {@link ACTIVE_LOAD_DAYS} дней был настоящий контакт (разговор по телефону —
 * TALKED_CALL_WHERE из lib/noContact.ts — или сообщение самого клиента), или по которым идёт сделка, или которые достались агенту за
 * эти же дни (свежая заявка — уже работа, даже до первого звонка).
 */
export function activeBuyersLoadWhere(now = new Date()): Prisma.ClientWhereInput {
  const since = new Date(now.getTime() - ACTIVE_LOAD_DAYS * 24 * 3600_000);
  return {
    AND: [
      { deletedAt: null, ...BUYERS_IN_WORK_WHERE },
      {
        OR: [
          { lastClientMessageAt: { gte: since } },
          { interactions: { some: { ...TALKED_CALL_WHERE, createdAt: { gte: since } } } },
          { deals: { some: { stage: { notIn: ["COMPLETED", "CANCELLED"] } } } },
          { assignedAt: { gte: since } },
        ],
      },
    ],
  };
}

export interface AgentLoad {
  /** Все покупатели в работе. */
  total: number;
  /** Из них — по СВОЕМУ объекту агента (ownPropertyLead). */
  own: number;
}

export const NO_LOAD: AgentLoad = { total: 0, own: 0 };

/** Нагрузка по каждому агенту одним запросом (groupBy), без N+1. */
export async function agentLoadCounts(agentIds: string[]): Promise<Map<string, AgentLoad>> {
  const result = new Map<string, AgentLoad>();
  if (agentIds.length === 0) return result;
  for (const id of agentIds) result.set(id, { total: 0, own: 0 });
  const rows = await prisma.client.groupBy({
    by: ["assignedAgentId", "ownPropertyLead"],
    where: { assignedAgentId: { in: agentIds }, deletedAt: null, ...BUYERS_IN_WORK_WHERE },
    _count: { _all: true },
  });
  for (const row of rows) {
    const load = row.assignedAgentId ? result.get(row.assignedAgentId) : undefined;
    if (!load) continue;
    load.total += row._count._all;
    if (row.ownPropertyLead) load.own += row._count._all;
  }
  return result;
}

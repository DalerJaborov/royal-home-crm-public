import { prisma } from "../db.js";
import { TERMINAL_CLIENT_STATUSES } from "./clientContact.js";

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

import { prisma } from "../db.js";
import { changeClientAgent, type Tx } from "./changeClientAgent.js";
import { logSystemError } from "./systemError.js";

/**
 * НЕПРИНЯТЫЕ ЛИДЫ СОТРУДНИКА, КОТОРЫЙ К НИМ НЕ ПОДОЙДЁТ, — ОБРАТНО В ОЧЕРЕДЬ.
 *
 * Одно правило для заморозки (routes/agents.ts, POST /:id/freeze), паузы
 * приёма лидов (lib/agentLeadPause.ts, 24.09.2026) и
 * отключения учётки (PATCH /:id с isActive=false, 23.09.2026, проверка
 * раздачи, пункт 16). До 23.09 отключение не делало этого вовсе: лиды
 * оставались на учётке, в которую никто не войдёт, и круг «не принял»
 * штрафовал её каждые 15 минут, пока лид не уходил дальше.
 *
 * Освобождаются ТОЛЬКО непринятые лиды в рабочем статусе (не LOST/DEAL_CLOSED/ARCHIVED).
 * Клиента, с которым человек
 * уже работает, этим путём не вырывают: для него есть «Передача дел»
 * (lib/agentHandover.ts), и это решение руководителя, а не побочный эффект.
 *
 * Потолок (22.09.2026, класс «Пагинация»): непринятых лидов у одного агента
 * держит lib/leadLimits.ts — реалистично десятки, не сотни. Предел с запасом,
 * а не рабочий лимит: если задет, освобождаем первых, аномалия — в журнал.
 */
const RELEASE_CAP = 1000;

export type ReleasableLead = { id: string; shortId: number; fullName: string };

/**
 * keepOwnProperty — не трогать лиды по СВОЕМУ объекту агента (ownPropertyLead).
 * Нужен паузе приёма лидов (lib/agentLeadPause.ts) и заморозке (routes/agents.ts,
 * с 10.10.2026, аудит P0-5): правило «свой объект» паузу и заморозку переживает
 * (services/leads/assignment.ts, ownPropertyAgentStatuses — «отпуск не отменяет
 * владение»), и снимать такой лид значило бы противоречить самому себе. Отключение
 * учётки снимает всё: человека нет. Снятый лид объект не теряет — matchedPropertyId
 * остаётся, и утренняя волна передаёт его в раздачу (reassignment.ts, assignPendingLeads).
 */
export async function findUnacceptedLeadsOfAgent(
  agentId: string,
  why: string,
  opts: { keepOwnProperty?: boolean } = {}
): Promise<ReleasableLead[]> {
  const leads = await prisma.client.findMany({
    where: {
      assignedAgentId: agentId,
      acceptedAt: null,
      deletedAt: null,
      // ЛЮБОЙ рабочий статус, а не только NEW/CONTACTED (№143 ночной проверки
      // 24.09): непринятым бывает и HOT/COLD/UNRESPONSIVE — отказной, переданный
      // руководителем, розданный из портфеля. Раньше такой лид оставался на
      // замороженном/отключённом с висящим пушем «Новый лид». Правило
      // «продавец не уходит никогда» — о ПРИНЯТЫХ (acceptedAt выше). Закрытые
      // карточки в очередь не возвращаем: работать там нечего.
      status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] },
      ...(opts.keepOwnProperty ? { ownPropertyLead: false } : {}),
    },
    select: { id: true, shortId: true, fullName: true },
    take: RELEASE_CAP,
  });
  if (leads.length >= RELEASE_CAP) {
    void logSystemError("api", `${why} агента ${agentId}: непринятых лидов больше ${RELEASE_CAP} — освобождены только первые`);
  }
  return leads;
}

/**
 * Снять каждый лид с агента через changeClientAgent (единственная точка записи
 * владельца: Interaction и AuditLog на каждую карточку). assignedAt не
 * трогаем: колонка не обнуляемая, а очередь смотрит на assignedAgentId.
 *
 * ЗАПИСЬ ТОЛЬКО С УСЛОВИЕМ НА ПРЕЖНЕГО ВЛАДЕЛЬЦА (аудит 04.10.2026, CRM-03).
 * Список лидов читается ДО транзакции, и за это время лид мог быть принят
 * агентом (acceptedAt) или передан другому: без условия в WHERE снятие уносило
 * бы такого клиента в очередь. Закон о владении: владелец не меняется молча.
 * Проигравшую гонку карточку пропускаем (не бросаем: транзакция заморозки
 * откатила бы остальных), возвращаем только реально снятых.
 */
export async function releaseLeadsToQueue(
  tx: Tx,
  leads: ReleasableLead[],
  opts: { agentId: string; actorId: string; actorName: string; reason: string; source: string }
): Promise<ReleasableLead[]> {
  const released: ReleasableLead[] = [];
  for (const c of leads) {
    const changed = await changeClientAgent({
      clientId: c.id,
      toAgentId: null,
      reason: opts.reason,
      actorId: opts.actorId,
      actorName: opts.actorName,
      source: opts.source,
      data: { escalatedAt: null },
      guardWhere: { assignedAgentId: opts.agentId, acceptedAt: null, status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] } },
      tx,
    });
    if (changed.ok) released.push(c);
  }
  return released;
}

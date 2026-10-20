import { prisma } from "../db.js";
import { SALES_AGENT_ROLES } from "@royal-home/shared";

/**
 * КОМУ МОЖНО НАЗНАЧИТЬ КЛИЕНТА ВРУЧНУЮ (B13 глубокой проверки 02.10.2026,
 * решение владельца «да, по советам»).
 *
 * Руководитель выбирает человека в списке — и раньше сервер не проверял, кто
 * это: клиент мог уйти отключённому или замороженному сотруднику (отпуск,
 * больничный) и висеть у того, кто его не увидит. Теперь:
 *  - отключённому или замороженному — НЕЛЬЗЯ, с понятной причиной;
 *  - сотруднику не в роли агента (директор, менеджер…) — МОЖНО: владелец иногда
 *    сам ведёт клиентов. Экран предупреждает об этом до нажатия, а сервер
 *    возвращает `notAgent`, чтобы вызывающий мог сказать это в ответе.
 *
 * Одна проверка на все ручные пути: создание клиента на сотрудника
 * (POST /clients), назначение и переназначение (POST /clients/:id/assign),
 * «Передача дел» конкретному получателю (POST /agents/:id/handover).
 */
export type ManualAssignTargetCheck =
  | { ok: true; agent: { id: string; fullName: string; role: string }; notAgent: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string };

export async function checkManualAssignTarget(agentId: string): Promise<ManualAssignTargetCheck> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, fullName: true, role: true, isActive: true, frozenAt: true },
  });
  if (!agent) return { ok: false, status: 404, error: "Сотрудник не найден — выберите другого" };
  if (!agent.isActive) {
    return {
      ok: false,
      status: 409,
      error: `${agent.fullName} отключён(а) — назначить ему клиента нельзя. Выберите другого сотрудника.`,
    };
  }
  if (agent.frozenAt) {
    return {
      ok: false,
      status: 409,
      error: `${agent.fullName} сейчас заморожен(а) (отпуск, больничный) — назначить ему клиента нельзя, пока заморозку не снимут. Выберите другого сотрудника.`,
    };
  }
  return { ok: true, agent: { id: agent.id, fullName: agent.fullName, role: agent.role }, notAgent: !(SALES_AGENT_ROLES as readonly string[]).includes(agent.role) };
}

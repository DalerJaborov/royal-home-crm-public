import { SALES_AGENT_ROLES } from "@royal-home/shared";
import { prisma } from "../db.js";

/**
 * Годится ли этот id в `intakeAgentId`/`assignedAgentId` объекта — дыра 11.09.2026
 * (Пачка 1 п.9): сервер проверял только право ПРИСЛАТЬ это поле (properties.editForeign
 * для чужого, самого себя — рядовой агент), но не то, что id вообще указывает на
 * живого действующего сотрудника с ролью «Агент». PATCH с id уволенного, гостя из
 * другой роли или вовсе несуществующей строкой раньше сохранялся как есть, и
 * карточка объекта показывала ответственным человека, который не может им быть.
 *
 * Возвращает текст ошибки или `null`, если id годится.
 */
export async function assignableAgentError(agentId: string): Promise<string | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { role: true, isActive: true, frozenAt: true },
  });
  if (!agent) return "Сотрудник не найден";
  if (!(SALES_AGENT_ROLES as readonly string[]).includes(agent.role)) return "Указанный сотрудник не может вести объекты (не агент)";
  if (!agent.isActive) return "Сотрудник уволен или деактивирован";
  if (agent.frozenAt) return "Сотрудник заморожен — назначьте другого";
  return null;
}

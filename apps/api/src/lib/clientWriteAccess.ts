import { assignmentWriteDenied } from "./assignmentCompletion.js";

/**
 * ПРАВИЛО «ПИСАТЬ В ЧУЖУЮ КАРТОЧКУ КЛИЕНТА» — ОДНО НА REST И НА ИИ-ПОМОЩНИКА
 * (31.10.2026, docs/design/internal-assistant-architecture-2026-10-31.md §1.2 №1).
 *
 * Разбор и причины — в шапке `foreignWriteDenied` (routes/clients/shared.ts):
 * «видеть все» (`clients.viewAll`) не значит «писать во все», чужую карточку
 * меняет тот, кто распределяет лидов (`clients.assign`), либо закреплённый агент.
 *
 * Правило жило только внутри `foreignWriteDenied(req, …)` — функции от Express-
 * запроса, — и помощник, у которого запроса нет, держал СВОЮ проверку: «агента
 * пускаем к своим, всех с `viewAll` — ко всем». Служба безопасности (`viewAll`
 * без `assign`) через помощника заводила задачи и двигала встречи в чужих
 * карточках, хотя экран ей это запрещал. Теперь правило — чистая функция от
 * «кто пишет», и обе стороны зовут её: REST через `foreignWriteDenied`, помощник
 * через `assertClientWritable` (ai/assistant/actor.ts).
 *
 * Возвращает текст отказа или null, если писать можно. Рядового агента
 * (`ownAgentId` задан) ограничивает проверка владения у вызывающего — как в REST.
 */
export interface ClientWriteSubject {
  id: string;
  role: string;
  /** Право `clients.assign`. */
  canAssignClients: boolean;
}

export const FOREIGN_CLIENT_WRITE_MESSAGE = "Чужую карточку клиента ведёт закреплённый агент или руководитель";

export function clientWriteDenied(
  subject: ClientWriteSubject,
  client: { assignedAgentId: string | null; assignmentCompletedAt?: Date | null },
  ownAgentId: string | undefined,
): string | null {
  const completed = assignmentWriteDenied(client, subject.role);
  if (completed) return completed;
  if (ownAgentId) return null;
  if (subject.canAssignClients) return null;
  if (client.assignedAgentId === subject.id) return null;
  return FOREIGN_CLIENT_WRITE_MESSAGE;
}

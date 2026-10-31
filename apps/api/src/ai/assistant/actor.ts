import { isReadOnlyRole, type PermissionId } from "@royal-home/shared";
import { READ_ONLY_ROLE_RESPONSE, type AgentAccess } from "../../auth/middleware.js";
import { clientWriteDenied } from "../../lib/clientWriteAccess.js";

/**
 * «КТО СПРАШИВАЕТ» У ИИ-ПОМОЩНИКА — ОДНИМ РАЗБОРОМ ПРАВ НА ВСЮ CRM (31.10.2026,
 * пачка П2 задача 2.1, docs/design/internal-assistant-architecture-2026-10-31.md
 * §1.2 №1, §2.1).
 *
 * Помощник ходит в базу под правами вызвавшего — иначе он становится обходным
 * путём вокруг ограничений интерфейса. Раньше актор собирался руками в роуте
 * (routes/ai.ts) по пять флагов, и каждый новый флаг надо было не забыть и там, и
 * в будущем входе из Telegram. Теперь его строит одна функция `actorFromAccess` из
 * того же `AgentAccess`, что у `requireAuth` (auth/middleware.ts, loadAgentAccess):
 * роут отдаёт `req.agent`, вход из Telegram — `loadAgentAccess(agentId)`.
 */
export interface AssistantActor {
  id: string;
  role: string;
  /** clients.viewAll — видеть чужих клиентов. НЕ даёт права писать в них (см. canAssignClients). */
  canViewAllClients: boolean;
  /**
   * Право видеть телефон клиента целиком (clients.viewPhone) — правило всей CRM
   * (presentClient в routes/clients, lib/clientPhone.ts). Раньше помощник маскировал
   * номер по своему признаку, и сотрудник с «видеть всех», но без права на телефон
   * получал у него полные номера всей базы.
   */
  canViewPhone: boolean;
  /** reports.view — раздел «Отчёты и источники лидов» (reportsRouter). */
  canViewReports: boolean;
  /** finance.view — «Финансы» (доходы/расходы/комиссии). */
  canViewFinance: boolean;
  /**
   * deals.viewAll — видеть ЧУЖИЕ сделки, отдельное от clients.viewAll право (как
   * scopeDealsToOwnAgent в REST): сочетание «видит всех клиентов, но не чужие
   * сделки» достижимо, и скоуп сделок по клиентам был бы обходом раздела «Сделки».
   */
  canViewAllDeals: boolean;
  /**
   * clients.assign — писать в ЧУЖУЮ карточку клиента (задачи, переносы). Без него
   * «видеть всех» остаётся только видеть: служба безопасности (viewAll без assign)
   * заводила через помощника задачи в чужих карточках, хотя REST ей это запрещал
   * (foreignWriteDenied). Проверка — assertClientWritable ниже.
   */
  canAssignClients: boolean;
  /** properties.editForeign — правка чужих карточек объектов (canAccessAssignedProperty). */
  canEditForeignProperties: boolean;
  /** properties.moderate — одобрять фото/видео объекта. */
  canModerate: boolean;
  /** properties.requestChange — просить изменить опубликованный объект. */
  canRequestChange: boolean;
  /**
   * Полный набор прав — по нему строится раздел промта «куда можно отправить»
   * (ai/assistant/promptSections.ts). Необязателен, потому что актора собирают и
   * руками (тесты, прямые вызовы runAssistant): без набора называются только
   * разделы без отдельного права и те, что видны по флагам выше, — осторожно, а
   * не щедро.
   */
  permissions?: ReadonlySet<PermissionId>;
}

/** Актор помощника из прав сотрудника — тех же, что проверяет requireAuth. */
export function actorFromAccess(agentId: string, access: Pick<AgentAccess, "role" | "permissions">): AssistantActor {
  const has = (permission: PermissionId) => access.permissions.has(permission);
  return {
    id: agentId,
    role: access.role,
    canViewAllClients: has("clients.viewAll"),
    canViewPhone: has("clients.viewPhone"),
    canViewReports: has("reports.view"),
    canViewFinance: has("finance.view"),
    canViewAllDeals: has("deals.viewAll"),
    canAssignClients: has("clients.assign"),
    canEditForeignProperties: has("properties.editForeign"),
    canModerate: has("properties.moderate"),
    canRequestChange: has("properties.requestChange"),
    permissions: access.permissions,
  };
}

export const FOREIGN_CLIENT_SCOPE_MESSAGE = "Нет доступа: клиент закреплён за другим агентом";
export const UNACCEPTED_LEAD_MESSAGE = "Сначала примите лид — до принятия карточка закрыта";

/**
 * МОЖНО ЛИ ПОМОЩНИКУ ПИСАТЬ В ЭТУ КАРТОЧКУ ОТ ИМЕНИ АКТОРА — ровно то, что
 * отвечает REST на запись в карточку (POST /clients/:id/interactions):
 *  - акционер только смотрит (requireAuth, READ_ONLY_ROLE_RESPONSE);
 *  - рядовой агент (без clients.viewAll) пишет только в своих и только принятых;
 *  - остальным — foreignWriteDenied, через общее clientWriteDenied
 *    (lib/clientWriteAccess.ts): завершённое назначение, затем clients.assign или
 *    своя карточка.
 * Возвращает текст отказа или null.
 */
export function assertClientWritable(
  actor: AssistantActor,
  client: { assignedAgentId: string | null; acceptedAt: Date | null; assignmentCompletedAt?: Date | null },
): string | null {
  if (isReadOnlyRole(actor.role)) return READ_ONLY_ROLE_RESPONSE.error;
  const ownScope = actor.canViewAllClients ? undefined : actor.id;
  if (ownScope && client.assignedAgentId !== ownScope) return FOREIGN_CLIENT_SCOPE_MESSAGE;
  if (ownScope && client.acceptedAt === null) return UNACCEPTED_LEAD_MESSAGE;
  return clientWriteDenied(
    { id: actor.id, role: actor.role, canAssignClients: actor.canAssignClients },
    client,
    ownScope,
  );
}

/**
 * Инструмент, недоступный актору, модели НЕ ОБЪЯВЛЯЕТСЯ (задача 2.5): она не
 * предлагает того, чего человек сделать не может, и не тратит раунд на заведомый
 * отказ. Запрет внутри runTool остаётся — это защита, а это подсказка модели.
 * Инструмента нет в таблице — он доступен всем (скоуп «своё» стоит внутри него).
 */
const TOOL_GATES: Readonly<Record<string, (actor: AssistantActor) => boolean>> = {
  get_finance_summary: (actor) => actor.canViewFinance,
  get_lead_sources: (actor) => actor.canViewReports,
  create_task: (actor) => !isReadOnlyRole(actor.role),
  reschedule_task: (actor) => !isReadOnlyRole(actor.role),
};

export function assistantToolAllowed(actor: AssistantActor, toolName: string): boolean {
  const gate = TOOL_GATES[toolName];
  return gate ? gate(actor) : true;
}

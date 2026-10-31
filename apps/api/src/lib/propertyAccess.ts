import { PROPERTY_PUBLISHED_ACTION_DENIED_MESSAGE, propertyEditLocked, type PermissionId } from "@royal-home/shared";

/**
 * КТО МОЖЕТ УПРАВЛЯТЬ ОБЪЕКТОМ — ОДНО ПРАВИЛО НА REST И НА ИИ-ПОМОЩНИКА
 * (31.10.2026, П3 «prop»). Раньше проверка жила в `routes/properties/shared.ts`
 * и принимала Express-запрос; помощнику запроса не от кого брать, и он писал бы
 * свою копию условия. Теперь тело здесь, а `canManageProperty(req, …)` лишь
 * достаёт из запроса сотрудника и его права.
 *
 * Руководитель (право `properties.editForeign`) — любым объектом; агент — своим
 * (ведущий, приёмщик или создатель карточки).
 */
export interface PropertyAccessActor {
  agentId: string;
  can: (permission: PermissionId) => boolean;
}

export function canManagePropertyAs(
  actor: PropertyAccessActor,
  property: { assignedAgentId?: string | null; intakeAgentId?: string | null; createdById?: string | null }
): boolean {
  if (actor.can("properties.editForeign")) return true;
  return [property.assignedAgentId, property.intakeAgentId, property.createdById].includes(actor.agentId);
}

/**
 * КНОПКИ ВИДЕО-ИСПРАВЛЕНИЙ ПОСЛЕ ПУБЛИКАЦИИ — только руководству (07.10.2026).
 * «Вернуть монтажёру», «Снова на монтаж» и соседи трогают то, что уже видно
 * подписчикам; агенту-владельцу они не доступны, он просит заявкой. Те же
 * критерии, что у замка правки (право properties.editForeign). Текст отказа 403
 * или null (можно). `publishedActionDeniedReason(req, …)` в routes/properties/
 * shared.ts — тонкая обёртка над этой функцией.
 */
export function publishedActionDeniedReasonAs(
  actor: PropertyAccessActor,
  property: { status: string; offSite?: boolean | null }
): string | null {
  return propertyEditLocked(property, actor.can("properties.editForeign")) ? PROPERTY_PUBLISHED_ACTION_DENIED_MESSAGE : null;
}

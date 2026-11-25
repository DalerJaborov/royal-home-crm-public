import { canManagePropertyAs, type PropertyAccessActor } from "../propertyAccess.js";

/**
 * КТО МЕНЯЕТ СВЯЗЬ ОБЪЕКТА С РЕЕСТРОМ СТРОЕК (ревью PR #441, 26.11.2026). Одно правило на все пути: карточка
 * (routes/constructionRegistry.ts), поле в мастере и форме правки (applyRegistryChoice из создания и PATCH) и Шабнам
 * (link_property_to_registry). Раньше карточка и Шабнам пускали только «хозяина» объекта (propertyOwnerAgentId), а форма
 * правки — ведущего, приёмщика и создателя: ведущий агент получал 403 в карточке и делал то же самое через форму.
 * Теперь правило то же, что у правки самой карточки объекта: тот, кто вправе её править, вправе и выбрать застройщика.
 */
export function canEditRegistryLinkAs(
  actor: PropertyAccessActor,
  property: { assignedAgentId?: string | null; intakeAgentId?: string | null; createdById?: string | null },
): boolean {
  return canManagePropertyAs(actor, property);
}

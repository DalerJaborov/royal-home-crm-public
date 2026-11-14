/**
 * Кто может отметить «Выложено»/«Отменить» в раздаче по группам Facebook
 * (глубокая проверка 02.10.2026, F9). Повторяет правило сервера
 * (apps/api/src/routes/properties/groupShare.ts → canMarkGroupShare):
 * кабинет маркетинга (право marketing.access: MARKETING, DIRECTOR, ADMIN, РОП) или
 * хозяин объекта — intake ?? assigned ?? createdBy (lib/propertyOwner.ts).
 *
 * Правило живёт пока в двух местах: общий модуль (packages/shared) в этой
 * правке трогать было нельзя. Перенести туда обе стороны — следующим шагом.
 */
export function canMarkFacebookGroupShare(
  hasMarketingAccess: boolean,
  agentId: string | undefined,
  property: {
    intakeAgentId?: string | null;
    assignedAgent?: { id: string } | null;
    createdById?: string | null;
  }
): boolean {
  if (hasMarketingAccess) return true;
  const owner = property.intakeAgentId ?? property.assignedAgent?.id ?? property.createdById ?? null;
  return !!agentId && owner === agentId;
}

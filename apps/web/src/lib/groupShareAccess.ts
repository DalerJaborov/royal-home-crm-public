/**
 * Кто может отметить «Выложено»/«Отменить» в раздаче по группам Facebook
 * (глубокая проверка 02.10.2026, F9). Повторяет правило сервера
 * (apps/api/src/routes/properties/groupShare.ts → canMarkGroupShare):
 * кабинет маркетинга (hasMarketingRole: MARKETING, DIRECTOR, ADMIN) или
 * хозяин объекта — intake ?? assigned ?? createdBy (lib/propertyOwner.ts).
 *
 * Правило живёт пока в двух местах: общий модуль (packages/shared) в этой
 * правке трогать было нельзя. Перенести туда обе стороны — следующим шагом.
 */
export function canMarkFacebookGroupShare(
  role: string | undefined,
  agentId: string | undefined,
  property: {
    intakeAgentId?: string | null;
    assignedAgent?: { id: string } | null;
    createdById?: string | null;
  }
): boolean {
  if (role === "MARKETING" || role === "DIRECTOR" || role === "ADMIN") return true;
  const owner = property.intakeAgentId ?? property.assignedAgent?.id ?? property.createdById ?? null;
  return !!agentId && owner === agentId;
}

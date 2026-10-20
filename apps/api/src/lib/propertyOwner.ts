/**
 * Единый резолвер «кто хозяин объекта» (Пачка 1, п.2, 11.09.2026).
 *
 * До этого правило «свой объект = свой клиент» в lib/instagramPostLead.ts,
 * services/leads/assignment.ts и routes/matching.ts смотрело только на
 * `intakeAgentId` и молча пропускало объект, если поле пустое — а lead по
 * объекту БЕЗ интейкера, но с назначенным риелтором или хотя бы с тем, кто
 * завёл карточку, никому не доставался, хотя хозяин у объекта фактически есть.
 * lib/propertyPipeline.ts уже считал ответственного именно так
 * (`intakeAgentId ?? assignedAgentId ?? createdById`, см. `responsibleId` там же)
 * — выносим формулу в одно место и используем везде, где решается, чей это лид,
 * чтобы три копии одного правила не разошлись, как уже бывало в этом репозитории.
 */
export interface PropertyOwnerFields {
  intakeAgentId?: string | null;
  assignedAgentId?: string | null;
  createdById?: string | null;
}

/** Кто отвечает за объект: принял (интейк) → ведёт сделку → завёл карточку. */
export function propertyOwnerAgentId(property: PropertyOwnerFields): string | null {
  return property.intakeAgentId ?? property.assignedAgentId ?? property.createdById ?? null;
}

/**
 * Причины назначения, означающие «лид отдан хозяину объекта по его объекту»
 * (services/leads/assignmentTypes.ts::LeadAssignReason). Список один на весь
 * сервер: им проверяют, держит ли агент лид ПО ПРАВУ хозяина объекта, и им же
 * снимают эту причину, когда лид ушёл к постороннему агенту (changeClientAgent).
 */
export const OWN_PROPERTY_ASSIGN_REASONS: readonly string[] = [
  "own_property_explicit",
  "own_property_shown",
  "own_property_match",
  "instagram_post_link",
];

/**
 * ДЕРЖИТ ЛИ АГЕНТ КАРТОЧКИ ЛИД ПО СВОЕМУ ОБЪЕКТУ (10.10.2026, аудит
 * docs/audit-bots-2026-10-10-object-routing.md, P0-1). Тот же признак, что у
 * закона в единой точке смены агента (changeClientAgent: пометка «свой объект»
 * остаётся, только если держатель и есть хозяин `matchedProperty`), плюс
 * причина назначения — пометка `ownPropertyLead` пишется отдельной транзакцией
 * после назначения и может не лечь (P2-13), а причина и объект уже на карточке.
 * Удалённый объект права не даёт.
 */
export function holdsOwnPropertyLead(client: {
  assignedAgentId: string | null;
  ownPropertyLead: boolean;
  assignReason: string | null;
  matchedProperty: (PropertyOwnerFields & { deletedAt?: Date | null }) | null;
}): boolean {
  const property = client.matchedProperty;
  if (!client.assignedAgentId || !property || property.deletedAt) return false;
  if (propertyOwnerAgentId(property) !== client.assignedAgentId) return false;
  return client.ownPropertyLead || OWN_PROPERTY_ASSIGN_REASONS.includes(client.assignReason ?? "");
}

/**
 * То же правило, но как условие Prisma «хозяин объекта — этот агент»
 * (28.09.2026, жалоба владельца «объекты Нозы не показывает»). До этого
 * «Мои объекты» в списке и на карте смотрели ТОЛЬКО на `intakeAgentId`, профиль
 * сотрудника считал объекты по OR трёх полей, а строка списка подписывала
 * `assignedAgent ?? intakeAgent` — четыре разных ответа на вопрос «чей объект»,
 * и объект без интейкера у своего агента в «Мои» не попадал, хотя в профиле
 * считался и лид по нему уходил именно ему.
 *
 * Условие повторяет `propertyOwnerAgentId` по ступеням: принял → ведёт сделку
 * (только если никто не принимал) → завёл карточку (только если пусты оба).
 */
export function propertyOwnerWhere(agentId: string): {
  OR: Array<Record<string, unknown>>;
} {
  return {
    OR: [
      { intakeAgentId: agentId },
      { intakeAgentId: null, assignedAgentId: agentId },
      { intakeAgentId: null, assignedAgentId: null, createdById: agentId },
    ],
  };
}

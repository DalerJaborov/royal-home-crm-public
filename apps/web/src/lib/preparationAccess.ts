/**
 * Очередь подготовки/монтажа: монтажёр по роли, остальные — по праву marketing.access
 * (с 14.11.2026; раньше роли MARKETING/DIRECTOR/ADMIN). Модерация отдельного объекта
 * доступа к очереди не даёт.
 */
export function canReadPreparation(role: string | undefined, hasMarketingAccess: boolean): boolean {
  return role === "EDITOR" || hasMarketingAccess;
}

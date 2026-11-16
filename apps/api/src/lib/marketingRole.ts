/**
 * Доступ к кабинету маркетинга — по ПРАВУ `marketing.access` (с 14.11.2026), а не
 * по роли: раньше тут стояло `role === "MARKETING" | "DIRECTOR" | "ADMIN"`, и выдать
 * маркетинг РОПу галочкой было нельзя. Пресеты MARKETING/DIRECTOR/ADMIN несут право
 * сами, так что для них ничего не изменилось. Вынесено из `routes/marketing.ts`
 * (31.10.2026, П3), чтобы ИИ-помощник проверял доступ тем же кодом, не подтягивая
 * в `lib/` целый роутер. Роут реэкспортирует функцию.
 */
export function hasMarketingRole(agent: { permissions: ReadonlySet<string> } | null | undefined): boolean {
  return agent?.permissions.has("marketing.access") ?? false;
}

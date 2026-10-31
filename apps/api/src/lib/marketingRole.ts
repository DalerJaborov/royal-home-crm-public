/**
 * Роли кабинета маркетинга (MARKETING, DIRECTOR, ADMIN) — право «Убрать из
 * соцсетей» и «Вернуть монтажёру» со снятием постов. Вынесено из
 * `routes/marketing.ts` (31.10.2026, П3), чтобы ИИ-помощник проверял роль тем же
 * кодом, не подтягивая в `lib/` целый роутер. Роут реэкспортирует функцию.
 */
export function hasMarketingRole(role: string | undefined): boolean {
  return role === "MARKETING" || role === "DIRECTOR" || role === "ADMIN";
}

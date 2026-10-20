/** Плитки «Здоровья системы» (макет tpl-health): счётчики журнала ошибок.
 *  Тип живёт отдельно от pages/Health.tsx, чтобы мобильная копия не
 *  импортировала страницу, которая импортирует её саму (цикл, CI). */
export interface HealthTilesData {
  count24h: number;
  count7d: number;
  resolvedCount: number;
}

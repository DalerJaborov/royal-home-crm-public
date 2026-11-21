import type { PermissionId } from "@royal-home/shared";
import { useAuthStore } from "../store/auth";
import { useCan } from "./permissions";

/**
 * ГЛАВНАЯ = ДАШБОРД РУКОВОДИТЕЛЯ (решение владельца 21.11.2026: «Дашборд же должен на главной
 * отображаться»). У директора, админа и РОПа с правом на отчёты «Сегодня» — это полоса «Требует
 * внимания сейчас» и под ней дашборд (pages/DirectorDashboard.tsx). У них же без права
 * `reports.view` дашборд закрыт, и главная остаётся прежней (блоки ядра). Остальные роли — как были.
 * Правило выбора — здесь одно, его читают и главная (registry), и «Оформление», и старый адрес /director.
 */
export const DASHBOARD_HOME_ROLES = ["DIRECTOR", "ADMIN", "HEAD_OF_SALES"] as const;

export function usesDashboardHome(role: string | null | undefined, can: (permission: PermissionId) => boolean): boolean {
  return !!role && (DASHBOARD_HOME_ROLES as readonly string[]).includes(role) && can("reports.view");
}

export function useDashboardHome(): boolean {
  const role = useAuthStore((s) => s.agent?.role);
  const can = useCan();
  return usesDashboardHome(role, can);
}

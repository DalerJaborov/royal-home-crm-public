import { parsePermissionOverrides, resolvePermissions, ROLES } from "@royal-home/shared";

// Owner-authorized maintenance window. It cannot be extended by an environment
// typo or restart. This is NOT MFA completion and never grants an elevation.
export const SETTINGS_MAINTENANCE_START = "2026-10-21T06:00:00.000Z";
export const SETTINGS_MAINTENANCE_DEADLINE = "2026-11-21T06:30:00.000Z";
export function settingsMaintenanceWindowUntil(now = Date.now()): string | null {
  const raw = process.env.SETTINGS_STEP_UP_MAINTENANCE_UNTIL;
  if (!raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)) return null;
  const until = Date.parse(raw);
  return Number.isFinite(until) && new Date(until).toISOString() === raw &&
    now >= Date.parse(SETTINGS_MAINTENANCE_START) && now < until &&
    until <= Date.parse(SETTINGS_MAINTENANCE_DEADLINE) ? raw : null;
}
export interface SettingsMaintenanceActor {
  role: string; permissions: unknown; isActive: boolean; totpEnabled: boolean;
}
export function settingsMaintenanceUntil(actor: SettingsMaintenanceActor, now = Date.now()): string | null {
  const until = settingsMaintenanceWindowUntil(now);
  if (!until || !actor.isActive || actor.totpEnabled || !["ADMIN", "DIRECTOR"].includes(actor.role)) return null;
  const role = ROLES.find(role => role === actor.role);
  return role && resolvePermissions(role, parsePermissionOverrides(actor.permissions)).has("settings.manage") ? until : null;
}
export function isSettingsMaintenancePath(originalUrl: string): boolean {
  const path = originalUrl.split("?")[0];
  return ["/api/v1/settings", "/api/v1/vacancies/positions", "/api/v1/bot-training", "/api/v1/bot-learning", "/api/v1/dashboard/modules",
    "/api/v1/ui-shell/config", "/api/v1/sms/settings", "/api/v1/sms/test"].some(
    prefix => path === prefix || path.startsWith(prefix + "/"));
}

import { afterEach, expect, it, vi } from "vitest";
import { settingsMaintenanceWindowUntil, settingsMaintenanceUntil, isSettingsMaintenancePath, SETTINGS_MAINTENANCE_DEADLINE } from "../src/lib/settingsMaintenance.js";
const now = Date.parse("2026-10-22T12:00:00.000Z");
const owner = { role: "DIRECTOR", permissions: null, isActive: true, totpEnabled: false };
afterEach(() => vi.unstubAllEnvs());
it("is strict by default and stops at the reviewed calendar-month deadline without restart", () => {
  vi.stubEnv("SETTINGS_STEP_UP_MAINTENANCE_UNTIL", "");
  expect(settingsMaintenanceWindowUntil(now)).toBeNull();
  vi.stubEnv("SETTINGS_STEP_UP_MAINTENANCE_UNTIL", SETTINGS_MAINTENANCE_DEADLINE);
  expect(settingsMaintenanceUntil(owner, now)).toBe(SETTINGS_MAINTENANCE_DEADLINE);
  expect(settingsMaintenanceUntil(owner, Date.parse(SETTINGS_MAINTENANCE_DEADLINE))).toBeNull();
  expect(settingsMaintenanceUntil(owner, Date.parse("2026-10-20T12:00:00.000Z"))).toBeNull();
});
it.each(["2026-12-21T06:30:00.000Z", "invalid", "2026-11-31T06:30:00.000Z", "2026-11-21", "2026-11-21T06:30:00.000Zjunk"])("fails closed for %s", value => {
  vi.stubEnv("SETTINGS_STEP_UP_MAINTENANCE_UNTIL", value);
  expect(settingsMaintenanceWindowUntil(now)).toBeNull();
});
it("retains real roles, active status, permissions and authenticator protection", () => {
  vi.stubEnv("SETTINGS_STEP_UP_MAINTENANCE_UNTIL", SETTINGS_MAINTENANCE_DEADLINE);
  for (const patch of [{ role: "AGENT" }, { role: "MANAGER" }, { role: "unknown" }, { isActive: false }, { totpEnabled: true }]) {
    expect(settingsMaintenanceUntil({ ...owner, ...patch }, now)).toBeNull();
  }
});
it.each(["/api/v1/settings", "/api/v1/settings/customer-agent/rollout", "/api/v1/settings/restore-points?x=1", "/api/v1/vacancies/positions/synthetic", "/api/v1/bot-training/example", "/api/v1/dashboard/modules/synthetic", "/api/v1/ui-shell/config", "/api/v1/sms/settings", "/api/v1/sms/test",
  "/api/v1/agents", "/api/v1/agents?next=/api/v1/settings", "/api/v1/agents/synthetic", "/api/v1/agents/synthetic/avatar", "/api/v1/agents/synthetic/permissions", "/api/v1/agents/synthetic/freeze", "/api/v1/agents/synthetic/unfreeze", "/api/v1/agents/synthetic/handover", "/api/v1/agents/handovers/synthetic/revert", "/api/v1/agents/synthetic/2fa/reset"])("allows only a settings maintenance route: %s", path => expect(isSettingsMaintenancePath(path)).toBe(true));
it.each(["/api/v1/me", "/api/v1/me/2fa/disable", "/api/v1/me/passkeys/synthetic", "/api/v1/properties/x/photos", "/api/v1/settings-evil", "/api/v1/agents-evil", "/api/v1/auth/step-up", "/api/v1/properties?next=/api/v1/agents"])("keeps nonsettings step-up: %s", path => expect(isSettingsMaintenancePath(path)).toBe(false));

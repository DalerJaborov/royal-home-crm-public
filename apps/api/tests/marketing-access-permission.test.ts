import { describe, expect, it } from "vitest";
import { ROLE_PRESETS, resolvePermissions } from "@royal-home/shared";
import { hasMarketingRole } from "../src/lib/marketingRole.js";

/**
 * Кабинет маркетинга открывается правом marketing.access, а не ролью
 * (владелец 14.11.2026: РОП Ноза ведёт маркетинг и смотрит разбор потерь).
 */
describe("marketing.access", () => {
  it("у прежних ролей кабинета право есть из коробки", () => {
    for (const role of ["MARKETING", "DIRECTOR", "ADMIN", "HEAD_OF_SALES"] as const) {
      expect(hasMarketingRole({ permissions: resolvePermissions(role, null) }), role).toBe(true);
    }
  });

  it("у остальных ролей права нет", () => {
    for (const role of ["AGENT", "MANAGER", "EDITOR", "SECURITY", "SHAREHOLDER"] as const) {
      expect(hasMarketingRole({ permissions: resolvePermissions(role, null) }), role).toBe(false);
    }
  });

  it("агенту право выдаётся галочкой, у маркетолога — снимается", () => {
    expect(hasMarketingRole({ permissions: resolvePermissions("AGENT", { granted: ["marketing.access"], revoked: [] }) })).toBe(true);
    expect(hasMarketingRole({ permissions: resolvePermissions("MARKETING", { granted: [], revoked: ["marketing.access"] }) })).toBe(false);
  });

  it("нет сотрудника — нет доступа", () => {
    expect(hasMarketingRole(undefined)).toBe(false);
    expect(hasMarketingRole(null)).toBe(false);
  });

  it("РОП видит потери лидов и пульс, но не пишет в инсайты", () => {
    const preset = new Set(ROLE_PRESETS.HEAD_OF_SALES);
    for (const id of ["reports.view", "dashboard.analytics", "team.viewFull"] as const) {
      expect(preset.has(id), id).toBe(true);
    }
    expect(preset.has("insights.view")).toBe(false);
  });
});

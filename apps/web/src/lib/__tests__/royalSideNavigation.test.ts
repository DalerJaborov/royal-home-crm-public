import { describe, expect, it } from "vitest";
import { ROLES, resolvePermissions, type PermissionId, type Role } from "@royal-home/shared";
import { buildNavigation, type NavInputs } from "../navigation";
import { ROYAL_PRIMARY_CAPACITY, royalSideNavigation } from "../cleanNavigationOrder";

/**
 * БОКОВОЕ МЕНЮ «НОВОГО ВИДА» (пачка B «одна оболочка», 20.11.2026).
 *
 * Было 33 строки подряд у директора (critic-uiux.md P1-7). Сторож держит то, что
 * ломается тихо: не больше восьми главных пунктов, каждый разрешённый путь — ровно
 * один раз (ничего не потеряно и не задвоено), личный порядок из «Порядка вкладок»
 * (preferences.navigation) уважается, права не расширяются.
 */
function inputs(role: Role): NavInputs {
  const granted = resolvePermissions(role, null);
  return {
    role,
    can: (permission: PermissionId) => granted.has(permission),
    counters: { clients: 3, deals: 2, calendar: 1, messages: 5, comments: 0, calls: 4, vacancies: 1 },
    siteNotifications: { total: 0 },
    oversightSummary: { overdueTasks: 2 },
    marketingSummary: { overdue: 1 },
    editorsLoad: { sharedQueue: { inEditing: 3, overdue: 1 } },
    deleteRequests: { items: [] },
    propertyDeleteRequests: { items: [] },
    settings: { botTrainingScreenEnabled: true },
  };
}

describe("боковое меню нового вида", () => {
  it.each([...ROLES])("%s: не больше восьми главных, каждый путь ровно один раз, без лишних", (role) => {
    const { main, all } = buildNavigation(inputs(role));
    const { primary, groups } = royalSideNavigation(main, all);
    expect(primary.length).toBeLessThanOrEqual(ROYAL_PRIMARY_CAPACITY);
    const shown = [...primary, ...groups.flatMap((g) => g.items)].map((i) => i.to);
    expect(new Set(shown).size, "повтор пункта").toBe(shown.length);
    const allowed = new Set([...main, ...all].map((i) => i.to));
    expect(new Set(shown), "потерян или добавлен раздел").toEqual(allowed);
    for (const group of groups) expect(group.items.length, group.title).toBeGreaterThan(0);
  });

  it("директор: 33 строки свёрнуты до восьми главных и групп", () => {
    const { main, all } = buildNavigation(inputs("DIRECTOR"));
    const { primary, groups } = royalSideNavigation(main, all);
    expect(primary.map((i) => i.to).slice(0, 6)).toEqual(["/", "/clients", "/messages", "/properties", "/deals", "/finance"]);
    expect(primary).toHaveLength(8);
    expect(groups.length).toBeGreaterThanOrEqual(3);
    expect(groups.length).toBeLessThanOrEqual(5);
  });

  it("личный порядок вкладок задаёт главные пункты", () => {
    const { main, all } = buildNavigation(inputs("DIRECTOR"));
    const saved = ["/calendar", "/clients", "/"];
    const { primary } = royalSideNavigation(main, all, saved);
    expect(primary.map((i) => i.to).slice(0, 3)).toEqual(saved);
    expect(primary.length).toBeLessThanOrEqual(ROYAL_PRIMARY_CAPACITY);
  });

  it("сторож проверен поломкой: задвоенный путь или девятый главный пункт видны", () => {
    const { main, all } = buildNavigation(inputs("DIRECTOR"));
    const broken = royalSideNavigation(main, all, [], 9);
    expect(broken.primary.length).toBeGreaterThan(ROYAL_PRIMARY_CAPACITY);
    const dup = [...broken.primary, broken.primary[0]].map((i) => i.to);
    expect(new Set(dup).size).not.toBe(dup.length);
  });
});

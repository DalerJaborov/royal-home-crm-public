import { describe, expect, it } from "vitest";
import { ROLES, resolvePermissions, type PermissionId, type Role } from "@royal-home/shared";
import { buildNavigation, type NavInputs } from "../navigation";
import { ROYAL_PRIMARY_CAPACITY, navGroupsKey, readOpenNavGroups, royalSideNavigation } from "../cleanNavigationOrder";
import { isWideRoute } from "../shellLayout";

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
  };
}

/** Что не так с меню: больше восьми главных, повтор пути, потерянный или лишний раздел. */
function sideNavProblems(nav: ReturnType<typeof royalSideNavigation>, allowed: Set<string>): string[] {
  const problems: string[] = [];
  if (nav.primary.length > ROYAL_PRIMARY_CAPACITY) problems.push(`главных ${nav.primary.length}`);
  const shown = [...nav.primary, ...nav.groups.flatMap((g) => g.items)].map((i) => i.to);
  const seen = new Set<string>();
  for (const to of shown) { if (seen.has(to)) problems.push(`повтор ${to}`); seen.add(to); }
  for (const to of allowed) if (!seen.has(to)) problems.push(`потерян ${to}`);
  for (const to of seen) if (!allowed.has(to)) problems.push(`лишний ${to}`);
  for (const g of nav.groups) if (!g.items.length) problems.push(`пустая группа ${g.title}`);
  return problems;
}

describe("боковое меню нового вида", () => {
  it.each([...ROLES])("%s: не больше восьми главных, каждый путь ровно один раз, без лишних", (role) => {
    const { main, all } = buildNavigation(inputs(role));
    expect(sideNavProblems(royalSideNavigation(main, all), new Set([...main, ...all].map((i) => i.to)))).toEqual([]);
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

  it("задвоенный на входе пункт показывается один раз (дедупликация — в самой функции)", () => {
    const { main, all } = buildNavigation(inputs("DIRECTOR"));
    const tail = all[all.length - 1];
    const nav = royalSideNavigation(main, [...all, { ...tail }, { ...tail }]);
    expect(sideNavProblems(nav, new Set([...main, ...all].map((i) => i.to)))).toEqual([]);
  });

  it("сторож проверен поломкой: функция с вместимостью 9 и с потерянным пунктом — красный", () => {
    const { main, all } = buildNavigation(inputs("DIRECTOR"));
    const allowed = new Set([...main, ...all].map((i) => i.to));
    expect(sideNavProblems(royalSideNavigation(main, all, [], 9), allowed)).toContain("главных 9");
    const lost = royalSideNavigation(main, all.slice(0, -1));
    expect(sideNavProblems(lost, allowed).some((p) => p.startsWith("потерян"))).toBe(true);
  });

  it("раскрытые группы помнятся на сотрудника, а не на устройство", () => {
    const data = new Map([[navGroupsKey("one"), JSON.stringify(["team"])]]);
    const storage = { getItem: (k: string) => data.get(k) ?? null };
    expect(readOpenNavGroups("one", storage)).toEqual(["team"]);
    expect(readOpenNavGroups("two", storage)).toEqual([]);
    expect(readOpenNavGroups("one", { getItem: () => { throw new Error("blocked"); } })).toEqual([]);
  });

  it("обзорные экраны широкие вместе с вложенными путями, «/» — только сама главная", () => {
    expect(isWideRoute("/")).toBe(true);
    expect(isWideRoute("/reports")).toBe(true);
    expect(isWideRoute("/reports/agents")).toBe(true);
    expect(isWideRoute("/clients")).toBe(false);
    expect(isWideRoute("/reportsx")).toBe(false);
  });
});

// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ГЛАВНАЯ РУКОВОДИТЕЛЯ = ДАШБОРД (21.11.2026): кто получает дашборд вместо старых блоков,
 * что рисуется на «/», и что остальные роли и руководитель без права на отчёты не тронуты.
 */
const h = vi.hoisted(() => ({ role: "DIRECTOR", perms: new Set<string>(["reports.view", "dashboard.analytics"]) }));
vi.mock("../../../store/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../store/auth")>(),
  useAuthStore: (select: (s: unknown) => unknown) => select({ agent: { id: "a1", fullName: "Сорбон Тестов", role: h.role } }),
}));
vi.mock("../../../lib/permissions", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/permissions")>(), useCan: () => (p: string) => h.perms.has(p),
}));
vi.mock("./blocks/dashboardHome", () => ({
  AttentionStrip: () => <p>полоса внимания</p>,
  DashboardHomeBlock: () => <p>дашборд директора</p>,
}));

import { usesDashboardHome } from "../../../lib/homeDashboard";
import { homeBlocksFor } from "./core";
import { HOME_BLOCKS, HOME_LAYOUT, RoyalRoleHome } from "./registry";

afterEach(cleanup);
const renderHome = () => render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><RoyalRoleHome /></MemoryRouter></QueryClientProvider>);
const shown = (container: HTMLElement) => [...container.querySelectorAll("[data-block]")].map((el) => el.getAttribute("data-block"));

describe("выбор главной по роли", () => {
  it("дашборд — директору, админу и РОПу с правом на отчёты; остальным и без права — нет", () => {
    const can = (p: string) => p === "reports.view";
    for (const role of ["DIRECTOR", "ADMIN", "HEAD_OF_SALES"]) expect(usesDashboardHome(role, can as never), role).toBe(true);
    for (const role of ["AGENT", "MANAGER", "MARKETING", "EDITOR", "SECURITY", "SHAREHOLDER", undefined, null]) expect(usesDashboardHome(role, can as never), String(role)).toBe(false);
    expect(usesDashboardHome("DIRECTOR", (() => false) as never)).toBe(false);
  });

  it.each(["DIRECTOR", "ADMIN", "HEAD_OF_SALES"])("%s: на главной полоса внимания и дашборд, старых блоков денег и команды нет", (role) => {
    h.role = role;
    const { container, getByText } = renderHome();
    expect(shown(container)).toEqual(["attention", "dashboard"]);
    getByText("полоса внимания");
    getByText("дашборд директора");
  });

  it("руководитель без права на отчёты получает прежнюю главную", () => {
    h.role = "DIRECTOR";
    h.perms = new Set(["dashboard.analytics"]);
    const ids = homeBlocksFor("DIRECTOR", HOME_BLOCKS, HOME_LAYOUT).map((b) => b.id);
    expect(ids).toContain("money");
    expect(ids).not.toContain("dashboard");
    h.perms = new Set(["reports.view", "dashboard.analytics"]);
  });

  it("агент и менеджер: раскладка без полосы внимания и дашборда", () => {
    for (const role of ["AGENT", "MANAGER", "SHAREHOLDER", "MARKETING", "EDITOR", "SECURITY"]) {
      const ids = homeBlocksFor(role, HOME_BLOCKS, HOME_LAYOUT).map((b) => b.id);
      expect(ids, role).not.toContain("attention");
      expect(ids, role).not.toContain("dashboard");
    }
  });
});

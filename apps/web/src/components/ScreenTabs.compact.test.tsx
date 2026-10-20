import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
const mode = vi.hoisted(() => ({ clean: true, narrow: true }));
vi.mock("../hooks/useCleanShell", () => ({ useCleanShell: () => mode.clean }));
vi.mock("../hooks/useNarrowScreen", () => ({ useNarrowScreen: () => mode.narrow }));
vi.mock("../lib/permissions", () => ({ useCan: () => (permission: string) => permission !== "settings.view" }));
import { ScreenTabs, type ScreenTab } from "./ScreenTabs";
const tabs: ScreenTab[] = [
  { to: "/clients", label: "Клиенты", end: true },
  { to: "/clients/all-mine", label: "Мои карточки", end: true },
  { to: "/reports", label: "Отчёты", permission: "reports.view" },
  { to: "/finance", label: "Деньги", count: 123, permission: "finance.view" },
  { to: "/settings", label: "Настройки", permission: "settings.view" },
  { to: "/finance", label: "Дубль" },
];
const render = (path = "/clients/all-mine", items = tabs, right?: React.ReactNode) => renderToStaticMarkup(
  <MemoryRouter initialEntries={[path]}><ScreenTabs tabs={items} right={right} /></MemoryRouter>
);
beforeEach(() => { mode.clean = true; mode.narrow = true; });
describe("compact section navigation", () => {
  it("retains every allowed destination once and excludes forbidden routes", () => {
    const html = render();
    expect(html).toContain('aria-label="Перейти в раздел"');
    expect(html.match(/<option /g)).toHaveLength(4);
    expect(html).toContain('value="/clients/all-mine" selected=""');
    expect(html).toContain("Деньги · 99+");
    expect(html).not.toContain("/settings");
    expect(html).not.toContain("Дубль");
  });
  it("shows the owning section on a nested record route", () => {
    expect(render("/clients/42")).toContain('value="/clients" selected=""');
  });
  it("keeps workspace controls outside the collapsed choice", () => {
    const html = render("/finance", tabs, <button>Расходы</button>);
    expect(html.indexOf("Расходы")).toBeGreaterThan(html.indexOf("</select>"));
  });
  it("keeps short rows directly accessible", () => {
    const html = render("/clients", tabs.slice(0, 3));
    expect(html).not.toContain("<select");
    expect(html).toContain('href="/reports"');
  });
  it.each(["desktop", "legacy"])("preserves existing links on %s", (variant) => {
    mode.narrow = variant !== "desktop";
    mode.clean = variant !== "legacy";
    const html = render();
    expect(html).not.toContain("<select");
    expect(html).toContain('href="/finance"');
    expect(html).not.toContain('href="/settings"');
  });
});

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/permissions", () => ({ useCan: () => (permission: string) => permission === "finance.view" }));
vi.mock("../hooks/useCleanShell", () => ({ useCleanShell: () => false }));
vi.mock("../hooks/useNarrowScreen", () => ({ useNarrowScreen: () => false }));
import { ScreenTabs } from "./ScreenTabs";
const tabs = [{ to: "/finance", label: "Финансы", permission: "finance.view" as const }, { to: "/reports", label: "Отчёты", permission: "reports.view" as const }];
describe("shared section tabs with a Clean workspace slot", () => {
  it("retains permitted routes and workspace controls when only one route is authorised", () => {
    const html = renderToStaticMarkup(<MemoryRouter><ScreenTabs tabs={tabs} right={<button>Расходы</button>} /></MemoryRouter>);
    expect(html).toContain('href="/finance"');
    expect(html).toContain("Расходы");
    expect(html).not.toContain('href="/reports"');
  });
  it("preserves the legacy no-choice behaviour without a workspace slot", () => {
    expect(renderToStaticMarkup(<MemoryRouter><ScreenTabs tabs={tabs} /></MemoryRouter>)).toBe("");
  });
});

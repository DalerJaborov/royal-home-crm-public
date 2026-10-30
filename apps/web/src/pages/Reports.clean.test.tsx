import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FunnelStage } from "../hooks/useReports";

const state = vi.hoisted(() => ({ clean: true, mobile: false, role: "DIRECTOR", exportAllowed: true,
  funnel: [] as FunnelStage[], loading: false, error: false,
}));
vi.mock("../hooks/useCleanShell", () => ({ useCleanShell: () => state.clean }));
vi.mock("../hooks/useMobileUx", () => ({ useMobileUx: () => state.mobile }));
vi.mock("../lib/permissions", () => ({ useCan: () => (permission: string) => permission !== "properties.export" || state.exportAllowed }));
vi.mock("../store/auth", () => ({ useAuthStore: (select: (value: { agent: { role: string } }) => unknown) => select({ agent: { role: state.role } }) }));
vi.mock("../hooks/useReports", () => ({
  useFunnelReport: () => ({ data: { funnel: state.funnel }, isLoading: state.loading, isError: state.error, refetch: vi.fn() }),
  useAgentsReport: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  useSourcesReport: () => ({ data: { sources: [], avgDaysNewToClosed: null }, isLoading: false, isError: false, refetch: vi.fn() }),
  useHotProperties: () => ({ data: { items: [] }, isLoading: false, isError: false, refetch: vi.fn() }),
  downloadPropertiesExport: vi.fn(),
}));
vi.mock("../components/SectionTabs", () => ({ MoneyTabs: () => <nav>Native report routes</nav> }));
vi.mock("../components/rh2/ShellOwnHeader", () => ({ ShellOwnHeader: () => null }));
vi.mock("../components/MonthlyReports", () => ({ MonthlyReports: () => <div>Native monthly report</div> }));
vi.mock("../components/ProblemReports", () => ({ ProblemReports: () => <div>Native problem report</div> }));
vi.mock("../components/DemandSupplySection", () => ({ DemandSupplySection: () => <div>Native demand/supply</div> }));

import { Reports } from "./Reports";
const render = () => renderToStaticMarkup(<MemoryRouter><Reports /></MemoryRouter>);
function overview(html: string) {
  const start = html.indexOf('aria-label="Основные показатели за выбранный период"');
  return start === -1 ? "" : html.slice(start, html.indexOf('<div class="sec" id="funnel-section"', start));
}
beforeEach(() => {
  Object.assign(state, { clean: true, mobile: false, role: "DIRECTOR", exportAllowed: true, loading: false, error: false,
    funnel: [
      { key: "deals", label: "Сделки", count: 3, commission: 45600 },
      { key: "showings", label: "Показы", count: 17 },
      { key: "leads", label: "Лиды", count: 41 },
    ],
  });
});

describe("Clean report hierarchy", () => {
  it.each([true, false])("does not describe independent period counts as cohort conversion (clean=%s)", clean => {
    state.clean = clean;
    state.funnel = [
      { key: "leads", label: "Лиды", count: 1 },
      { key: "showings", label: "Показы", count: 2 },
      { key: "negotiations", label: "Переговоры", count: 5 },
      { key: "deals", label: "Сделки", count: 3 },
    ];
    const html = render();
    expect(html).toContain("250 %");
    expect(html).toContain("переговоры / показы за период");
    expect(html).toContain("Это соотношения событий, а не конверсия одних и тех же клиентов");
    expect(html).not.toContain("показ доходит до переговоров");
    expect(html).not.toContain("лид доходит до сделки");
    expect(html).not.toContain("конверсия за период");
  });
  it("shows headline metrics by stable stage keys and retains detailed native sections below", () => {
    const html = render(); const summary = overview(html);
    expect(summary).toMatch(/Новые лиды[\s\S]*?<b>41<\/b>/);
    expect(summary).toMatch(/Показы[\s\S]*?<b>17<\/b>/);
    expect(summary).toMatch(/Закрытые сделки[\s\S]*?<b>3<\/b>/);
    expect(summary).toContain("45 600");
    expect(html).toContain("Native monthly report");
    expect(html).toContain("Native demand/supply");
  });
  it("does not disclose money when the server withholds commission, and preserves agent scope", () => {
    state.role = "AGENT";
    state.funnel = state.funnel.map((row) => ({ ...row, commission: null }));
    const html = render();
    expect(overview(html)).not.toContain("Комиссия");
    expect(overview(html)).toContain("Сделки / новые лиды");
    expect(html).toContain("Ваши показатели по фактическим записям CRM");
  });
  it.each(["loading", "error"] as const)("does not invent headline numbers during %s", (key) => {
    state[key] = true;
    expect(overview(render())).toBe("");
    expect(render()).toContain(key === "loading" ? "Считаем отчёт" : "нулевой период");
  });
  it("labels property exports as auxiliary rather than claiming to export the report", () => {
    const html = render();
    expect(html).toContain("Вспомогательная выгрузка объектов");
    expect(html).toContain("Список объектов, а не выгрузка отчёта за выбранный период");
    expect((html.match(/type="date"/g) ?? []).length).toBe(2);
    state.exportAllowed = false;
    expect(render()).not.toContain("Вспомогательная выгрузка объектов");
  });
  it("provides shortcuts to existing detailed sections only in Clean", () => {
    const html = render();
    expect(html).toContain('aria-label="Разделы отчётов"');
    for (const id of ["funnel-section", "agents-report-section", "sources-report-section", "hot-properties-section"]) {
      expect(html).toContain(`id="${id}"`);
    }
    state.clean = false;
    expect(render()).not.toContain('aria-label="Разделы отчётов"');
  });
  it("shares readable Clean report metrics with an authorized phone", () => {
    state.mobile = true;
    const html = render();
    expect(html).toContain("clean-reports");
    expect(overview(html)).not.toBe("");
    expect(html).not.toContain('class="mh"');
  });
  it("preserves the legacy report controls when shell policy excludes the phone", () => {
    state.mobile = true;
    state.clean = false;
    const html = render();
    expect(html).not.toContain("clean-reports");
    expect(overview(html)).toBe("");
    expect(html).not.toContain("Вспомогательная выгрузка объектов");
    expect(html).toContain("Объекты CSV");
  });
});

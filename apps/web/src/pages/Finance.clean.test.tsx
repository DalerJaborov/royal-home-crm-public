import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { FinanceMonth } from "../hooks/useFinance";

const state = vi.hoisted(() => ({ clean: true, mobile: false, readOnly: false, data: undefined as unknown, loading: false, error: null as Error | null }));
vi.mock("../hooks/useCleanShell", () => ({ useCleanShell: () => state.clean }));
vi.mock("../hooks/useMobileUx", () => ({ useMobileUx: () => state.mobile }));
vi.mock("../lib/permissions", () => ({ useCan: () => () => true, useIsReadOnly: () => state.readOnly }));
vi.mock("../hooks/useFinance", () => ({
  useFinanceSummary: () => ({ data: state.data, isLoading: state.loading, error: state.error, refetch: vi.fn() }),
  useExpenseForecast: () => ({ data: undefined }),
  useCommissionForecast: () => ({ data: undefined }),
  downloadFinanceCsv: vi.fn(),
}));
vi.mock("../components/SectionTabs", () => ({ MoneyTabs: ({ right }: { right?: React.ReactNode }) => <nav>Existing money routes{right}</nav> }));
vi.mock("../components/rh2/ShellOwnHeader", () => ({ ShellOwnHeader: () => null }));
vi.mock("../components/finance/ExpensesWorkspace", () => ({ ExpensesWorkspace: ({ canManage }: { canManage: boolean }) => <input aria-label="Legacy expense draft" disabled={!canManage} /> }));
vi.mock("../components/finance/RecurringSection", () => ({ RecurringSection: ({ canManage }: { canManage: boolean }) => canManage ? <button>Native recurring editor</button> : <p>Native recurring view</p> }));
vi.mock("../components/finance/PulseTiles", () => ({ PulseTiles: () => <div>Native pulse</div> }));
vi.mock("../components/finance/CommissionForecastBlock", () => ({ CommissionForecastCard: () => <div>Native commission forecast</div> }));
// Keep the real money shell and route wiring; isolate child API controllers, tested separately.
vi.mock("../components/finance/ClaudeExpenseFeed", () => ({ ClaudeExpenseFeed: ({ canManage }: { canManage: boolean }) => <div data-workspace="expenses"><input aria-label="Native expense draft" disabled={!canManage} /></div> }));
vi.mock("../components/finance/ClaudeSubscriptions", () => ({ ClaudeSubscriptions: ({ canManage }: { canManage: boolean }) => <div data-workspace="recurring">{canManage ? <button>Native subscription editor</button> : <p>Native subscription view</p>}</div> }));
vi.mock("../components/finance/ClaudePaymentCalendar", () => ({ ClaudePaymentCalendar: () => <div data-workspace="calendar">Native payment calendar</div> }));
vi.mock("../components/finance/ClaudeExpenseTable", () => ({ ClaudeExpenseTable: ({ canManage }: { canManage: boolean }) => <div data-workspace="table"><button>View expense details</button><button>Download expense CSV</button>{canManage && <button>Edit expense</button>}</div> }));
vi.mock("../components/finance/ClaudeExpenseSheet", () => ({ ClaudeExpenseSheet: () => <div>Expense sheet</div> }));
vi.mock("../components/finance/ClaudeCategorySettings", () => ({ ClaudeCategorySettings: () => <div>Category settings</div> }));

import { Finance } from "./Finance";

const month: FinanceMonth = {
  month: "2026-10", revenue: 21000, realtorPayouts: 7000, companyRevenue: 14000,
  expenses: {}, totalExpenses: 7000, dealSalaryExpenses: 4000, operatingExpenses: 3000,
  profit: 11000, payouts: [], leads: 0, costPerLead: [],
};
const render = (url = "/finance") => renderToStaticMarkup(<MemoryRouter initialEntries={[url]}><Finance /></MemoryRouter>);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  Object.assign(state, { clean: true, mobile: false, readOnly: false, loading: false, error: null, data: { months: [month], usdToTjsRate: 10 } });
});
afterEach(() => vi.useRealTimers());

describe("native Clean finance", () => {
  it("keeps subscription viewing and exports but closes mutations for a read-only profile even with manage permission", () => {
    state.readOnly = true;
    const subscriptions = render("/finance?workspace=recurring");
    expect(subscriptions).toContain("Native subscription view");
    expect(subscriptions).not.toContain("Native subscription editor");
    expect(subscriptions).not.toContain("cef-add");
    expect(subscriptions).toContain('aria-label="Скачать общую финансовую выгрузку"');
    expect(render()).toContain('aria-label="Native expense draft" disabled=""');
    const table = render("/finance?workspace=table");
    expect(table).toContain("View expense details");
    expect(table).toContain("Download expense CSV");
    expect(table).not.toContain("Edit expense");
  });
  it("opens expenses with six accessible tabs without mounting inactive workspaces or legacy controllers", () => {
    const html = render();
    expect(html).toContain('aria-label="Разделы денег"');
    expect((html.match(/role="tab"/g) ?? []).length).toBe(6);
    expect(html).toMatch(/id="finance-tab-expenses" aria-selected="true"/);
    expect(html).toContain('id="finance-panel-expenses" aria-labelledby="finance-tab-expenses"');
    expect(html).toContain('data-workspace="expenses"');
    expect(html).not.toContain('data-workspace="recurring"');
    expect(html).not.toContain('id="profit-chart-section"');
    expect(html).not.toContain("Legacy expense draft");
    expect(html).not.toContain("iframe");
  });
  it.each(["recurring", "calendar", "table", "overview", "payouts"])("restores URL-selected %s after reload and mounts only its panel", (workspace) => {
    const html = render(`/finance?shell=clean&workspace=${workspace}`);
    expect(html).toContain(`id="finance-tab-${workspace}" aria-selected="true"`);
    expect(html).toContain(`id="finance-panel-${workspace}" aria-labelledby="finance-tab-${workspace}"`);
    expect(html).not.toContain('data-workspace="expenses"');
    if (workspace === "overview") expect(html).toContain("Native pulse");
    else expect(html).not.toContain("Native pulse");
    if (workspace === "payouts") expect(html).toContain("За выбранный месяц нет начисленных долей");
    else if (workspace !== "overview") expect(html).toContain(`data-workspace="${workspace}"`);
  });
  it("offers native subscription editing and a writable expense creator instead of the legacy recurring layout", () => {
    const html = render("/finance?workspace=recurring");
    expect(html).toContain("Native subscription editor");
    expect(html).toContain("cef-add");
    expect(html).not.toContain("Native recurring editor");
    expect(html).not.toContain("Перейти к добавлению расхода");
  });
  it("shows profit history, pulse and forecast only when the overview is selected", () => {
    expect(render()).not.toContain("Native pulse");
    const html = render("/finance?workspace=overview");
    expect(html).toContain('id="profit-chart-section"');
    expect(html).toContain("Native pulse");
    expect(html).toContain("Native commission forecast");
    expect(html).toContain('id="commission-chart-section"');
    expect(html).not.toContain("Existing money routes");
  });
  it("uses server profit and operational expenses without subtracting agent shares twice", () => {
    const html = render("/finance?workspace=overview");
    expect(html).toContain("Валовая комиссия</span><strong class=\"cef-kpi\">21 000 с.");
    expect(html).toContain("Доход компании</span><strong class=\"cef-kpi\">14 000 с.");
    expect(html).toContain("Операционные расходы</span><strong class=\"cef-kpi\">3 000 с.");
    expect(html).toContain("Прибыль</span><strong class=\"cef-kpi\">11 000 с.");
    expect(html).not.toContain("7 000 с.");
  });
  it("shares all native financial workspaces with the authorized Clean phone", () => {
    state.mobile = true;
    const html = render("/finance?workspace=calendar");
    expect(html).toContain('role="tablist" aria-label="Разделы денег"');
    expect(html).toContain("Native payment calendar");
    expect(html).not.toContain('class="mh"');
  });
  it("preserves the legacy phone when shell policy excludes it", () => {
    state.mobile = true;
    state.clean = false;
    const html = render();
    expect(html).not.toContain("cef-main-tabs");
    expect(html).not.toContain("Native payment calendar");
    expect(html).toContain('class="mh"');
    expect(html).toContain("Расходы месяца");
    expect(html).toContain("Native recurring editor");
    expect(html).toContain("Native commission forecast");
  });
  it("reports failed overview and payouts summaries without inventing zero financial results", () => {
    state.data = undefined; state.error = new Error("offline");
    const html = render("/finance?workspace=overview");
    expect(html).toContain('role="status" aria-label="Финансовая сводка"');
    expect(html).toContain("Не загрузилось. Данные этого раздела не подтверждены.");
    expect(html).toContain("Повторить");
    expect(html).not.toContain("cef-kpi");
    expect(html).not.toContain('id="profit-chart-section"');
    const payouts = render("/finance?workspace=payouts");
    expect(payouts).toContain('role="status" aria-label="Выплаты агентам"');
    expect(payouts).toContain("Не загрузилось. Данные этого раздела не подтверждены.");
    expect(payouts).not.toContain("нет начисленных долей");
  });
});

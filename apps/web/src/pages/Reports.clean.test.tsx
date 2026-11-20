import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FunnelStage } from "../hooks/useReports";

const state = vi.hoisted(() => ({ clean: true, mobile: false, role: "DIRECTOR", exportAllowed: true,
  funnel: [] as FunnelStage[], loading: false, error: false, royal: false,
  cohort: undefined as undefined | { key: string; label: string; count: number }[],
  agents: [] as { agentId: string; agentName: string; isActive: boolean; avatarUrl: null; showings: number; dealsClosed: number; commission: number | null }[],
  sources: [] as { source: string; total: number; closed: number; wrote: number }[],
  rangeOverride: null as null | [string, string], dateStateIndex: 0,
  queryEnabled: [] as boolean[],
}));
vi.mock("react", async importOriginal => {
  const original = await importOriginal<typeof import("react")>();
  return { ...original, useState: ((value: unknown) => {
    const override = state.rangeOverride && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && state.dateStateIndex < 2 ? state.rangeOverride[state.dateStateIndex++] : value;
    return original.useState(override);
  }) as typeof original.useState };
});
vi.mock("../hooks/useCleanShell", () => ({ useCleanShell: () => state.clean, useCleanShellSelection: () => ({ clean: state.clean, look: undefined }) }));
vi.mock("../hooks/useMobileUx", () => ({ useMobileUx: () => state.mobile }));
vi.mock("../hooks/useRoyalLook", () => ({ useRoyalLook: () => state.royal }));
vi.mock("../lib/permissions", () => ({ useCan: () => (permission: string) => permission !== "properties.export" || state.exportAllowed }));
vi.mock("../store/auth", () => ({ useAuthStore: (select: (value: { agent: { role: string } }) => unknown) => select({ agent: { role: state.role } }) }));
vi.mock("../hooks/useReports", () => ({
  useFunnelReport: (_range: unknown, enabled: boolean) => { state.queryEnabled.push(enabled); return { data: { funnel: state.funnel, cohort: state.cohort }, isLoading: state.loading, isError: state.error, refetch: vi.fn() }; },
  useAgentsReport: (_range: unknown, enabled: boolean) => { state.queryEnabled.push(enabled); return { data: state.agents, isLoading: false, isError: false, refetch: vi.fn() }; },
  useSourcesReport: (_range: unknown, enabled: boolean) => { state.queryEnabled.push(enabled); return { data: { sources: state.sources, avgDaysNewToClosed: null }, isLoading: false, isError: false, refetch: vi.fn() }; },
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
    rangeOverride: null, dateStateIndex: 0, queryEnabled: [], royal: false, cohort: undefined, agents: [], sources: [],
    funnel: [
      { key: "deals", label: "Сделки", count: 3, commission: 45600 },
      { key: "showings", label: "Показы", count: 17 },
      { key: "leads", label: "Лиды", count: 41 },
    ],
  });
});

describe("Clean report hierarchy", () => {
  it.each([true, false])("rejects reversed dates without showing cached or zero metrics (mobile=%s)", mobile => {
    state.mobile = mobile;
    state.rangeOverride = ["2026-11-02", "2026-10-30"];
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Дата начала не может быть позже даты окончания");
    expect(html).not.toContain('id="funnel-section"');
    expect(html).not.toContain("За этот период показов и сделок не было");
    expect(state.queryEnabled).toEqual([false, false, false]);
  });
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
    expect(summary).toMatch(/Новые заявки[\s\S]*?<b>41<\/b>/);
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
    expect(overview(html)).toContain("Сделки / новые заявки");
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

describe("Отчёты директора (20.11.2026): воронка заявок периода, склонения, одна строка вкладок", () => {
  const cohort = [
    { key: "leads", label: "Новые заявки", count: 10 },
    { key: "contacted", label: "Связались", count: 4 },
    { key: "showings", label: "Был показ", count: 2 },
    { key: "negotiations", label: "Переговоры", count: 2 },
    { key: "deals", label: "Сделка", count: 1 },
  ];
  it.each([true, false])("воронка по заявкам периода: проценты от заявок, не больше 100 %, без оговорки про «больше 100 %» (clean=%s)", (clean) => {
    state.clean = clean;
    state.cohort = cohort;
    // события периода нарочно «шире» заявок — экран их в воронку больше не берёт
    state.funnel = [
      { key: "leads", label: "Новые заявки", count: 10 },
      { key: "showings", label: "Показы", count: 0 },
      { key: "negotiations", label: "Переговоры", count: 4 },
      { key: "deals", label: "Сделки", count: 1, commission: 15510 },
    ];
    const html = render();
    const funnel = html.slice(html.indexOf('id="funnel-section"'), html.indexOf('id="agents-report-section"'));
    expect(funnel).toContain("4 · 40 %");
    expect(funnel).toContain("1 · 10 %");
    expect(funnel).toContain("заявок периода дошли до сделки");
    expect(funnel).not.toContain("больше 100");
    const percents = [...funnel.matchAll(/(\d+) %/g)].map((m) => Number(m[1]));
    expect(percents.length).toBeGreaterThan(0);
    expect(Math.max(...percents)).toBeLessThanOrEqual(100);
  });
  it("склонения: «1 заявка», «2 заявки», «5 заявок»; в кольце источников нет «2 лидов»", () => {
    state.sources = [
      { source: "INSTAGRAM", total: 2, closed: 0, wrote: 0 },
      { source: "WEBSITE", total: 1, closed: 0, wrote: 0 },
      { source: "FACEBOOK", total: 5, closed: 0, wrote: 0 },
    ];
    const html = render().replace(/&nbsp;| /g, " ");
    expect(html).toContain("2 заявки · 25 %");
    expect(html).toContain("1 заявка · 13 %");
    expect(html).toContain("5 заявок · 63 %");
    expect(html).toContain("8 заявок за период");
    expect(html).not.toMatch(/\d лидов/);
  });
  it("новый вид: одна строка вкладок (без второй строки быстрых ссылок), «Спрос и предложение» свёрнут", () => {
    state.royal = true;
    const html = render();
    expect(html).not.toContain('aria-label="Разделы отчётов"');
    expect(html).toMatch(/<details class="card tight ry-fold" id="demand-supply-fold"><summary>Где не хватает квартир/);
    expect(html).toContain("Native demand/supply");
    state.royal = false;
    expect(render()).not.toContain("ry-fold");
  });
});

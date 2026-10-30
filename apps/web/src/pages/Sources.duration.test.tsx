import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ clean: true, duration: -12 as number | null,
  rangeOverride: null as null | [string, string], dateStateIndex: 0, enabled: true }));
beforeEach(() => { state.rangeOverride = null; state.dateStateIndex = 0; state.enabled = true; });
vi.mock("react", async importOriginal => {
  const original = await importOriginal<typeof import("react")>();
  return { ...original, useState: ((value: unknown) => {
    const override = state.rangeOverride && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && state.dateStateIndex < 2 ? state.rangeOverride[state.dateStateIndex++] : value;
    return original.useState(override);
  }) as typeof original.useState };
});
vi.mock("../hooks/useCleanShell", () => ({ useCleanShell: () => state.clean }));
vi.mock("../lib/permissions", () => ({ useCan: () => () => true }));
vi.mock("../components/SectionTabs", () => ({ MoneyTabs: () => null }));
vi.mock("../components/ResponseSpeedSection", () => ({ ResponseSpeedSection: () => null }));
vi.mock("../hooks/useCharts", () => ({ useDashboardHeatmap: () => ({}), useDashboardHeatmapChannels: () => ({}) }));
vi.mock("../hooks/useReports", () => ({
  useSourcesReport: (_range: unknown, enabled: boolean) => { state.enabled = enabled; return { data: { sources: [{ source: "SITE", total: 1, closed: 1, wrote: 1 }], avgDaysNewToClosed: state.duration }, isLoading: false, error: null, refetch: vi.fn() }; },
  useMarketingFunnel: () => ({}), useLostByChannel: () => ({}), useWaitingNow: () => ({}),
  useMarketingInsights: () => ({ data: null, isLoading: false, refresh: { isPending: false, mutate: vi.fn() } }),
}));
import { Sources } from "./Sources";
function durationTile() {
  const html = renderToStaticMarkup(<MemoryRouter><Sources /></MemoryRouter>);
  const start = html.indexOf("Срок до сделки");
  if (start < 0) throw new Error("Duration tile missing");
  return html.slice(start, html.indexOf("</button>", start));
}
describe("Clean source report duration", () => {
  it.each([["2026-11-02", "2026-10-30"], ["", "2026-10-30"]])("blocks invalid period %s to %s without stale metrics", (from, to) => {
    state.rangeOverride = [from, to];
    const html = renderToStaticMarkup(<MemoryRouter><Sources /></MemoryRouter>);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Срок до сделки");
    expect(html).not.toContain("За этот период обращений не было");
    expect(state.enabled).toBe(false);
  });
  it("explains invalid chronology rather than displaying a negative or invented zero KPI", () => {
    state.clean = true; state.duration = -12;
    const tile = durationTile();
    expect(tile).toContain("Проверьте даты клиента и сделки");
    expect(tile).toContain("<b>—</b>");
    expect(tile).not.toContain("<b>-12</b>"); expect(tile).not.toContain("<b>0</b>");
  });
  it.each([0, 12])("retains a valid %s-day duration", value => {
    state.clean = true; state.duration = value;
    expect(durationTile()).toContain(`<b>${value}</b>`);
    expect(durationTile()).not.toContain("Проверьте даты");
  });
  it("retains the existing no-data state", () => {
    state.clean = true; state.duration = null;
    expect(durationTile()).toContain("<b>нет</b>");
  });
  it("also rejects invalid chronology in the legacy presentation", () => {
    state.clean = false; state.duration = -12;
    expect(durationTile()).not.toContain("<b>-12</b>");
    expect(durationTile()).toContain("Проверьте даты клиента и сделки");
  });
});

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ failed: false }));
vi.mock("../../hooks/useFinance", () => ({ useFinancePulse: () => ({
  data: state.failed ? undefined : { refreshing: false, buckets: [{ period: "month", label: "Октябрь 2026", incomeTjs: 12000, expenseTjs: 3000, balanceTjs: 9000, previousIncomeTjs: 0, previousExpenseTjs: 0, previousBalanceTjs: 0 }] },
  isError: state.failed, refetch: vi.fn(),
}) }));
import { PulseTiles } from "./PulseTiles";
describe("native pulse in a Clean overview", () => {
  it("shows the actual pulse period and preserves the accounting scope", () => {
    state.failed = false;
    const html = renderToStaticMarkup(<PulseTiles compact />);
    expect(html).toContain("Октябрь 2026 · текущий период пульса");
    expect(html).toContain("это не остаток на банковском счёте");
    expect(html).toContain("9 000");
  });
  it("keeps the legacy rendering unchanged without optional Clean props", () => {
    state.failed = false;
    expect(renderToStaticMarkup(<PulseTiles />)).not.toContain("текущий период пульса");
  });
  it("renders actual errors instead of zero pulse totals", () => {
    state.failed = true;
    const html = renderToStaticMarkup(<PulseTiles compact />);
    expect(html).toContain("Это сбой связи, а не нулевые деньги");
    expect(html).not.toContain("Октябрь 2026");
  });
});

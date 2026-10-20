import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

const state = vi.hoisted(() => ({
  query: {
    data: undefined as unknown[] | undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  mutation: { isPending: false, isError: false, error: null as Error | null, mutate: vi.fn(), reset: vi.fn() },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => state.query,
  useMutation: () => state.mutation,
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));
vi.mock("../../lib/permissions", () => ({ useCan: () => () => true }));
vi.mock("../../lib/api", () => ({ api: vi.fn() }));

import { MonthlyReports } from "../MonthlyReports";
import { ProblemReports } from "../ProblemReports";

const render = (Component: typeof MonthlyReports) => renderToStaticMarkup(<MemoryRouter><Component /></MemoryRouter>);

beforeEach(() => {
  Object.assign(state.query, { data: undefined, isLoading: false, isError: false, isFetching: false, error: null });
  Object.assign(state.mutation, { isPending: false, isError: false, error: null });
});

describe.each([
  { name: "monthly", Component: MonthlyReports, loading: "Считаем отчёт", empty: "Отчётов пока нет", failure: "Не удалось загрузить месячные отчёты" },
  { name: "problems", Component: ProblemReports, loading: "Считаем разбор", empty: "Разборов пока нет", failure: "Не удалось загрузить разборы проблемных мест" },
])("$name report query states", ({ Component, loading, empty, failure }) => {
  it("renders actual loading instead of an empty or silently blank section", () => {
    state.query.isLoading = true;
    expect(render(Component)).toContain(loading);
    expect(render(Component)).not.toContain(empty);
  });

  it("exposes failed GET and a retry action without claiming an empty result", () => {
    Object.assign(state.query, { isError: true, error: new Error("Connection unavailable") });
    const html = render(Component);
    expect(html).toContain('role="alert"');
    expect(html).toContain(failure);
    expect(html).toContain("Connection unavailable");
    expect(html).toContain("Повторить загрузку");
    expect(html).not.toContain(empty);
  });

  it("preserves cached report navigation while a background refresh fails", () => {
    Object.assign(state.query, {
      data: [{ id: "cached", period: "week", periodStart: "2026-10-01T00:00:00Z", periodEnd: "2026-10-08T00:00:00Z" }],
      isError: true,
      isFetching: true,
      error: new Error("Refresh failed"),
    });
    const html = render(Component);
    expect(html).toContain("Показаны последние загруженные данные");
    expect(html).toContain('role="tab"');
    expect(html).toContain("Загружаем…");
    expect(html).not.toContain(empty);
  });
});

it("monthly generation failure is visible inline", () => {
  state.query.data = [];
  Object.assign(state.mutation, { isError: true, error: new Error("Report generation failed") });
  const html = render(MonthlyReports);
  expect(html).toContain('role="alert"');
  expect(html).toContain("Report generation failed");
});

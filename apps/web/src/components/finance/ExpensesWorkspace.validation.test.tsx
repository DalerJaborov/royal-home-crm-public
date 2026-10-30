import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  day: "31", amount: "100", emptyIndex: 0,
  submit: null as null | (() => Promise<void>), disabled: false,
  create: vi.fn(async () => ({})), recurring: vi.fn(async () => ({})),
}));
vi.mock("react", async importOriginal => {
  const original = await importOriginal<typeof import("react")>();
  return { ...original, useState: ((value: unknown) => {
    // Populate the existing form without replacing its validation or submit handler.
    const next = value === "" ? ["QA recurring", state.amount, "", ""][state.emptyIndex++]
      : value === "1" ? state.day : value === false ? true : value;
    return original.useState(next);
  }) as typeof original.useState };
});
vi.mock("../../hooks/useCleanShell", () => ({ useCleanShell: () => false }));
vi.mock("../../hooks/useAgents", () => ({ useAgents: () => ({ data: [] }) }));
vi.mock("../../hooks/useFinance", () => ({
  useExpenses: () => ({ data: [], isLoading: false, isError: false }),
  useExpenseForecast: () => ({ data: undefined }),
  useCreateExpense: () => ({ isPending: false, mutateAsync: state.create }),
  useCreateRecurring: () => ({ isPending: false, mutateAsync: state.recurring }),
  useUpdateExpense: () => ({ isPending: false }),
  useDeleteExpense: () => ({ isPending: false }),
}));
vi.mock("../rh2/Rh2Sheet", () => ({ Rh2Sheet: ({ footer, children }: { footer: React.ReactElement<{ children: React.ReactNode }>; children: React.ReactNode }) => {
  const add = React.Children.toArray(footer.props.children).find(child =>
    React.isValidElement<{ children: React.ReactNode }>(child) && child.props.children === "Добавить"
  ) as React.ReactElement<{ onClick: () => Promise<void>; disabled: boolean }>;
  state.submit = add.props.onClick;
  state.disabled = add.props.disabled;
  return <section>{children}{footer}</section>;
} }));
import { ExpensesWorkspace } from "./ExpensesWorkspace";
const render = () => renderToStaticMarkup(<ExpensesWorkspace month="2026-10" canManage usdToTjs={11} />);
beforeEach(() => {
  Object.assign(state, { day: "31", amount: "100", emptyIndex: 0, submit: null, disabled: false });
  vi.clearAllMocks();
});
describe("legacy expense sheet keeps the entered recurring day", () => {
  it.each(["31", "29", "0", "", "1.5"])("rejects %j rather than saving another day", async day => {
    state.day = day;
    const html = render();
    expect(state.disabled).toBe(true);
    expect(html).toContain("Выберите число от 1 до 28");
    await state.submit!();
    expect(state.recurring).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });
  it("uses the same decimal amount and exact day as the Clean form", async () => {
    state.day = "28";
    state.amount = "100,25";
    render();
    expect(state.disabled).toBe(false);
    await state.submit!();
    expect(state.recurring).toHaveBeenCalledWith(expect.objectContaining({ dayOfMonth: 28, amount: 100.25, title: "QA recurring" }));
  });
});

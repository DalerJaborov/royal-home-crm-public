import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ clean: true }));
vi.mock("../../hooks/useCleanShell", () => ({ useCleanShell: () => state.clean }));
vi.mock("../../hooks/useFinance", () => ({
  useExpenses: () => ({ data: [], isLoading: false, isError: false }),
  useExpenseForecast: () => ({ data: undefined }),
  useCreateExpense: () => ({ isPending: false }),
  useCreateRecurring: () => ({ isPending: false }),
  useUpdateExpense: () => ({ isPending: false }),
  useDeleteExpense: () => ({ isPending: false }),
}));
vi.mock("../../hooks/useAgents", () => ({ useAgents: () => ({ data: [] }) }));
vi.mock("./CleanExpenseWizard", () => ({ CleanExpenseWizard: () => <div data-testid="clean-expense-wizard" /> }));
vi.mock("../rh2/Rh2Sheet", () => ({ Rh2Sheet: () => <div data-testid="legacy-expense-sheet" /> }));
import { ExpensesWorkspace } from "./ExpensesWorkspace";

describe("expense presentation follows the authoritative shell policy", () => {
  it.each([true, false])("keeps the expense wizard tied to shell policy (%s), including authorized phones", (clean) => {
    state.clean = clean;
    const html = renderToStaticMarkup(<ExpensesWorkspace month="2026-10" canManage usdToTjs={10} />);
    expect(html.includes('data-testid="clean-expense-wizard"')).toBe(clean);
    expect(html.includes('data-testid="legacy-expense-sheet"')).toBe(!clean);
  });
});

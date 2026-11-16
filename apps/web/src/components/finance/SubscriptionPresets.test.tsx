// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBSCRIPTION_PRESETS } from "@royal-home/shared";

const h = vi.hoisted(() => ({
  saveRecurring: vi.fn(async (value: unknown) => ({ id: "r1", title: "x", ...(value as { body: object }).body })),
  rows: [{ id: "s1", title: "Gemini (Google AI)", category: "OTHER", amount: "2000", currency: "TJS", dayOfMonth: 5, active: true, autoPay: true, period: "MONTH", vendor: "GEMINI", counterparty: "Google", startsOn: "2026-11-05", nextDate: "2026-12-05", note: null, lastCreatedMonth: null }],
}));
vi.mock("../../lib/permissions", () => ({ useIsReadOnly: () => false, useCan: () => () => false }));
vi.mock("../../hooks/useUndoToast", () => ({ useUndoToast: () => ({ showUndoToast: vi.fn() }) }));
vi.mock("../../hooks/useAgents", () => ({ useAgents: () => ({ data: [], isPending: false, isError: false }) }));
vi.mock("../../lib/claudeFinanceApi", async (importOriginal) => {
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    ...(await importOriginal<typeof import("../../lib/claudeFinanceApi")>()),
    useClaudeRecurring: () => ({ data: h.rows, isLoading: false, isError: false }),
    useClaudeExpenseCategories: () => ({ data: [], isError: false }),
    useClaudeExpensePage: () => ({ data: { items: [], total: 0, page: 1, pageSize: 6 }, isLoading: false, isError: false }),
    useSaveClaudeRecurring: () => ({ mutateAsync: h.saveRecurring, isPending: false }),
    useSaveClaudeExpense: mutation, useUploadClaudeReceipt: mutation, useDeleteClaudeExpense: mutation, useDeleteClaudeRecurring: mutation,
    useDeleteClaudeReceipt: mutation, useRestoreClaudeExpense: mutation, useRestoreClaudeRecurring: mutation,
    usePayClaudeRecurring: mutation, useSkipClaudeRecurring: mutation, useUndoClaudeRecurring: mutation,
  };
});
import { ClaudeSubscriptions } from "./ClaudeSubscriptions";
import { ClaudeExpenseSheet } from "./ClaudeExpenseSheet";

beforeEach(() => { vi.clearAllMocks(); window.scrollTo = vi.fn(); });
afterEach(cleanup);

describe("быстрое добавление подписок", () => {
  it("чип сервиса открывает добавление с заготовкой, а в строке виден сервис", () => {
    const onAddPreset = vi.fn();
    render(<ClaudeSubscriptions month="2026-11" canManage onAdd={vi.fn()} onAddPreset={onAddPreset} />);
    expect(screen.getByRole("group", { name: "Быстро добавить подписку" })).toBeTruthy();
    expect(screen.getAllByText(/Gemini \(Google AI\)/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Meta Verified \(синяя галочка\)/ }));
    expect(onAddPreset).toHaveBeenCalledWith(SUBSCRIPTION_PRESETS.find((p) => p.vendor === "META_VERIFIED"));
  });

  it("форма с заготовкой: поля подставлены, сумма пустая и обязательна, шаблон уходит с vendor и автоучётом", async () => {
    const preset = SUBSCRIPTION_PRESETS.find((p) => p.vendor === "ELEVENLABS")!;
    render(<ClaudeExpenseSheet month="2026-11" canManage initialRecurring initialPreset={preset} onClose={vi.fn()} />);
    expect((screen.getByLabelText("Название расхода") as HTMLInputElement).value).toBe(preset.title);
    expect((screen.getByLabelText("Кому платили") as HTMLInputElement).value).toBe(preset.counterparty);
    expect((screen.getByLabelText("Сервис") as HTMLSelectElement).value).toBe("ELEVENLABS");
    expect((screen.getByLabelText("Сумма расхода") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(h.saveRecurring).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Сумма расхода"), { target: { value: "55" } });
    fireEvent.change(screen.getByLabelText("Валюта"), { target: { value: "USD" } });
    fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    await waitFor(() => expect(h.saveRecurring).toHaveBeenCalledTimes(1));
    const { body } = h.saveRecurring.mock.calls[0][0] as { body: Record<string, unknown> };
    expect(body).toMatchObject({ vendor: "ELEVENLABS", title: preset.title, counterparty: preset.counterparty, category: "OTHER", amount: 55, currency: "USD", period: "MONTH", autoPay: true, active: true });
  });

  it("у обычного расхода сервис по умолчанию не выбран", () => {
    render(<ClaudeExpenseSheet month="2026-11" canManage onClose={vi.fn()} />);
    expect((screen.getByLabelText("Сервис") as HTMLSelectElement).value).toBe("");
  });
});

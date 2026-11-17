// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readonly: false,
  saveContribution: vi.fn(async (value: unknown) => ({ id: "c-new", ...(value as object) })),
  deleteContribution: vi.fn(async () => undefined),
  restoreContribution: vi.fn(async () => undefined),
  addFounder: vi.fn(async (name: string) => ({ id: "f-new", name, sortOrder: 9, deleted: false })),
  deleteFounder: vi.fn(async (id: string) => ({ id })),
  restoreFounder: vi.fn(async (id: string) => ({ id })),
  updateFounder: vi.fn(async () => ({})),
  founders: [
    { id: "f1", name: "Баходур", sortOrder: 0, deleted: false },
    { id: "f2", name: "Илхом", sortOrder: 1, deleted: false },
    { id: "f3", name: "Старый учредитель", sortOrder: 2, deleted: true },
  ],
  totals: {
    month: "2026-11", monthTjs: 3000, allTimeTjs: 8000,
    founders: [
      { founderId: "f1", name: "Баходур", deleted: false, monthTjs: 3000, allTimeTjs: 5000, monthCount: 1, allTimeCount: 2 },
      { founderId: "f2", name: "Илхом", deleted: false, monthTjs: 0, allTimeTjs: 1000, monthCount: 0, allTimeCount: 1 },
      { founderId: "f3", name: "Старый учредитель", deleted: true, monthTjs: 0, allTimeTjs: 2000, monthCount: 0, allTimeCount: 1 },
    ],
  },
  contributions: [
    { id: "c1", founderId: "f1", founderName: "Баходур", amount: "3000.00", currency: "TJS", exchangeRate: null, amountTjs: 3000, date: "2026-11-05", month: "2026-11", note: "На рекламу", createdBy: { id: "a1", fullName: "Директор" } },
  ],
}));
const query = (data: unknown) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });
vi.mock("../../lib/permissions", () => ({ useIsReadOnly: () => h.readonly }));
vi.mock("../../hooks/useUndoToast", () => ({ useUndoToast: () => ({ showUndoToast: vi.fn() }) }));
vi.mock("../rh2/Rh2Sheet", () => ({
  Rh2Sheet: ({ title, children, footer, onSubmit }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onSubmit?: () => void }) =>
    <form role="dialog" aria-label={String(title)} onSubmit={(e) => { e.preventDefault(); onSubmit?.(); }}>{children}{footer}</form>,
}));
vi.mock("../ConfirmDialog", () => ({
  ConfirmDialog: ({ title, description, confirmLabel, onConfirm }: { title: string; description: string; confirmLabel: string; onConfirm: () => void }) =>
    <div role="alertdialog"><h2>{title}</h2><p>{description}</p><button type="button" onClick={onConfirm}>{confirmLabel}</button></div>,
}));
vi.mock("../../lib/foundersApi", () => ({
  useFounders: () => query(h.founders),
  useFounderTotals: () => query(h.totals),
  useFounderContributions: () => query(h.contributions),
  useSaveContribution: () => ({ mutateAsync: h.saveContribution, isPending: false }),
  useDeleteContribution: () => ({ mutateAsync: h.deleteContribution, isPending: false }),
  useRestoreContribution: () => ({ mutateAsync: h.restoreContribution, isPending: false }),
  useAddFounder: () => ({ mutateAsync: h.addFounder, isPending: false }),
  useUpdateFounder: () => ({ mutateAsync: h.updateFounder, isPending: false }),
  useDeleteFounder: () => ({ mutateAsync: h.deleteFounder, isPending: false }),
  useRestoreFounder: () => ({ mutateAsync: h.restoreFounder, isPending: false }),
}));
vi.mock("../../lib/date", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/date")>()), dushanbeTodayKey: () => "2026-11-17" }));
import { ClaudeFounders, defaultContributionDate } from "./ClaudeFounders";

beforeEach(() => { h.readonly = false; vi.clearAllMocks(); window.scrollTo = vi.fn(); });
afterEach(cleanup);

describe("вкладка Учредители", () => {
  it("показывает итоги по каждому учредителю, общий итог и пояснение про прибыль", () => {
    render(<ClaudeFounders month="2026-11" canManage />);
    expect(screen.getByText(/не доход от продаж: в прибыль и комиссию не входят/)).toBeTruthy();
    const total = screen.getByText("Всего").parentElement!;
    const text = (total.textContent ?? "").replace(/\s/g, " ");
    expect(text).toContain("3 000 с.");
    expect(text).toContain("8 000 с.");
    expect(screen.getByText(/Старый учредитель/, { selector: ".cef-founder-card span" }).textContent).toContain("убран из списка");
    expect(screen.getByText("Записал Директор")).toBeTruthy();
    expect(screen.getByLabelText("Удалить взнос Баходур")).toBeTruthy();
  });

  it("добавление взноса отправляет POST с верным телом и ключом повтора", async () => {
    render(<ClaudeFounders month="2026-11" canManage />);
    fireEvent.click(screen.getByRole("button", { name: /Добавить взнос/ }));
    const dialog = screen.getByRole("dialog", { name: "Новый взнос" });
    fireEvent.change(dialog.querySelector("select")!, { target: { value: "f2" } });
    fireEvent.change(dialog.querySelector("input[inputmode=decimal]")!, { target: { value: "1500,50" } });
    fireEvent.change(dialog.querySelector('input[maxlength="300"]')!, { target: { value: "  На сервер " } });
    fireEvent.submit(dialog);
    await waitFor(() => expect(h.saveContribution).toHaveBeenCalledTimes(1));
    const call = h.saveContribution.mock.calls[0][0] as { id?: string; body: Record<string, unknown>; idempotencyKey: string };
    expect(call.id).toBeUndefined();
    expect(call.body).toEqual({ founderId: "f2", amount: 1500.5, currency: "TJS", date: "2026-11-17", note: "На сервер" });
    expect(call.idempotencyKey).toMatch(/[0-9a-f-]{36}/);
  });

  it("не отправляет взнос с пустой суммой и объясняет почему", async () => {
    render(<ClaudeFounders month="2026-11" canManage />);
    fireEvent.click(screen.getByRole("button", { name: /Добавить взнос/ }));
    fireEvent.submit(screen.getByRole("dialog", { name: "Новый взнос" }));
    expect((await screen.findByRole("alert")).textContent).toContain("сумму больше нуля");
    expect(h.saveContribution).not.toHaveBeenCalled();
  });

  it("удаление учредителя просит подтверждение и сообщает, что история сохранится", async () => {
    render(<ClaudeFounders month="2026-11" canManage />);
    fireEvent.click(screen.getByLabelText("Удалить учредителя Илхом"));
    expect(screen.getByRole("alertdialog").textContent).toContain("История взносов сохранится");
    expect(h.deleteFounder).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Убрать" }));
    await waitFor(() => expect(h.deleteFounder).toHaveBeenCalledWith("f2"));
  });

  it("добавляет учредителя по имени и возвращает убранного", async () => {
    render(<ClaudeFounders month="2026-11" canManage />);
    fireEvent.change(screen.getByLabelText("Имя нового учредителя"), { target: { value: " Мирсаид " } });
    fireEvent.click(screen.getByRole("button", { name: /^Добавить$/ }));
    await waitFor(() => expect(h.addFounder).toHaveBeenCalledWith("Мирсаид"));
    fireEvent.click(screen.getByRole("button", { name: /Вернуть/ }));
    await waitFor(() => expect(h.restoreFounder).toHaveBeenCalledWith("f3"));
  });

  it("без права записи кнопок изменения нет", () => {
    render(<ClaudeFounders month="2026-11" canManage={false} />);
    expect(screen.queryByRole("button", { name: /Добавить взнос/ })).toBeNull();
    expect(screen.queryByLabelText("Удалить взнос Баходур")).toBeNull();
    expect(screen.queryByLabelText("Имя нового учредителя")).toBeNull();
    expect(screen.queryByRole("button", { name: /Вернуть/ })).toBeNull();
  });

  it("дата взноса по умолчанию: сегодня, а для прошлого месяца его первое число", () => {
    expect(defaultContributionDate("2026-11", "2026-11-17")).toBe("2026-11-17");
    expect(defaultContributionDate("2026-09", "2026-11-17")).toBe("2026-09-01");
    expect(defaultContributionDate("2026-12", "2026-11-17")).toBe("2026-11-17");
  });
});

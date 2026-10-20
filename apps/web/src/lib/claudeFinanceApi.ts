import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExpenseCategoryItem, ExpenseUpcomingItem, ExpensePivot, ExpenseReceiptItem, ExpenseSortKey, ClientSource, ExpenseCategory, Currency } from "@royal-home/shared";
import type { Expense, RecurringExpense } from "../hooks/useFinance";
import { invalidateExpenseQueries } from "../hooks/useFinance";
import { api } from "./api";
import { useAuthStore } from "../store/auth";
import { EXPENSE_PAYMENT_METHODS, EXPENSE_METHOD_LABELS, resolvePermissions } from "@royal-home/shared";
import type { MyProfile } from "./meProfile";
export type ClaudePaymentMethod = (typeof EXPENSE_PAYMENT_METHODS)[number];
export type ClaudeExpenseCategory = ExpenseCategoryItem;
export type ClaudeUpcoming = ExpenseUpcomingItem;
export interface ClaudeExpense extends Expense {
  status?: "PLANNED" | "PAID"; paymentDate?: string | null; counterparty?: string | null;
  paymentMethod?: ClaudePaymentMethod | null; categoryId?: string | null;
  exchangeRate?: string | null; receipts?: ExpenseReceiptItem[]; createdById?: string | null; createdBy?: { id: string; fullName: string } | null; recurringId?: string | null; occurrenceDate?: string | null; createdAt?: string; amountTjs?: number;
}
export interface ClaudeRecurring extends RecurringExpense {
  period?: "WEEK" | "MONTH" | "QUARTER" | "YEAR"; startsOn?: string | null; endsOn?: string | null;
  autoPay?: boolean; categoryId?: string | null; counterparty?: string | null;
  paymentMethod?: ClaudePaymentMethod | null; nextDate?: string | null; skippedDates?: string[];
}
export interface ClaudeExpenseInput {
  version?: number;
  amount: number; exchangeRate?: number | null; category: ExpenseCategory; month: string; currency: Currency;
  note: string | null; source: ClientSource | null; agentId: string | null;
  status: "PLANNED" | "PAID"; paymentDate: string | null; categoryId: string | null;
  counterparty: string | null; paymentMethod: ClaudePaymentMethod | null;
}
export type ClaudeRecurringInput = Partial<Omit<ClaudeRecurring, "id" | "amount">> & { amount?: number };
export interface ClaudeExpenseFilters {
  sortBy?: ExpenseSortKey; sortDirection?: "asc" | "desc";
  month?: string; from?: string; to?: string; page?: number; pageSize?: number;
  categoryId?: string; rootCategory?: ExpenseCategory; counterparty?: string;
  recurringId?: string; paymentMethod?: ClaudePaymentMethod; status?: "PLANNED" | "PAID"; q?: string;
}
export function claudeExpenseQuery(filters: ClaudeExpenseFilters) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== "") q.set(key, String(value));
  return q.toString();
}
/** Stable key of everything that selects WHICH rows are shown (pagination excluded). */
export function claudeExpenseFilterKey(filters: ClaudeExpenseFilters | undefined) {
  if (!filters) return "";
  return JSON.stringify(Object.entries(filters).filter(([key, value]) => key !== "page" && key !== "pageSize" && value !== undefined && value !== "").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
/** Old rows may stay on screen only while the filter set is unchanged (i.e. while paging). */
export function keepExpensePagePlaceholder<T>(data: T | undefined, previous: ClaudeExpenseFilters | undefined, next: ClaudeExpenseFilters): T | undefined {
  return previous && claudeExpenseFilterKey(previous) === claudeExpenseFilterKey(next) ? data : undefined;
}
export function useClaudeExpenses(month: string, enabled = true) {
  return useQuery({ queryKey: ["expenses", "claude-feed", month], queryFn: () => api<ClaudeExpense[]>(`/expenses?month=${month}`), enabled, staleTime: 30_000 });
}
export function useClaudeExpensePage(filters: ClaudeExpenseFilters) {
  return useQuery({ queryKey: ["expenses", "claude-page", filters], queryFn: () => api<{ items: ClaudeExpense[]; total: number; page: number; pageSize: number }>(`/expenses?${claudeExpenseQuery({ page: 1, ...filters })}`), staleTime: 30_000, placeholderData: (data, query) => keepExpensePagePlaceholder(data, query?.queryKey[2] as ClaudeExpenseFilters | undefined, filters) });
}
export function useClaudeExpensePivot(filters: ClaudeExpenseFilters) {
  return useQuery({ queryKey: ["expenses", "claude-pivot", filters], queryFn: () => api<ExpensePivot>(`/expenses/pivot?${claudeExpenseQuery(filters)}`), staleTime: 30_000 });
}
export function useClaudeExpenseCategories() {
  return useQuery({ queryKey: ["expenses", "categories"], queryFn: () => api<ClaudeExpenseCategory[]>("/expenses/categories"), staleTime: 60_000 });
}
export function useClaudeRecurring() {
  return useQuery({ queryKey: ["expenses", "recurring"], queryFn: () => api<ClaudeRecurring[]>("/expenses/recurring"), staleTime: 30_000 });
}
export function useClaudeUpcoming(from: string, to: string) {
  return useQuery({ queryKey: ["expenses", "upcoming", from, to], queryFn: () => api<ClaudeUpcoming[]>(`/expenses/upcoming?from=${from}&to=${to}`), staleTime: 30_000 });
}
export function assertClaudeFinanceWrite(current: Pick<ReturnType<typeof useAuthStore.getState>, "agent" | "sessionEpoch">, context: { actorId?: string; epoch: number; me?: Pick<MyProfile, "readOnly" | "permissions"> }) {
  const { actorId, epoch, me } = context;
    if (!current.agent || current.agent.id !== actorId || current.sessionEpoch !== epoch) throw new Error("Сессия изменилась. Повторите действие в текущей сессии.");
    if (current.agent.role === "SHAREHOLDER" || me?.readOnly) throw new Error("Режим просмотра: изменение финансов недоступно.");
    const granted = me?.permissions ? new Set(me.permissions) : resolvePermissions(current.agent.role, null);
    if (!granted.has("finance.manage")) throw new Error("Нет права на изменение финансов.");
}
function useClaudeMutation<T, R>(run: (value: T) => Promise<R>) {
  const qc = useQueryClient();
  const actorId = useAuthStore(s => s.agent?.id); const epoch = useAuthStore(s => s.sessionEpoch);
  return useMutation({ mutationFn: (value: T) => {
    const current = useAuthStore.getState(); const me = qc.getQueryData<MyProfile>(["me"]);
    assertClaudeFinanceWrite(current, { actorId, epoch, me });
    return run(value);
  }, onSuccess: () => { invalidateExpenseQueries(qc); void qc.invalidateQueries({ queryKey: ["mission-control"] }); } });
}
export function useSaveClaudeExpense() {
  return useClaudeMutation(({ id, body, idempotencyKey }: { id?: string; body: ClaudeExpenseInput; idempotencyKey?: string }) => api<ClaudeExpense>(`/expenses${id ? `/${id}` : ""}`, { method: id ? "PATCH" : "POST", body, idempotencyKey }));
}
export function useDeleteClaudeExpense() { return useClaudeMutation((value: string | { id: string; version?: number }) => { const { id, version } = typeof value === "string" ? { id: value, version: undefined } : value; return api(`/expenses/${id}${version === undefined ? "" : `?version=${version}`}`, { method: "DELETE" }); }); }
export function useRestoreClaudeExpense() { return useClaudeMutation((id: string) => api(`/expenses/${id}/restore`, { method: "PATCH" })); }
export function usePayClaudeExpense() { return useClaudeMutation(({ id, paymentDate }: { id: string; paymentDate?: string }) => api<ClaudeExpense>(`/expenses/${id}/pay`, { method: "POST", body: { paymentDate } })); }
export function useUndoClaudePayment() { return useClaudeMutation((id: string) => api<ClaudeExpense>(`/expenses/${id}/undo-payment`, { method: "POST" })); }
export function useSaveClaudeRecurring() { return useClaudeMutation(({ id, body, idempotencyKey }: { id?: string; body: ClaudeRecurringInput; idempotencyKey?: string }) => api<ClaudeRecurring>(`/expenses/recurring${id ? `/${id}` : ""}`, { method: id ? "PATCH" : "POST", body, idempotencyKey })); }
export function useDeleteClaudeRecurring() { return useClaudeMutation((id: string) => api(`/expenses/recurring/${id}`, { method: "DELETE" })); }
export function useRestoreClaudeRecurring() { return useClaudeMutation((id: string) => api(`/expenses/recurring/${id}/restore`, { method: "PATCH" })); }
export function usePayClaudeRecurring() { return useClaudeMutation(({ id, date }: { id: string; date: string }) => api<ClaudeExpense>(`/expenses/recurring/${id}/pay`, { method: "POST", body: { dueDate: date } })); }
export function useSkipClaudeRecurring() { return useClaudeMutation(({ id, date }: { id: string; date: string }) => api(`/expenses/recurring/${id}/skip`, { method: "POST", body: { dueDate: date } })); }
export function useUndoClaudeRecurring() { return useClaudeMutation(({ id, date }: { id: string; date: string }) => api<ClaudeExpense>(`/expenses/recurring/${id}/undo-payment`, { method: "POST", body: { dueDate: date } })); }
export function useDeleteClaudeReceipt() { return useClaudeMutation(({ id, receiptId }: { id: string; receiptId: string }) => api(`/expenses/${id}/receipts/${receiptId}`, { method: "DELETE" })); }
export function useUploadClaudeReceipt() {
  return useClaudeMutation(({ id, file }: { id: string; file: File }) => { const body = new FormData(); body.append("file", file); return api<ExpenseReceiptItem>(`/expenses/${id}/receipts`, { method: "POST", body }); });
}
export function useSaveClaudeCategory() { return useClaudeMutation(({ id, body }: { id?: string; body: { title: string; rootCategory: ExpenseCategory; parentId?: string | null; icon: string; color: string; budgetMonthly?: number | null; active?: boolean } }) => api<ClaudeExpenseCategory>(`/expenses/categories${id ? `/${id}` : ""}`, { method: id ? "PATCH" : "POST", body })); }
export function useSendClaudeExpenseExport() { return useClaudeMutation((filters: ClaudeExpenseFilters) => api<{ ok: true }>(`/expenses/export/telegram?${claudeExpenseQuery(filters)}`, { method: "POST", body: {} })); }
export async function exportClaudeExpenses(filters: ClaudeExpenseFilters) {
  const blob = await api<Blob>(`/expenses/export?${claudeExpenseQuery(filters)}`, { responseType: "blob" });
  const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "royal-home-expenses.csv"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const CLAUDE_METHOD_LABELS = EXPENSE_METHOD_LABELS;
export const CLAUDE_CATEGORY_TONES = { OFFICE: "office", ADVERTISING: "ads", SALARY: "salary", OTHER: "other" };
export function claudeMoney(amount: number, currency: Currency = "TJS") { return `${amount.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ${currency === "USD" ? "$" : "с."}`; }
export function expenseTjs(expense: Pick<ClaudeExpense, "amount" | "currency" | "exchangeRate">, fallbackRate?: number): number | null {
  const amount = Number(expense.amount); if (!Number.isFinite(amount)) return null;
  if (expense.currency === "TJS") return amount;
  const rate = Number(expense.exchangeRate ?? fallbackRate); return Number.isFinite(rate) && rate > 0 ? Math.round(amount * rate * 100) / 100 : null;
}
export function previousClaudeMonth(month: string) { const [y,m] = month.split("-").map(Number); return `${m === 1 ? y-1 : y}-${String(m === 1 ? 12 : m-1).padStart(2,"0")}`; }
export function claudeMonthRange(month: string) { const [y,m] = month.split("-").map(Number); return { from: `${month}-01`, to: `${month}-${new Date(y,m,0).getDate()}` }; }
export function groupClaudeExpenses(expenses: ClaudeExpense[]) {
  const groups = new Map<string, ClaudeExpense[]>();
  for (const expense of expenses) { const day = expense.paymentDate || "unknown"; groups.set(day, [...(groups.get(day) ?? []), expense]); }
  return [...groups].sort(([a],[b]) => a === "unknown" ? 1 : b === "unknown" ? -1 : b.localeCompare(a));
}
export function parseClaudeQuickExpense(text: string) {
  const match = text.trim().match(/^(\d+(?:[.,]\d{1,2})?)(?:\s+(.+))?$/);
  if (!match) return null; const amount = Number(match[1].replace(",", "."));
  if (amount <= 0 || amount > 99_999_999.99) return null;
  return { amount: match[1], note: match[2] ?? "" };
}

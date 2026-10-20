import { expenseCreateSchema, type ClientSource, type ExpenseCategory } from "@royal-home/shared";
import type { useCreateRecurring } from "../../hooks/useFinance";

/** Form state is textual; request bodies come from the existing shared schema/hooks. */
export interface CleanExpenseDraft {
  amount: string;
  category: ExpenseCategory;
  note: string;
  source: ClientSource | "";
  agentId: string;
  month: string;
  repeat: boolean;
  day: string;
}

type RecurringBody = Parameters<ReturnType<typeof useCreateRecurring>["mutateAsync"]>[0];
type ExpenseBody = ReturnType<typeof expenseCreateSchema.parse>;
type DraftField = keyof CleanExpenseDraft;
export type CleanExpenseRequest =
  | { ok: false; field: DraftField; message: string }
  | { ok: true; kind: "expense"; body: ExpenseBody }
  | { ok: true; kind: "recurring"; body: RecurringBody };

export function prepareCleanExpense(draft: CleanExpenseDraft): CleanExpenseRequest {
  const year = Number(draft.month.split("-")[0]);
  if (year < 1900 || year > new Date().getFullYear() + 1) return { ok: false, field: "month", message: "Выберите месяц с 1900 года до конца следующего года." };
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(draft.amount.trim())) {
    return { ok: false, field: "amount", message: "Без разделителей тысяч: 1000 или 1000,50. После запятой или точки — не больше двух цифр." };
  }
  if (Number(draft.amount.trim().replace(",", ".")) > 99_999_999.99) {
    return { ok: false, field: "amount", message: "Сумма не должна превышать 99 999 999,99 с." };
  }
  const parsed = expenseCreateSchema.safeParse({
    amount: Number(draft.amount.trim().replace(",", ".")),
    month: draft.month,
    category: draft.category,
    note: draft.note.trim() || undefined,
    source: draft.category === "ADVERTISING" ? draft.source || undefined : undefined,
    agentId: draft.category === "SALARY" ? draft.agentId || undefined : undefined,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path[0] as DraftField;
    return { ok: false, field, message: field === "amount" ? "Введите сумму больше нуля, например 500 или 500,50." : issue.message };
  }
  if (!draft.repeat) return { ok: true, kind: "expense", body: parsed.data };

  // Recurring validation still belongs to the existing API. Check its documented
  // title/day bounds before sending; never clamp an entered date silently.
  const title = draft.note.trim();
  if (!title || title.length > 200) return { ok: false, field: "note", message: "Укажите название повторяющегося расхода, до 200 символов." };
  const dayOfMonth = Number(draft.day);
  if (!/^\d{1,2}$/.test(draft.day.trim()) || !Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) {
    return { ok: false, field: "day", message: "Выберите число от 1 до 28: оно есть в каждом месяце." };
  }
  return {
    ok: true,
    kind: "recurring",
    body: {
      title,
      amount: parsed.data.amount,
      currency: "TJS",
      category: parsed.data.category,
      dayOfMonth,
      source: parsed.data.source ?? undefined,
      agentId: parsed.data.agentId ?? undefined,
    },
  };
}

/** A same-tick second submit cannot outrun React's pending render. */
export function createCleanExpenseSubmitLock() {
  let busy = false;
  return {
    isBusy: () => busy,
    async run(action: () => Promise<void>) {
      if (busy) return false;
      busy = true;
      try { await action(); return true; }
      finally { busy = false; }
    },
  };
}

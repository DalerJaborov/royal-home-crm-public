import { useUndoToast } from "../../hooks/useUndoToast";
import { toast } from "../../store/toast";
import { useRef, useState } from "react";
import { ClaudeCategoryIcon as FeedCategoryIcon } from "./ClaudeExpenseFeed";
import type { ExpenseCategory } from "@royal-home/shared";
import { useIsReadOnly } from "../../lib/permissions";
import type { ClaudeExpenseCategory, ClaudeRecurring } from "../../lib/claudeFinanceApi";
export const CLAUDE_PERIOD_LABELS = { WEEK: "Каждую неделю", MONTH: "Каждый месяц", QUARTER: "Каждый квартал", YEAR: "Каждый год" };
export function ClaudeCategoryIcon({ root, category }: { root: ExpenseCategory; category?: ClaudeExpenseCategory }) {
 return <FeedCategoryIcon category={root} detail={category} />;
}
export function claudeDateLabel(date: string) {
 const value = new Date(`${date}T12:00:00Z`);
 return Number.isNaN(value.getTime()) ? date : value.toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
}
export function shiftClaudeMonth(month: string, shift: number) {
 const [year, number] = month.split("-").map(Number);const value = new Date(Date.UTC(year, number - 1 + shift, 1));return value.toISOString().slice(0, 7);
}
/** Forecast only, anchored to the contractual day; February does not shift March. */
export function nextClaudeRecurringDates(row: Pick<ClaudeRecurring, "nextDate" | "startsOn" | "endsOn" | "period" | "dayOfMonth"> & { skippedDates?: string[] }, count = 6) {
 if (!row.nextDate) return [];
 const result: string[] = [], first = new Date(`${row.nextDate}T12:00:00Z`);
 if (Number.isNaN(first.getTime())) return [];
 const period = row.period ?? "MONTH", day = row.dayOfMonth;
 for (let step = 0; result.length < count && step < count + 100; step++) {
  let value: Date;
  if (period === "WEEK") value = new Date(first.getTime() + step * 7 * 86400000);
  else { const months = step * (period === "QUARTER" ? 3 : period === "YEAR" ? 12 : 1); const base = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + months, 1, 12)); value = step === 0 ? first : new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), Math.min(day || first.getUTCDate(), new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate()), 12)); }
  const key = value.toISOString().slice(0, 10);if (row.endsOn && key > row.endsOn) break;if (!row.skippedDates?.includes(key)) result.push(key);
 }
 return result;
}
export function claudeCalendarDays(month: string) {
 const [y, m] = month.split("-").map(Number), start = new Date(Date.UTC(y, m - 1, 1));const offset = (start.getUTCDay() + 6) % 7;
 const days = new Date(Date.UTC(y, m, 0)).getUTCDate();const length = Math.ceil((offset + days) / 7) * 7;
 return Array.from({ length }, (_, index) => { const d = new Date(Date.UTC(y, m - 1, index - offset + 1));return { key: d.toISOString().slice(0, 10), number: d.getUTCDate(), inMonth: d.getUTCMonth() === m - 1 }; });
}
export function useClaudeUndo(canManage: boolean) {
 const readonly = useIsReadOnly(), allowed = canManage && !readonly;
 const allowedRef = useRef(allowed); allowedRef.current = allowed;
 const [error, setError] = useState<string | null>(null), { showUndoToast } = useUndoToast();
 function recorded(message: string, undo?: () => Promise<unknown>) {
  setError(null);showUndoToast({ message, duration: 10_000, onUndo: undo ? () => {
   if (!allowedRef.current) { toast.error("Доступ только для просмотра. Отмена изменения недоступна.");return; }
   void undo().catch(e => toast.error(e instanceof Error ? e.message : "Не удалось отменить"));
  } : undefined });
 }
 const feedback = error ? <p className="cef-error" role="alert">{error}</p> : null;
 return { allowed, allowedRef, error, setError, recorded, feedback };
}

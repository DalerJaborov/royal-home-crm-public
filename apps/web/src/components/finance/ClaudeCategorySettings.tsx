import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, expenseCategorySchema, type ExpenseCategory, type ExpenseCategoryItem } from "@royal-home/shared";
import { api } from "../../lib/api";
import { useIsReadOnly } from "../../lib/permissions";
import { claudeMonthRange, claudeMoney, useClaudeExpenseCategories, useClaudeExpensePivot } from "../../lib/claudeFinanceApi";
import { Rh2Sheet } from "../rh2/Rh2Sheet";
import { ClaudeCategoryIcon } from "./ClaudeExpenseFeed";

const ICONS = ["building-2", "wifi", "phone", "coffee", "server", "user", "megaphone", "wallet"];
const ICON_NAMES: Record<string, string> = { "building-2": "Здание", wifi: "Интернет", phone: "Телефон", coffee: "Офис", server: "Сервер", user: "Сотрудник", megaphone: "Реклама", wallet: "Прочее" };
type Draft = { title: string; rootCategory: ExpenseCategory; parentId: string; icon: string; color: string; budget: string; active: boolean };
const blank = (): Draft => ({ title: "", rootCategory: "OFFICE", parentId: "", icon: "building-2", color: "", budget: "", active: true });
function draftOf(row: ExpenseCategoryItem): Draft {
  return { title: row.title, rootCategory: row.rootCategory, parentId: row.parentId ?? "", icon: row.icon.toLowerCase() === "building2" ? "building-2" : row.icon.toLowerCase() === "walletcards" ? "wallet" : row.icon.toLowerCase(), color: row.color, budget: row.budgetMonthly ?? "", active: row.active };
}
function descendantIds(id: string, rows: ExpenseCategoryItem[]) {
  const ids = new Set([id]);
  for (let i = 0; i < rows.length; i++) {
    const next = rows.filter((row) => row.parentId && ids.has(row.parentId) && !ids.has(row.id));
    if (!next.length) break;
    next.forEach((row) => ids.add(row.id));
  }
  return ids;
}
export function ClaudeCategorySettings({ month, canManage, onClose }: { month: string; canManage: boolean; onClose: () => void }) {
  const readOnly = useIsReadOnly();
  const writable = canManage && !readOnly;
  const allowed = useRef(writable); allowed.current = writable;
  const categories = useClaudeExpenseCategories();
  const range = claudeMonthRange(month);
  const pivot = useClaudeExpensePivot({ ...range, status: "PAID" });
  const rows = categories.data ?? [];
  const [selected, setSelected] = useState<ExpenseCategoryItem | null | undefined>(undefined);
  const [draft, setDraft] = useState<Draft>(blank);
  const [error, setError] = useState<string | null>(null);
  const form = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const save = useMutation({ mutationFn: async (body: ReturnType<typeof expenseCategorySchema.parse>) => {
    if (!allowed.current) throw new Error("Ваш доступ изменился: редактирование недоступно.");
    return api<ExpenseCategoryItem>(`/expenses/categories${selected?.id ? `/${selected.id}` : ""}`, { method: selected ? "PATCH" : "POST", body });
  }, onSuccess: async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ["expenses"] }), queryClient.invalidateQueries({ queryKey: ["finance-summary"] })]);
    setSelected(undefined); setError(null);
  } });
  async function submit() {
    if (!allowed.current || save.isPending || selected === undefined) return;
    const budget = draft.budget.trim();
    if (budget && !/^\d+(?:[.,]\d{1,2})?$/.test(budget)) { setError("Введите лимит без разделителей тысяч: 1000 или 1000,50."); form.current?.querySelector<HTMLInputElement>('[name="budget"]')?.focus(); return; }
    if (budget && Number(budget.replace(",", ".")) > 99_999_999.99) { setError("Лимит должен быть не больше 99 999 999,99 с."); form.current?.querySelector<HTMLInputElement>('[name="budget"]')?.focus(); return; }
    if (!draft.title.trim()) { setError("Укажите название категории."); form.current?.querySelector<HTMLInputElement>('[name="title"]')?.focus(); return; }
    const parsed = expenseCategorySchema.safeParse({ title: draft.title, rootCategory: draft.rootCategory, parentId: draft.parentId || null, icon: draft.icon, color: draft.color, budgetMonthly: budget ? Number(budget.replace(",", ".")) : null, active: draft.active });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      form.current?.querySelector<HTMLInputElement>('[name="title"]')?.focus(); return;
    }
    try { await save.mutateAsync(parsed.data); } catch (cause) { setError(cause instanceof Error ? cause.message : "Категория не сохранилась. Повторите попытку."); }
  }
  const open = (row: ExpenseCategoryItem | null) => { if (!writable) return; setSelected(row); setDraft(row ? draftOf(row) : { ...blank(), color: rows.find(category => category.rootCategory === "OFFICE" && !category.parentId)?.color ?? "" }); setError(null); };
  const spentFor = (row: ExpenseCategoryItem) => {
    const descendants = descendantIds(row.id, rows);
    return (pivot.data?.rows ?? []).filter((entry) => descendants.has(entry.categoryId) || !row.parentId && entry.categoryId === row.rootCategory).reduce((total, entry) => total + Object.values(entry.values).reduce((n, value) => n + value, 0), 0);
  };
  const excludedParents = selected ? descendantIds(selected.id, rows) : new Set<string>();
  return <Rh2Sheet title="Категории и лимиты" ariaLabel="Категории и лимиты расходов" className="cef-sheet" onClose={onClose} dismissible={!save.isPending} onSubmit={(event) => { event.preventDefault(); void submit(); }} footer={selected !== undefined && writable ? <div className="cef-sheet-footer"><button className="cef-btn cef-soft" type="button" disabled={save.isPending} onClick={() => setSelected(undefined)}>Назад к категориям</button><button className="cef-btn cef-black" type="submit" disabled={save.isPending}>{save.isPending ? "Сохраняем…" : "Сохранить"}</button></div> : undefined}>
    <div className="cef">
      <p className="cef-muted">Лимит — план по категории на месяц. Он не меняет реальные расходы и не является остатком банковского счёта.</p>
      {error && <p className="cef-error" role="alert" id="cef-category-error">{error}</p>}
      {categories.isError ? <p className="cef-error" role="alert">Категории не загрузились. <button className="cef-btn" type="button" onClick={() => void categories.refetch()}>Повторить</button></p> : categories.isPending ? <p role="status">Загружаем категории…</p> : selected === undefined ? <>
        {writable && <button className="cef-btn cef-blue" type="button" onClick={() => open(null)}><Plus size={18} />Добавить категорию</button>}
        {EXPENSE_CATEGORIES.map((root) => <div className="cef-category-group" key={root}><h3>{EXPENSE_CATEGORY_LABELS[root]}</h3>{rows.filter((row) => row.rootCategory === root).map((row) => {
          const spent = spentFor(row); const limit = Number(row.budgetMonthly); const bounded = row.budgetMonthly !== null;
          const content = <><ClaudeCategoryIcon category={root} detail={row} /><div className="cef-row-text"><strong>{row.title}{!row.active ? " · в архиве" : ""}</strong><span>{row.parentId ? rows.find((p) => p.id === row.parentId)?.title : "Основная категория"}</span>{bounded && !pivot.isError && !pivot.isPending && <><small>{claudeMoney(spent)} из {claudeMoney(limit)} в {month}</small><progress className="cef-budget" max={Math.max(1, limit)} value={Math.min(spent, Math.max(1, limit))} aria-label={`Лимит ${row.title}`} /></>}{bounded && pivot.isError && <small>Расходы для лимита не загрузились</small>}</div></>;
          return writable ? <button className="cef-row cef-row-button" type="button" key={row.id} onClick={() => open(row)}>{content}</button> : <div className="cef-row" key={row.id}>{content}</div>;
        })}</div>)}
      </> : <div className="cef-form-fields" ref={form}><fieldset className="cef-fields" disabled={!writable || save.isPending}>
        <label>Название<input name="title" value={draft.title} autoFocus maxLength={100} aria-describedby={error ? "cef-category-error" : undefined} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        <label>Группа<select disabled={!!selected} value={draft.rootCategory} onChange={(event) => setDraft({ ...draft, rootCategory: event.target.value as ExpenseCategory, parentId: "" })}>{EXPENSE_CATEGORIES.map((category) => <option value={category} key={category}>{EXPENSE_CATEGORY_LABELS[category]}</option>)}</select>{selected && <small>Группа сохранена для истории расходов.</small>}</label>
        <label>Внутри категории<select value={draft.parentId} onChange={(event) => setDraft({ ...draft, parentId: event.target.value })}><option value="">Основная категория</option>{rows.filter((row) => row.active && row.rootCategory === draft.rootCategory && !excludedParents.has(row.id)).map((row) => <option value={row.id} key={row.id}>{row.title}</option>)}</select></label>
        <label>Иконка<select value={draft.icon} onChange={(event) => setDraft({ ...draft, icon: event.target.value })}>{ICONS.map((icon) => <option value={icon} key={icon}>{ICON_NAMES[icon]}</option>)}</select></label>
        <label>Цвет<input type="color" value={draft.color} aria-label="Цвет категории" onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></label>
        <label>Лимит на месяц, с.<input name="budget" inputMode="decimal" value={draft.budget} placeholder="Без лимита" onChange={(event) => setDraft({ ...draft, budget: event.target.value })} /></label>
        <label className="cef-check"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} />Использовать для новых расходов</label>
      </fieldset></div>}
    </div>
  </Rh2Sheet>;
}

import { RuDateField } from "../look/fields/RuFields";
import { useMemo, useState, type FormEvent } from "react";
import { Pencil, Plus, RotateCcw, Trash2, Users, X } from "lucide-react";
import type { FounderContributionItem, FounderItem, FounderTotalsRow } from "@royal-home/shared";
import { dushanbeTodayKey } from "../../lib/date";
import { claudeMoney } from "../../lib/claudeFinanceApi";
import { useAddFounder, useDeleteContribution, useDeleteFounder, useFounderContributions, useFounderTotals, useFounders, useRestoreContribution, useRestoreFounder, useSaveContribution, useUpdateFounder } from "../../lib/foundersApi";
import { Rh2Sheet } from "../rh2/Rh2Sheet";
import { ConfirmDialog } from "../ConfirmDialog";
import { claudeDateLabel, useClaudeUndo } from "./ClaudeFinancePresentation";

const AMOUNT_RE = /^\d+(?:[.,]\d{1,2})?$/;

/** Дата по умолчанию для нового взноса: сегодня, а в прошлом месяце его первое число (будущее нельзя). */
export function defaultContributionDate(month: string, today = dushanbeTodayKey()): string {
  return month < today.slice(0, 7) ? `${month}-01` : today;
}

interface ContributionDraft { founderId: string; amount: string; currency: "TJS" | "USD"; exchangeRate: string; date: string; note: string }
type Recorded = (message: string, undo?: () => Promise<unknown>) => void;

/** Вкладка «Учредители»: кто и сколько вложил (не доход от продаж). */
export function ClaudeFounders({ month, canManage }: { month: string; canManage: boolean }) {
  const totals = useFounderTotals(month), contributions = useFounderContributions(month), founders = useFounders(true);
  const deleteContribution = useDeleteContribution(), restoreContribution = useRestoreContribution(), deleteFounder = useDeleteFounder(), restoreFounder = useRestoreFounder();
  const feedback = useClaudeUndo(canManage);
  const [sheet, setSheet] = useState<{ row: FounderContributionItem | null } | null>(null);
  const [removingFounder, setRemovingFounder] = useState<FounderItem | null>(null), [busy, setBusy] = useState<string | null>(null);
  const all = useMemo(() => founders.data ?? [], [founders.data]);
  const active = useMemo(() => all.filter((f) => !f.deleted), [all]);
  const archived = useMemo(() => all.filter((f) => f.deleted), [all]);
  const rows = contributions.data ?? [];
  const loading = totals.isLoading || contributions.isLoading || founders.isLoading;
  const failed = totals.isError || contributions.isError || founders.isError;

  async function removeContribution(row: FounderContributionItem) {
    if (!feedback.allowedRef.current) return;
    setBusy(row.id);
    try {
      await deleteContribution.mutateAsync(row.id);
      feedback.recorded(`Взнос ${row.founderName}, ${claudeMoney(Number(row.amount), row.currency)}, удалён`, () => restoreContribution.mutateAsync(row.id));
    } catch (e) { feedback.setError(e instanceof Error ? e.message : "Не удалось удалить взнос"); } finally { setBusy(null); }
  }
  async function confirmRemoveFounder() {
    const founder = removingFounder;
    if (!feedback.allowedRef.current || !founder) return;
    setRemovingFounder(null); setBusy(founder.id);
    try {
      await deleteFounder.mutateAsync(founder.id);
      feedback.recorded(`${founder.name} убран из списка. История взносов сохранена.`, () => restoreFounder.mutateAsync(founder.id));
    } catch (e) { feedback.setError(e instanceof Error ? e.message : "Не удалось убрать учредителя"); } finally { setBusy(null); }
  }
  async function bringBack(founder: FounderItem) {
    if (!feedback.allowedRef.current) return;
    setBusy(founder.id);
    try {
      await restoreFounder.mutateAsync(founder.id);
      feedback.recorded(`${founder.name} возвращён в список`, () => deleteFounder.mutateAsync(founder.id));
    } catch (e) { feedback.setError(e instanceof Error ? e.message : "Не удалось вернуть учредителя"); } finally { setBusy(null); }
  }

  return <section className="cef-founders" aria-label="Учредители">
    <header className="cef-section-head"><div><h2>Учредители</h2><p>Сколько вложил каждый учредитель</p></div>{feedback.allowed && active.length > 0 && <button className="cef-btn cef-blue" type="button" onClick={() => setSheet({ row: null })}><Plus size={18} aria-hidden />Добавить взнос</button>}</header>
    {feedback.feedback}
    <p className="cef-caption cef-founders-note">Взносы учредителей не доход от продаж: в прибыль и комиссию не входят.</p>
    {loading ? <div className="cef-loading" role="status" aria-busy="true">Загружаем взносы…</div>
      : failed ? <div className="cef-error" role="alert">Взносы не загрузились. <button className="cef-btn" type="button" onClick={() => { void totals.refetch(); void contributions.refetch(); void founders.refetch(); }}>Повторить</button></div>
      : <>
        <div className="cef-founder-cards">
          {(totals.data?.founders ?? []).map((row) => <FounderCard key={row.founderId} row={row} />)}
          <div className="cef-founder-card cef-founder-total"><span>Всего</span><strong>{claudeMoney(totals.data?.monthTjs ?? 0)}</strong><small>за месяц</small><small>{claudeMoney(totals.data?.allTimeTjs ?? 0)} за всё время</small></div>
        </div>
        <h3 className="cef-founders-h">Взносы за месяц</h3>
        {rows.length === 0
          ? <div className="cef-empty"><Users size={44} aria-hidden /><h3>В этом месяце взносов нет</h3><p>{active.length ? "Нажмите «Добавить взнос», когда учредитель внесёт деньги." : "Сначала добавьте учредителей в списке ниже."}</p></div>
          : <ul className="cef-founder-list">{rows.map((row) => <li className="cef-row" key={row.id}>
            <span className="cef-row-copy"><strong>{row.founderName}</strong><small>{claudeDateLabel(row.date)}{row.note ? ` · ${row.note}` : ""}</small>{row.createdBy && <small>Записал {row.createdBy.fullName}</small>}</span>
            <strong className="cef-amount">{claudeMoney(Number(row.amount), row.currency)}{row.currency === "USD" && <small>{claudeMoney(row.amountTjs)}</small>}</strong>
            {feedback.allowed && <span className="cef-founder-actions"><button className="cef-icon-btn" type="button" aria-label={`Изменить взнос ${row.founderName}`} disabled={busy === row.id} onClick={() => setSheet({ row })}><Pencil size={18} aria-hidden /></button><button className="cef-icon-btn" type="button" aria-label={`Удалить взнос ${row.founderName}`} disabled={busy === row.id} onClick={() => void removeContribution(row)}><Trash2 size={18} aria-hidden /></button></span>}
          </li>)}</ul>}
        <FounderList active={active} archived={archived} canManage={feedback.allowed} busy={busy} onRemove={setRemovingFounder} onRestore={(f) => void bringBack(f)} onError={feedback.setError} onDone={feedback.recorded} />
      </>}
    {sheet && <ContributionSheet row={sheet.row} month={month} founders={all} canManage={feedback.allowed} onClose={() => setSheet(null)} onSaved={feedback.recorded} />}
    {feedback.allowed && removingFounder && <ConfirmDialog title={`Убрать ${removingFounder.name} из списка?`} description="История взносов сохранится. Вернуть учредителя можно в любой момент." confirmLabel="Убрать" onConfirm={() => void confirmRemoveFounder()} onCancel={() => setRemovingFounder(null)} />}
  </section>;
}

function FounderCard({ row }: { row: FounderTotalsRow }) {
  return <div className="cef-founder-card"><span>{row.name}{row.deleted && <em> · убран из списка</em>}</span><strong>{claudeMoney(row.monthTjs)}</strong><small>за месяц</small><small>{claudeMoney(row.allTimeTjs)} за всё время</small></div>;
}

function FounderList({ active, archived, canManage, busy, onRemove, onRestore, onError, onDone }: {
  active: FounderItem[]; archived: FounderItem[]; canManage: boolean; busy: string | null;
  onRemove: (f: FounderItem) => void; onRestore: (f: FounderItem) => void;
  onError: (message: string | null) => void; onDone: Recorded;
}) {
  const add = useAddFounder(), update = useUpdateFounder(), remove = useDeleteFounder();
  const [name, setName] = useState(""), [editingId, setEditingId] = useState<string | null>(null), [editName, setEditName] = useState("");
  async function submitNew(event: FormEvent) {
    event.preventDefault();
    const value = name.trim();
    if (!value) { onError("Укажите имя учредителя."); return; }
    try {
      const created = await add.mutateAsync(value);
      setName(""); onError(null);
      onDone(`${created.name} добавлен в список учредителей`, () => remove.mutateAsync(created.id));
    } catch (e) { onError(e instanceof Error ? e.message : "Не удалось добавить учредителя"); }
  }
  async function submitRename(founder: FounderItem) {
    const value = editName.trim();
    if (!value) { onError("Имя не может быть пустым."); return; }
    if (value === founder.name) { setEditingId(null); return; }
    try {
      await update.mutateAsync({ id: founder.id, body: { name: value } });
      setEditingId(null);
      onDone(`Имя изменено: ${value}`, () => update.mutateAsync({ id: founder.id, body: { name: founder.name } }));
    } catch (e) { onError(e instanceof Error ? e.message : "Не удалось изменить имя"); }
  }
  return <section className="cef-founders-list" aria-label="Список учредителей">
    <h3 className="cef-founders-h">Список учредителей</h3>
    {active.length === 0 && <p className="cef-caption">Пока никого нет. Впишите имя ниже.</p>}
    <ul className="cef-founder-names">{active.map((f) => <li key={f.id}>
      {editingId === f.id
        ? <form className="cef-founder-edit" onSubmit={(e) => { e.preventDefault(); void submitRename(f); }}><input aria-label={`Новое имя для ${f.name}`} autoFocus maxLength={80} value={editName} onChange={(e) => setEditName(e.target.value)} /><button className="cef-btn cef-blue" type="submit" disabled={update.isPending}>Сохранить</button><button className="cef-icon-btn" type="button" aria-label="Отменить переименование" onClick={() => setEditingId(null)}><X size={18} aria-hidden /></button></form>
        : <><span>{f.name}</span>{canManage && <span className="cef-founder-actions"><button className="cef-icon-btn" type="button" aria-label={`Переименовать ${f.name}`} disabled={busy === f.id} onClick={() => { setEditingId(f.id); setEditName(f.name); }}><Pencil size={18} aria-hidden /></button><button className="cef-icon-btn" type="button" aria-label={`Удалить учредителя ${f.name}`} disabled={busy === f.id} onClick={() => onRemove(f)}><Trash2 size={18} aria-hidden /></button></span>}</>}
    </li>)}</ul>
    {canManage && <form className="cef-founder-add" onSubmit={(e) => void submitNew(e)}><input aria-label="Имя нового учредителя" placeholder="Имя учредителя" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /><button className="cef-btn cef-blue" type="submit" disabled={add.isPending}><Plus size={16} aria-hidden />Добавить</button></form>}
    {archived.length > 0 && <><h4 className="cef-founders-h">Убраны из списка</h4><p className="cef-caption">Их взносы остаются в истории и в итогах за всё время.</p><ul className="cef-founder-names">{archived.map((f) => <li key={f.id}><span>{f.name}</span>{canManage && <button className="cef-btn" type="button" disabled={busy === f.id} onClick={() => onRestore(f)}><RotateCcw size={16} aria-hidden />Вернуть</button>}</li>)}</ul></>}
  </section>;
}

function ContributionSheet({ row, month, founders, canManage, onClose, onSaved }: { row: FounderContributionItem | null; month: string; founders: FounderItem[]; canManage: boolean; onClose: () => void; onSaved: Recorded }) {
  const save = useSaveContribution(), removeContribution = useDeleteContribution();
  const [draft, setDraft] = useState<ContributionDraft>(() => row
    ? { founderId: row.founderId, amount: row.amount, currency: row.currency, exchangeRate: row.exchangeRate ?? "", date: row.date, note: row.note ?? "" }
    : { founderId: founders.find((f) => !f.deleted)?.id ?? "", amount: "", currency: "TJS", exchangeRate: "", date: defaultContributionDate(month), note: "" });
  const [error, setError] = useState<string | null>(null), [key] = useState(() => crypto.randomUUID());
  const choices = founders.filter((f) => !f.deleted || f.id === row?.founderId);
  const set = <K extends keyof ContributionDraft>(field: K, value: ContributionDraft[K]) => { setDraft((d) => ({ ...d, [field]: value })); setError(null); };
  async function submit() {
    if (save.isPending) return;
    const amount = Number(draft.amount.replace(",", ".")), rate = Number(draft.exchangeRate.replace(",", "."));
    if (!draft.founderId) return setError("Выберите учредителя.");
    if (!AMOUNT_RE.test(draft.amount.trim()) || !(amount > 0) || amount > 99_999_999.99) return setError("Введите сумму больше нуля: 1000 или 1000,50.");
    if (!draft.date || draft.date > dushanbeTodayKey()) return setError("Выберите дату не позже сегодняшней.");
    if (draft.currency === "USD" && draft.exchangeRate.trim() && (!AMOUNT_RE.test(draft.exchangeRate.trim()) || !(rate > 0) || rate > 1000)) return setError("Курс: число больше нуля, не больше 1000.");
    const body = { founderId: draft.founderId, amount, currency: draft.currency, ...(draft.currency === "USD" && draft.exchangeRate.trim() ? { exchangeRate: rate } : {}), date: draft.date, note: draft.note.trim() || null };
    const who = founders.find((f) => f.id === draft.founderId)?.name ?? "учредитель";
    try {
      if (row) {
        const before = { founderId: row.founderId, amount: Number(row.amount), currency: row.currency, exchangeRate: row.exchangeRate ? Number(row.exchangeRate) : null, date: row.date, note: row.note };
        await save.mutateAsync({ id: row.id, body });
        onSaved(`Взнос ${who} изменён`, () => save.mutateAsync({ id: row.id, body: before }));
      } else {
        const created = await save.mutateAsync({ body, idempotencyKey: key });
        onSaved(`Взнос записан: ${who}, ${claudeMoney(amount, draft.currency)}`, () => removeContribution.mutateAsync(created.id));
      }
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "Не удалось сохранить взнос"); }
  }
  return <Rh2Sheet className="cef-sheet" title={row ? "Изменить взнос" : "Новый взнос"} onClose={onClose} dismissible={!save.isPending} closeOnBackdrop={false} onSubmit={() => void submit()} footer={<><button className="cef-btn" type="button" disabled={save.isPending} onClick={onClose}><X size={16} aria-hidden />Отмена</button><button className="cef-btn primary" type="submit" disabled={!canManage || save.isPending}>{save.isPending ? "Сохраняем…" : "Сохранить"}</button></>}>
    <div className="cef-sub-editor">{error && <p className="cef-error" role="alert">{error}</p>}
      <fieldset disabled={!canManage || save.isPending}>
        <label>Учредитель<select value={draft.founderId} onChange={(e) => set("founderId", e.target.value)}><option value="">Выберите</option>{choices.map((f) => <option key={f.id} value={f.id}>{f.name}{f.deleted ? " (убран из списка)" : ""}</option>)}</select></label>
        <label>Сумма<input inputMode="decimal" value={draft.amount} onChange={(e) => set("amount", e.target.value)} placeholder="0" /></label>
        <label>Валюта<select value={draft.currency} onChange={(e) => set("currency", e.target.value as "TJS" | "USD")}><option value="TJS">Сомони</option><option value="USD">Доллары</option></select></label>
        {draft.currency === "USD" && <label>Курс, с. за $, необязательно<input inputMode="decimal" value={draft.exchangeRate} onChange={(e) => set("exchangeRate", e.target.value)} placeholder="Если пусто, возьмём курс CRM" /></label>}
        <label>Дата<RuDateField max={dushanbeTodayKey()} value={draft.date} onChange={(e) => set("date", e.target.value)} /></label>
        <label>Заметка<input maxLength={300} value={draft.note} onChange={(e) => set("note", e.target.value)} placeholder="Например, на рекламу" /></label>
      </fieldset>
    </div>
  </Rh2Sheet>;
}

import { useLayoutEffect, useRef, useState } from "react";
import { Banknote, Building2, CalendarDays, Check, ChevronLeft, Megaphone, Repeat2, WalletCards } from "lucide-react";
import { CLIENT_SOURCES, CLIENT_SOURCE_LABELS, EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, type ClientSource, type ExpenseCategory } from "@royal-home/shared";
import { useAgents } from "../../hooks/useAgents";
import { useCreateExpense, useCreateRecurring } from "../../hooks/useFinance";
import { CButton } from "../clean/ui";
import { Rh2Sheet } from "../rh2/Rh2Sheet";
import { createCleanExpenseSubmitLock, prepareCleanExpense, type CleanExpenseDraft } from "./cleanExpenseDraft";
import { isReadOnlyRoleError } from "../../lib/apiError";

const CATEGORIES = {
  ADVERTISING: { icon: Megaphone, hint: "Продвижение и привлечение клиентов" },
  SALARY: { icon: Banknote, hint: "Выплата конкретному сотруднику" },
  OFFICE: { icon: Building2, hint: "Аренда, связь, серверы и сервисы" },
  OTHER: { icon: WalletCards, hint: "Остальные расходы компании" },
} satisfies Record<ExpenseCategory, { icon: typeof Megaphone; hint: string }>;
const PRESETS: { title: string; category: ExpenseCategory }[] = [
  { title: "Аренда офиса", category: "OFFICE" },
  { title: "Интернет и связь", category: "OFFICE" },
  { title: "Сервер и домены", category: "OFFICE" },
  { title: "Телефония, АТС", category: "OFFICE" },
  { title: "Хранилище файлов", category: "OFFICE" },
  { title: "Реклама у блогеров", category: "ADVERTISING" },
];
const STEPS = ["Сколько", "За что", "Когда"];
const INITIAL = { amount: "", category: "OFFICE" as ExpenseCategory, note: "", source: "" as ClientSource | "", agentId: "", repeat: false, day: "1" };

/** Desktop presentation of the existing expense and monthly-template contracts. */
export function CleanExpenseWizard({ open, onClose, month, canManage }: {
  open: boolean; onClose: () => void; month: string; canManage: boolean;
}) {
  const create = useCreateExpense();
  const recurring = useCreateRecurring();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState(INITIAL);
  const [accountingMonth, setAccountingMonth] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<keyof CleanExpenseDraft | null>(null);
  const fields = useRef<HTMLFieldSetElement>(null);
  useLayoutEffect(() => {
    if (errorField) fields.current?.querySelector<HTMLElement>(`[data-expense-field="${errorField}"]`)?.focus();
  }, [errorField, step, error]);
  const lock = useRef(createCleanExpenseSubmitLock());
  const agents = useAgents({ enabled: open && canManage && draft.category === "SALARY" });
  const current: CleanExpenseDraft = { ...draft, month: accountingMonth ?? month };
  const pending = working || create.isPending || recurring.isPending;
  const needsNote = draft.category === "OFFICE" || draft.category === "OTHER";

  function change<K extends keyof typeof INITIAL>(key: K, value: typeof INITIAL[K]) {
    if (pending) return;
    setDraft((previous) => ({ ...previous, [key]: value }));
    setError(null);
    setErrorField(null);
  }
  function close() { if (!lock.current.isBusy() && !pending) onClose(); }
  function back() { if (!pending) { setStep((value) => Math.max(0, value - 1)); setError(null); } }

  async function advance() {
    if (!canManage || pending || lock.current.isBusy()) return;
    if (step === 0) {
      // Shared monetary validation, even before the attribution fields are filled.
      const amountCheck = prepareCleanExpense({ ...current, category: "OTHER", note: "Проверка суммы", repeat: false });
      if (!amountCheck.ok) { setErrorField(amountCheck.field); setError(amountCheck.message); return; }
      setError(null); setStep(1); return;
    }
    const request = prepareCleanExpense(current);
    if (!request.ok) {
      setErrorField(request.field);
      setError(request.message);
      if (["day", "month"].includes(request.field)) setStep(2);
      if (step === 2 && ["note", "source", "agentId"].includes(request.field)) setStep(1);
      return;
    }
    if (step === 1) { setError(null); setStep(2); return; }
    await lock.current.run(async () => {
      setWorking(true); setError(null);
      try {
        if (request.kind === "recurring") await recurring.mutateAsync(request.body);
        else await create.mutateAsync(request.body);
        setDraft(INITIAL); setAccountingMonth(null); setStep(0);
        onClose();
      } catch (reason) {
        setError(isReadOnlyRoleError(reason) ? "Режим просмотра: запись расходов недоступна для вашей роли. Данные формы не отправлены повторно." : reason instanceof Error ? reason.message : "Не удалось записать расход. Данные сохранены в форме — повторите.");
      } finally { setWorking(false); }
    });
  }

  return <Rh2Sheet open={open && canManage} title="Добавить расход" onClose={close} dismissible={!pending}
    closeOnBackdrop={false} onSubmit={() => void advance()}
    footer={<>
      <CButton variant="soft" disabled={pending} onClick={step > 0 ? back : close}>
        {step > 0 ? <><ChevronLeft size={20} aria-hidden="true" />Назад</> : "Закрыть"}
      </CButton>
      <CButton type="submit" disabled={pending}>{pending ? "Сохраняем…" : step < 2 ? "Продолжить" : draft.repeat ? "Создать шаблон" : "Записать расход"}</CButton>
    </>}>
    <fieldset ref={fields} aria-busy={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
    <div data-clean-expense-wizard="" style={{ display: "grid", gap: 24 }}>
      <ol aria-label="Шаги добавления расхода" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, listStyle: "none", margin: 0, padding: 0 }}>
        {STEPS.map((label, index) => <li key={label} aria-current={index === step ? "step" : undefined}
          style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, color: index === step ? "rgb(var(--rgb-accent))" : "var(--muted)" }}>
          <span aria-hidden="true" style={{ width: 28, height: 28, borderRadius: 14, display: "grid", placeItems: "center", background: index === step ? "rgb(var(--rgb-accent))" : "var(--track)", color: index === step ? "white" : "var(--ink)", flexShrink: 0 }}>
            {index < step ? <Check size={16} /> : index + 1}
          </span>{label}
        </li>)}
      </ol>
      <div aria-live="polite"><h3 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>{STEPS[step]}</h3>
        <p style={{ fontSize: 15, color: "var(--muted)", marginTop: 8 }}>{step === 0 ? "Введите сумму в сомони." : step === 1 ? "Укажите назначение, чтобы расход было легко найти позже." : "Проверьте запись и выберите разовый расход или ежемесячный шаблон."}</p>
      </div>
      {step === 0 && <label className="field">
        <span className="lab">Сумма, сомони</span>
        <input key="amount" className="inp" autoFocus inputMode="decimal" autoComplete="off" placeholder="0" value={draft.amount}
          onChange={(event) => change("amount", event.target.value)} data-expense-field="amount" aria-invalid={errorField === "amount"} aria-describedby={errorField === "amount" ? "clean-expense-error" : undefined} aria-required="true"
          style={{ maxWidth: "none", minHeight: 80, fontSize: 40, fontVariantNumeric: "tabular-nums", padding: "16px 18px" }} />
      </label>}
      {step === 1 && <>
        <div role="group" aria-label="Категория расхода" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
          {EXPENSE_CATEGORIES.map((category) => { const Icon = CATEGORIES[category].icon; const selected = category === draft.category;
            return <button key={category} type="button" aria-pressed={selected} onClick={() => change("category", category)}
              style={{ minHeight: 110, padding: 16, borderRadius: 18, textAlign: "left", background: selected ? "rgb(var(--rgb-accent) / .10)" : "var(--track)", color: "var(--ink)", display: "grid", gap: 6 }}>
              <Icon size={26} aria-hidden="true" style={{ color: selected ? "rgb(var(--rgb-accent))" : "var(--muted)" }} />
              <strong style={{ fontSize: 16 }}>{EXPENSE_CATEGORY_LABELS[category]}{selected && <Check size={16} aria-hidden="true" style={{ display: "inline", marginLeft: 6 }} />}</strong>
              <span style={{ fontSize: 13, lineHeight: 1.4, color: "var(--muted)" }}>{CATEGORIES[category].hint}</span>
            </button>;
          })}
        </div>
        <label className="field"><span className="lab">Назначение расхода{needsNote ? " *" : " · необязательно"}</span>
          <input className="inp" maxLength={draft.repeat ? 200 : 300} placeholder="Например: аренда офиса" data-expense-field="note" aria-required={needsNote} aria-invalid={errorField === "note"} aria-describedby={errorField === "note" ? "clean-expense-error" : undefined} value={draft.note} onChange={(event) => change("note", event.target.value)} style={{ maxWidth: "none" }} />
        </label>
        {draft.category === "ADVERTISING" && <label className="field"><span className="lab">Канал рекламы *</span>
          <select className="inp" data-expense-field="source" aria-invalid={errorField === "source"} aria-describedby={errorField === "source" ? "clean-expense-error" : undefined} aria-required="true" value={draft.source} onChange={(event) => change("source", event.target.value as ClientSource | "")} style={{ maxWidth: "none" }}>
            <option value="">Выберите канал</option>{CLIENT_SOURCES.map((source) => <option key={source} value={source}>{CLIENT_SOURCE_LABELS[source]}</option>)}
          </select>
        </label>}
        {draft.category === "SALARY" && <>
          <label className="field"><span className="lab">Сотрудник *</span>
            <select className="inp" data-expense-field="agentId" aria-invalid={errorField === "agentId"} aria-describedby={errorField === "agentId" ? "clean-expense-error" : undefined} aria-required="true" value={draft.agentId} disabled={agents.isPending || agents.isError} onChange={(event) => change("agentId", event.target.value)} style={{ maxWidth: "none" }}>
              <option value="">{agents.isPending ? "Загружаем сотрудников…" : "Выберите сотрудника"}</option>{agents.data?.map((agent) => <option key={agent.id} value={agent.id}>{agent.fullName}</option>)}
            </select>
          </label>
          {agents.isError && <div role="alert"><p>Сотрудники не загрузились.</p><CButton variant="soft" onClick={() => void agents.refetch()}>Повторить загрузку</CButton></div>}
        </>}
        <div><p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>Частые назначения</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{PRESETS.map((preset) => <CButton key={preset.title} size="sm" variant="soft"
            onClick={() => { if (pending) return; setDraft((previous) => ({ ...previous, note: preset.title, category: preset.category })); setError(null); setErrorField(null); }}>{preset.title}</CButton>)}</div>
        </div>
      </>}
      {step === 2 && <>
        <div role="group" aria-label="Повторять расход" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
          {[false, true].map((repeat) => <button key={String(repeat)} type="button" aria-pressed={draft.repeat === repeat} onClick={() => change("repeat", repeat)}
            style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 64, padding: 16, borderRadius: 16, fontSize: 15, color: "var(--ink)", background: draft.repeat === repeat ? "rgb(var(--rgb-accent) / .10)" : "var(--track)" }}>
            {repeat ? <Repeat2 size={24} aria-hidden="true" /> : <CalendarDays size={24} aria-hidden="true" />}{repeat ? "Каждый месяц" : "Разовый"}
          </button>)}
        </div>
        {draft.repeat ? <>
          <label className="field"><span className="lab">Число месяца · от 1 до 28</span><input className="inp" inputMode="numeric" data-expense-field="day" aria-invalid={errorField === "day"} aria-describedby={errorField === "day" ? "clean-expense-error" : undefined} aria-required="true" value={draft.day} onChange={(event) => change("day", event.target.value)} style={{ maxWidth: 140 }} /></label>
          <label className="field"><span className="lab">Название шаблона *</span><input className="inp" maxLength={200} data-expense-field="note" aria-required="true" aria-invalid={errorField === "note"} aria-describedby={errorField === "note" ? "clean-expense-error" : undefined} value={draft.note} placeholder="Например: аренда офиса" onChange={(event) => change("note", event.target.value)} style={{ maxWidth: "none" }} /></label>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--muted)" }}>Создаётся ежемесячный шаблон. В указанное число CRM заведёт расход; банковское списание этот шаблон не выполняет.</p>
        </> : <>
          <label className="field"><span className="lab">Месяц учёта</span><input className="inp" type="month" data-expense-field="month" aria-invalid={errorField === "month"} aria-describedby={errorField === "month" ? "clean-expense-error" : undefined} aria-required="true" value={current.month} onChange={(event) => { if (pending) return; setAccountingMonth(event.target.value); setError(null); setErrorField(null); }} style={{ maxWidth: "none" }} /></label>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--muted)" }}>Расход попадёт в выбранный месяц. Точная дата оплаты пока не хранится.</p>
        </>}
        <div aria-label="Итог расхода" style={{ padding: 20, borderRadius: 18, background: "var(--track)", display: "grid", gap: 10 }}>
          <strong style={{ fontSize: 28, fontVariantNumeric: "tabular-nums" }}>{Number(draft.amount.replace(",", ".")).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} с.</strong>
          <span style={{ fontSize: 16 }}>{draft.note.trim() || EXPENSE_CATEGORY_LABELS[draft.category]}</span>
          <span style={{ fontSize: 14, color: "var(--muted)" }}>{EXPENSE_CATEGORY_LABELS[draft.category]}{draft.category === "ADVERTISING" && draft.source ? ` · ${CLIENT_SOURCE_LABELS[draft.source]}` : ""}{draft.category === "SALARY" ? ` · ${agents.data?.find((agent) => agent.id === draft.agentId)?.fullName ?? "Выбранный сотрудник"}` : ""}</span>
          <span style={{ fontSize: 14, color: "var(--muted)" }}>{draft.repeat ? `Каждый месяц, ${draft.day}-го числа` : `Месяц учёта: ${new Date(`${current.month}-01T12:00:00`).toLocaleDateString("ru-RU", {month:"long",year:"numeric",timeZone:"Asia/Dushanbe"})}`}</span>
        </div>
      </>}
      {error && <p id="clean-expense-error" className="state err" role="alert" style={{ fontSize: 15 }}>{error}</p>}
    </div>
    </fieldset>
  </Rh2Sheet>;
}

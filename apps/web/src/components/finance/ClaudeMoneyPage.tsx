import { useEffect, useRef, useState, type ReactNode } from "react";
import { Archive, ChevronLeft, ChevronRight, Download, MoreHorizontal, Plus, SlidersHorizontal } from "lucide-react";
import { Link } from "react-router-dom";
import { useIsReadOnly } from "../../lib/permissions";
import { useMobileUx } from "../../hooks/useMobileUx";
import { Rh2Inline } from "../rh2/Rh2Scope";
import type { FinanceWorkspace } from "../../lib/financeWorkspace";
import type { ClaudeExpense } from "../../lib/claudeFinanceApi";
import { ClaudeExpenseFeed } from "./ClaudeExpenseFeed";
import { ClaudeExpenseSheet } from "./ClaudeExpenseSheet";
import { ClaudeSubscriptions } from "./ClaudeSubscriptions";
import { ClaudePaymentCalendar } from "./ClaudePaymentCalendar";
import { ClaudeExpenseTable } from "./ClaudeExpenseTable";
import { ClaudeCategorySettings } from "./ClaudeCategorySettings";

const TABS: { key: FinanceWorkspace; label: string }[] = [
  { key: "expenses", label: "Расходы" }, { key: "recurring", label: "Подписки" },
  { key: "calendar", label: "Календарь" }, { key: "table", label: "Таблица" },
  { key: "overview", label: "Обзор и прогноз" }, { key: "payouts", label: "Выплаты" },
];
function monthName(month: string) {
  return new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "Asia/Dushanbe" })
    .format(new Date(`${month}-15T12:00:00Z`));
}
function moveMonth(month: string, direction: number) {
  const date = new Date(`${month}-15T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + direction);
  return date.toISOString().slice(0, 7);
}

/** The approved Claude money workspace, using live CRM controllers. */
export function ClaudeMoneyPage({ month, onMonthChange, workspace, onWorkspaceChange, canManage, archiveAllowed, overview, payouts, onExport, exporting, exportError }: {
  month: string; onMonthChange: (month: string) => void;
  workspace: FinanceWorkspace; onWorkspaceChange: (workspace: FinanceWorkspace) => void;
  canManage: boolean; archiveAllowed: boolean; overview: ReactNode; payouts: ReactNode;
  onExport: () => void; exporting: boolean; exportError: string | null;
}) {
  const readOnly = useIsReadOnly();
  const mobile = useMobileUx();
  const writable = canManage && !readOnly;
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsRef = useRef<HTMLDetailsElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [sheet, setSheet] = useState<{ expense: ClaudeExpense | null; initialDate?: string; initialRecurring?: boolean } | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  useEffect(() => {
    if (!mobile) return;
    const tabs = tabsRef.current;
    const active = tabs?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!tabs || !active) return;
    const track = tabs.getBoundingClientRect();
    const selected = active.getBoundingClientRect();
    const delta = selected.left < track.left ? selected.left - track.left
      : selected.right > track.right ? selected.right - track.right : 0;
    if (delta) tabs.scrollTo({ left: tabs.scrollLeft + delta, behavior: "instant" });
  }, [mobile, workspace]);
  useEffect(() => {
    // Keep the originating action visible until the sheet restores focus.
    // A portal is outside <details>; its pointer events must not dismiss it.
    if (!mobile || !toolsOpen || categoriesOpen || sheet) return;
    const closeOutside = (event: PointerEvent) => {
      if (!toolsRef.current?.contains(event.target as Node)) setToolsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setToolsOpen(false);
      toolsRef.current?.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [mobile, toolsOpen, categoriesOpen, sheet]);
  const add = (initialDate?: string, initialRecurring = false) => { if (writable) setSheet({ expense: null, initialDate, initialRecurring }); };
  const edit = (expense: ClaudeExpense) => setSheet({ expense });
  const monthControls = <div className="cef-month-controls">
    <button type="button" className="cef-icon-btn" aria-label="Предыдущий месяц" disabled={month <= "1900-01"} onClick={() => onMonthChange(moveMonth(month, -1))}><ChevronLeft /></button>
    <label className="cef-month-picker"><span className="sr-only">Месяц финансов</span><input type="month" value={month} min="1900-01" max="2199-12" onChange={(event) => { if (/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(event.target.value)) onMonthChange(event.target.value); }} /></label>
    <button type="button" className="cef-icon-btn" aria-label="Следующий месяц" disabled={month >= "2199-12"} onClick={() => onMonthChange(moveMonth(month, 1))}><ChevronRight /></button>
  </div>;
  return <div className="cef cef-page">
    <header className="cef-toolbar">
      <div className="cef-title"><h1>Деньги</h1><p>{monthName(month)} · всё в сомони</p></div>
      <div ref={tabsRef} className="cef-pills cef-main-tabs" role="tablist" aria-label="Разделы денег" onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
        const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next]?.focus(); tabs[next]?.click();
      }}>{TABS.map((tab) => <button type="button" key={tab.key} role="tab" className={workspace === tab.key ? "cef-active" : ""} id={`finance-tab-${tab.key}`} aria-selected={workspace === tab.key} aria-controls={`finance-panel-${tab.key}`} tabIndex={workspace === tab.key ? 0 : -1} onClick={() => onWorkspaceChange(tab.key)}>{tab.label}</button>)}</div>
      {writable && <button type="button" className="cef-btn cef-blue cef-add" onClick={() => add()}><Plus size={20} />Расход</button>}
    </header>
    <div className="cef-tools">
      {workspace !== "calendar" && monthControls}
      <details ref={toolsRef} className="cef-tool-disclosure" open={!mobile || toolsOpen} onToggle={(event) => { if (mobile) setToolsOpen(event.currentTarget.open); }}>
        <summary className="cef-icon-btn" aria-label="Действия с финансами"><MoreHorizontal aria-hidden="true" /></summary>
        <div className="cef-tool-actions">
          <button type="button" className="cef-btn cef-soft" onClick={() => setCategoriesOpen(true)}><SlidersHorizontal size={18} /><span>Категории и лимиты</span></button>
          <button type="button" className="cef-icon-btn" aria-label="Скачать общую финансовую выгрузку" disabled={exporting} onClick={onExport}><Download /><span className="cef-mobile-action-label">Скачать CSV</span></button>
          {archiveAllowed && <Link className="cef-icon-btn" aria-label="Архив расходов" to="/archive"><Archive /><span className="cef-mobile-action-label">Архив расходов</span></Link>}
        </div>
      </details>
    </div>
    {exportError && <p className="cef-error" role="alert">{exportError}</p>}
    <section className="cef-panel" role="tabpanel" id={`finance-panel-${workspace}`} aria-labelledby={`finance-tab-${workspace}`}>
      {workspace === "expenses" && <ClaudeExpenseFeed month={month} canManage={writable} onAdd={() => add()} onEdit={edit} />}
      {workspace === "recurring" && <ClaudeSubscriptions month={month} canManage={writable} onAdd={() => add(undefined, true)} />}
      {workspace === "calendar" && <ClaudePaymentCalendar month={month} onMonthChange={onMonthChange} canManage={writable} onAdd={add} onEdit={edit} />}
      {workspace === "table" && <ClaudeExpenseTable month={month} canManage={writable} onAdd={() => add()} onEdit={edit} />}
      {workspace === "overview" && <Rh2Inline className="cef-overview">{overview}</Rh2Inline>}
      {workspace === "payouts" && <Rh2Inline className="cef-overview">{payouts}</Rh2Inline>}
    </section>
    {sheet && <ClaudeExpenseSheet key={sheet.expense?.id ?? `new:${sheet.initialDate ?? "today"}:${sheet.initialRecurring}`} month={month} canManage={writable} editing={sheet.expense} initialDate={sheet.initialDate} initialRecurring={sheet.initialRecurring} onClose={() => setSheet(null)} />}
    {categoriesOpen && <ClaudeCategorySettings month={month} canManage={writable} onClose={() => setCategoriesOpen(false)} />}
  </div>;
}

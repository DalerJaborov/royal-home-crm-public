import { useRef, useState, type ReactNode } from "react";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { Banknote, Building2, Check, ChevronRight, Coffee, CreditCard, Megaphone, Phone, Server, User, Wifi, Paperclip, Repeat2, Search, SlidersHorizontal, WalletCards } from "lucide-react";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "@royal-home/shared";
import { useFinanceSummary } from "../../hooks/useFinance";
import { useUndoToast } from "../../hooks/useUndoToast";
import { useIsReadOnly } from "../../lib/permissions";
import { useMobileUx } from "../../hooks/useMobileUx";
import { CLAUDE_CATEGORY_TONES, CLAUDE_METHOD_LABELS, claudeMoney, claudeMonthRange, groupClaudeExpenses, previousClaudeMonth, useClaudeExpenseCategories, useClaudeExpensePage, useClaudeUpcoming, usePayClaudeExpense, usePayClaudeRecurring, useUndoClaudePayment, useUndoClaudeRecurring, type ClaudeExpense, type ClaudeExpenseCategory, type ClaudePaymentMethod, type ClaudeUpcoming } from "../../lib/claudeFinanceApi";
const ICONS = { OFFICE: Building2, ADVERTISING: Megaphone, SALARY: Banknote, OTHER: WalletCards };
export function ClaudeCategoryIcon({ category, detail }: { category: ExpenseCategory; detail?: ClaudeExpenseCategory }) {
  const custom = { "building-2": Building2, building: Building2, building2: Building2, walletcards: WalletCards, wifi: Wifi, phone: Phone, coffee: Coffee, server: Server, user: User, megaphone: Megaphone, banknote: Banknote, wallet: WalletCards };
  const Icon = detail ? custom[detail.icon.toLowerCase() as keyof typeof custom] ?? ICONS[category] : ICONS[category]; return <span className={`cef-ic cef-${CLAUDE_CATEGORY_TONES[category]}`} style={detail ? { backgroundColor: detail.color } : undefined}><Icon size={22} aria-hidden="true" /></span>;
}
export function claudeToday() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dushanbe", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function dayLabel(day: string) {
  if (day === "unknown") return "Дата платежа не указана";
  if (day === claudeToday()) return "Сегодня";
  const yesterday = new Date(`${claudeToday()}T12:00:00Z`); yesterday.setUTCDate(yesterday.getUTCDate()-1);
  if (day === yesterday.toISOString().slice(0,10)) return "Вчера";
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("ru-RU", { day:"numeric", month:"long", timeZone:"UTC" });
}
export function claudeExpenseEmptyKind(total: number, hasFilters: boolean): "no-match" | "first" {
  return hasFilters || total ? "no-match" : "first";
}
export function ClaudeExpenseFeed({ month, canManage, onAdd, onEdit, monthControls }: { month: string; canManage: boolean; onAdd: () => void; onEdit: (expense: ClaudeExpense) => void; monthControls?: ReactNode }) {
  const readOnly = useIsReadOnly(); const writable = canManage && !readOnly;
  const mobile = useMobileUx(); const [filtersOpen, setFiltersOpen] = useState(false);
  const categories = useClaudeExpenseCategories(); const summary = useFinanceSummary(2, true, month);
  const range = claudeMonthRange(month); const upcoming = useClaudeUpcoming(range.from, range.to);
  const pay = usePayClaudeExpense(); const payRecurring = usePayClaudeRecurring(); const undo = useUndoClaudePayment(); const undoRecurring = useUndoClaudeRecurring();
  const { showUndoToast } = useUndoToast(); const [search, setSearch] = useState(""); const [category, setCategory] = useState<ExpenseCategory | "">("");const [categoryId,setCategoryId]=useState("");
  const [counterparty,setCounterparty] = useState(""); const [method,setMethod] = useState(""); const [plan,setPlan] = useState(false);
  const activeFilterCount = [category, categoryId, counterparty, method, plan].filter(Boolean).length;
  const [busy,setBusy] = useState<string|null>(null); const busyRef=useRef(false); const [error,setError] = useState<string|null>(null);
  const [pageState,setPageState]=useState({month,page:1});const page=pageState.month===month?pageState.page:1;
  function setPage(value:number|((old:number)=>number)){setPageState({month,page:typeof value==="number"?value:value(page)});}
  const q=useDebouncedValue(search.trim(),300);
  const expenses=useClaudeExpensePage({month,page,pageSize:50,categoryId:categoryId||undefined,rootCategory:category||undefined,counterparty:counterparty||undefined,paymentMethod:(method||undefined) as ClaudePaymentMethod|undefined,status:plan?"PLANNED":undefined,q:q||undefined});
  const lastPage=useRef<{month:string;data:NonNullable<typeof expenses.data>}|null>(null);
  if(expenses.data) lastPage.current={month,data:expenses.data};
  const pageData=expenses.data??(lastPage.current?.month===month?lastPage.current.data:undefined);
  const hasFilters=!!search.trim()||activeFilterCount>0;
  const monthly=summary.data?.months.find(m=>m.month===month);
  const previous=summary.data?.months.find(m=>m.month===previousClaudeMonth(month));
  const missingRate=!monthly;
  const total=monthly?.totalExpenses??0;
  const byCategory=EXPENSE_CATEGORIES.map(cat=>({category:cat,total:monthly?.expenses[cat]??0}));
  const today=claudeToday(); const comparable=!!previous&&previous.totalExpenses>0&&month<today.slice(0,7);
  const delta=comparable?Math.round((total/previous.totalExpenses-1)*100):null;
  const parties=[...new Set((pageData?.items??[]).map(e=>e.counterparty).filter((p):p is string=>!!p))];
  const filtered=pageData?.items??[];
  async function markPaid(row: ClaudeUpcoming) {
    if (!writable || busyRef.current) return; busyRef.current=true; setBusy(row.id); setError(null);
    try {
      if(row.expenseId) { await pay.mutateAsync({id:row.expenseId,paymentDate:today}); showUndoToast({message:`Оплачено: ${row.title}`,duration:10000,onUndo:()=>{void undo.mutateAsync(row.expenseId!).catch(e=>setError(e instanceof Error?e.message:"Не удалось отменить оплату"));}}); }
      else if(row.recurringId) { await payRecurring.mutateAsync({id:row.recurringId,date:row.dueDate}); showUndoToast({message:`Оплачено: ${row.title}`,duration:10000,onUndo:()=>{void undoRecurring.mutateAsync({id:row.recurringId!,date:row.dueDate}).catch(e=>setError(e instanceof Error?e.message:"Не удалось отменить оплату"));}}); }
    } catch(e) { setError(e instanceof Error?e.message:"Оплата не записана. Повторите."); }
    finally {busyRef.current=false;setBusy(null);}
  }
  if(expenses.isPending&&!pageData) return <div className="cef-card" role="status"><div className="cef-skeleton" /><p>Загружаем расходы…</p></div>;
  if(expenses.isError) return <div className="cef-card" role="alert"><h2>Расходы не загрузились</h2><p>Данные не потеряны. Повторите запрос.</p><button type="button" className="cef-btn" onClick={()=>void expenses.refetch()}>Повторить</button></div>;
  return <div className="cef-feed">
    <section className="cef-card" aria-label="Расходы месяца">
      <div className="cef-head"><div><small>Потрачено за {new Date(`${month}-15T12:00:00Z`).toLocaleDateString("ru-RU",{month:"long",timeZone:"UTC"})}</small><div className="cef-kpi">{missingRate?"—":claudeMoney(total)}</div></div>{delta!==null&&<span className={`cef-chip ${delta<=0?"cef-green":"cef-orange"}`}>{delta>0?"+":""}{delta}% к прошлому месяцу</span>}{monthControls}</div>
      {missingRate&&<p className="cef-muted">Сводка месяца не загрузилась. Суммы не вычисляем по одной странице расходов. <button type="button" className="cef-btn" onClick={()=>void summary.refetch()}>Повторить сводку</button></p>}
      <div className="cef-bar" aria-label="Распределение расходов">{byCategory.map(c=>c.total>0&&<span key={c.category} className={`cef-${CLAUDE_CATEGORY_TONES[c.category]}`} style={{width:`${total?c.total/total*100:0}%`}} title={`${EXPENSE_CATEGORY_LABELS[c.category]}: ${claudeMoney(c.total)}`}/>)}</div>
      <div className="cef-legend">{byCategory.map(c=><button type="button" key={c.category} onClick={()=>{setCategory(category===c.category?"":c.category);setPage(1);}} aria-pressed={category===c.category}><i className={`cef-dot cef-${CLAUDE_CATEGORY_TONES[c.category]}`}/>{EXPENSE_CATEGORY_LABELS[c.category]} <b>{monthly?claudeMoney(c.total):"—"}</b></button>)}</div>
    </section>
    <section className="cef-card" aria-label="Предстоящие платежи"><div className="cef-head"><h2>Предстоящие платежи</h2><span className="cef-chip cef-orange">{(upcoming.data??[]).filter(r=>r.status==="PLANNED").length}</span></div>
      {upcoming.isError?<div role="alert">Платежи не загрузились. <button type="button" className="cef-btn" onClick={()=>void upcoming.refetch()}>Повторить</button></div>:upcoming.isPending?<p role="status">Загружаем платежи…</p>:(upcoming.data??[]).filter(r=>r.status==="PLANNED").map(row=><div className="cef-row" key={row.id}><ClaudeCategoryIcon category={row.category} detail={categories.data?.find(c=>c.id===row.categoryId)}/><div className="cef-row-text"><strong>{row.title}</strong><span className={row.dueDate<today?"cef-overdue":"cef-muted"}>{dayLabel(row.dueDate)}{row.dueDate<today?" · просрочено":""}{row.counterparty?` · ${row.counterparty}`:""}</span></div><strong className="cef-value">{claudeMoney(Number(row.amount),row.currency)}</strong>{writable&&<button type="button" className="cef-btn cef-black" disabled={!!busy} onClick={()=>void markPaid(row)}><Check size={17}/>{busy===row.id?"Записываем…":"Оплатил"}</button>}</div>)}
      {!upcoming.isPending&&!upcoming.isError&&!(upcoming.data??[]).some(r=>r.status==="PLANNED")&&<p className="cef-muted">В этом месяце нет неоплаченных платежей.</p>}
    </section>
    {error&&<p className="cef-error" role="alert">{error}</p>}
    <section className="cef-card"><div className="cef-head"><h2>Траты</h2><span className="cef-muted">{filtered.length} из {pageData?.total??0}</span></div>
      <div className="cef-feed-search"><label className="cef-search"><Search size={18}/><input aria-label="Поиск расходов" placeholder="Поиск трат" value={search} maxLength={200} onChange={e=>{setSearch(e.target.value);setPage(1);}}/></label></div><details className="cef-feed-filter-disclosure" open={!mobile || filtersOpen} onToggle={(event) => { if (mobile) setFiltersOpen(event.currentTarget.open); }}><summary><SlidersHorizontal size={18} aria-hidden="true"/>Фильтры{activeFilterCount > 0 && <span className="cef-chip cef-blue">{activeFilterCount}</span>}</summary><div className="cef-filters"><select aria-label="Категория" value={category} onChange={e=>{setCategory(e.target.value as ExpenseCategory|"");setPage(1);}}><option value="">Все категории</option>{EXPENSE_CATEGORIES.map(c=><option key={c} value={c}>{EXPENSE_CATEGORY_LABELS[c]}</option>)}</select><select aria-label="Статья расходов" value={categoryId} onChange={e=>{setCategoryId(e.target.value);setPage(1);}}><option value="">Все статьи</option>{categories.data?.filter(c=>c.active).map(c=><option value={c.id} key={c.id}>{c.title}</option>)}</select><input aria-label="Контрагент" placeholder="Кому платили" list="cef-feed-parties" value={counterparty} maxLength={200} onChange={e=>{setCounterparty(e.target.value);setPage(1);}}/><datalist id="cef-feed-parties">{parties.map(p=><option value={p} key={p}/>)}</datalist><select aria-label="Способ оплаты" value={method} onChange={e=>{setMethod(e.target.value);setPage(1);}}><option value="">Все способы</option>{Object.entries(CLAUDE_METHOD_LABELS).map(([key,title])=><option value={key} key={key}>{title}</option>)}</select><button type="button" className={`cef-chip ${plan?"cef-blue":""}`} aria-pressed={plan} onClick={()=>{setPlan(!plan);setPage(1);}}>Только план</button>{activeFilterCount > 0 && <button type="button" className="cef-btn" onClick={() => { setCategory(""); setCategoryId(""); setCounterparty(""); setMethod(""); setPlan(false); setPage(1); }}>Сбросить фильтры</button>}</div></details>
      {expenses.isFetching&&<p className="cef-muted" role="status">Обновляем список…</p>}
      {groupClaudeExpenses(filtered).map(([day,rows])=><div className="cef-day" key={day}><div className="cef-day-head"><h3>{dayLabel(day)}</h3>{day==="unknown"&&<small>Исторические расходы: известен месяц, не день оплаты</small>}</div>{rows.map(e=>{const custom=categories.data?.find(c=>c.id===e.categoryId);const content=<><ClaudeCategoryIcon category={e.category} detail={custom}/><div className="cef-row-text"><strong>{e.note||custom?.title||EXPENSE_CATEGORY_LABELS[e.category]}</strong><span>{e.counterparty||e.agent?.fullName||custom?.title||EXPENSE_CATEGORY_LABELS[e.category]}{e.paymentMethod?` · ${CLAUDE_METHOD_LABELS[e.paymentMethod]}`:""}</span></div><div className="cef-row-tags">{e.autoKey&&<span className="cef-chip"><Repeat2 size={14}/>авто</span>}{e.status==="PLANNED"&&<span className="cef-chip cef-orange">план</span>}{!!e.receipts?.length&&<Paperclip size={17} aria-label="Есть чек"/>}</div><strong className="cef-value">{claudeMoney(Number(e.amount),e.currency)}</strong><ChevronRight size={17}/></>;return <button type="button" className="cef-row cef-row-button" key={e.id} onClick={()=>onEdit(e)} aria-label={`${writable?"Изменить":"Просмотреть"}: ${e.note||EXPENSE_CATEGORY_LABELS[e.category]}`}>{content}</button>;})}</div>)}
      <div className="cef-pagination"><button type="button" className="cef-btn" disabled={page<=1||expenses.isFetching} onClick={()=>setPage(p=>p-1)}>Назад</button><span>Страница {page} · всего {pageData?.total??0}</span><button type="button" className="cef-btn" disabled={expenses.isFetching||page*50>=(pageData?.total??0)} onClick={()=>setPage(p=>p+1)}>Далее</button></div>
      {!filtered.length&&<div className="cef-empty"><CreditCard size={36}/><h3>{claudeExpenseEmptyKind(pageData?.total??0,hasFilters)==="first"?"Здесь будут траты компании":"Ничего не найдено"}</h3><p>{claudeExpenseEmptyKind(pageData?.total??0,hasFilters)==="first"?"Добавьте первый расход: сумму, категорию и дату.":"Измените поиск или фильтры."}</p>{writable&&claudeExpenseEmptyKind(pageData?.total??0,hasFilters)==="first"&&<button type="button" className="cef-btn cef-blue" onClick={onAdd}>Добавить расход</button>}</div>}
    </section>
  </div>;
}

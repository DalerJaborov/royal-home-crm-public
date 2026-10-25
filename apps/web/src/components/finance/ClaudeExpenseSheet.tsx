import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, ChevronDown, Delete, FileText, Sparkles, Store, X } from "lucide-react";
import { CLIENT_SOURCES, CLIENT_SOURCE_LABELS, EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, expenseCreateSchema, expenseDateSchema, type ClientSource, type ExpenseCategory } from "@royal-home/shared";
import { useAgents } from "../../hooks/useAgents";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useScrollLock } from "../../hooks/useScrollLock";
import { useUndoToast } from "../../hooks/useUndoToast";
import { useIsReadOnly } from "../../lib/permissions";
import { api } from "../../lib/api";
import { ApiError, isReadOnlyRoleError } from "../../lib/apiError";
import { CLAUDE_METHOD_LABELS, claudeMoney, parseClaudeQuickExpense, useClaudeExpenseCategories, useClaudeExpensePage, claudeMonthRange, useSaveClaudeExpense, useSaveClaudeRecurring, useUploadClaudeReceipt, useDeleteClaudeExpense, useDeleteClaudeRecurring, useDeleteClaudeReceipt, useRestoreClaudeExpense, type ClaudeExpense, type ClaudeExpenseInput, type ClaudePaymentMethod } from "../../lib/claudeFinanceApi";
import { ClaudeCategoryIcon, claudeToday } from "./ClaudeExpenseFeed";
export interface ClaudeExpenseDraft {
  amount: string; exchangeRate: string; currency: "TJS"|"USD"; category: ExpenseCategory; categoryId: string; note: string;
  source: ClientSource|""; agentId: string; paymentDate: string; counterparty: string;
  paymentMethod: ClaudePaymentMethod|""; status: "PAID"|"PLANNED";
}
export function prepareClaudeExpense(draft: ClaudeExpenseDraft, month: string): { body: ClaudeExpenseInput } | { field: keyof ClaudeExpenseDraft; message: string } {
  if(!/^\d+(?:[.,]\d{1,2})?$/.test(draft.amount.trim())) return {field:"amount",message:"Без разделителей тысяч: 1000 или 1000,50. Не больше двух цифр после запятой."};
  const amount=Number(draft.amount.replace(",","."));
  if(amount<=0||amount>99_999_999.99) return {field:"amount",message:"Введите сумму от 0,01 до 99 999 999,99."};
  if(draft.paymentDate&&!expenseDateSchema.safeParse(draft.paymentDate).success) return {field:"paymentDate",message:"Выберите корректную дату платежа."};
  if(draft.status==="PAID"&&draft.paymentDate>claudeToday()) return {field:"paymentDate",message:"Будущий платёж можно сохранить только как план."};
  if(draft.status==="PLANNED"&&!draft.paymentDate) return {field:"paymentDate",message:"Для плана нужна дата платежа."};
  if(draft.exchangeRate&&(!/^\d+(?:[.,]\d{1,2})?$/.test(draft.exchangeRate)||Number(draft.exchangeRate.replace(",","."))<=0||Number(draft.exchangeRate.replace(",","."))>1000)) return {field:"exchangeRate",message:"Введите курс больше нуля, не больше 1000 с. за доллар."};
  const basic={amount,category:draft.category,month: draft.paymentDate?draft.paymentDate.slice(0,7):month,note:draft.note.trim()||null,source:draft.category==="ADVERTISING"?draft.source||null:null,agentId:draft.category==="SALARY"?draft.agentId||null:null};
  const parsed=expenseCreateSchema.safeParse(basic);
  if(!parsed.success) {const issue=parsed.error.issues[0]; return {field:issue.path[0] as keyof ClaudeExpenseDraft,message:issue.message};}
  return {body:{...basic,currency:draft.currency,...(draft.currency==="USD"&&draft.exchangeRate?{exchangeRate:Number(draft.exchangeRate.replace(",","."))}:{}),status:draft.status,paymentDate:draft.paymentDate||null,categoryId:draft.categoryId||null,counterparty:draft.counterparty.trim()||null,paymentMethod:draft.paymentMethod||null}};
}
export function claudeExpenseDraft(editing?:ClaudeExpense|null):ClaudeExpenseDraft {
  return {amount:editing?.amount??"",exchangeRate:editing?.exchangeRate??"",currency:editing?.currency??"TJS",category:editing?.category??"OFFICE",categoryId:editing?.categoryId??"",note:editing?.note??"",source:editing?.source??"",agentId:editing?.agentId??"",paymentDate:editing?editing.paymentDate??"":claudeToday(),counterparty:editing?.counterparty??"",paymentMethod:editing?.paymentMethod??"",status:editing?.status??"PAID"};
}
export function initialClaudeExpenseDraft(editing:ClaudeExpense|null|undefined,month:string,initialDate?:string):ClaudeExpenseDraft {
  const base=claudeExpenseDraft(editing);if(editing)return base;
  const date=initialDate??(month===claudeToday().slice(0,7)?claudeToday():`${month}-01`);
  return {...base,paymentDate:date,status:date>claudeToday()?"PLANNED":"PAID"};
}
export function nextClaudeExpenseDate(date:string,period:"WEEK"|"MONTH"|"QUARTER"|"YEAR") {
  const d=new Date(date+"T12:00:00Z");if(period==="WEEK"){d.setUTCDate(d.getUTCDate()+7);return d.toISOString().slice(0,10);}
  const increment=period==="MONTH"?1:period==="QUARTER"?3:12;const day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+increment);const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return d.toISOString().slice(0,10);
}
export function ClaudeExpenseSheet({month,canManage,editing: initialEditing,onClose,initialDate,initialRecurring=false}:{month:string;canManage:boolean;editing?:ClaudeExpense|null;initialDate?:string;initialRecurring?:boolean;onClose:()=>void}) {
  // Snapshot and optimistic version must come from the same opening read.
  const editing = useRef(initialEditing).current;
  const readOnly=useIsReadOnly();const writable=canManage&&!readOnly;const templateOnly=initialRecurring&&!editing;
  const initial=()=>initialClaudeExpenseDraft(editing,month,initialDate);
  const [draft,setDraft]=useState(initial);const [quick,setQuick]=useState("");const [more,setMore]=useState(!!editing||initialRecurring||!!initialDate);const [repeat,setRepeat]=useState(initialRecurring);const [period,setPeriod]=useState<"WEEK"|"MONTH"|"QUARTER"|"YEAR">("MONTH");const [autoPay,setAutoPay]=useState(false);const [endsOn,setEndsOn]=useState("");const [allCategories,setAllCategories]=useState(false);
  const [receipt,setReceipt]=useState<File|null>(null);const [error,setError]=useState<string|null>(null);const [field,setField]=useState<keyof ClaudeExpenseDraft|null>(null);const [working,setWorking]=useState(false);
  const saving=useRef(false);const submitted=useRef<{body:ClaudeExpenseInput;key:string}|null>(null);const repeatKey=useRef<string|null>(null);const saved=useRef<{expense:ClaudeExpense;templateId?:string;receiptId?:string}|null>(null);
  const save=useSaveClaudeExpense();const recurring=useSaveClaudeRecurring();const upload=useUploadClaudeReceipt();const remove=useDeleteClaudeExpense();const removeRecurring=useDeleteClaudeRecurring();const deleteReceipt=useDeleteClaudeReceipt();const restore=useRestoreClaudeExpense();const {showUndoToast}=useUndoToast();
  const categories=useClaudeExpenseCategories();const historyEnd=month===claudeToday().slice(0,7)?claudeToday():claudeMonthRange(month).to;const historyStart=new Date(`${historyEnd}T12:00:00Z`);historyStart.setUTCDate(historyStart.getUTCDate()-90);const history=useClaudeExpensePage({from:historyStart.toISOString().slice(0,10),to:historyEnd,page:1,pageSize:200});const agents=useAgents({enabled:writable&&draft.category==="SALARY"});
  const [confirmDelete,setConfirmDelete]=useState(false); const [confirmClose,setConfirmClose]=useState(false);
  const trap=useFocusTrap<HTMLDivElement>();useScrollLock();
  const dirty=JSON.stringify(draft)!==JSON.stringify(initial())||!!receipt||repeat!==initialRecurring||!!endsOn||autoPay||period!=="MONTH"||!!saved.current;
  const closeRef=useRef(()=>{}); closeRef.current=()=>{if(saving.current)return;if(dirty)setConfirmClose(true);else onClose();};
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==="Escape")closeRef.current();};document.addEventListener("keydown",key);return()=>document.removeEventListener("keydown",key);},[onClose]);
  useLayoutEffect(()=>{if(field)trap.current?.querySelector<HTMLElement>(`[data-cef-field="${field}"]`)?.focus();},[field,error,trap]);
  function change<K extends keyof ClaudeExpenseDraft>(key:K,value:ClaudeExpenseDraft[K]) { if(saved.current||submitted.current)return;setDraft(d=>({...d,[key]:value}));setError(null);setField(null); }
  function quickChange(value:string) {
    setQuick(value);const parsed=parseClaudeQuickExpense(value);if(!parsed)return;
    const match=categories.data?.filter(c=>c.active).find(c=>parsed.note.toLocaleLowerCase().includes(c.title.toLocaleLowerCase()));
    const previous=(history.data?.items??[]).find(e=>e.note?.trim().toLocaleLowerCase()===parsed.note.toLocaleLowerCase());
    setDraft(d=>({...d,amount:parsed.amount,note:parsed.note,...(match?{category:match.rootCategory,categoryId:match.id}:previous?{category:previous.category,categoryId:previous.categoryId??"",counterparty:previous.counterparty??"",source:previous.source??"",agentId:previous.agentId??""}:{})}));
  }
  const activeCats=(categories.data??[]).filter(c=>c.active||c.id===draft.categoryId).sort((a,b)=>(history.data?.items??[]).filter(e=>e.categoryId===b.id).length-(history.data?.items??[]).filter(e=>e.categoryId===a.id).length);
  const firstCats=activeCats.slice(0,8);const selectedCat=activeCats.find(c=>c.id===draft.categoryId);const shownCats=writable?(allCategories?activeCats:selectedCat&&!firstCats.includes(selectedCat)?[...firstCats,selectedCat]:firstCats):activeCats.filter(c=>c.id===draft.categoryId||(!draft.categoryId&&!c.parentId&&c.rootCategory===draft.category));
  const counterparties=[...new Set((history.data?.items??[]).map(e=>e.counterparty).filter((v):v is string=>!!v))];
  const disabled=working||!writable||!!saved.current||!!submitted.current;
  function undoFailure(reason:unknown) {showUndoToast({message:reason instanceof Error?reason.message:"Отмена не выполнена. Проверьте расход в списке."});}
  async function submit() {
    if(!writable||saving.current)return;const prepared=prepareClaudeExpense(draft,editing?.month.slice(0,7)??month);
    if("field" in prepared){setField(prepared.field);setError(prepared.message);if(["paymentDate","paymentMethod"].includes(prepared.field))setMore(true);return;}
    if(repeat&&draft.paymentDate&&endsOn&&endsOn<(templateOnly?draft.paymentDate:nextClaudeExpenseDate(draft.paymentDate,period))){setMore(true);setField("paymentDate");setError("Дата окончания раньше первого повторения.");return;}
    if(repeat&&!draft.paymentDate){setMore(true);setField("paymentDate");setError("Укажите дату первого повторяющегося платежа.");return;}
    if(editing&&"body" in prepared&&draft.currency==="USD"&&!draft.exchangeRate)prepared.body.exchangeRate=null;
    saving.current=true;setWorking(true);setError(null);
    try {
      if(templateOnly) {
        if(!repeatKey.current)repeatKey.current=crypto.randomUUID();
        const template=await recurring.mutateAsync({idempotencyKey:repeatKey.current,body:{title:draft.note.trim()||EXPENSE_CATEGORY_LABELS[draft.category],category:draft.category,amount:prepared.body.amount,currency:draft.currency,dayOfMonth:Number(draft.paymentDate.slice(-2)),startsOn:draft.paymentDate,period,autoPay,endsOn:endsOn||null,note:draft.note,categoryId:draft.categoryId||null,counterparty:draft.counterparty||null,paymentMethod:draft.paymentMethod||null,source:draft.source||null,agentId:draft.agentId||null,active:true}});
        showUndoToast({message:`Подписка добавлена: ${template.title}`,duration:10000,onUndo:()=>{void removeRecurring.mutateAsync(template.id).catch(undoFailure);}});onClose();return;
      }
      if(!submitted.current)submitted.current={body:{...prepared.body,...(editing?{version:editing.version}:{})},key:crypto.randomUUID()};
      if(!saved.current) saved.current={expense:await save.mutateAsync({id:editing?.id,body:submitted.current.body,idempotencyKey:submitted.current.key})};
      if(repeat&&!saved.current.templateId) {
        if(!repeatKey.current)repeatKey.current=crypto.randomUUID();
        const template=await recurring.mutateAsync({idempotencyKey:repeatKey.current,body:{title:draft.note.trim()||EXPENSE_CATEGORY_LABELS[draft.category],category:draft.category,amount:prepared.body.amount,currency:draft.currency,dayOfMonth:Number(draft.paymentDate.slice(-2)),startsOn:nextClaudeExpenseDate(draft.paymentDate,period),period,autoPay,endsOn:endsOn||null,note:draft.note,categoryId:draft.categoryId||null,counterparty:draft.counterparty||null,paymentMethod:draft.paymentMethod||null,source:draft.source||null,agentId:draft.agentId||null,active:true}});
        saved.current.templateId=template.id;
      }
      if(receipt&&!saved.current.receiptId){const attached=await upload.mutateAsync({id:saved.current.expense.id,file:receipt});saved.current.receiptId=attached.id;}
      const completed=saved.current; const before=editing?prepareClaudeExpense(claudeExpenseDraft(editing),editing.month.slice(0,7)):null;if(before&&"body" in before&&editing?.currency==="USD")before.body.exchangeRate=editing.exchangeRate?Number(editing.exchangeRate):null;
      showUndoToast({message:`${editing?"Изменено":"Записано"}: ${claudeMoney(prepared.body.amount,draft.currency)} · ${draft.note||EXPENSE_CATEGORY_LABELS[draft.category]}`,duration:10000,onUndo:editing&&before&&!("body" in before)?undefined:()=>{
        void (async()=>{if(editing&&before&&"body" in before)await save.mutateAsync({id:editing.id,body:{...before.body,version:completed.expense.version}});else if(!editing)await remove.mutateAsync({id:completed.expense.id,version:completed.expense.version});if(editing&&completed.receiptId)await deleteReceipt.mutateAsync({id:editing.id,receiptId:completed.receiptId});if(completed.templateId)await removeRecurring.mutateAsync(completed.templateId);})().catch(undoFailure);
      }});onClose();
    }catch(reason){const versionConflict=reason instanceof ApiError&&reason.status===409&&!!reason.data&&typeof reason.data==="object"&&"code" in reason.data&&["EXPENSE_VERSION_REQUIRED","EXPENSE_VERSION_CONFLICT"].includes(String(reason.data.code));if(!saved.current&&reason instanceof ApiError&&([400,403,404,422].includes(reason.status)||versionConflict))submitted.current=null;setError(`${saved.current?"Расход уже записан. ":""}${isReadOnlyRoleError(reason)?"Для вашей роли запись недоступна.":versionConflict?"Расход уже изменён. Обновите список и откройте актуальную запись заново перед сохранением.":reason instanceof Error?reason.message:"Не удалось сохранить."}${saved.current?" Нажмите «Повторить оставшиеся шаги» — второй расход не создадим.":" Данные остались в форме."}`);}
    finally{saving.current=false;setWorking(false);}
  }
  async function deleteExpense() {
    if(!editing||!writable||saving.current)return;saving.current=true;setWorking(true);setError(null);
    try{await remove.mutateAsync({id:editing.id,version:editing.version});showUndoToast({message:"Расход удалён",duration:10000,onUndo:()=>{void restore.mutateAsync(editing.id).catch(undoFailure);}});onClose();}catch(e){setError(e instanceof Error?e.message:"Не удалось удалить расход");}finally{saving.current=false;setWorking(false);}
  }
  async function downloadReceipt(url:string,name:string) {try{const blob=await api<Blob>(url.replace(/^\/api\/v1/,""),{responseType:"blob"});const href=URL.createObjectURL(blob);const a=document.createElement("a");a.href=href;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(href),1000);}catch(e){setError(e instanceof Error?e.message:"Чек не загрузился");}}
  const mark=(key:keyof ClaudeExpenseDraft)=>({"data-cef-field":key,"aria-invalid":field===key,"aria-describedby":field===key?"cef-expense-error":undefined});
  return createPortal(<div className="cef-sheet-backdrop"><div className="cef-sheet cef-card" data-no-sheet role="dialog" aria-modal="true" aria-labelledby="cef-sheet-title" ref={trap}>
    <div className="cef-head"><h2 id="cef-sheet-title">{editing?"Изменить расход":templateOnly?"Новая подписка":"Новый расход"}</h2><button type="button" className="cef-icon-btn" aria-label="Закрыть расход" onClick={()=>closeRef.current()} disabled={working}><X size={22}/></button></div>
    {!writable&&<p role="note">Режим просмотра. Изменение расходов недоступно.</p>}
    <div className="cef-form-fields"><fieldset disabled={disabled} className="cef-fields">{writable&&<label className="cef-line-input"><Sparkles size={20}/><input autoFocus aria-label="Что и сколько" placeholder="Напишите «500 интернет» — подставим сами" value={quick} maxLength={300} onChange={e=>quickChange(e.target.value)}/></label>}
    <div className="cef-step"><i>1</i><h3>Сколько</h3></div><div className="cef-amount"><input {...mark("amount")} inputMode="decimal" aria-label="Сумма расхода" placeholder="0" value={draft.amount} onChange={e=>change("amount",e.target.value)} maxLength={14}/><select aria-label="Валюта" value={draft.currency} onChange={e=>change("currency",e.target.value as "TJS"|"USD")}><option value="TJS">с.</option><option value="USD">$</option></select></div>
    {draft.currency==="USD"&&<label className="cef-field"><span>Курс для этого расхода, с. за $</span><input {...mark("exchangeRate")} aria-label="Курс для этого расхода" inputMode="decimal" value={draft.exchangeRate} onChange={e=>change("exchangeRate",e.target.value)} placeholder="Текущий курс при оплате"/><small>Оставьте пустым, чтобы использовать курс CRM при оплате. Для старых трат известный курс укажите вручную.</small></label>}
    {writable&&<div className="cef-keys">{["1","2","3","4","5","6","7","8","9","000","0","del"].map(key=><button type="button" key={key} aria-label={key==="del"?"Удалить последнюю цифру":key} onClick={()=>change("amount",key==="del"?draft.amount.slice(0,-1):(draft.amount==="0"?key:draft.amount+key))}>{key==="del"?<Delete size={22}/>:key}</button>)}</div>}
    <div className="cef-step"><i>2</i><h3>За что</h3></div><div className="cef-tiles">{(activeCats.length?shownCats:EXPENSE_CATEGORIES.map(category=>({id:category,title:EXPENSE_CATEGORY_LABELS[category],rootCategory:category}))).map(c=><button type="button" className={`cef-tile ${draft.categoryId===c.id||(!draft.categoryId&&draft.category===c.rootCategory&&c.id===c.rootCategory)?"cef-selected":""}`} aria-pressed={draft.categoryId===c.id||(!draft.categoryId&&draft.category===c.rootCategory&&c.id===c.rootCategory)} key={c.id} onClick={()=>{change("category",c.rootCategory);change("categoryId",activeCats.length?c.id:"");if(!draft.note)change("note",c.title);}}><ClaudeCategoryIcon category={c.rootCategory} detail={activeCats.find(detail=>detail.id===c.id)}/><span>{c.title}</span></button>)}</div>
    {activeCats.length>8&&writable&&<button className="cef-btn" type="button" onClick={()=>setAllCategories(!allCategories)}>{allCategories?"Показать частые":"Все категории"} · {activeCats.length}</button>}
    {(history.data?.total??0)>200&&<small className="cef-muted">Частые категории по последним 200 платежам за 90 дней.</small>}
    {categories.isError&&<p className="cef-muted">Справочник не загрузился. Доступны основные категории.</p>}
    <label className="cef-field"><span>Название расхода</span><input {...mark("note")} aria-label="Название расхода" value={draft.note} maxLength={300} onChange={e=>change("note",e.target.value)} placeholder="Например, интернет в офисе"/></label>
    {draft.category==="ADVERTISING"&&<label className="cef-field"><span>Канал рекламы</span><select {...mark("source")} value={draft.source} onChange={e=>change("source",e.target.value as ClientSource)}><option value="">Выберите канал</option>{CLIENT_SOURCES.map(s=><option value={s} key={s}>{CLIENT_SOURCE_LABELS[s]}</option>)}</select></label>}
    {draft.category==="SALARY"&&<label className="cef-field"><span>Сотрудник</span><select {...mark("agentId")} value={draft.agentId} onChange={e=>change("agentId",e.target.value)}><option value="">{agents.isPending?"Загружаем сотрудников…":"Выберите сотрудника"}</option>{agents.data?.map(a=><option value={a.id} key={a.id}>{a.fullName}</option>)}</select>{agents.isError&&<span role="alert">Сотрудники не загрузились.</span>}</label>}
    <label className="cef-line-input"><Store size={20}/><input {...mark("counterparty")} aria-label="Кому платили" list="cef-counterparties" placeholder="Кому платили" value={draft.counterparty} maxLength={200} onChange={e=>change("counterparty",e.target.value)}/></label><datalist id="cef-counterparties">{counterparties.map(p=><option value={p} key={p}/>)}</datalist>
    <button type="button" className="cef-more" aria-expanded={more} aria-controls="cef-expense-more" onClick={()=>setMore(!more)}><span>{draft.paymentDate===claudeToday()?"Сегодня":draft.paymentDate||"Дата не указана"} · {draft.paymentMethod?CLAUDE_METHOD_LABELS[draft.paymentMethod]:"способ не указан"} · {repeat?"повторять":"не повторять"}</span><ChevronDown size={20}/></button>
    {more&&<div id="cef-expense-more"><div className="cef-step"><i>3</i><h3>Когда и чем</h3></div><label className="cef-field"><span>Дата платежа</span><input {...mark("paymentDate")} type="date" aria-label="Дата платежа" value={draft.paymentDate} onChange={e=>change("paymentDate",e.target.value)}/></label>{!templateOnly&&<label className="cef-field"><span>Статус</span><select value={draft.status} onChange={e=>change("status",e.target.value as "PAID"|"PLANNED")}><option value="PAID">Оплачено</option><option value="PLANNED">План</option></select></label>}<label className="cef-field"><span>Чем платили</span><select value={draft.paymentMethod} onChange={e=>change("paymentMethod",e.target.value as ClaudeExpenseDraft["paymentMethod"])}><option value="">Не указано</option>{Object.entries(CLAUDE_METHOD_LABELS).map(([key,title])=><option value={key} key={key}>{title}</option>)}</select></label>
    {!editing&&<><label className="cef-field"><span>Повторять</span><input type="checkbox" role="switch" checked={repeat} disabled={templateOnly} onChange={e=>setRepeat(e.target.checked)}/></label>{repeat&&<><label className="cef-field"><span>Период</span><select value={period} onChange={e=>setPeriod(e.target.value as typeof period)}><option value="WEEK">Каждую неделю</option><option value="MONTH">Каждый месяц</option><option value="QUARTER">Каждый квартал</option><option value="YEAR">Каждый год</option></select></label><label className="cef-field"><span>До даты, необязательно</span><input type="date" aria-label="Дата окончания повторения" value={endsOn} onChange={e=>setEndsOn(e.target.value)}/></label><label className="cef-field"><span>Автоматически записывать оплату</span><input type="checkbox" role="switch" checked={autoPay} onChange={e=>setAutoPay(e.target.checked)}/></label><p className="cef-muted">{autoPay?`Первый повтор — ${draft.paymentDate?(templateOnly?draft.paymentDate:nextClaudeExpenseDate(draft.paymentDate,period)):"после выбора даты"}. CRM создаст оплаченный расход в день повторения. Деньги с карты не списываются.`:"CRM напомнит о платеже. Оплату подтвердите сами."}</p></>}</>}
    {!templateOnly&&<label className="cef-receipt"><Camera size={20}/><span>{receipt?receipt.name:"Прикрепить чек: фото или PDF"}</span><input type="file" aria-label="Прикрепить чек" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" onChange={e=>{const f=e.target.files?.[0];if(f&&f.size>10*1024*1024){setError("Чек должен быть не больше 10 МБ.");return;}setReceipt(f??null);}}/></label>}</div>}
    </fieldset></div>
    {saved.current&&receipt&&!saved.current.receiptId&&<label className="cef-receipt"><Camera size={20}/><span>Заменить чек для повторной загрузки</span><input type="file" aria-label="Заменить чек" disabled={working||!writable} accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e=>{const f=e.target.files?.[0];if(f&&f.size>10*1024*1024){setError("Чек должен быть не больше 10 МБ.");return;}setReceipt(f??null);}}/></label>}
    {!!editing?.receipts?.length&&<div className="cef-receipts">{editing.receipts.map(r=><button type="button" className="cef-btn" key={r.id} onClick={()=>void downloadReceipt(r.url,r.originalName)}><FileText size={18}/>{r.originalName}</button>)}</div>}
    {error&&<p id="cef-expense-error" className="cef-error" role="alert">{error}</p>}
    {confirmDelete&&<div className="cef-confirm" role="alert"><div><p>Удалить этот расход? Он сохранится в архиве.</p><button type="button" className="cef-btn cef-danger" disabled={working} onClick={()=>void deleteExpense()}>Да, удалить</button><button type="button" className="cef-btn" onClick={()=>setConfirmDelete(false)}>Оставить</button></div></div>}
    {confirmClose&&<div className="cef-confirm" role="alert"><div><p>{saved.current?"Расход уже записан, но дополнительные шаги не завершены. Закрыть форму?":submitted.current?"Результат записи ещё не подтверждён. Повторное сохранение использует тот же ключ и не создаст дубль. Всё равно закрыть?":"Закрыть форму и потерять введённые данные?"}</p><button type="button" className="cef-btn" onClick={onClose}>Закрыть форму</button><button type="button" className="cef-btn cef-blue" onClick={()=>setConfirmClose(false)}>Продолжить</button></div></div>}
    {writable&&<div className="cef-sheet-footer"><button type="button" className="cef-btn cef-black" onClick={()=>void submit()} disabled={working}>{working?"Сохраняем…":saved.current?"Повторить оставшиеся шаги":submitted.current?"Повторить сохранение":"Готово"}</button>{editing&&!saved.current&&<button type="button" className="cef-btn cef-danger" disabled={working} onClick={()=>setConfirmDelete(true)}>Удалить расход</button>}</div>}
  </div></div>,document.body);
}

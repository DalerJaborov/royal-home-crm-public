import { Children, isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(()=>({ readonly:true, cursor:0, values:[] as unknown[], requests:[] as Record<string,unknown>[], remove:vi.fn(), telegram:vi.fn() }));
vi.mock("react",async importOriginal=>({...await importOriginal<typeof import("react")>(),useState:(value:unknown)=>{const index=h.cursor++;if(!(index in h.values))h.values[index]=typeof value==='function'?(value as ()=>unknown)():value;return[h.values[index],(next:unknown)=>{h.values[index]=typeof next==='function'?(next as (previous:unknown)=>unknown)(h.values[index]):next;}];},useEffect:()=>{},useMemo:(fn:()=>unknown)=>fn(),useRef:(value:unknown)=>({current:value})}));
vi.mock("../../lib/permissions",()=>({useIsReadOnly:()=>h.readonly}));
vi.mock("../../hooks/useUndoToast",()=>({useUndoToast:()=>({showUndoToast:vi.fn()})}));
vi.mock("../../hooks/useDebouncedValue",()=>({useDebouncedValue:(value:unknown)=>value}));
vi.mock("../../lib/claudeFinanceApi",()=>({useClaudeExpensePage:(filters:Record<string,unknown>)=>{h.requests.push(filters);return{data:{items:[{id:"expense",category:"OFFICE",amount:"200",currency:"USD",amountTjs:2000,createdBy:{id:"actor",fullName:"Далер Сафаров"},month:"2026-10",note:"Реальная запись",status:"PAID",paymentDate:"2026-10-09"}],total:123,page:1,pageSize:50,sortBy:"date",sortDirection:"desc"},isLoading:false,isError:false,isFetching:false};},useClaudeExpensePivot:()=>({data:{totalTjs:200,rows:[],months:[]}}),useClaudeExpenseCategories:()=>({data:[]}),useDeleteClaudeExpense:()=>({mutateAsync:h.remove}),useRestoreClaudeExpense:()=>({mutateAsync:vi.fn()}),usePayClaudeExpense:()=>({mutateAsync:vi.fn()}),useUndoClaudePayment:()=>({mutateAsync:vi.fn()}),useSendClaudeExpenseExport:()=>({mutateAsync:h.telegram}),exportClaudeExpenses:vi.fn(),claudeMonthRange:()=>({from:"2026-10-01",to:"2026-10-31"}),claudeMoney:(value:number)=>`${value} с.`,CLAUDE_METHOD_LABELS:{CASH:"Наличные"},CLAUDE_CATEGORY_TONES:{OFFICE:"office"}}));
import { ClaudeExpenseTable } from "./ClaudeExpenseTable";
function buttons(node:ReactNode): {children?:ReactNode;"aria-label"?:string;disabled?:boolean;onClick?:()=>void}[] {return Children.toArray(node).flatMap(child=>isValidElement<{children?:ReactNode;"aria-label"?:string;disabled?:boolean;onClick?:()=>void}>(child)?[...(child.type==='button'?[child.props]:[]),...buttons(child.props.children)]:[]);}
function renderTable(onEdit=vi.fn()) {h.cursor=0;return ClaudeExpenseTable({month:"2026-10",canManage:true,onEdit});}
function elements(node:ReactNode): import("react").ReactElement<Record<string,unknown>>[] {return Children.toArray(node).flatMap(child=>isValidElement<Record<string,unknown>>(child)?[child,...elements(child.props.children as ReactNode)]:[]);}
beforeEach(()=>{h.values=[];h.cursor=0;h.requests=[];vi.clearAllMocks();});
describe("readonly expense table",()=>{
 it("explains payment-date scope while retaining the exact date-bounded server query",()=>{
  const tree=renderTable();
  expect(elements(tree).find(element=>element.type==='p' && element.props.children==='Таблица учитывает расходы с указанной датой платежа. Записи, где известен только месяц, смотрите во вкладке «Расходы».')).toBeDefined();
  expect(h.requests).toEqual([{from:"2026-10-01",to:"2026-10-31",sortBy:"date",sortDirection:"desc",page:1,pageSize:50}]);
  expect(h.remove).not.toHaveBeenCalled();expect(h.telegram).not.toHaveBeenCalled();
 });

 it("requests actual server pagination and keeps expense details available without mutation controls",()=>{
  const onEdit=vi.fn();const controls=buttons(renderTable(onEdit));
  expect(h.requests.at(-1)).toMatchObject({from:"2026-10-01",to:"2026-10-31",page:1,pageSize:50});
  const view=controls.find(control=>control['aria-label']==='Посмотреть расход Реальная запись');expect(view).toBeDefined();view?.onClick?.();expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({id:"expense"}));
  expect(controls.some(control=>control['aria-label']?.startsWith('Удалить'))).toBe(false);expect(controls.some(control=>control.children==='В мой Telegram')).toBe(false);expect(controls.find(control=>control.children==='Дальше')?.disabled).toBe(false);expect(h.remove).not.toHaveBeenCalled();expect(h.telegram).not.toHaveBeenCalled();
 });
 it("sorts every server page by author and amount with an accessible header and resets pagination",()=>{
  let tree=renderTable();let controls=buttons(tree);
  expect(elements(tree).find(element=>element.type==='th' && element.props['aria-sort']==='descending')).toBeDefined();
  controls.find(control=>control.children==='Дальше')?.onClick?.();renderTable();expect(h.requests.at(-1)).toMatchObject({page:2});
  controls=buttons(renderTable());controls.find(control=>control['aria-label']==='Сортировать: Кто внёс')?.onClick?.();tree=renderTable();
  expect(h.requests.at(-1)).toMatchObject({page:1,sortBy:'author',sortDirection:'asc'});
  const sorted=elements(tree).find(element=>element.type==='th' && element.props['aria-sort']==='ascending');expect(sorted).toBeDefined();
  const authorButton=elements(tree).find(element=>element.props['aria-label']==='Сортировать: Кто внёс');expect(authorButton?.props.className).toBe('cef-pivot-value');
  buttons(tree).find(control=>control['aria-label']==='Сортировать: Кто внёс')?.onClick?.();renderTable();expect(h.requests.at(-1)).toMatchObject({sortBy:'author',sortDirection:'desc'});
  buttons(renderTable()).find(control=>control['aria-label']==='Сортировать: Сумма')?.onClick?.();tree=renderTable();expect(h.requests.at(-1)).toMatchObject({sortBy:'amount',sortDirection:'asc'});
  const cells=elements(tree).filter(element=>element.type==='td');expect(cells.some(cell=>cell.props.children==='Далер Сафаров')).toBe(true);
  const amount=cells.find(cell=>cell.props.className==='cef-amount');expect(amount?.props.children).toEqual(expect.arrayContaining(['2000 с.']));
 });
});

import { Children, isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ readonly: false, index: 0, refs: [] as {current:unknown}[], save: vi.fn(), pay: vi.fn(), categories: [], rows: [{ id: "subscription", title: "Интернет", category: "OFFICE", amount: "200", currency: "TJS", dayOfMonth: 9, active: true, autoPay: false, period: "MONTH", startsOn: "2026-10-09", nextDate: "2026-10-09", note: null, lastCreatedMonth: null }] }));
vi.mock("react", async importOriginal => ({ ...(await importOriginal<typeof import("react")>()), useMemo: (fn:()=>unknown) => fn(), useEffect: () => {}, useRef: (v:unknown)=>{const i=h.index++;return h.refs[i] ??= {current:v};}, useState: (v:unknown)=>[typeof v==='function'?(v as ()=>unknown)():v,vi.fn()] }));
vi.mock("../../hooks/useUndoToast",()=>({useUndoToast:()=>({showUndoToast:vi.fn()})}));
vi.mock("../../lib/permissions",()=>({useIsReadOnly:()=>h.readonly}));
vi.mock("../../lib/claudeFinanceApi",()=>({useClaudeRecurring:()=>({data:h.rows,isLoading:false,isError:false}),useClaudeExpenseCategories:()=>({data:[]}),useClaudeExpensePage:()=>({data:{items:[],total:0,page:1,pageSize:6}}),useSaveClaudeRecurring:()=>({mutateAsync:h.save}),useDeleteClaudeRecurring:()=>({mutateAsync:vi.fn()}),useRestoreClaudeRecurring:()=>({mutateAsync:vi.fn()}),usePayClaudeRecurring:()=>({mutateAsync:h.pay}),useSkipClaudeRecurring:()=>({mutateAsync:vi.fn()}),useUndoClaudeRecurring:()=>({mutateAsync:vi.fn()}),CLAUDE_METHOD_LABELS:{CASH:"Наличные"},CLAUDE_CATEGORY_TONES:{OFFICE:"office"},claudeMoney:(v:number)=>`${v} с.`,claudeMonthRange:()=>({from:"2026-10-01",to:"2026-10-31"})}));
import { ClaudeSubscriptions, recurringEditorDay } from "./ClaudeSubscriptions";
function buttons(node:ReactNode): {"aria-label"?:string;role?:string;children?:ReactNode;disabled?:boolean;onClick?:()=>unknown}[] {return Children.toArray(node).flatMap(child=>isValidElement<{"aria-label"?:string;role?:string;children?:ReactNode;disabled?:boolean;onClick?:()=>unknown}>(child)?[...(child.type==='button'?[child.props]:[]),...buttons(child.props.children)]:[]);}
beforeEach(()=>{h.readonly=false;h.refs=[];h.index=0;h.save.mockReset();h.pay.mockReset();});
describe("subscription management boundary",()=>{
 it.each([29,30,31])("preserves contractual day %i for title-only edits, including a February start", day => {
  const row = { startsOn: "2026-02-28", nextDate: "2026-03-31", dayOfMonth: day };
  expect(recurringEditorDay(row, "2026-02-28")).toBe(day);
  expect(recurringEditorDay(row, "2026-03-15")).toBe(15);
 });
 it("preserves the old contractual day when editing a template without startsOn", () => {
  expect(recurringEditorDay({ startsOn: null, nextDate: "2026-02-28", dayOfMonth: 31 }, "2026-02-28")).toBe(31);
 });
 it("keeps subscription viewing available but blocks readonly switches and payment",()=>{h.readonly=true;const tree=ClaudeSubscriptions({month:"2026-10",canManage:true});const controls=buttons(tree);expect(controls.filter(button=>button.role==='switch').every(button=>button.disabled)).toBe(true);expect(controls.some(button=>button.children==='Оплатил сегодня')).toBe(false);expect(controls.some(button=>button.disabled===undefined&&button['aria-label']===undefined)).toBe(true);expect(h.save).not.toHaveBeenCalled();});
 it("sends an actual active update and protects a captured callback after readonly revocation",async()=>{let tree=ClaudeSubscriptions({month:"2026-10",canManage:true});const active=buttons(tree).find(button=>button['aria-label']==='Подписка «Интернет» активна')!;await active.onClick?.();expect(h.save).toHaveBeenCalledWith({id:"subscription",body:{active:false}});h.save.mockClear();h.readonly=true;h.index=0;tree=ClaudeSubscriptions({month:"2026-10",canManage:true});await active.onClick?.();expect(h.save).not.toHaveBeenCalled();expect(buttons(tree).find(button=>button['aria-label']==='Подписка «Интернет» активна')?.disabled).toBe(true);});
});

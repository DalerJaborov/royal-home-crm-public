import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ refs: [] as {current: unknown}[], index: 0, effects: [] as (()=>unknown)[], layouts: [] as (()=>unknown)[], state: {agent:{id:"a"} as {id:string}|null,sessionEpoch:1}, listeners: [] as ((s:unknown,p:unknown)=>void)[] }));
vi.mock("react", () => ({ useRef: (value:unknown) => h.refs[h.index++] ?? (h.refs[h.index-1]={current:value}), useEffect: (fn:()=>unknown)=>h.effects.push(fn), useLayoutEffect:(fn:()=>unknown)=>h.layouts.push(fn) }));
vi.mock("../../store/auth",()=>({useAuthStore:Object.assign((selector:(s:typeof h.state)=>unknown)=>selector(h.state),{getState:()=>h.state,subscribe:(listener:(s:unknown,p:unknown)=>void)=>{h.listeners.push(listener);return ()=>{};}})}));
import { useCleanChatDraft } from "../useCleanChatDraft";
import { readCleanChatDraft, writeCleanChatDraft } from "../../lib/cleanChatDraft";
let text="";
const restore=(next:string|((s:string)=>string))=>{text=typeof next==="function"?next(text):next;};
function Harness() { h.index=0; h.effects=[]; h.layouts=[]; useCleanChatDraft({enabled:true,conversationId:"chat",text,restore}); }
beforeEach(()=>{vi.useFakeTimers();h.refs=[];h.state={agent:{id:"a"},sessionEpoch:1};text="";const data=new Map<string,string>();vi.stubGlobal("window",{sessionStorage:{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v),removeItem:(k:string)=>data.delete(k)}});});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
describe("clean draft hook lifecycle",()=>{
 it("debounces typing but flushes navigation before the timer fires",()=>{text="unsent";Harness();const cleanup=h.layouts[0]() as ()=>void;h.effects[0]();expect(readCleanChatDraft("a","chat")).toBeNull();vi.advanceTimersByTime(250);expect(readCleanChatDraft("a","chat")).toBe("unsent");text="latest";Harness();h.effects[0]();cleanup();expect(readCleanChatDraft("a","chat")).toBe("latest");});
 it("replayed StrictMode setup cannot erase a pending restore",()=>{writeCleanChatDraft("a","chat","saved");Harness();const cleanup=h.layouts[0]() as ()=>void;h.effects[0]();expect(readCleanChatDraft("a","chat")).toBe("saved");cleanup();h.layouts[0]();h.effects[0]();expect(text).toBe("saved");expect(readCleanChatDraft("a","chat")).toBe("saved");});
 it("restoration does not overwrite text typed before the setter applies",()=>{writeCleanChatDraft("a","chat","old");Harness();text="fresh";h.layouts[0]();expect(text).toBe("fresh");});
 it("successful send clears only the current draft after restoration",()=>{writeCleanChatDraft("a","chat","saved");writeCleanChatDraft("a","other","keep");Harness();h.layouts[0]();h.effects[0]();Harness();h.effects[0]();text="";Harness();h.effects[0]();expect(readCleanChatDraft("a","chat")).toBeNull();expect(readCleanChatDraft("a","other")).toBe("keep");});
 it("logout clears dormant drafts and old effects cannot recreate or transfer them",()=>{writeCleanChatDraft("a","chat","old");text="unsent";Harness();const cleanup=h.layouts[0]() as ()=>void;h.effects[0]();const previous=h.state;h.state={agent:{id:"b"},sessionEpoch:2};h.listeners.forEach(fn=>fn(h.state,previous));h.effects[0]();cleanup();Harness();h.layouts[0]();h.effects[0]();expect(readCleanChatDraft("a","chat")).toBeNull();expect(readCleanChatDraft("b","chat")).toBeNull();});
});

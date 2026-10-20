import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ index: 0, slots: [] as unknown[], effects: [] as (() => unknown)[], dirty: false }));
vi.mock("react", () => ({
 useRef: (v:unknown) => { const i=h.index++; return h.slots[i] ?? (h.slots[i]={current:v}); },
 useState: (v:unknown) => { const i=h.index++;if(!(i in h.slots))h.slots[i]=v;return [h.slots[i],(n:unknown)=>{const r=typeof n==='function'?n(h.slots[i]):n;if(r!==h.slots[i])h.dirty=true;h.slots[i]=r;}]; },
 useCallback: (fn:unknown)=>fn,
 useLayoutEffect: (fn:()=>unknown,deps:unknown[])=>{const i=h.index++;const prev=h.slots[i] as unknown[]|undefined;if(!prev||deps.some((d,j)=>!Object.is(d,prev[j])))h.effects.push(fn);h.slots[i]=deps;},
}));
import { useChatReadingPosition } from "../useChatReadingPosition";
beforeEach(()=>{h.index=0;h.slots=[];h.effects=[];h.dirty=false;});afterEach(()=>vi.unstubAllGlobals());
function setup(count=120,enabled=true,viewportHeight=200){
 let reading!:ReturnType<typeof useChatReadingPosition>;let resize!:ResizeObserverCallback;let mediaHeight=0;let mediaAbove=0;let earlierHeight=0;
 vi.stubGlobal('ResizeObserver',class{constructor(cb:ResizeObserverCallback){resize=cb;}observe(){}disconnect(){}});
 const message={dataset:{chatMessage:"read"},getBoundingClientRect:()=>({top:200+mediaAbove+earlierHeight-element.scrollTop,bottom:210+mediaAbove+earlierHeight-element.scrollTop})};
 const element={getBoundingClientRect:()=>({top:0,bottom:viewportHeight}),querySelectorAll:()=>[message],scrollTop:0,clientHeight:200,get scrollHeight(){return reading.visibleCount*10+mediaHeight;},scrollTo(this:{scrollTop:number;clientHeight:number},{top}:ScrollToOptions){this.scrollTop=Math.max(0,(top??0)-this.clientHeight);}} as unknown as HTMLDivElement;
 function Harness(){reading=useChatReadingPosition(enabled,count);}
 function render(next=count,nextEnabled=enabled){count=next;enabled=nextEnabled;let runs=0;do{h.index=0;h.effects=[];h.dirty=false;Harness();reading.scrollRef.current=element;reading.contentRef.current={} as HTMLDivElement;h.effects.forEach(fn=>fn());if(++runs>10)throw Error('Unstable reading lifecycle');}while(h.dirty);}
 render();return{get reading(){return reading;},update:render,groupingArrival:()=>{mediaAbove+=16;render(count+3);},earlier:()=>{element.scrollTop=100;reading.onScroll();render();},grow:()=>{mediaHeight+=200;resize([],{} as ResizeObserver);render();},growAbove:()=>{mediaHeight+=200;mediaAbove+=200;resize([],{} as ResizeObserver);render();},more:()=>{reading.showMoreMessages();earlierHeight+=600;render();},latest:()=>{reading.jumpToLatest();render();}};
}
describe('live chat reading position',()=>{
 it('starts at latest and follows arrivals without growing the rendered tail',()=>{const c=setup();expect(c.reading.scrollRef.current!.scrollTop).toBe(400);c.update(121);expect(c.reading.visibleCount).toBe(60);expect(c.reading.newMessageCount).toBe(0);});
 it('retains the visible start and counts new arrivals once while reading earlier',()=>{const c=setup();c.earlier();c.update(123);expect(c.reading.visibleCount).toBe(63);expect(c.reading.scrollRef.current!.scrollTop).toBe(100);expect(c.reading.newMessageCount).toBe(3);c.update(123);expect(c.reading.newMessageCount).toBe(3);c.latest();expect(c.reading.newMessageCount).toBe(0);expect(c.reading.showLatest).toBe(false);});
 it('keeps the message offset when earlier history opens',()=>{const c=setup();c.earlier();c.more();expect(c.reading.visibleCount).toBe(120);expect(c.reading.scrollRef.current!.scrollTop).toBe(700);});
 it('image sizing follows only a reader at the bottom',()=>{const c=setup();c.grow();expect(c.reading.scrollRef.current!.scrollTop).toBe(600);c.earlier();c.grow();expect(c.reading.scrollRef.current!.scrollTop).toBe(100);});
 it('preserves the visible message when an image above it expands',()=>{const c=setup();c.earlier();c.growAbove();expect(c.reading.scrollRef.current!.scrollTop).toBe(300);});
 it('restores regrouped bubble offset before a following scroll event',()=>{const c=setup();c.earlier();c.groupingArrival();expect(c.reading.scrollRef.current!.scrollTop).toBe(116);expect(c.reading.newMessageCount).toBe(3);});
 it('anchors the next message when the history control fills the viewport',()=>{const c=setup(120,true,32);c.earlier();c.more();expect(c.reading.scrollRef.current!.scrollTop).toBe(700);});
 it('leaves the legacy phone scroll and window untouched',()=>{const c=setup(120,false);c.earlier();c.update(125,false);expect(c.reading.visibleCount).toBe(60);expect(c.reading.scrollRef.current!.scrollTop).toBe(100);expect(c.reading.newMessageCount).toBe(0);});
});

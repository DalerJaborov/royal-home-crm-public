import { describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({findMany:vi.fn()}));
vi.mock("../src/db.js", async(importOriginal)=>({...await importOriginal<typeof import("../src/db.js")>(),prisma:{interaction:{findMany:mocks.findMany},$disconnect:vi.fn()}}));
import { projectMonthlyPublicInteractions } from "../src/lib/monthlyPublicProjection.js";
describe("historical monthly public projection",()=>{
  const snapshot={commission:17,funnel:[{key:"contacted",count:1},{key:"showings",count:1},{key:"leads",count:5}],agents:[{agentId:"a",showings:1,leads:1,deals:2,commission:17}]};
  it("reconstructs only public event counters without modifying cached facts",async()=>{
    mocks.findMany.mockResolvedValue([]);
    const result=await projectMonthlyPublicInteractions(snapshot,new Date("2020-01-31T19:00:00Z"));
    expect(result).toMatchObject({commission:17,funnel:[{key:"contacted",count:0},{key:"showings",count:0},{key:"leads",count:5}],agents:[{showings:0,commission:17}],publicInteractionCountersBasis:"CURRENT_RECORDED_PUBLIC_EVENTS"});
    expect(snapshot.funnel[0].count).toBe(1);
    expect(mocks.findMany.mock.calls.at(-1)?.[0].where).toMatchObject({investigationOnly:false,createdAt:{gte:new Date("2020-01-31T19:00:00Z"),lt:new Date("2020-02-29T19:00:00Z")}});
  });
  it("overflow and unavailable source produce unknown, never a truncated zero",async()=>{
    for(const value of [null,Array.from({length:20001},()=>({}))]){
      mocks.findMany.mockResolvedValue(value);
      expect(await projectMonthlyPublicInteractions(snapshot,new Date("2020-01-31T19:00:00Z"))).toMatchObject({publicInteractionCountersBasis:"UNAVAILABLE",funnel:[{count:null},{count:null},{count:5}],agents:[{showings:null}]});
    }
  });
});

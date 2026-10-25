import { describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({findUnique:vi.fn()}));
vi.mock("../src/db.js",async(importOriginal)=>({...await importOriginal<typeof import("../src/db.js")>(),prisma:{interaction:{findUnique:mocks.findUnique},$disconnect:vi.fn()}}));
import { isPrivateBackgroundJob, publicBackgroundJobSql } from "../src/lib/backgroundJobPrivacy.js";
import { isPrivateOperation, withInvestigationPrivacy } from "../src/lib/investigationOperations.js";
describe("background job source privacy",()=>{
  it("private actual binding overrides a legacy public payload and missing bindings are private",async()=>{
    mocks.findUnique.mockResolvedValueOnce({investigationOnly:true}).mockResolvedValueOnce(null).mockResolvedValueOnce({investigationOnly:false});
    const job={type:"transcription-retry",payload:{interactionId:"synthetic",investigationOnly:false}};
    expect(await isPrivateBackgroundJob(job)).toBe(true);
    expect(await isPrivateBackgroundJob(job)).toBe(true);
    expect(await isPrivateBackgroundJob(job)).toBe(false);
    expect(await isPrivateBackgroundJob({...job,payload:{}})).toBe(true);
  });
  it("durable marker survives deleted source without hiding ordinary unrelated jobs",async()=>{
    expect(await isPrivateBackgroundJob({type:"recording-search-retry",payload:{investigationOnly:true}})).toBe(true);
    expect(await isPrivateBackgroundJob({type:"geocode",payload:{propertyId:"ordinary"}})).toBe(false);
    expect(publicBackgroundJobSql().text).toContain('i."investigationOnly" = false');
  });
  it("error handling inherits private async context without contaminating ordinary operations",async()=>{
    expect(isPrivateOperation()).toBe(false);
    await withInvestigationPrivacy(true,async()=>{
      await Promise.resolve();
      expect(isPrivateOperation()).toBe(true);
      await withInvestigationPrivacy(false,async()=>{expect(isPrivateOperation()).toBe(true);});
    });
    expect(isPrivateOperation()).toBe(false);
  });
});

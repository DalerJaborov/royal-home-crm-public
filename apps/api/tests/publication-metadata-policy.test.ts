import { describe, expect, it, vi } from "vitest";
import { metadataHash, planPublicationMetadata, performMetadataTargets } from "../src/lib/publicationMetadataPolicy.js";
import { summarizeComparableListings } from "@royal-home/shared";

const input = { caption: "Approved caption", coverKey: "/uploads/covers/test.jpg", coverDigest: "hash", channels: ["FACEBOOK", "TELEGRAM", "INSTAGRAM"], postIds: { FACEBOOK: "fb1", TELEGRAM: "11", TELEGRAM_EXTRA: { chat2: "22" } }, telegramChatId: "chat1" };
describe("publication metadata planning and bounded execution", () => {
  it("keeps unsupported operations manual and supported ones preview only", () => {
    const rows = planPublicationMetadata(input);
    expect(rows).toHaveLength(6);
    expect(rows.find(r=>r.channel==='INSTAGRAM' && r.operation==='CAPTION')?.status).toBe('MANUAL_REQUIRED');
    expect(rows.find(r=>r.channel==='FACEBOOK' && r.operation==='COVER')?.status).toBe('PREVIEW');
    expect(rows.find(r=>r.channel==='TELEGRAM' && r.operation==='CAPTION')?.payload.targets).toEqual([{postId:'11',chatId:'chat1'},{postId:'22',chatId:'chat2'}]);
  });
  it("does not invent missing targets/covers or duplicate channel plans", () => {
    const rows=planPublicationMetadata({...input,channels:['FACEBOOK','FACEBOOK'],postIds:{},coverDigest:null});
    expect(rows).toHaveLength(2);expect(rows.every(r=>r.status==='MANUAL_REQUIRED')).toBe(true);
    expect(metadataHash(input)).not.toBe(metadataHash({...input,caption:'New price'}));
  });
  it("stops on timeout and never calls next target or retries",async()=>{
    const adapter=vi.fn().mockRejectedValue(new Error('timeout'));
    const plan=planPublicationMetadata(input).find(r=>r.channel==='TELEGRAM'&&r.operation==='CAPTION')!;
    expect((await performMetadataTargets(plan,adapter)).status).toBe('UNKNOWN');expect(adapter).toHaveBeenCalledTimes(1);
  });
  it("keeps partial writes ambiguous; complete acknowledgements are explicit",async()=>{
    const plan=planPublicationMetadata(input).find(r=>r.channel==='TELEGRAM'&&r.operation==='CAPTION')!;
    const adapter=vi.fn().mockResolvedValueOnce({status:'APPLIED',code:'ACK'}).mockResolvedValueOnce({status:'FAILED',code:'MISSING'});
    expect((await performMetadataTargets(plan,adapter)).status).toBe('UNKNOWN');expect(adapter).toHaveBeenCalledTimes(2);
    const ack=vi.fn().mockResolvedValue({status:'APPLIED',code:'ACK'});
    expect((await performMetadataTargets(plan,ack)).status).toBe('APPLIED');
  });
});
describe('internal comparable asking prices',()=>{
  const subject={price:600000,currency:'TJS',areaSqm:60};
  const row=(n:number)=>({id:String(n),shortId:n,price:n*100000,currency:'TJS',areaSqm:50,updatedAt:'2026-10-20T00:00:00.000Z'});
  it('computes deterministic median without mixing currencies or invalid values',()=>{
    const result=summarizeComparableListings(subject,[row(4),row(6),{...row(2),currency:'USD'},{...row(3),areaSqm:0}],4,new Date('2026-10-25T00:00:00Z'));
    expect(result).toMatchObject({basis:'ASKING_PRICES',source:'CRM',usableCount:2,medianPricePerSqm:10000,differencePercent:0});
    expect(result.listings[0].ageDays).toBe(5);expect(result.limitation).toContain('не подтверждает');
  });
  it('reports empty and capped coverage without fabricated valuation',()=>{
    expect(summarizeComparableListings(subject,[],0).medianPricePerSqm).toBeNull();
    expect(summarizeComparableListings(subject,[row(1)],140)).toMatchObject({truncated:true,sampledCount:1,totalCandidates:140});
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(()=>({ $disconnect: vi.fn(), publicationMetadataSync: { findUnique: vi.fn(), updateMany: vi.fn() }, agent: { findFirst: vi.fn() }, property: { findUnique: vi.fn() }, settings: { findUnique: vi.fn() }, $transaction: vi.fn() }));
vi.mock('../src/db.js',async importOriginal=>({...await importOriginal<typeof import('../src/db.js')>(),prisma:db}));
vi.mock('../src/lib/publicationMetadataAdapter.js',()=>({applyPublicationMetadata:vi.fn()}));
import { metadataHash } from "../src/lib/publicationMetadataPolicy.js";
import { executePublicationMetadataSync } from '../src/lib/publicationMetadataSync.js';
describe('publication execution gates',()=>{
  beforeEach(()=>{vi.clearAllMocks();delete process.env.PUBLICATION_METADATA_EXECUTION;});
  it('default denies without touching database or provider',async()=>{
    const adapter=vi.fn();expect(await executePublicationMetadataSync('id','actor',{adapter,allowLive:true})).toEqual({status:'DISABLED'});
    expect(adapter).not.toHaveBeenCalled();expect(db.publicationMetadataSync.findUnique).not.toHaveBeenCalled();
  });
  it('needs independent server dependency even when env enabled',async()=>{
    process.env.PUBLICATION_METADATA_EXECUTION='LIVE';expect(await executePublicationMetadataSync('id','actor')).toEqual({status:'DISABLED'});
  });
  it.each(['PREVIEW','EXECUTING','UNKNOWN','APPLIED'])('never drains preview mode or retries %s',async status=>{
    process.env.PUBLICATION_METADATA_EXECUTION='LIVE';db.publicationMetadataSync.findUnique.mockResolvedValue({executionMode:status==='PREVIEW'?'PREVIEW':'LIVE',status});const adapter=vi.fn();
    expect(await executePublicationMetadataSync('id','actor',{adapter,allowLive:true})).toEqual({status:'NOT_CLAIMABLE'});expect(adapter).not.toHaveBeenCalled();
  });
});

const payload={caption:'Caption',coverKey:null,coverDigest:null,targets:[{postId:'fb1'}]};
function liveFixture() {
  const property={id:'property',deletedAt:null,updatedAt:new Date('2026-10-25T00:00:00Z'),price:100,currency:'TJS',reelsCaption:'Caption',socialCoverSquareUrl:null,publishedChannels:['FACEBOOK'],publishedPostIds:{FACEBOOK:'fb1'}};
  const input={caption:'Caption',coverKey:null,coverDigest:null,channels:property.publishedChannels,postIds:property.publishedPostIds,telegramChatId:null};
  const hash=metadataHash({contentHash:metadataHash({...input,price:'100',currency:'TJS'}),executionMode:'LIVE'});
  db.publicationMetadataSync.findUnique.mockResolvedValue({id:'id',propertyId:'property',channel:'FACEBOOK',operation:'CAPTION',status:'PREVIEW',executionMode:'LIVE',revisionHash:hash,payload});
  db.property.findUnique.mockResolvedValue(property);db.settings.findUnique.mockResolvedValue(null);db.agent.findFirst.mockResolvedValue({id:'actor'});
  let startedAt: Date;
  const tx={$queryRaw:vi.fn(),property:{findUnique:vi.fn().mockResolvedValue(property)},publicationMetadataSync:{findUnique:vi.fn(async()=>({status:"EXECUTING",startedAt})),findFirst:vi.fn().mockResolvedValue(null),updateMany:vi.fn(async(arg:any)=>{ if(arg.data.startedAt) startedAt=arg.data.startedAt; return {count:1}; })}};
  db.$transaction.mockImplementation(async(fn:any)=>fn(tx));db.publicationMetadataSync.updateMany.mockResolvedValue({count:1});
  process.env.PUBLICATION_METADATA_EXECUTION='LIVE';return tx;
}
describe('durable execution boundaries',()=>{
  beforeEach(()=>vi.clearAllMocks());
  it('records acknowledgement only after claim',async()=>{const tx=liveFixture();const adapter=vi.fn().mockResolvedValue({status:'APPLIED',code:'ACK'});expect((await executePublicationMetadataSync('id','actor',{adapter,allowLive:true})).status).toBe('APPLIED');expect(tx.publicationMetadataSync.updateMany).toHaveBeenCalledTimes(2);expect(tx.publicationMetadataSync.updateMany).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({status:'APPLIED'})}));});
  it('blocks new revisions when a previous result is unresolved',async()=>{const tx=liveFixture();tx.publicationMetadataSync.findFirst.mockResolvedValue({id:'old'} as never);const adapter=vi.fn();expect((await executePublicationMetadataSync('id','actor',{adapter,allowLive:true})).status).toBe('NOT_CLAIMABLE');expect(adapter).not.toHaveBeenCalled();});
  it('blocks simultaneous loser and stale property',async()=>{const tx=liveFixture();tx.publicationMetadataSync.updateMany.mockResolvedValue({count:0});const adapter=vi.fn();expect((await executePublicationMetadataSync('id','actor',{adapter,allowLive:true})).status).toBe('NOT_CLAIMABLE');expect(adapter).not.toHaveBeenCalled();});
  it('preserves ambiguous provider failure as UNKNOWN without retry',async()=>{liveFixture();const adapter=vi.fn().mockRejectedValue(new Error('lost'));expect((await executePublicationMetadataSync('id','actor',{adapter,allowLive:true})).status).toBe('UNKNOWN');expect(adapter).toHaveBeenCalledTimes(1);});
});

afterEach(()=>{ delete process.env.PUBLICATION_METADATA_EXECUTION; });
it('late provider evidence never overwrites a manual decision',async()=>{
  const tx=liveFixture();
  tx.publicationMetadataSync.findUnique.mockImplementation(async()=>({status:'FAILED_MANUAL',startedAt:tx.publicationMetadataSync.updateMany.mock.calls[0][0].data.startedAt,result:{operatorConfirmation:{outcome:'FAILED'}}}) as never);
  const adapter=vi.fn().mockResolvedValue({status:'APPLIED',code:'ACK'});
  const result=await executePublicationMetadataSync('id','actor',{adapter,allowLive:true});
  expect(result.status).toBe('FAILED_MANUAL');
  const last=tx.publicationMetadataSync.updateMany.mock.calls.at(-1)![0];
  expect(last.data).not.toHaveProperty('status');expect(last.data.result.operatorConfirmation.outcome).toBe('FAILED');expect(last.data.result.lateProviderEvidence.status).toBe('APPLIED');
});

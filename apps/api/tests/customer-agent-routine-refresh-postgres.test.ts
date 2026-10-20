// Real authenticated HTTP + PostgreSQL. Only the historical release manifest is
// synthetic. No principal/permission mocks, model calls or delivery attempts.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { invalidateAgentAccess } from '../src/auth/middleware.js';
import { revokeElevation } from '../src/lib/stepUp.js';
import { encryptSecret } from '../src/crypto.js';
import { createCustomerAgentMediaProviderSnapshot } from '../src/ai/customerAgentProviderConfig.js';
import * as registration from '../src/lib/customerAgentRegistration.js';
import { customerAgentManifestId } from '../src/lib/customerAgentRevision.js';
import { ensureCustomerEndpoint } from '../src/lib/customerConversationScope.js';
import { registerAuthenticatedMetaCustomerRequest } from '../src/lib/customerIngressAuthority.js';
import { persistVerifiedCustomerIngressBatch } from '../src/lib/customerIngressProducer.js';
import { drainBackgroundTasks } from '../src/lib/shutdownState.js';

const tag=`synthetic-routine-refresh-${randomUUID()}`, base='/api/v1/settings/customer-agent';
const accountId=randomUUID(),resource=`${tag}-resource`,peer=`${tag}-peer`,secret=`${tag}-secret`;
const events:string[]=[];
const capabilities={publicRead:true,contactWrite:true,callbackWrite:true,newLeadBridge:true,handoverWrite:false,showingWrite:true,ownerQuestionWrite:true};
const readPolicy=()=>prisma.customerRuntimePolicy.findUniqueOrThrow({where:{id:'singleton'}});
let savedPolicy:Awaited<ReturnType<typeof readPolicy>>;
let savedSettings:Awaited<ReturnType<typeof prisma.settings.findUniqueOrThrow>>;
let actorId='',staffId='',token='',staffToken='',scopeId='',oldId='',newId='';
let manifest:Omit<Awaited<ReturnType<typeof registration.registerCurrentCustomerAgentRevision>>,'id'>;
const auth=(value=token)=>({Authorization:`Bearer ${value}`});
const command=async(extra:Record<string,unknown>={})=>({expectedPolicyRevision:(await readPolicy()).policyRevision.toString(),reason:tag,...extra});
async function historical(change:Record<string,unknown>={}) {
  const previous={...manifest,coreHash:createHash('sha256').update(`${tag}-${randomUUID()}`).digest('hex'),...change};
  const id=customerAgentManifestId(previous);
  await prisma.$executeRaw`INSERT INTO "CustomerAgentRevision" ("id","manifestJson","createdAt") VALUES (${id},${JSON.stringify(previous)}::jsonb,now())`;
  return id;
}
async function install(id=oldId,mode='ACTIVE',percent=5000) {
  const rollout={version:1,cohortId:randomUUID(),candidateRevisionId:id,percentBasisPoints:percent,allowed:[{surface:'dm',channel:'INSTAGRAM',endpointScopeId:scopeId}]};
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"='scoped',"rolloutMode"=${mode},"activeAgentRevisionId"=${id},
    "rolloutConfig"=${JSON.stringify(rollout)}::jsonb,"capabilities"=${JSON.stringify(capabilities)}::jsonb WHERE "id"='singleton'`;
}
async function capturePending() {
  const rawBody=Buffer.from(JSON.stringify({object:'instagram',entry:[{id:resource,messaging:[{sender:{id:peer},recipient:{id:resource},timestamp:Date.now(),message:{mid:randomUUID(),text:'Какие варианты есть?'}}]}]}));
  const req={rawBody,get:()=>`sha256=${createHmac('sha256',secret).update(rawBody).digest('hex')}`};
  registerAuthenticatedMetaCustomerRequest(req);
  const value=await persistVerifiedCustomerIngressBatch(req);
  expect(value.status).toBe('persisted');if(value.status!=='persisted')throw Error('Signed test ingress failed');
  const eventKey=value.tickets[0].eventKey;events.push(eventKey);
  return prisma.customerPropertyIngressTicket.findUniqueOrThrow({where:{eventKey}});
}
beforeAll(async()=>{
  savedPolicy=await readPolicy();savedSettings=await prisma.settings.findUniqueOrThrow({where:{id:'singleton'}});
  const actor=await prisma.agent.create({data:{fullName:tag,phone:`synthetic-${randomUUID()}`,role:'DIRECTOR'}});
  actorId=actor.id;token=signAccessToken({sub:actorId,role:'DIRECTOR'});
  const staff=await prisma.agent.create({data:{fullName:tag,phone:`synthetic-${randomUUID()}`,role:'AGENT',permissions:{granted:['settings.manage'],revoked:[]}}});
  staffId=staff.id;staffToken=signAccessToken({sub:staffId,role:'AGENT'});
  const current=await registration.registerCurrentCustomerAgentRevision(createCustomerAgentMediaProviderSnapshot());
  newId=current.id;const {id:_,...rest}=current;manifest=rest;oldId=await historical();
  await prisma.settings.update({where:{id:'singleton'},data:{metaEnabled:true,botEnabled:true,botInstagramEnabled:true,metaVerifyToken:encryptSecret(tag)}});
  await prisma.messengerAccount.create({data:{id:accountId,channel:'INSTAGRAM',externalId:resource,title:tag,enabled:true,token:encryptSecret(tag),appSecret:encryptSecret(secret)}});
  const scope=await prisma.$transaction(tx=>ensureCustomerEndpoint(tx,{channel:'INSTAGRAM',subscriberId:peer,accountId,accountExternalId:resource}));scopeId=scope.endpointScopeId;
  vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('Routine controls must not call providers');}));
});
beforeEach(async()=>{
  await prisma.agent.update({where:{id:actorId},data:{role:'DIRECTOR',isActive:true,permissions:Prisma.DbNull}});
  invalidateAgentAccess(actorId);revokeElevation(actorId);await install();
});
afterEach(async()=>{
  expect(fetch).not.toHaveBeenCalled();vi.restoreAllMocks();revokeElevation(actorId);
  await drainBackgroundTasks(3000);
  await prisma.backgroundJob.deleteMany({where:{dedupeKey:{in:events.map(e=>`customer-inbox-consume:${e}`)}}});
  await prisma.customerPropertyIngressTicket.deleteMany({where:{eventKey:{in:events}}});
  await prisma.customerAgentRolloutAssignment.deleteMany({where:{endpointScopeId:scopeId}});
});
afterAll(async()=>{
  try{
    if(savedPolicy)await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"=${savedPolicy.contractVersion},"rolloutMode"=${savedPolicy.rolloutMode},
      "activeAgentRevisionId"=${savedPolicy.activeAgentRevisionId},"rolloutConfig"=${savedPolicy.rolloutConfig===null?null:JSON.stringify(savedPolicy.rolloutConfig)}::jsonb,"capabilities"=${JSON.stringify(savedPolicy.capabilities)}::jsonb WHERE "id"='singleton'`;
    // Revision manifests and advance edges remain immutable, including fixtures.
    await prisma.customerEndpointScope.deleteMany({where:{id:scopeId}});await prisma.messengerAccount.deleteMany({where:{id:accountId}});
    await prisma.auditLog.deleteMany({where:{agentId:{in:[actorId,staffId]}}});await prisma.errorLog.deleteMany({where:{agentId:{in:[actorId,staffId]}}});
    await prisma.session.deleteMany({where:{agentId:{in:[actorId,staffId]}}});await prisma.agent.deleteMany({where:{id:{in:[actorId,staffId]}}});
  }finally{
    if(savedSettings)await prisma.settings.update({where:{id:'singleton'},data:{metaEnabled:savedSettings.metaEnabled,botEnabled:savedSettings.botEnabled,botInstagramEnabled:savedSettings.botInstagramEnabled,metaVerifyToken:savedSettings.metaVerifyToken}});
    vi.unstubAllGlobals();
  }
});
it('requires a real current administrator even when ordinary staff has settings.manage',async()=>{
  const before=await readPolicy();
  expect((await request(app).post(`${base}/refresh-current`).send(await command())).status).toBe(401);
  expect((await request(app).post(`${base}/refresh-current`).set(auth(staffToken)).send(await command())).status).toBe(403);
  expect((await readPolicy()).policyRevision).toBe(before.policyRevision);
});
it.each([{percentBasisPoints:10000},{capabilities:{handoverWrite:true}},{candidateRevisionId:'f'.repeat(64)},{authority:'retained_policy_refresh'},{confirmMediaProfileUpgrade:true}])('rejects client policy/authority overrides: %j',async extra=>{
  const before=await readPolicy();
  expect((await request(app).post(`${base}/refresh-current`).set(auth()).send(await command(extra))).status).toBe(400);
  expect((await readPolicy()).policyRevision).toBe(before.policyRevision);
});
it('adopts only the actual deployed factory at the retained50%, scopes and rights without creating an elevation grant',async()=>{
  const before=await readPolicy();
  const response=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command());
  expect(response.status,JSON.stringify(response.body)).toBe(200);
  const after=await readPolicy(),prior=before.rolloutConfig as Record<string,unknown>,next=after.rolloutConfig as Record<string,unknown>;
  expect(after.activeAgentRevisionId).toBe(newId);expect(next.cohortId).not.toBe(prior.cohortId);
  expect({...next,candidateRevisionId:prior.candidateRevisionId,cohortId:prior.cohortId}).toEqual(prior);
  expect(after.capabilities).toEqual(before.capabilities);expect(after.policyRevision).toBe(before.policyRevision+1n);
  const audit=await prisma.auditLog.findFirstOrThrow({where:{agentId:actorId,action:'CUSTOMER_AGENT_PUBLISH'},orderBy:{createdAt:'desc'}});
  expect(audit.meta).toMatchObject({authority:'retained_policy_refresh',routineRefresh:true,retainedPaidAuthority:true,paidConfirmed:null,noDailyCapAcknowledged:null,percentBasisPoints:5000});
  expect((await request(app).get('/api/v1/auth/step-up').set(auth())).body.elevated).toBe(false);
});
it('is a verified no-op when this factory is already current',async()=>{
  await install(newId);const before=await readPolicy();
  const response=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command());
  expect(response.status).toBe(200);expect(response.body.alreadyCurrent).toBe(true);
  expect((await readPolicy()).policyRevision).toBe(before.policyRevision);
});
it('commits one publication for two concurrent routine refreshes with the same policy revision',async()=>{
  const before=await readPolicy(),body=await command();
  const responses=await Promise.all([1,2].map(()=>request(app).post(`${base}/refresh-current`).set(auth()).send(body)));
  expect(responses.map(r=>r.status).sort(),JSON.stringify(responses.map(r=>r.body))).toEqual([200,409]);
  expect((await readPolicy()).policyRevision).toBe(before.policyRevision+1n);
});
it.each(['mode','capabilities','percentage'] as const)('rejects a concurrent %s change after artifact verification',async field=>{
  const original=registration.loadVerifiedCustomerAgentRevision;
  let concurrent:Awaited<ReturnType<typeof readPolicy>>|undefined;
  vi.spyOn(registration,'loadVerifiedCustomerAgentRevision').mockImplementation(async value=>{
    const verified=await original(value);
    if(field==='mode')await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutMode"='OFF' WHERE "id"='singleton'`;
    else if(field==='capabilities')await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "capabilities"=${JSON.stringify({...capabilities,contactWrite:false})}::jsonb WHERE "id"='singleton'`;
    else await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=jsonb_set("rolloutConfig",'{percentBasisPoints}','2500'::jsonb) WHERE "id"='singleton'`;
    concurrent=await readPolicy();
    return verified;
  });
  const before=await readPolicy();
  const response=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command());
  expect(response.status,JSON.stringify(response.body)).toBe(409);
  const after=await readPolicy();expect(concurrent).toBeDefined();expect(after).toEqual(concurrent);
  expect(after.activeAgentRevisionId).toBe(before.activeAgentRevisionId);
  if(field==='mode')expect(after.rolloutMode).toBe('OFF');
  if(field==='capabilities')expect(after.capabilities).toEqual({...capabilities,contactWrite:false});
  if(field==='percentage')expect(after.rolloutConfig).toMatchObject({percentBasisPoints:2500});
});
it('does not turn OFF into ACTIVE',async()=>{
  await install(oldId,'OFF');const before=await readPolicy();
  expect((await request(app).post(`${base}/refresh-current`).set(auth()).send(await command())).status).toBe(409);
  expect(await readPolicy()).toEqual(before);
});
it.each(['promptHash','knowledgeSourceHash','providerProfileHash','providerPolicyHash'] as const)('rejects a changed %s without changing the active policy',async field=>{
  await install(await historical({[field]:'b'.repeat(64)}));const before=await readPolicy();
  const response=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command());
  expect(response.status,JSON.stringify(response.body)).toBe(409);expect(await readPolicy()).toEqual(before);
});
it('does not silently change per-turn model limits',async()=>{
  await install(await historical({limits:{...manifest.limits,maxModelOutputTokens:manifest.limits.maxModelOutputTokens+1}}));
  const before=await readPolicy();
  expect((await request(app).post(`${base}/refresh-current`).set(auth()).send(await command())).status).toBe(409);
  expect(await readPolicy()).toEqual(before);
});
it('accepts the existing qualified catalog-only transition with identical provider, business policy and budgets',async()=>{
  await install(await historical({toolSchemaHash:'c'.repeat(64),knowledgeSchemaHash:'d'.repeat(64)}));
  const before=await readPolicy();const response=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command());
  expect(response.status,JSON.stringify(response.body)).toBe(200);
  expect((await readPolicy()).capabilities).toEqual(before.capabilities);
  expect((await readPolicy()).rolloutConfig).toMatchObject({percentBasisPoints:5000,allowed:(before.rolloutConfig as {allowed:unknown}).allowed});
});
it('rejects a stale revision and keeps ordinary registration/publish/kill step-up requirements',async()=>{
  const stale=((await readPolicy()).policyRevision+1n).toString();
  expect((await request(app).post(`${base}/refresh-current`).set(auth()).send({expectedPolicyRevision:stale,reason:tag})).status).toBe(409);
  const p=await readPolicy();
  expect((await request(app).post(`${base}/revisions/register`).set(auth()).send({configId:createCustomerAgentMediaProviderSnapshot().configRevision,reason:tag})).status).toBe(428);
  expect((await request(app).put(`${base}/rollout`).set(auth()).send({})).status).toBe(428);
  expect((await request(app).post(`${base}/kill`).set(auth()).send({expectedPolicyRevision:p.policyRevision.toString(),reason:tag})).status).toBe(428);
  expect((await readPolicy()).policyRevision).toBe(p.policyRevision);
});
it('respects pending signed customer work instead of invalidating it or falling back',async()=>{
  await install(oldId,'ACTIVE',10000);const ticket=await capturePending();
  expect(ticket.intakeAgentRevisionId).toBe(oldId);const before=await readPolicy();
  const response=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command());
  expect(response.status).toBe(409);expect(response.body.error).toBe('core_work_requires_idle_publication');
  expect(await readPolicy()).toEqual(before);
  expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({where:{eventKey:ticket.eventKey}})).processingState).toBe(ticket.processingState);
});
it.each([
  ['role',{role:'AGENT' as const}],
  ['activity',{isActive:false}],
  ['permission',{role:'ADMIN' as const,permissions:{granted:[],revoked:['settings.manage']}}],
] as const)('rechecks actual DB %s after artifact awaits, despite a previously accepted director JWT',async(_name,data)=>{
  const original=registration.loadVerifiedCustomerAgentRevision;
  vi.spyOn(registration,'loadVerifiedCustomerAgentRevision').mockImplementation(async value=>{
    const verified=await original(value);await prisma.agent.update({where:{id:actorId},data:JSON.parse(JSON.stringify(data))});return verified;
  });
  const before=await readPolicy();
  expect((await request(app).post(`${base}/refresh-current`).set(auth()).send(await command())).status).toBe(403);
  expect(await readPolicy()).toEqual(before);
});

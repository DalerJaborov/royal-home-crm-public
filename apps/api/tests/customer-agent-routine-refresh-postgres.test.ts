// Real authenticated HTTP + PostgreSQL. Only the historical release manifest is
// synthetic. No principal/permission mocks, model calls or delivery attempts.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import bcrypt from 'bcrypt';
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
import { inspectCustomerDeliveryObservation } from '../src/lib/customerDeliveryObservation.js';
import { dispatchCustomerOutboxPart } from '../src/lib/customerDeliveryDispatcher.js';
import { CUSTOMER_RECRUITMENT_UPGRADE_V1, CUSTOMER_RECRUITMENT_RESUME_UPGRADE_V2 } from '../src/lib/customerRecruitmentUpgrade.js';
import { CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V2 } from '../src/lib/customerAgentQualityContinuityUpgrade.js';
import {customerAgentRevisionReachable} from '../src/lib/customerAgentRevisionAdvance.js';
import {readCustomerDmSourceExecution} from '../src/lib/customerAgentEnrollment.js';
import * as revisionLineage from '../src/lib/customerAgentRevisionAdvance.js';

const tag=`synthetic-routine-refresh-${randomUUID()}`, base='/api/v1/settings/customer-agent';
const password=`Synthetic-${tag}`;
const accountId=randomUUID(),resource=`${tag}-resource`,peer=`${tag}-peer`,secret=`${tag}-secret`;
const events:string[]=[];
const isolatedParts:string[]=[];
const isolatedInquiries:string[]=[];
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
  const actor=await prisma.agent.create({data:{fullName:tag,phone:`synthetic-${randomUUID()}`,role:'DIRECTOR',passwordHash:await bcrypt.hash(password,4)}});
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
  await prisma.customerDeliveryAttempt.deleteMany({where:{partId:{in:isolatedParts}}});
  await prisma.customerOutboxPart.deleteMany({where:{id:{in:isolatedParts}}});
  await prisma.customerInquiry.deleteMany({where:{id:{in:isolatedInquiries}}});
  await prisma.backgroundJob.deleteMany({where:{dedupeKey:{in:events.map(e=>`customer-inbox-consume:${e}`)}}});
  await prisma.customerPropertyIngressTicket.deleteMany({where:{eventKey:{in:events}}});
  await prisma.customerAgentRolloutAssignment.deleteMany({where:{endpointScopeId:scopeId}});
});
// Disposable historical transport fixtures, never admissions or send grants.
async function uncertainPart(ageMinutes:number,withAttempt=true,lease=false) {
  const id=randomUUID(),at=new Date(Date.now()-ageMinutes*60000);
  isolatedParts.push(id);
  const inquiry=await prisma.customerInquiry.create({data:{endpointScopeId:scopeId,peerId:peer,threadId:id}});
  isolatedInquiries.push(inquiry.id);
  await prisma.customerOutboxPart.create({data:{id,inquiryId:inquiry.id,partKey:createHash('sha256').update(id).digest('hex'),
    originalNativeId:randomUUID(),turnKey:id,ordinal:0,mode:'LIVE',sourceKind:'BOT_TURN',sourceKey:id,
    channel:'INSTAGRAM',endpointScopeId:scopeId,agentRevisionId:oldId,transportJson:{},
    payloadEncrypted:encryptSecret(JSON.stringify({kind:'text',text:'Synthetic uncertain delivery'})),
    payloadHash:createHash('sha256').update(JSON.stringify({kind:'text',text:'Synthetic uncertain delivery'})).digest('hex'),payloadVersion:1,
    fenceJson:{endpoint:{peerId:peer}},receiptRefsJson:[],status:'UNKNOWN',createdAt:at,
    ...(lease?{leaseOwner:id,leaseUntil:new Date(Date.now()+60000)}:{})}});
  if(withAttempt)await prisma.customerDeliveryAttempt.create({data:{partId:id,endpointScopeId:scopeId,
    attemptNo:1,claimRevision:0n,startedAt:at,finishedAt:at,outcome:'UNKNOWN',errorCode:'synthetic_network_failure',dispatchFenceJson:{}}});
  return id;
}
it('updates unrelated future work while retaining a closed historical UNKNOWN and its source quarantine without resending',async()=>{
  const id=await uncertainPart(10),before=await prisma.customerOutboxPart.findUniqueOrThrow({where:{id}});
  const attempts=await prisma.customerDeliveryAttempt.findMany({where:{partId:id}});
  expect(await inspectCustomerDeliveryObservation({endpointScopeId:scopeId,peerId:peer})).toEqual({status:'ambiguous_own_send'});
  const response=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command());
  expect(response.status,JSON.stringify(response.body)).toBe(200);
  expect(await prisma.customerOutboxPart.findUniqueOrThrow({where:{id}})).toEqual(before);
  expect(await prisma.customerDeliveryAttempt.findMany({where:{partId:id}})).toEqual(attempts);
  expect(await dispatchCustomerOutboxPart(id)).toEqual({status:'unknown'});
  expect(await inspectCustomerDeliveryObservation({endpointScopeId:scopeId,peerId:peer})).toEqual({status:'ambiguous_own_send'});
  expect(await inspectCustomerDeliveryObservation({endpointScopeId:scopeId,peerId:peer+'-other'})).toEqual({status:'none'});
});
it.each([[0,true,false],[10,false,false],[10,true,true]] as const)('still blocks unresolved/live UNKNOWN: age=%i attempt=%s lease=%s',async(age,attempt,lease)=>{
  await uncertainPart(age,attempt,lease);const before=await readPolicy();
  const response=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command());
  expect(response.status).toBe(409);expect(response.body.error).toBe('core_work_requires_idle_publication');
  expect(await readPolicy()).toEqual(before);
  await expect(prisma.customerAgentRevisionAdvance.create({data:{fromRevisionId:oldId,
    fromCohortId:(before.rolloutConfig as {cohortId:string}).cohortId,toRevisionId:newId,toCohortId:randomUUID(),
    policyRevision:before.policyRevision+1n}})).rejects.toThrow(/requires idle/u);
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
it('actual retained publication crosses sixteen edges without dropping original subjects or changing original source pins',async()=>{
  const root=await historical();await install(root,'ACTIVE',10000);
  const original=await capturePending();
  await prisma.customerPropertyIngressTicket.update({where:{eventKey:original.eventKey},data:{processingState:'HELD',errorCode:'synthetic-idle-routing-fixture'}});
  const assignment=await prisma.customerAgentRolloutAssignment.findUniqueOrThrow({where:{id:original.rolloutAssignmentId!}});
  for(let i=0;i<16;i++){
    const p=await readPolicy(),prior=p.rolloutConfig as {cohortId:string},next=await historical(),cohort=randomUUID();
    await prisma.$executeRaw`INSERT INTO "CustomerAgentRevisionAdvance" ("id","fromRevisionId","fromCohortId","toRevisionId","toCohortId","policyRevision","approvedAt")
      VALUES (${randomUUID()},${p.activeAgentRevisionId},${prior.cohortId},${next},${cohort},${p.policyRevision+1n},now())`;
    await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "activeAgentRevisionId"=${next},"rolloutConfig"=${JSON.stringify({...p.rolloutConfig as object,candidateRevisionId:next,cohortId:cohort,percentBasisPoints:5000})}::jsonb WHERE "id"='singleton'`;
  }
  const before=await readPolicy(),response=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command());
  expect(response.status,JSON.stringify(response.body)).toBe(200);
  const after=await readPolicy(),cohort=(after.rolloutConfig as {cohortId:string}).cohortId;
  expect(after.capabilities).toEqual(before.capabilities);
  expect(after.rolloutConfig).toMatchObject({percentBasisPoints:5000,allowed:(before.rolloutConfig as {allowed:unknown}).allowed});
  expect(await customerAgentRevisionReachable(prisma,assignment,newId,cohort)).toBe(true);
  const scope=await prisma.customerEndpointScope.findUniqueOrThrow({where:{id:scopeId}});
  const subject={surface:'dm' as const,endpoint:{endpointScopeId:scopeId,scopeRevision:String(scope.scopeRevision),channel:'INSTAGRAM' as const,accountId,transportKey:scope.transportKey},peer};
  expect(await readCustomerDmSourceExecution(prisma,original.eventKey,original.scopeKey,subject)).toMatchObject({lane:'CORE',revisionId:root});
  const fresh=await capturePending();expect(fresh.intakeAgentRevisionId).toBe(newId);expect(fresh.rolloutAssignmentId).toBe(assignment.id);
  expect(await prisma.customerAgentRolloutAssignment.findUniqueOrThrow({where:{id:assignment.id}})).toEqual(assignment);
  expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({where:{eventKey:original.eventKey}})).intakeAgentRevisionId).toBe(root);
});
it('a failed prospective lineage observation rolls back the tentative edge and policy before publication',async()=>{
  await install(oldId,'ACTIVE',10000);
  const source=await capturePending();
  await prisma.customerPropertyIngressTicket.update({where:{eventKey:source.eventKey},data:{processingState:'HELD',errorCode:'synthetic-idle-routing-fixture'}});
  const before=await readPolicy(),cohort=(before.rolloutConfig as {cohortId:string}).cohortId;
  const count=await prisma.auditLog.count({where:{agentId:actorId,action:'CUSTOMER_AGENT_PUBLISH'}});
  const actual=revisionLineage.customerAgentRevisionReachable;
  // A deny-only fault injection, never a substitute positive permission proof.
  vi.spyOn(revisionLineage,'customerAgentRevisionReachable').mockImplementation((db,from,to,toCohort)=>
    to===newId?Promise.resolve(false):actual(db,from,to,toCohort));
  const response=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command());
  expect(response.status).toBe(409);expect(response.body.error).toBe('revision_advance_target_unreachable');
  expect(await readPolicy()).toEqual(before);
  expect(await prisma.customerAgentRevisionAdvance.count({where:{fromRevisionId:oldId,fromCohortId:cohort}})).toBe(0);
  expect(await prisma.auditLog.count({where:{agentId:actorId,action:'CUSTOMER_AGENT_PUBLISH'}})).toBe(count);
  expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({where:{eventKey:source.eventKey}})).intakeAgentRevisionId).toBe(oldId);
});
it('retains the catalog-only refresh path separately from the pinned quality/continuity prompt change',async()=>{
  const pair=CUSTOMER_RECRUITMENT_UPGRADE_V1;
  expect(manifest.promptHash).toBe(CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V2.toPrompt);
  expect(manifest.knowledgeSchemaHash).toBe(CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V2.toKnowledgeSchema);
  expect(manifest.toolSchemaHash).toBe('16dcce629b9cec908e64942333769bdc05353fbe5675726fe9c9cfd3c9ee7b67');
  await install(await historical({toolSchemaHash:pair.toTools}));
  const before=await readPolicy();
  const response=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command());
  expect(response.status,JSON.stringify(response.body)).toBe(200);
  const after=await readPolicy();expect(after.activeAgentRevisionId).toBe(newId);
  expect(after.capabilities).toEqual(before.capabilities);
  expect(after.rolloutConfig).toMatchObject({percentBasisPoints:5000,allowed:(before.rolloutConfig as {allowed:unknown}).allowed});
  const audit=await prisma.auditLog.findFirstOrThrow({where:{agentId:actorId,action:'CUSTOMER_AGENT_PUBLISH'},orderBy:{createdAt:'desc'}});
  expect(audit.meta).toMatchObject({authority:'retained_policy_refresh',catalogFactsUpgrade:true,recruitmentProtocolUpgrade:false,paidConfirmed:null});
});
it('requires a distinct elevated quality/continuity acknowledgement before advancing the actual current factory',async()=>{
  const pair=CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V2;
  await install(await historical({promptHash:pair.fromPrompt,toolSchemaHash:pair.toolSchemaHash,knowledgeSchemaHash:pair.fromKnowledgeSchema}),'ACTIVE',10000);
  const before=await readPolicy();
  const denied=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command());
  expect(denied.status).toBe(409);expect(denied.body.error).toBe('quality_continuity_upgrade_confirmation_required');
  expect(await readPolicy()).toEqual(before);
  const noElevation=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command({confirmQualityContinuityUpgrade:true}));
  expect(noElevation.status).toBe(428);expect(noElevation.body.error).toBe('step_up_required');
  expect(await readPolicy()).toEqual(before);
  expect((await request(app).post('/api/v1/auth/step-up').set(auth()).send({password})).status).toBe(200);
  const response=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command({confirmQualityContinuityUpgrade:true}));
  expect(response.status,JSON.stringify(response.body)).toBe(200);
  const after=await readPolicy();expect(after.activeAgentRevisionId).toBe(newId);
  expect(after.capabilities).toEqual(before.capabilities);
  expect(after.rolloutConfig).toMatchObject({percentBasisPoints:10000,allowed:(before.rolloutConfig as {allowed:unknown}).allowed});
  const audit=await prisma.auditLog.findFirstOrThrow({where:{agentId:actorId,action:'CUSTOMER_AGENT_PUBLISH'},orderBy:{createdAt:'desc'}});
  expect(audit.meta).toMatchObject({authority:'quality_continuity_step_up',routineRefresh:true,qualityContinuityUpgradeVersion:'v2',recruitmentResumeUpgradeVersion:null,catalogFactsUpgrade:false,percentBasisPoints:10000,paidConfirmed:null,noDailyCapAcknowledged:null});
  // Elevation is the existing timed settings session, not a consumed one-shot grant.
  expect((await request(app).get('/api/v1/auth/step-up').set(auth())).body.elevated).toBe(true);
});
it('rejects quality acknowledgement for an unqualified prompt and a current-version replay',async()=>{
  expect((await request(app).post('/api/v1/auth/step-up').set(auth()).send({password})).status).toBe(200);
  const historicalResume=CUSTOMER_RECRUITMENT_RESUME_UPGRADE_V2;
  await install(await historical({promptHash:historicalResume.fromPrompt,toolSchemaHash:historicalResume.fromTools}));
  const oldResumeBefore=await readPolicy();
  const oldResume=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command({confirmRecruitmentResumeUpgrade:true}));
  expect(oldResume.status).toBe(409);expect(oldResume.body.error).toBe('recruitment_resume_upgrade_not_qualified');
  expect(await readPolicy()).toEqual(oldResumeBefore);
  await install(await historical({promptHash:'f'.repeat(64)}));const before=await readPolicy();
  expect((await request(app).post(`${base}/refresh-current`).set(auth()).send(await command({confirmQualityContinuityUpgrade:true}))).status).toBe(409);
  expect(await readPolicy()).toEqual(before);
  await install(newId);const already=await readPolicy();
  const response=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command({confirmQualityContinuityUpgrade:true}));
  expect(response.status).toBe(409);expect(response.body.error).toBe('quality_continuity_upgrade_not_required');
  expect(await readPolicy()).toEqual(already);
});
it.each(['tools','knowledge','knowledge-schema','limits','provider-profile','provider-policy'] as const)('quality/continuity acknowledgement cannot change another %s',async field=>{
  const pair=CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V2;
  const change:Record<string,unknown>={promptHash:pair.fromPrompt,toolSchemaHash:pair.toolSchemaHash,knowledgeSchemaHash:pair.fromKnowledgeSchema};
  if(field==='tools')change.toolSchemaHash='f'.repeat(64);
  if(field==='knowledge')change.knowledgeSourceHash='f'.repeat(64);
  if(field==='knowledge-schema')change.knowledgeSchemaHash='f'.repeat(64);
  if(field==='limits')change.limits={...manifest.limits,maxModelOutputTokens:manifest.limits.maxModelOutputTokens+1};
  if(field==='provider-profile')change.providerProfileHash='f'.repeat(64);
  if(field==='provider-policy')change.providerPolicyHash='f'.repeat(64);
  await install(await historical(change));const before=await readPolicy();
  expect((await request(app).post('/api/v1/auth/step-up').set(auth()).send({password})).status).toBe(200);
  const response=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command({confirmQualityContinuityUpgrade:true}));
  expect(response.status,JSON.stringify(response.body)).toBe(409);expect(await readPolicy()).toEqual(before);
});
it('does not extend the historical recruitment prompt permission to a different availability tool catalog',async()=>{
  const pair=CUSTOMER_RECRUITMENT_UPGRADE_V1;
  await install(await historical({promptHash:pair.fromPrompt,toolSchemaHash:pair.fromTools}));
  const before=await readPolicy();
  const count=await prisma.auditLog.count({where:{agentId:actorId,action:'CUSTOMER_AGENT_PUBLISH'}});
  const response=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command());
  expect(response.status,JSON.stringify(response.body)).toBe(409);
  expect(await readPolicy()).toEqual(before);
  expect(await prisma.auditLog.count({where:{agentId:actorId,action:'CUSTOMER_AGENT_PUBLISH'}})).toBe(count);
});
it.each(['prompt','tools','knowledge','limits','provider-profile','provider-policy'] as const)(
  'the reviewed recruitment transition still rejects another %s without publishing or creating an elevation grant',async field=>{
    const pair=CUSTOMER_RECRUITMENT_UPGRADE_V1;
    const change:Record<string,unknown>={promptHash:pair.fromPrompt,toolSchemaHash:pair.fromTools};
    if(field==='prompt')change.promptHash='f'.repeat(64);
    if(field==='tools')change.toolSchemaHash='f'.repeat(64);
    if(field==='knowledge')change.knowledgeSourceHash='f'.repeat(64);
    if(field==='limits')change.limits={...manifest.limits,maxModelOutputTokens:manifest.limits.maxModelOutputTokens+1};
    if(field==='provider-profile')change.providerProfileHash='f'.repeat(64);
    if(field==='provider-policy')change.providerPolicyHash='f'.repeat(64);
    await install(await historical(change));const before=await readPolicy();
    const count=await prisma.auditLog.count({where:{agentId:actorId,action:'CUSTOMER_AGENT_PUBLISH'}});
    const response=await request(app).post(`${base}/refresh-current`).set(auth()).send(await command());
    expect(response.status,JSON.stringify(response.body)).toBe(409);expect(await readPolicy()).toEqual(before);
    expect(await prisma.auditLog.count({where:{agentId:actorId,action:'CUSTOMER_AGENT_PUBLISH'}})).toBe(count);
    expect((await request(app).get('/api/v1/auth/step-up').set(auth())).body.elevated).toBe(false);
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

// PRIVATE normal real HTTP/SQL tests, NOT RUN. No permission/principal mocks.
import { createHmac,randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { afterAll,afterEach,beforeAll,expect,it,vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { invalidateAgentAccess } from '../src/auth/middleware.js';
import { revokeElevation } from '../src/lib/stepUp.js';
import { encryptSecret } from '../src/crypto.js';
import { createCustomerAgentMediaProviderSnapshot as createCustomerAgentProviderSnapshot } from '../src/ai/customerAgentProviderConfig.js';
import { registerCurrentCustomerAgentRevision } from '../src/lib/customerAgentRegistration.js';
import { ensureCustomerEndpoint } from '../src/lib/customerConversationScope.js';
import { persistVerifiedCustomerIngressBatch } from '../src/lib/customerIngressProducer.js';
import { registerAuthenticatedMetaCustomerRequest } from '../src/lib/customerIngressAuthority.js';
import { persistVerifiedMetaPublicCommentBatch } from '../src/lib/customerPublicCommentProducer.js';
import { ensurePublicCommentInstallation } from '../src/lib/customerPublicCommentStore.js';
import { drainBackgroundTasks } from '../src/lib/shutdownState.js';
const tag=`owner-rollout-${randomUUID()}`,password=`Synthetic-${tag}`,base='/api/v1/settings/customer-agent';
const actors:string[]=[],accounts:string[]=[],scopes:string[]=[],events:string[]=[],resources:string[]=[];
let policy:Awaited<ReturnType<typeof readPolicy>>,settings:Awaited<ReturnType<typeof readSettings>>;
let director:{id:string;token:string},agent:{id:string;token:string},revisionId='';
const readPolicy=()=>prisma.customerRuntimePolicy.findUniqueOrThrow({where:{id:'singleton'}});
const readSettings=()=>prisma.settings.findUniqueOrThrow({where:{id:'singleton'},select:{metaEnabled:true,botEnabled:true,botInstagramEnabled:true,botCanAnswerComments:true,metaVerifyToken:true}});
async function actor(role:'DIRECTOR'|'AGENT'){
 const row=await prisma.agent.create({data:{fullName:`Synthetic rollout ${role}`,phone:`+992${Math.floor(Math.random()*900000000)+100000000}`,
  role,passwordHash:await bcrypt.hash(password,4)}});actors.push(row.id);return{id:row.id,token:signAccessToken({sub:row.id,role})};
}
const auth=(token:string)=>({Authorization:`Bearer ${token}`});
async function elevate(){expect((await request(app).post('/api/v1/auth/step-up').set(auth(director.token)).send({password})).status).toBe(200);}
async function endpoint(){
 const id=randomUUID(),resource=`${tag}-account-${id}`,secret=`${tag}-secret-${id}`;
 await prisma.messengerAccount.create({data:{id,channel:'INSTAGRAM',externalId:resource,title:'Synthetic owner routing',enabled:true,
  username:`synthetic_owner_${id.replaceAll('-','')}`,token:encryptSecret(`${tag}-token-${id}`),appSecret:encryptSecret(secret)}});accounts.push(id);resources.push(resource);
 const peer=`${tag}-peer-${id}`,scope=await prisma.$transaction(tx=>ensureCustomerEndpoint(tx,{channel:'INSTAGRAM',subscriberId:peer,accountId:id,accountExternalId:resource}));
 scopes.push(scope.endpointScopeId);return{id,resource,secret,peer,scope};
}
async function body(e:Awaited<ReturnType<typeof endpoint>>,percent=0){const p=await readPolicy();return{expectedPolicyRevision:p.policyRevision.toString(),
 rollout:{version:1,cohortId:randomUUID(),candidateRevisionId:revisionId,percentBasisPoints:percent,allowed:[{surface:'dm',channel:'INSTAGRAM',endpointScopeId:e.scope.endpointScopeId}]},
 capabilities:{publicRead:true,contactWrite:false,callbackWrite:false,newLeadBridge:false,handoverWrite:false,showingWrite:false,ownerQuestionWrite:false},
 confirmManagedPaidCalls:true,acknowledgeNoDailyCap:true,reason:tag};}
beforeAll(async()=>{policy=await readPolicy();settings=await readSettings();director=await actor('DIRECTOR');agent=await actor('AGENT');
 await prisma.settings.update({where:{id:'singleton'},data:{metaEnabled:true,botEnabled:true,botInstagramEnabled:true,botCanAnswerComments:true,metaVerifyToken:encryptSecret(`${tag}-verify`)}});
 revisionId=(await registerCurrentCustomerAgentRevision(createCustomerAgentProviderSnapshot())).id;
 vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('Owner controls must perform zero provider/model calls');}));});
afterEach(async()=>{expect(fetch).not.toHaveBeenCalled();vi.restoreAllMocks();if(director)revokeElevation(director.id);});
afterAll(async()=>{try{await drainBackgroundTasks(3000);
 await prisma.backgroundJob.deleteMany({where:{dedupeKey:{in:events.map(e=>`customer-inbox-consume:${e}`)}}});
 await prisma.customerPropertyIngressTicket.deleteMany({where:{endpointScopeId:{in:scopes}}});
 await prisma.instagramComment.deleteMany({where:{accountExternalId:{in:resources}}});
 await prisma.customerEndpointScope.deleteMany({where:{id:{in:scopes}}});await prisma.messengerAccount.deleteMany({where:{id:{in:accounts}}});
 await prisma.auditLog.deleteMany({where:{agentId:{in:actors},action:{in:['CUSTOMER_AGENT_REGISTER','CUSTOMER_AGENT_PUBLISH','CUSTOMER_AGENT_KILL']}}});
 await prisma.errorLog.deleteMany({where:{agentId:{in:actors}}});
 await prisma.session.deleteMany({where:{agentId:{in:actors}}});await prisma.agent.deleteMany({where:{id:{in:actors}}});
 }finally{try{if(settings)await prisma.settings.update({where:{id:'singleton'},data:settings});}finally{if(policy){
 await prisma.customerRuntimePolicy.update({where:{id:'singleton'},data:{contractVersion:policy.contractVersion,rolloutMode:policy.rolloutMode,activeAgentRevisionId:policy.activeAgentRevisionId,capabilities:policy.capabilities!}});
 await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${policy.rolloutConfig===null?null:JSON.stringify(policy.rolloutConfig)}::jsonb WHERE "id"='singleton'`;
 }vi.unstubAllGlobals();}}});
it('ordinary staff is403 and a genuine settings actor without step-up is428, with zero changes',async()=>{
 const before=await readPolicy();
 expect((await request(app).post(`${base}/kill`).set(auth(agent.token)).send({expectedPolicyRevision:before.policyRevision.toString(),reason:tag})).status).toBe(403);
 expect((await request(app).post(`${base}/kill`).set(auth(director.token)).send({expectedPolicyRevision:before.policyRevision.toString(),reason:tag})).status).toBe(428);
 expect((await readPolicy()).policyRevision).toBe(before.policyRevision);
 expect(await prisma.auditLog.count({where:{agentId:director.id,action:'CUSTOMER_AGENT_KILL'}})).toBe(0);
});
it('an AGENT explicitly granted settings.manage still cannot use owner controls',async()=>{
 await prisma.agent.update({where:{id:agent.id},data:{permissions:{granted:['settings.manage'],revoked:[]}}});invalidateAgentAccess(agent.id);
 try{
  expect((await request(app).post('/api/v1/auth/step-up').set(auth(agent.token)).send({password})).status).toBe(200);
  expect((await request(app).get(base).set(auth(agent.token))).status).toBe(403);
  const p=await readPolicy();expect((await request(app).post(`${base}/kill`).set(auth(agent.token)).send({expectedPolicyRevision:p.policyRevision.toString(),reason:tag})).status).toBe(403);
  expect((await readPolicy()).policyRevision).toBe(p.policyRevision);
 }finally{revokeElevation(agent.id);await prisma.agent.update({where:{id:agent.id},data:{permissions:Prisma.DbNull}});invalidateAgentAccess(agent.id);}
});
it('real step-up registers actual server artifacts and an atomic audit without activation or provider I/O',async()=>{
 await elevate();const before=await readPolicy(),configId=createCustomerAgentProviderSnapshot().configRevision;
 const response=await request(app).post(`${base}/revisions/register`).set(auth(director.token)).send({configId,reason:tag});
 expect(response.status).toBe(200);expect(response.body).toEqual({revisionId,activated:false});
 expect((await readPolicy()).policyRevision).toBe(before.policyRevision);
 expect(await prisma.customerAgentRevision.count({where:{id:revisionId}})).toBe(1);
 expect(await prisma.auditLog.count({where:{agentId:director.id,action:'CUSTOMER_AGENT_REGISTER',entityId:revisionId}})).toBe(1);
 expect((await request(app).post(`${base}/revisions/register`).set(auth(director.token)).send({configId,reason:tag,model:'body-chosen-model'})).status).toBe(400);
});
it('fresh DB permission denial overrides an already cached director JWT/access result',async()=>{
 await elevate();expect((await request(app).get(base).set(auth(director.token))).status).toBe(200);
 const before=await readPolicy();await prisma.agent.update({where:{id:director.id},data:{role:'AGENT'}});
 try{expect((await request(app).post(`${base}/kill`).set(auth(director.token)).send({expectedPolicyRevision:before.policyRevision.toString(),reason:tag})).status).toBe(403);
  expect((await readPolicy()).policyRevision).toBe(before.policyRevision);
 }finally{await prisma.agent.update({where:{id:director.id},data:{role:'DIRECTOR'}});}
});
it('two actual concurrent publish HTTP requests with the same expected revision commit once and409 once',async()=>{
 await elevate();const e=await endpoint(),value=await body(e),before=await prisma.auditLog.count({where:{agentId:director.id,action:'CUSTOMER_AGENT_PUBLISH'}});
 const results=await Promise.all([request(app).put(`${base}/rollout`).set(auth(director.token)).send(value),request(app).put(`${base}/rollout`).set(auth(director.token)).send(value)]);
 expect(results.map(r=>r.status).sort(),JSON.stringify(results.map(r=>r.body))).toEqual([200,409]);
 expect(await prisma.auditLog.count({where:{agentId:director.id,action:'CUSTOMER_AGENT_PUBLISH'}})).toBe(before+1);
 expect((await readPolicy()).policyRevision>BigInt(value.expectedPolicyRevision)).toBe(true);
});
it('kill retains a real pending CORE source/pin/assignment and cannot silently publish a new cohort over its subject',async()=>{
 await elevate();const e=await endpoint(),value=await body(e,10000);
 // Same current cohort when any earlier CORE exists is a real explicit gate;
 // this fixture has not created another CORE, unlike the prior 0% route.
 expect((await request(app).put(`${base}/rollout`).set(auth(director.token)).send(value)).status).toBe(200);
 const rawBody=Buffer.from(JSON.stringify({object:'instagram',entry:[{id:e.resource,messaging:[{sender:{id:e.peer},recipient:{id:e.resource},timestamp:Date.now(),message:{mid:randomUUID(),text:'Здравствуйте'}}]}]}));
 const req={rawBody,get:()=>`sha256=${createHmac('sha256',e.secret).update(rawBody).digest('hex')}`};registerAuthenticatedMetaCustomerRequest(req);
 const stored=await persistVerifiedCustomerIngressBatch(req);expect(stored.status).toBe('persisted');if(stored.status!=='persisted')throw Error('Actual signed intake failed');
 const eventKey=stored.tickets[0].eventKey;events.push(eventKey);const before=await prisma.customerPropertyIngressTicket.findUniqueOrThrow({where:{eventKey}});
 expect(before.rolloutAssignmentId).not.toBeNull();const p=await readPolicy();
 const percentOnly={...value,expectedPolicyRevision:p.policyRevision.toString(),rollout:{...value.rollout,percentBasisPoints:9999}};
 const rejected=await request(app).put(`${base}/rollout`).set(auth(director.token)).send(percentOnly);
 expect(rejected.status).toBe(409);expect(rejected.body.error).toBe('core_work_requires_idle_publication');
 expect((await readPolicy()).policyRevision).toBe(p.policyRevision); // no unnecessary invalidation of pending RAW
 expect((await request(app).post(`${base}/kill`).set(auth(director.token)).send({expectedPolicyRevision:p.policyRevision.toString(),reason:tag})).status).toBe(200);
 const retained=await prisma.customerPropertyIngressTicket.findUniqueOrThrow({where:{eventKey}});
 expect(retained.intakeAgentRevisionId).toBe(before.intakeAgentRevisionId);expect(retained.rolloutAssignmentId).toBe(before.rolloutAssignmentId);
 expect(await prisma.customerOutboxPart.count({where:{ticketEventKey:eventKey}})).toBe(0);
 const changed=await body(e,10000);const response=await request(app).put(`${base}/rollout`).set(auth(director.token)).send(changed);
 expect(response.status).toBe(409);expect(response.body.error).toBe('existing_core_requires_idle_promotion');
 // Exact own fixture teardown after retention assertions, not an app reset or
 // permission to erase a live production source. Next audit-fault gate is idle.
 await prisma.backgroundJob.deleteMany({where:{dedupeKey:`customer-inbox-consume:${eventKey}`}});
 await prisma.customerPropertyIngressTicket.delete({where:{eventKey}});
});
it('actual audit INSERT failure rolls back policy publication instead of accepting a best-effort audit',async()=>{
 await elevate();const e=await endpoint(),value=await body(e,0);
 // If another earlier case owns CORE, retain its exact cohort/candidate. This
 // test changes only allowed scopes/percent, never bypasses immutable ownership.
 const existing=await prisma.$queryRaw<Array<{cohortId:string;candidateRevisionId:string}>>`SELECT "cohortId","candidateRevisionId" FROM "CustomerAgentRolloutAssignment" WHERE "lane"='CORE' LIMIT 1`;
 if(existing.length){value.rollout.cohortId=existing[0].cohortId;value.rollout.candidateRevisionId=existing[0].candidateRevisionId;}
 const before=await readPolicy(),faultReason=`${tag}-audit-fault-${randomUUID()}`,index=`test_rollout_audit_${randomUUID().replaceAll('-','')}`;
 value.reason=faultReason;value.expectedPolicyRevision=before.policyRevision.toString();
 const seed=await prisma.auditLog.create({data:{action:'CUSTOMER_AGENT_PUBLISH',entityType:'CustomerAgentPolicy',entityId:'singleton',
  agentId:director.id,agentName:'Synthetic constraint witness',meta:{reason:faultReason}}});
 // Bounded own-stand fault injection only. Its predicate targets this UUID actor
 // AND unique test reason; no app writer/global audit row is affected. No new
 // persistent migration or permission mock; always drop before cleanup.
 const quote=(text:string)=>Prisma.raw('"'+text.replaceAll('"','""')+'"');
 const literal=(text:string)=>Prisma.raw("'"+text.replaceAll("'","''")+"'");
 await prisma.$executeRaw(Prisma.sql`CREATE UNIQUE INDEX ${quote(index)} ON "AuditLog"("entityId") WHERE "agentId"=${literal(director.id)}
   AND "action"='CUSTOMER_AGENT_PUBLISH' AND "meta"->>'reason'=${literal(faultReason)}`);
 try{
  expect((await request(app).put(`${base}/rollout`).set(auth(director.token)).send(value)).status).toBe(500);
  const after=await readPolicy();expect(after.policyRevision).toBe(before.policyRevision);expect(after.rolloutMode).toBe(before.rolloutMode);
  expect(after.rolloutConfig).toEqual(before.rolloutConfig);expect(after.activeAgentRevisionId).toBe(before.activeAgentRevisionId);
  expect(await prisma.auditLog.count({where:{agentId:director.id,action:'CUSTOMER_AGENT_PUBLISH',meta:{path:['reason'],equals:faultReason}}})).toBe(1);
 }finally{await prisma.$executeRaw(Prisma.sql`DROP INDEX ${quote(index)}`);await prisma.auditLog.delete({where:{id:seed.id}});}
});
it('a genuine public elected source before OUT/model blocks percent publication without losing its immutable origin',async()=>{
 await elevate();const e=await endpoint(),installation=await ensurePublicCommentInstallation('INSTAGRAM',e.resource);
 if(!installation)throw Error('Actual public installation unavailable');scopes.push(installation.installation.id);
 const value=await body(e,10000),existing=await prisma.$queryRaw<Array<{cohortId:string;candidateRevisionId:string}>>`SELECT "cohortId","candidateRevisionId" FROM "CustomerAgentRolloutAssignment" WHERE "lane"='CORE' LIMIT 1`;
 if(existing.length){value.rollout.cohortId=existing[0].cohortId;value.rollout.candidateRevisionId=existing[0].candidateRevisionId;}
 const publication={...value,rollout:{...value.rollout,allowed:[{surface:'public_comment',channel:'INSTAGRAM',endpointScopeId:installation.installation.id}]}};
 expect((await request(app).put(`${base}/rollout`).set(auth(director.token)).send(publication)).status).toBe(200);
 const commentId=`${tag}-public-${randomUUID()}`,rawBody=Buffer.from(JSON.stringify({object:'instagram',entry:[{id:e.resource,changes:[{field:'comments',value:{id:commentId,
  media:{id:`${tag}-publication`},from:{id:`${tag}-public-author`},text:'Здравствуйте!'}}]}]}));
 const req={rawBody,get:()=>`sha256=${createHmac('sha256',e.secret).update(rawBody).digest('hex')}`};registerAuthenticatedMetaCustomerRequest(req);
 const captured=await persistVerifiedMetaPublicCommentBatch(req);expect(captured.status).toBe('persisted');
 const source=await prisma.instagramComment.findUniqueOrThrow({where:{commentId}});
 try{
  expect(source.status).toBe('PENDING');expect(source.publicOriginCiphertext).not.toBeNull();
  expect(await prisma.customerOutboxPart.count({where:{publicMetaCommentId:source.id}})).toBe(0);
  const p=await readPolicy(),change={...publication,expectedPolicyRevision:p.policyRevision.toString(),rollout:{...publication.rollout,percentBasisPoints:5000}};
  const response=await request(app).put(`${base}/rollout`).set(auth(director.token)).send(change);
  expect(response.status).toBe(409);expect(response.body.error).toBe('core_work_requires_idle_publication');
  expect((await readPolicy()).policyRevision).toBe(p.policyRevision);
  expect((await prisma.instagramComment.findUniqueOrThrow({where:{id:source.id}})).publicOriginCiphertext).toBe(source.publicOriginCiphertext);
 }finally{await prisma.instagramComment.delete({where:{id:source.id}});}
});

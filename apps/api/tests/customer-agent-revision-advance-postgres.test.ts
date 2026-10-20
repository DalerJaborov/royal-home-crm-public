// NORMAL PG + real authenticated HTTP + signed producer. Only the old release
// manifest is a synthetic historical fixture; no mocked permission/principal.
import { createHmac, randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import request from "supertest";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { revokeElevation } from "../src/lib/stepUp.js";
import { encryptSecret } from "../src/crypto.js";
import { createCustomerAgentMediaProviderSnapshot as createCustomerAgentProviderSnapshot, createCustomerAgentProviderSnapshot as createTextSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import { registerCurrentCustomerAgentRevision } from "../src/lib/customerAgentRegistration.js";
import { customerAgentManifestId } from "../src/lib/customerAgentRevision.js";
import { ensureCustomerEndpoint } from "../src/lib/customerConversationScope.js";
import { registerAuthenticatedMetaCustomerRequest } from "../src/lib/customerIngressAuthority.js";
import { persistVerifiedCustomerIngressBatch } from "../src/lib/customerIngressProducer.js";
import { customerAgentRevisionReachable } from "../src/lib/customerAgentRevisionAdvance.js";
import { readCustomerDmSourceExecution } from "../src/lib/customerAgentEnrollment.js";
import { Prisma } from "../src/generated/prisma/client.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

const tag=`synthetic-idle-advance-${randomUUID()}`, password=`Synthetic-${tag}`, accountId=randomUUID(), oldCohort=randomUUID(),newCohort=randomUUID();
const resource=`${tag}-resource`,peer=`${tag}-peer`,secret=`${tag}-secret`,base="/api/v1/settings/customer-agent";
const events:string[]=[];
let oldId="",newId="",actorId="",token="",scopeId="",savedPolicy:Awaited<ReturnType<typeof readPolicy>>,savedSettings:Awaited<ReturnType<typeof readSettings>>;
const readPolicy=()=>prisma.customerRuntimePolicy.findUniqueOrThrow({where:{id:"singleton"}});
const readSettings=()=>prisma.settings.findUniqueOrThrow({where:{id:"singleton"},select:{metaEnabled:true,botEnabled:true,botInstagramEnabled:true,metaVerifyToken:true}});
const auth=()=>({Authorization:`Bearer ${token}`});
async function capture(mid=randomUUID()) {
  const rawBody=Buffer.from(JSON.stringify({object:"instagram",entry:[{id:resource,messaging:[{sender:{id:peer},recipient:{id:resource},timestamp:Date.now(),message:{mid,text:"Какие варианты есть?"}}]}]}));
  const req={rawBody,get:()=>`sha256=${createHmac("sha256",secret).update(rawBody).digest("hex")}`};
  registerAuthenticatedMetaCustomerRequest(req);
  const result=await persistVerifiedCustomerIngressBatch(req);
  expect(result.status).toBe("persisted");if(result.status!=="persisted")throw Error("Signed producer failed");
  const eventKey=result.tickets[0].eventKey;events.push(eventKey);
  return prisma.customerPropertyIngressTicket.findUniqueOrThrow({where:{eventKey}});
}
async function publication(extra:Record<string,unknown>={}) {
  return {expectedPolicyRevision:(await readPolicy()).policyRevision.toString(),
    rollout:{version:1,cohortId:newCohort,candidateRevisionId:newId,percentBasisPoints:5000,
      allowed:[{surface:"dm",channel:"INSTAGRAM",endpointScopeId:scopeId}]},
    capabilities:{publicRead:true,contactWrite:false,callbackWrite:false,newLeadBridge:false,handoverWrite:false,showingWrite:false,ownerQuestionWrite:false},
    confirmManagedPaidCalls:true,acknowledgeNoDailyCap:true,reason:tag,...extra};
}
beforeAll(async()=>{
  savedPolicy=await readPolicy();savedSettings=await readSettings();
  await prisma.settings.update({where:{id:"singleton"},data:{metaEnabled:true,botEnabled:true,botInstagramEnabled:true,metaVerifyToken:encryptSecret(tag)}});
  const actor=await prisma.agent.create({data:{fullName:tag,phone:`+992${Math.floor(Math.random()*900000000)+100000000}`,role:"DIRECTOR",passwordHash:await bcrypt.hash(password,4)}});
  actorId=actor.id;token=signAccessToken({sub:actorId,role:"DIRECTOR"});
  const current=await registerCurrentCustomerAgentRevision(createCustomerAgentProviderSnapshot());newId=current.id;
  const {id:_,...manifest}=current;const previous={...manifest,coreHash:"f".repeat(64)};oldId=customerAgentManifestId(previous);
  await prisma.$executeRaw`INSERT INTO "CustomerAgentRevision" ("id","manifestJson","createdAt") VALUES (${oldId},${JSON.stringify(previous)}::jsonb,now()) ON CONFLICT DO NOTHING`;
  await prisma.messengerAccount.create({data:{id:accountId,channel:"INSTAGRAM",externalId:resource,title:tag,enabled:true,token:encryptSecret(tag),appSecret:encryptSecret(secret)}});
  const scope=await prisma.$transaction(tx=>ensureCustomerEndpoint(tx,{channel:"INSTAGRAM",subscriberId:peer,accountId,accountExternalId:resource}));scopeId=scope.endpointScopeId;
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"='scoped',"rolloutMode"='ACTIVE',"activeAgentRevisionId"=${oldId},
    "capabilities"='{"publicRead":true}'::jsonb,"rolloutConfig"=${JSON.stringify({version:1,cohortId:oldCohort,candidateRevisionId:oldId,percentBasisPoints:10000,allowed:[{surface:"dm",channel:"INSTAGRAM",endpointScopeId:scopeId}]})}::jsonb WHERE "id"='singleton'`;
  vi.stubGlobal("fetch",vi.fn(async()=>{throw Error("No provider calls allowed in idle routing tests");}));
});
afterAll(async()=>{
  try {
    await drainBackgroundTasks(3000);
    await prisma.backgroundJob.deleteMany({where:{dedupeKey:{in:events.map(e=>`customer-inbox-consume:${e}`)}}});
    await prisma.customerPropertyIngressTicket.deleteMany({where:{endpointScopeId:scopeId}});
    await prisma.customerEndpointScope.deleteMany({where:{id:scopeId}});await prisma.messengerAccount.deleteMany({where:{id:accountId}});
    await prisma.auditLog.deleteMany({where:{agentId:actorId}});await prisma.errorLog.deleteMany({where:{agentId:actorId}});
    await prisma.session.deleteMany({where:{agentId:actorId}});await prisma.agent.deleteMany({where:{id:actorId}});
  } finally {
    revokeElevation(actorId);await prisma.settings.update({where:{id:"singleton"},data:savedSettings});
    await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"=${savedPolicy.contractVersion},"rolloutMode"=${savedPolicy.rolloutMode},
      "activeAgentRevisionId"=${savedPolicy.activeAgentRevisionId},"capabilities"=${JSON.stringify(savedPolicy.capabilities)}::jsonb,
      "rolloutConfig"=${savedPolicy.rolloutConfig===null?null:JSON.stringify(savedPolicy.rolloutConfig)}::jsonb WHERE "id"='singleton'`;
    expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();
  }
});
it("requires separate catalog-schema consent and preserves model,50%,scopes and capabilities",async()=>{
  const baseline=await readPolicy(), next=await registerCurrentCustomerAgentRevision(createCustomerAgentProviderSnapshot());
  const {id:_,...manifest}=next;
  const previous={...manifest,toolSchemaHash:"c".repeat(64),knowledgeSchemaHash:"d".repeat(64)},previousId=customerAgentManifestId(previous);
  await prisma.$executeRaw`INSERT INTO "CustomerAgentRevision" ("id","manifestJson","createdAt") VALUES (${previousId},${JSON.stringify(previous)}::jsonb,now()) ON CONFLICT DO NOTHING`;
  const from=randomUUID(),to=randomUUID(),value=await publication({advanceIdleRevision:true});
  value.rollout={...value.rollout,cohortId:to};
  const oldRollout={...value.rollout,candidateRevisionId:previousId,cohortId:from};
  try {
    await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "activeAgentRevisionId"=${previousId},"rolloutConfig"=${JSON.stringify(oldRollout)}::jsonb,
      "capabilities"=${JSON.stringify(value.capabilities)}::jsonb WHERE "id"='singleton'`;
    const command=async(extra:Record<string,unknown>={})=>({...value,expectedPolicyRevision:(await readPolicy()).policyRevision.toString(),...extra});
    expect((await request(app).put(`${base}/rollout`).set(auth()).send(await command({confirmCatalogFactsUpgrade:true}))).status).toBe(428);
    expect((await request(app).post("/api/v1/auth/step-up").set(auth()).send({password})).status).toBe(200);
    let response=await request(app).put(`${base}/rollout`).set(auth()).send(await command());
    expect(response.status).toBe(409);expect(response.body.error).toBe("catalog_facts_upgrade_confirmation_required");
    const scopeChange=await command({confirmCatalogFactsUpgrade:true});scopeChange.rollout={...scopeChange.rollout,percentBasisPoints:7500};
    response=await request(app).put(`${base}/rollout`).set(auth()).send(scopeChange);
    expect(response.status).toBe(409);expect(response.body.error).toBe("catalog_facts_upgrade_configuration_changed");
    response=await request(app).put(`${base}/rollout`).set(auth()).send(await command({confirmCatalogFactsUpgrade:true}));
    expect(response.status,JSON.stringify(response.body)).toBe(200);
    expect((await readPolicy()).rolloutConfig).toMatchObject({candidateRevisionId:newId,percentBasisPoints:5000,cohortId:to});
    const audit=await prisma.auditLog.findFirstOrThrow({where:{agentId:actorId,action:"CUSTOMER_AGENT_PUBLISH"},orderBy:{createdAt:"desc"}});
    expect(audit.meta).toMatchObject({catalogFactsUpgrade:true,percentBasisPoints:5000});
  }finally{
    await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "activeAgentRevisionId"=${baseline.activeAgentRevisionId},
      "rolloutConfig"=${JSON.stringify(baseline.rolloutConfig)}::jsonb,"capabilities"=${JSON.stringify(baseline.capabilities)}::jsonb WHERE "id"='singleton'`;
    await prisma.auditLog.deleteMany({where:{agentId:actorId,action:"CUSTOMER_AGENT_PUBLISH"}});revokeElevation(actorId);
  }
});
it("requires genuine step-up and a separate exact media-profile acknowledgement without changing50%,scopes or rights",async()=>{
  const baseline=await readPolicy(), textRevision=await registerCurrentCustomerAgentRevision(createTextSnapshot());
  const mediaFrom=randomUUID(),mediaTo=randomUUID(),value=await publication({advanceIdleRevision:true});
  const oldRollout={...value.rollout,candidateRevisionId:textRevision.id,cohortId:mediaFrom};
  value.rollout={...value.rollout,cohortId:mediaTo};
  try {
    await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "activeAgentRevisionId"=${textRevision.id},
      "rolloutConfig"=${JSON.stringify(oldRollout)}::jsonb,"capabilities"=${JSON.stringify(value.capabilities)}::jsonb WHERE "id"='singleton'`;
    const command=async(extra:Record<string,unknown>={})=>({...value,expectedPolicyRevision:(await readPolicy()).policyRevision.toString(),...extra});
    expect((await request(app).put(`${base}/rollout`).set(auth()).send(await command({confirmMediaProfileUpgrade:true}))).status).toBe(428);
    expect((await request(app).post("/api/v1/auth/step-up").set(auth()).send({password})).status).toBe(200);
    let response=await request(app).put(`${base}/rollout`).set(auth()).send(await command());
    expect(response.status).toBe(409);expect(response.body.error).toBe("media_profile_upgrade_confirmation_required");
    response=await request(app).put(`${base}/rollout`).set(auth()).send(await command({confirmMediaProfileUpgrade:true,rollout:{...value.rollout,percentBasisPoints:7500}}));
    expect(response.status).toBe(409);expect(response.body.error).toBe("media_profile_upgrade_not_qualified");
    response=await request(app).put(`${base}/rollout`).set(auth()).send(await command({confirmMediaProfileUpgrade:true,capabilities:{...value.capabilities,contactWrite:true}}));
    expect(response.status).toBe(409);expect(response.body.error).toBe("media_profile_upgrade_not_qualified");
    response=await request(app).put(`${base}/rollout`).set(auth()).send(await command({confirmMediaProfileUpgrade:true}));
    expect(response.status,JSON.stringify(response.body)).toBe(200);
    expect((await readPolicy()).rolloutConfig).toMatchObject({candidateRevisionId:newId,percentBasisPoints:5000,cohortId:mediaTo});
    const audit=await prisma.auditLog.findFirstOrThrow({where:{agentId:actorId,action:"CUSTOMER_AGENT_PUBLISH"},orderBy:{createdAt:"desc"}});
    expect(audit.meta).toMatchObject({mediaProfileUpgrade:true,percentBasisPoints:5000});
  } finally {
    await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "activeAgentRevisionId"=${baseline.activeAgentRevisionId},
      "rolloutConfig"=${JSON.stringify(baseline.rolloutConfig)}::jsonb,"capabilities"=${JSON.stringify(baseline.capabilities)}::jsonb WHERE "id"='singleton'`;
    await prisma.auditLog.deleteMany({where:{agentId:actorId,action:"CUSTOMER_AGENT_PUBLISH"}});
    revokeElevation(actorId);
  }
});
it("requires actual owner step-up, explicit acknowledgement and idle before preserving old sources and routing future turns to50% revision",async()=>{
  const old=await capture();expect(old.intakeAgentRevisionId).toBe(oldId);expect(old.rolloutAssignmentId).toBeTruthy();
  const assignment=await prisma.customerAgentRolloutAssignment.findUniqueOrThrow({where:{id:old.rolloutAssignmentId!}});
  let response=await request(app).put(`${base}/rollout`).set(auth()).send(await publication({advanceIdleRevision:true}));
  expect(response.status).toBe(428);
  expect((await request(app).post("/api/v1/auth/step-up").set(auth()).send({password})).status).toBe(200);
  response=await request(app).put(`${base}/rollout`).set(auth()).send(await publication());
  expect(response.status).toBe(409);expect(response.body.error).toBe("existing_core_requires_idle_promotion");
  response=await request(app).put(`${base}/rollout`).set(auth()).send(await publication({advanceIdleRevision:true}));
  expect(response.status).toBe(409);expect(response.body.error).toBe("core_work_requires_idle_publication");
  await prisma.customerPropertyIngressTicket.update({where:{eventKey:old.eventKey},data:{processingState:"FAILED"}});
  const reservation=await prisma.aiProviderOperation.create({data:{policyKey:"royal-customer-gemini",policyHash:"e".repeat(64),dayKey:"2026-10-16",
    deadlineAt:new Date(Date.now()+60000),maxAttempts:1,reservedUsd:"0.01"}});
  try {
    response=await request(app).put(`${base}/rollout`).set(auth()).send(await publication({advanceIdleRevision:true}));
    expect(response.status).toBe(409);expect(response.body.error).toBe("core_work_requires_idle_publication");
  } finally {await prisma.aiProviderOperation.update({where:{id:reservation.id},data:{status:"HELD"}});}
  // HELD is non-resumable in recoverManagedProviderOperation. Its historical
  // accounting hold survives publication; it is never settled or retried here.
  const faultIndex=`test_advance_audit_${randomUUID().replaceAll("-","")}`;
  const seed=await prisma.auditLog.create({data:{action:"CUSTOMER_AGENT_PUBLISH",entityType:"CustomerAgentPolicy",entityId:"singleton",agentId:actorId,agentName:tag,meta:{reason:tag}}});
  await prisma.$executeRaw(Prisma.sql`CREATE UNIQUE INDEX ${Prisma.raw('"'+faultIndex+'"')} ON "AuditLog"("entityId")
    WHERE "agentId"=${Prisma.raw("'"+actorId+"'")} AND "action"='CUSTOMER_AGENT_PUBLISH'`);
  try {
    const before=await readPolicy();response=await request(app).put(`${base}/rollout`).set(auth()).send(await publication({advanceIdleRevision:true}));
    expect(response.status).toBe(500);expect((await readPolicy()).policyRevision).toBe(before.policyRevision);
    expect(await prisma.customerAgentRevisionAdvance.count({where:{fromRevisionId:oldId,fromCohortId:oldCohort}})).toBe(0);
  } finally {await prisma.$executeRaw(Prisma.sql`DROP INDEX ${Prisma.raw('"'+faultIndex+'"')}`);await prisma.auditLog.delete({where:{id:seed.id}});}
  const value=await publication({advanceIdleRevision:true});
  const results=await Promise.all([request(app).put(`${base}/rollout`).set(auth()).send(value),request(app).put(`${base}/rollout`).set(auth()).send(value)]);
  expect(results.map(r=>r.status).sort(),JSON.stringify(results.map(r=>r.body))).toEqual([200,409]);
  expect((await readPolicy()).rolloutConfig).toMatchObject({percentBasisPoints:5000,candidateRevisionId:newId,cohortId:newCohort});
  expect((await prisma.aiProviderOperation.findUniqueOrThrow({where:{id:reservation.id}})).reservedUsd.toString()).toBe("0.01");
  expect((await prisma.aiProviderOperation.findUniqueOrThrow({where:{id:reservation.id}})).status).toBe("HELD");
  await prisma.aiProviderOperation.delete({where:{id:reservation.id}}); // Own disposable accounting fixture only.
  expect(await prisma.customerAgentRolloutAssignment.findUnique({where:{id:assignment.id}})).toEqual(assignment);
  expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({where:{eventKey:old.eventKey}})).intakeAgentRevisionId).toBe(oldId);
  expect(await customerAgentRevisionReachable(prisma,assignment,newId,newCohort)).toBe(true);
  expect(await readCustomerDmSourceExecution(prisma,old.eventKey,old.scopeKey,{surface:"dm",endpoint:{endpointScopeId:scopeId,
    scopeRevision:"0",channel:"INSTAGRAM",accountId,transportKey:`messenger-account:${accountId}`},peer})).toMatchObject({lane:"CORE",revisionId:oldId});
  const fresh=await capture();expect(fresh.intakeAgentRevisionId).toBe(newId);expect(fresh.rolloutAssignmentId).toBe(assignment.id);
  await expect(prisma.customerPropertyIngressTicket.update({where:{eventKey:old.eventKey},data:{intakeAgentRevisionId:newId}})).rejects.toThrow();
  const edge=await prisma.customerAgentRevisionAdvance.findFirstOrThrow({where:{fromRevisionId:oldId,fromCohortId:oldCohort}});
  await expect(prisma.customerAgentRevisionAdvance.update({where:{id:edge.id},data:{toRevisionId:oldId}})).rejects.toThrow();
  await expect(prisma.customerAgentRevisionAdvance.delete({where:{id:edge.id}})).rejects.toThrow();
  await prisma.customerPropertyIngressTicket.update({where:{eventKey:fresh.eventKey},data:{processingState:"FAILED"}});
  // A later percentage-only publication accepts the approved lineage; it does
  // not demand a second migration or mutate the old assignment.
  const percent=await publication();percent.rollout.percentBasisPoints=5000;
  expect((await request(app).put(`${base}/rollout`).set(auth()).send(percent)).status).toBe(200);
});

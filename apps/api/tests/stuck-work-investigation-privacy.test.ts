import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { enqueueBackgroundJob } from "../src/jobs/enqueue.js";
const agentIds: string[] = [], tokens: Record<string,string> = {};
const clientId = randomUUID(), ordinary = randomUUID(), secret = randomUUID();
const jobIds = Array.from({length:4},()=>randomUUID());
beforeAll(async () => {
  for (const [key, role, revoked] of [["agent", "AGENT", []], ["admin", "ADMIN", []], ["revoked", "ADMIN", ["clients.securityReview"]]] as const) {
    const id=randomUUID(); agentIds.push(id);
    await prisma.agent.create({data:{id,fullName:`Synthetic queue ${key}`,phone:`queue-${id}`,passwordHash:"unused",role,permissions:{granted:["auditLog.view","clients.securityReview"],revoked:[...revoked]}}});
    tokens[key]=signAccessToken({sub:id,role});
  }
  await prisma.client.create({data:{id:clientId,fullName:"Synthetic queue client",phone:`queue-client-${clientId}`,source:"WALK_IN"}});
  await prisma.interaction.createMany({data:[ordinary,secret].map(id=>({id,clientId,type:"CALL",actorKind:"SYSTEM",notes:"Synthetic queue evidence",investigationOnly:id===secret}))});
  await prisma.backgroundJob.createMany({data:jobIds.map((id,index)=>({id,type:"transcription-retry",payload:index===3?{interactionId:ordinary,investigationOnly:true}:{interactionId:index===0?ordinary:index===1?secret:randomUUID()},status:"GIVEN_UP",lastError:index===0?"ordinary error":"PRIVATE_QUEUE_CANARY",maxAttempts:3,attempts:3}))});
});
afterAll(async()=>{
  await prisma.backgroundJob.deleteMany({where:{id:{in:jobIds}}});
  await prisma.interaction.deleteMany({where:{id:{in:[ordinary,secret]}}});
  await prisma.client.deleteMany({where:{id:clientId}});
  await prisma.agent.deleteMany({where:{id:{in:agentIds}}});
});
describe("stuck work private source boundaries",()=>{
  it.each(["agent","revoked"])("%s sees ordinary jobs but no private or missing bindings, including retry",async actor=>{
    const result=await request(app).get("/api/v1/stuck-work?givenUpLimit=1000").set("Authorization",`Bearer ${tokens[actor]}`);
    expect(result.status).toBe(200); expect(result.body.givenUp.some((j:{id:string})=>j.id===jobIds[0])).toBe(true);
    for(const id of jobIds.slice(1)){
      expect(result.body.givenUp.some((j:{id:string})=>j.id===id)).toBe(false);
      expect((await request(app).post(`/api/v1/stuck-work/${id}/retry`).set("Authorization",`Bearer ${tokens[actor]}`)).status).toBe(404);
    }
    expect(JSON.stringify(result.body)).not.toContain("PRIVATE_QUEUE_CANARY");
    expect(await prisma.backgroundJob.count({where:{id:{in:jobIds.slice(1)},status:"GIVEN_UP"}})).toBe(3);
  });
  it("authorized leadership retains private rows while ordinary staff may retry ordinary transcription",async()=>{
    const result=await request(app).get("/api/v1/stuck-work?givenUpLimit=1000").set("Authorization",`Bearer ${tokens.admin}`);
    expect(result.status).toBe(200); expect(result.body.givenUp.some((j:{id:string})=>j.id===jobIds[1])).toBe(true);
    const publicResult=await request(app).get("/api/v1/stuck-work?givenUpLimit=1").set("Authorization",`Bearer ${tokens.agent}`);
    expect(publicResult.status).toBe(200);
    expect(result.body.counts.givenUp-publicResult.body.counts.givenUp).toBeGreaterThanOrEqual(3);
    expect(publicResult.body.givenUp.every((j:{id:string})=>!jobIds.slice(1).includes(j.id))).toBe(true);
    expect((await request(app).post(`/api/v1/stuck-work/${jobIds[0]}/retry`).set("Authorization",`Bearer ${tokens.agent}`)).status).toBe(204);
    expect((await request(app).post(`/api/v1/stuck-work/${jobIds[1]}/retry`).set("Authorization",`Bearer ${tokens.admin}`)).status).toBe(204);
  });
  it("future enqueue durably records privacy without running a provider",async()=>{
    const key=`privacy-fixture-${randomUUID()}`;
    try {
      await enqueueBackgroundJob({type:"transcription-retry",payload:{interactionId:secret},dedupeKey:key,maxAttempts:1});
      const row=await prisma.backgroundJob.findUniqueOrThrow({where:{dedupeKey:key}});
      expect(row.payload).toMatchObject({investigationOnly:true});
    } finally { await prisma.backgroundJob.deleteMany({where:{dedupeKey:key}}); }
  });
});

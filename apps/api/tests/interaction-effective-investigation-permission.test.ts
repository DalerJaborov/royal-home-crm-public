import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { invalidateAgentAccess } from "../src/auth/middleware.js";
import { transcriptAccess } from "../src/lib/callTranscripts.js";
import { isPrivateOperation } from "../src/lib/investigationOperations.js";
const probe = vi.hoisted(() => ({ retranscribe: vi.fn() }));
vi.mock("../src/lib/telephony/callRecordings.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/telephony/callRecordings.js")>(), retranscribeInteraction: probe.retranscribe,
}));
import { app } from "../src/app.js";
const agents: string[] = [];
let clientId: string, privateId: string, publicId: string, adminToken: string, ropToken: string;
const secret = `private-call-${randomUUID()}`;
beforeAll(async () => {
  for (const role of ["ADMIN", "HEAD_OF_SALES"] as const) {
    const agent = await prisma.agent.create({data:{role, fullName:"Synthetic effective call permission",phone:randomUUID(),passwordHash:"unused",
      permissions:{granted:["clients.securityReview","calls.transcripts","calls.hearRecording"],revoked:[]}}});
    agents.push(agent.id);
    const token = signAccessToken({sub:agent.id,role}); if(role==="ADMIN") adminToken=token; else ropToken=token;
  }
  clientId=(await prisma.client.create({data:{fullName:"Synthetic call fixture",phone:randomUUID(),kind:"BUYER",source:"PHONE_CALL"}})).id;
  privateId=(await prisma.interaction.create({data:{clientId,agentId:agents[0],type:"CALL",notes:secret,transcript:secret,transcriptRu:secret,investigationOnly:true,recordingUrl:"synthetic/private.mp3"}})).id;
  publicId=(await prisma.interaction.create({data:{clientId,agentId:agents[0],type:"CALL",notes:"Public",transcript:"Public",transcriptRu:"Public",recordingUrl:"synthetic/public.mp3"}})).id;
  // Warm the real auth cache with enabled access, then revoke through the same invalidation seam as staff settings.
  expect((await request(app).get(`/api/v1/interactions/${privateId}/transcript`).set("Authorization",`Bearer ${adminToken}`)).status).toBe(200);
  await prisma.agent.update({where:{id:agents[0]},data:{permissions:{granted:[],revoked:["clients.securityReview"]}}});
  invalidateAgentAccess(agents[0]);
});
afterAll(async()=>{
  if(clientId){await prisma.interaction.deleteMany({where:{clientId}});await prisma.client.delete({where:{id:clientId}});}
  await prisma.agent.deleteMany({where:{id:{in:agents}}}); for(const id of agents) invalidateAgentAccess(id);
  await prisma.$disconnect();
});
describe("direct private call endpoints obey current capability and role ceiling",()=>{
  it.each(["ADMIN_REVOKED","HEAD_OF_SALES"])("denies all four endpoints for %s without invoking transcription",async role=>{
    const token=role==="ADMIN_REVOKED"?adminToken:ropToken;
    for(const suffix of ["recording","transcript","translate","retranscribe"]){
      const path=`/api/v1/interactions/${privateId}/${suffix}`;
      const response=await (suffix==="recording"||suffix==="transcript"?request(app).get(path):request(app).post(path)).set("Authorization",`Bearer ${token}`).send();
      expect(response.status,suffix).toBe(404); expect(JSON.stringify(response.body)).not.toContain(secret);
    }
    expect(probe.retranscribe).not.toHaveBeenCalled();
  });
  it("retains ordinary transcript/translation access despite the private capability revocation",async()=>{
    for(const suffix of ["transcript","translate"]){
      const path=`/api/v1/interactions/${publicId}/${suffix}`;
      const response=await (suffix==="transcript"?request(app).get(path):request(app).post(path)).set("Authorization",`Bearer ${adminToken}`).send();
      expect(response.status).toBe(200); expect(JSON.stringify(response.body)).toContain("Public");
    }
  });
  it("excludes private rows before list totals and summary aggregation",async()=>{
    const list=await request(app).get(`/api/v1/interactions?agentId=${agents[0]}`).set("Authorization",`Bearer ${adminToken}`);
    expect(list.status).toBe(200); expect(list.body.total).toBe(1); expect(JSON.stringify(list.body)).not.toContain(secret);
    const summary=await request(app).get(`/api/v1/interactions/summary?agentId=${agents[0]}`).set("Authorization",`Bearer ${adminToken}`);
    expect(summary.status).toBe(200); expect(summary.body.total).toBe(1);
  });
  it("runs an authorized private retranscription inside private error context",async()=>{
    await prisma.agent.update({where:{id:agents[0]},data:{permissions:{granted:[],revoked:[]}}}); invalidateAgentAccess(agents[0]);
    probe.retranscribe.mockImplementation(async()=>{expect(isPrivateOperation()).toBe(true);return {ok:true};});
    expect((await request(app).post(`/api/v1/interactions/${privateId}/retranscribe`).set("Authorization",`Bearer ${adminToken}`)).status).toBe(202);
    expect(probe.retranscribe).toHaveBeenCalledWith(privateId);
  });
  it("common transcript projection requires the effective private capability",()=>{
    expect(transcriptAccess({id:"admin",role:"ADMIN",can:p=>p!=="clients.securityReview"}).investigations).toBe(false);
    expect(transcriptAccess({id:"rop",role:"HEAD_OF_SALES",can:()=>true}).investigations).toBe(false);
    expect(transcriptAccess({id:"admin",role:"ADMIN",can:()=>true}).investigations).toBe(true);
  });
});

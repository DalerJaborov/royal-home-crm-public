import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
const ids: string[] = [];
const tokens: Record<string, string> = {};
const reportId = randomUUID();
const privateClientId = randomUUID(), privateInteractionIds = [randomUUID(), randomUUID()];
const publicShowingId = randomUUID();
const reportPeriod = new Date(Date.UTC(2400, 0, 1) + Date.now() % 1000000);
const privateCanary = "SYNTHETIC_PRIVATE_OWNER_QUOTE_DO_NOT_DISCLOSE";
const phoneCanary = "+992 900 123 456";
const metrics = { funnel: [{key:"contacted",label:"Contacts",count:1},{key:"showings",label:"Showings",count:1}], dealsCompleted: 7, commission: 987654321, expenses: 123456789, agents: [{ agentId: "synthetic", fullName: "Synthetic employee", leads: 8, showings: 9, deals: 1, commission: 111222333 }],
  postShowingCohort: { version: 2, evaluation: "DEFINITION_PENDING", limitations: [privateCanary], agents: [{ agentId:"cohort-id-preserved",agentName:`Synthetic ${phoneCanary}`,eligible:8,silent:4,ratePercent:50 }] },
  postShowingSilence: { agents: [{ agentId: "synthetic", agentName: `Synthetic ${phoneCanary}`, suspicious: true, ratePercent: 80, peerRatePercent: 20 }], provableCase: { quote: privateCanary, clientName: `Synthetic ${phoneCanary}`, what: `Contact ${phoneCanary}`, clientShortId: 123, agentId: "agent-id-preserved" } } };
beforeAll(async () => {
  for (const [key, role, granted, revoked] of [
    ["agentGranted", "AGENT", ["reports.view", "dashboard.analytics", "finance.view", "clients.securityReview"], []],
    ["securityGranted", "SECURITY", ["reports.view", "dashboard.analytics", "finance.view", "clients.securityReview"], []],
    ["adminRevoked", "ADMIN", [], ["clients.securityReview", "finance.view"]],
    ["admin", "ADMIN", [], []],
    ["adminNoFinance", "ADMIN", [], ["finance.view"]],
    ["adminNoPhone", "ADMIN", [], ["clients.viewPhone"]],
  ] as const) {
    const id = randomUUID(); ids.push(id);
    await prisma.agent.create({ data: { id, fullName: `Synthetic report ${key}`, phone: `monthly-private-${id}`, role, passwordHash: "unused", permissions: { granted: [...granted], revoked: [...revoked] } } });
    tokens[key] = signAccessToken({ sub: id, role });
  }
  await prisma.client.create({data:{id:privateClientId,fullName:"Synthetic private report source",phone:`private-report-${privateClientId}`,source:"WALK_IN"}});
  const occurredAt=new Date(Date.now()-2*86400000), talkedAt=new Date(occurredAt.getTime()+3600000);
  await prisma.agent.update({where:{id:ids[0]},data:{fullName:`Synthetic ${phoneCanary}`}});
  await prisma.interaction.create({data:{id:publicShowingId,clientId:privateClientId,type:"SHOWING",actorKind:"SYSTEM",notes:"Synthetic cohort phone source",createdAt:occurredAt,nextActionDate:occurredAt,completedAt:occurredAt}});
  await prisma.postShowingCall.create({data:{showingId:publicShowingId,clientId:privateClientId,agentId:ids[0],scheduledFor:talkedAt,status:"DONE",outcome:"REFUSED",talkedAt}});
  await prisma.interaction.createMany({data:privateInteractionIds.map((id,index)=>({id,clientId:privateClientId,type:index ? "SHOWING" : "CALL",actorKind:"SYSTEM",notes:"Private report fixture",investigationOnly:true,createdAt:new Date(reportPeriod.getTime()+3600000)}))});
  await prisma.monthlyReport.create({ data: { id: reportId, periodStart: reportPeriod, metrics, notes: "Ordinary owner note" } });
});
afterAll(async () => {
  await prisma.monthlyReport.deleteMany({ where: { id: reportId } });
  await prisma.interaction.deleteMany({where:{id:{in:[...privateInteractionIds,publicShowingId]}}});
  await prisma.client.deleteMany({where:{id:privateClientId}});
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
});
describe("monthly report historical private snapshot projection", () => {
  it("authorized leadership without phone permission gets masked free text, preserving evidence identities and stored snapshot", async () => {
    const get = await request(app).get("/api/v1/reports/monthly").set("Authorization", `Bearer ${tokens.adminNoPhone}`);
    expect(get.status).toBe(200);
    const row = get.body.find((r: { id: string }) => r.id === reportId);
    const patch = await request(app).patch(`/api/v1/reports/monthly/${reportId}`).set("Authorization", `Bearer ${tokens.adminNoPhone}`).send({ notes: "Leadership note without phone access" });
    expect(patch.status).toBe(200);
    for (const responseRow of [row, patch.body]) {
      expect(JSON.stringify(responseRow)).not.toContain(phoneCanary);
      expect(responseRow.metrics.postShowingSilence.provableCase).toMatchObject({ clientShortId: 123, agentId: "agent-id-preserved", quote: privateCanary });
      expect(responseRow.metrics.postShowingCohort.agents[0]).toMatchObject({agentId:"cohort-id-preserved",ratePercent:50});
    }
    const stored = await prisma.monthlyReport.findUniqueOrThrow({ where: { id: reportId } });
    expect(JSON.stringify(stored.metrics)).toContain(phoneCanary);
  });
  it("direct cohort API masks agent names without phone permission while preserving counts and identities",async()=>{
    const response=await request(app).get("/api/v1/reports/post-showing-cohort").set("Authorization",`Bearer ${tokens.adminNoPhone}`);
    expect(response.status).toBe(200);
    const row=response.body.agents.find((item:{agentId:string})=>item.agentId===ids[0]);
    expect(row).toBeTruthy();expect(row.robotResponses).toBe(1);expect(row.unresolvedSurvey).toBe(1);
    expect(row.agentName).not.toContain(phoneCanary);
    const allowed=await request(app).get("/api/v1/reports/post-showing-cohort").set("Authorization",`Bearer ${tokens.admin}`);
    expect(allowed.status).toBe(200);expect(allowed.body.agents.find((item:{agentId:string})=>item.agentId===ids[0]).agentName).toContain(phoneCanary);
  });
  it.each(["agentGranted", "securityGranted", "adminRevoked"])("%s cannot read investigation metrics through GET or PATCH", async actor => {
    const get = await request(app).get("/api/v1/reports/monthly").set("Authorization", `Bearer ${tokens[actor]}`);
    expect(get.status).toBe(200);
    const row = get.body.find((r: { id: string }) => r.id === reportId);
    expect(row).toBeTruthy(); expect(row.metrics.dealsCompleted).toBe(7); expect(row.metrics).not.toHaveProperty("postShowingSilence"); expect(row.metrics).not.toHaveProperty("postShowingCohort");
    expect(JSON.stringify(row)).not.toContain(privateCanary);
    expect(row.metrics.funnel.map((r:{count:number})=>r.count)).toEqual([0,0]);
    expect(row.metrics.agents[0].showings).toBe(0);
    const patch = await request(app).patch(`/api/v1/reports/monthly/${reportId}`).set("Authorization", `Bearer ${tokens[actor]}`).send({ notes: "Ordinary edited note" });
    expect(patch.status).toBe(200); expect(patch.body.metrics).not.toHaveProperty("postShowingSilence"); expect(JSON.stringify(patch.body)).not.toContain(privateCanary);
    if (actor === "adminRevoked") { expect(row.metrics.commission).toBeNull(); expect(patch.body.metrics.expenses).toBeNull(); expect(patch.body.metrics.agents[0].commission).toBeNull(); }
    else { expect(row.metrics.commission).toBe(metrics.commission); expect(patch.body.metrics.expenses).toBe(metrics.expenses); }
    const stored = await prisma.monthlyReport.findUniqueOrThrow({ where: { id: reportId } });
    expect(stored.metrics).toMatchObject({ postShowingSilence: metrics.postShowingSilence });
    expect(stored.metrics).toMatchObject({funnel:metrics.funnel,agents:metrics.agents});
  });
  it.each(["agentGranted", "securityGranted", "adminRevoked"])("%s cannot access private cohort facts or configuration even with report grants", async actor => {
    for (const path of ["/api/v1/reports/post-showing-cohort", "/api/v1/reports/post-showing-cohort/config"]) {
      const result = await request(app).get(path).set("Authorization", `Bearer ${tokens[actor]}`);
      expect(result.status).toBe(403);
    }
    const update = await request(app).put("/api/v1/reports/post-showing-cohort/config").set("Authorization", `Bearer ${tokens[actor]}`).send({ minAgentShowings: 1 });
    expect(update.status).toBe(403);
  });
  it("leadership can read configuration but invalid thresholds cannot change it", async () => {
    const before = await request(app).get("/api/v1/reports/post-showing-cohort/config").set("Authorization", `Bearer ${tokens.admin}`);
    expect(before.status).toBe(200); expect(before.body.automaticVerdict).toBe(false);
    const invalid = await request(app).put("/api/v1/reports/post-showing-cohort/config").set("Authorization", `Bearer ${tokens.admin}`).send({ minAgentShowings: 0 });
    expect(invalid.status).toBe(400);
    const after = await request(app).get("/api/v1/reports/post-showing-cohort/config").set("Authorization", `Bearer ${tokens.admin}`);
    expect(after.body).toEqual(before.body);
  });
  it.each(["admin", "adminNoFinance"])("%s retains private section independently of finance visibility", async actor => {
    const get = await request(app).get("/api/v1/reports/monthly").set("Authorization", `Bearer ${tokens[actor]}`);
    expect(get.status).toBe(200); const row = get.body.find((r: { id: string }) => r.id === reportId);
    expect(row.metrics.postShowingSilence.provableCase.quote).toBe(privateCanary); expect(row.metrics.dealsCompleted).toBe(7);
    const patch = await request(app).patch(`/api/v1/reports/monthly/${reportId}`).set("Authorization", `Bearer ${tokens[actor]}`).send({ notes: "Ordinary leadership note" });
    expect(patch.status).toBe(200); expect(patch.body.metrics.postShowingSilence.provableCase.quote).toBe(privateCanary);
    expect(row.metrics.commission).toBe(actor === "adminNoFinance" ? null : metrics.commission);
    expect(patch.body.metrics.commission).toBe(actor === "adminNoFinance" ? null : metrics.commission);
  });
  it("private calls and showings do not enter ordinary monthly funnel totals", async () => {
    const clientId = randomUUID(), interactionIds = [randomUUID(), randomUUID()];
    const month = new Date("1801-01-31T19:00:00Z");
    await prisma.client.create({ data: { id: clientId, fullName: "Synthetic private-only contact", phone: `private-monthly-client-${clientId}`, source: "WALK_IN" } });
    try {
      await prisma.interaction.createMany({ data: interactionIds.map((id, index) => ({ id, clientId, actorKind: "SYSTEM" as const, type: index ? "SHOWING" as const : "CALL" as const, notes: "Synthetic private monthly fixture", investigationOnly: true, createdAt: new Date("1801-02-05T12:00:00Z") })) });
      const { buildMonthlyMetrics } = await import("../src/lib/monthlyReport.js");
      const result = await buildMonthlyMetrics(month);
      expect(result.funnel.find(r => r.key === "contacted")?.count).toBe(0);
      expect(result.funnel.find(r => r.key === "showings")?.count).toBe(0);
    } finally {
      await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
      await prisma.client.deleteMany({ where: { id: clientId } });
    }
  });});

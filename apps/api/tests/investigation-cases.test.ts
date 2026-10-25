import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { decideInvestigation, InvestigationConflict, recordInvestigationSignal, type InvestigationSignal } from "../src/lib/investigationCases.js";
import { logTimeline } from "../src/lib/timeline.js";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";

let clientId: string;
let actorId: string;
const assignmentAt = new Date();
const roleIds: string[] = [];
beforeAll(async () => {
  const agent = await prisma.agent.create({ data: { fullName: "Investigation fixture", phone: `+992${Date.now()}`, role: "ADMIN", passwordHash: "unused" } });
  actorId = agent.id;
  const client = await prisma.client.create({ data: { fullName: "Private case fixture", phone: `+991${Date.now()}`, source: "PHONE_CALL", assignedAgentId: actorId } });
  clientId = client.id;
});
afterAll(async () => {
  await prisma.investigationCase.deleteMany({ where: { clientId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: [actorId, ...roleIds] } } });
  await prisma.$disconnect();
});
function signal(overrides: Partial<InvestigationSignal> = {}): InvestigationSignal {
  return { clientId, assignmentAt, subjectAgentId: actorId, sourceType: "call", sourceId: randomUUID(),
    kind: "finding", independenceKey: randomUUID(), summary: "Evidence, not a verdict", occurredAt: new Date(), ...overrides };
}
describe("private investigation episodes", () => {
  it("masks embedded seller phones in control preview when administrator phone permission is revoked", async () => {
    const phone = `case-phone-denied-${randomUUID()}`, password = "case-phone-denied-password";
    const agent = await prisma.agent.create({ data: { fullName: "Phone-restricted administrator", phone, role: "ADMIN",
      passwordHash: await bcrypt.hash(password, 4), permissions: { granted: [], revoked: ["clients.viewPhone"] } } });
    roleIds.push(agent.id);
    const seller = await prisma.client.create({ data: { id: `00000000-0000-4000-8000-${randomUUID().slice(-12)}`, fullName: "Входящий +992911234567", phone: `seller-mask-${randomUUID()}`, kind: "SELLER", source: "PHONE_CALL", assignedAgentId: actorId } });
    try {
      const login = await request(app).post("/api/v1/auth/login").send({ phone, password });
      expect(login.status).toBe(200);
      const response = await request(app).get("/api/v1/security/cases/seller-control-preview").set("Authorization", `Bearer ${login.body.accessToken}`);
      expect(response.status).toBe(200);
      const item = response.body.items.find((row: { id: string }) => row.id === seller.id);
      expect(item).toBeDefined(); expect(item.name).not.toContain("911234567");
    } finally { await prisma.client.delete({ where: { id: seller.id } }); }
  });
  it("honors an explicit denial of investigation permission even for an administrator", async () => {
    const phone = `test-case-denied-${randomUUID()}`;
    const password = "case-denied-password";
    const agent = await prisma.agent.create({ data: { fullName: "Case denied administrator", phone, role: "ADMIN",
      passwordHash: await bcrypt.hash(password, 4), permissions: { granted: [], revoked: ["clients.securityReview"] } } });
    roleIds.push(agent.id);
    const login = await request(app).post("/api/v1/auth/login").send({ phone, password });
    expect(login.status).toBe(200);
    expect((await request(app).get("/api/v1/security/cases").set("Authorization", `Bearer ${login.body.accessToken}`)).status).toBe(403);
  });
  it("mirrors only current pending assignment and does not clear a card with another open case", async () => {
    const client = await prisma.client.update({ where: { id: clientId }, data: { securityReview: "PENDING" } });
    const a = await recordInvestigationSignal(signal({ assignmentAt: client.assignedAt, showingId: randomUUID() }));
    const b = await recordInvestigationSignal(signal({ assignmentAt: client.assignedAt, showingId: randomUUID() }));
    const first = await decideInvestigation({ caseId: a.caseId, actorId, requestKey: randomUUID(), revision: 1, status: "CLEARED", note: "First case cleared" });
    expect(first.mirrorWarning).toContain("другие открытые дела");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).securityReview).toBe("PENDING");
    await decideInvestigation({ caseId: b.caseId, actorId, requestKey: randomUUID(), revision: 1, status: "CONFIRMED", note: "Human confirmed evidence" });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(after.securityReview).toBe("CONFIRMED");
    expect(after.status).toBe(client.status);
    expect(after.assignedAgentId).toBe(client.assignedAgentId);
  });
  it("saves historical decisions but never changes a new assignment", async () => {
    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const old = await recordInvestigationSignal(signal({ assignmentAt: client.assignedAt, showingId: randomUUID() }));
    await prisma.client.update({ where: { id: clientId }, data: { assignedAt: new Date(client.assignedAt.getTime() + 1000), securityReview: "PENDING" } });
    const decision = await decideInvestigation({ caseId: old.caseId, actorId, requestKey: randomUUID(), revision: 1, status: "CONFIRMED", note: "Historical human decision" });
    expect(decision.mirrorWarning).toContain("Назначение клиента изменилось");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).securityReview).toBe("PENDING");
    expect((await prisma.investigationCase.findUniqueOrThrow({ where: { id: old.caseId } })).status).toBe("CONFIRMED");
  });
  it("rejects agents and legacy security role even with an investigation permission override", async () => {
    const created = await recordInvestigationSignal(signal({ showingId: randomUUID(), summary: "PRIVATE-EVIDENCE-CANARY" }));
    const passwordHash = await bcrypt.hash("case-test-password", 4);
    for (const role of ["AGENT", "MANAGER", "SECURITY", "ADMIN", "DIRECTOR"] as const) {
      const phone = `+992${Date.now()}${roleIds.length}`;
      const agent = await prisma.agent.create({ data: { fullName: `Case role ${role}`, phone, role, passwordHash,
        permissions: { granted: ["clients.securityReview", "settings.view"], revoked: [] } } });
      roleIds.push(agent.id);
      const login = await request(app).post("/api/v1/auth/login").send({ phone, password: "case-test-password" });
      expect(login.status).toBe(200);
      const response = await request(app).get("/api/v1/security/cases").set("Authorization", `Bearer ${login.body.accessToken}`);
      expect(response.status).toBe(role === "ADMIN" || role === "DIRECTOR" ? 200 : 403);
      for (const path of ["/config", "/recurrence", "/automation-preview", "/seller-control-preview", "/buyer-showing-candidates", "/workflow-observations", "/manual-contact-preview", "/named-assignment-preview", `/${created.caseId}`]) {
        const detail = await request(app).get(`/api/v1/security/cases${path}`).set("Authorization", `Bearer ${login.body.accessToken}`);
        expect(detail.status).toBe(role === "ADMIN" || role === "DIRECTOR" ? 200 : 403);
        if (detail.status === 403) expect(JSON.stringify(detail.body)).not.toContain("PRIVATE-EVIDENCE-CANARY");
      }
      if (role === "AGENT" || role === "MANAGER" || role === "SECURITY") {
        const settings = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${login.body.accessToken}`);
        expect(settings.status).toBe(200);
        expect(settings.body).not.toHaveProperty("investigationCaseConfig");
        const decision = await request(app).post(`/api/v1/security/cases/${created.caseId}/decisions`)
          .set("Authorization", `Bearer ${login.body.accessToken}`)
          .send({ requestKey: randomUUID(), revision: 1, status: "CONFIRMED", note: "Forged decision must fail" });
        expect(decision.status).toBe(403);
        expect((await request(app).get("/api/v1/security/cases/workflow-agent-preview").set("Authorization", `Bearer ${login.body.accessToken}`)).status).toBe(403);
        expect((await request(app).post("/api/v1/security/cases/seller-control/buyer-candidate").set("Authorization", `Bearer ${login.body.accessToken}`)
          .send({ buyerCandidateId: randomUUID(), candidateRevision: 1, ropAgentId: actorId, requestKey: randomUUID() })).status).toBe(403);
        expect((await request(app).post(`/api/v1/security/cases/${created.caseId}/severity`).set("Authorization", `Bearer ${login.body.accessToken}`)
          .send({ requestKey: randomUUID(), revision: 1, level: "C4", confirmC4: true, note: "Forged severity decision" })).status).toBe(403);
        expect((await request(app).put("/api/v1/security/cases/config").set("Authorization", `Bearer ${login.body.accessToken}`)
          .send({ config: { minSample: 1, repeatThreshold: 1 } })).status).toBe(403);
      }
    }
    expect(await prisma.investigationDecision.count({ where: { caseId: created.caseId } })).toBe(0);
  });
  it("deduplicates evidence, preserves cleared decisions and reopens only new independent post-resolution facts", async () => {
    const first = signal({ showingId: randomUUID() });
    const created = await recordInvestigationSignal(first);
    expect((await recordInvestigationSignal(first)).inserted).toBe(false);
    const row = await prisma.investigationCase.findUniqueOrThrow({ where: { id: created.caseId } });
    const decision = { caseId: row.id, actorId, revision: row.revision, requestKey: randomUUID(), status: "CLEARED" as const, note: "Checked original evidence" };
    const saved = await decideInvestigation(decision);
    expect((await decideInvestigation(decision)).id).toBe(saved.id);
    const cleared = await prisma.investigationCase.findUniqueOrThrow({ where: { id: row.id } });
    expect(cleared.level).toBe("C0");
    expect((await recordInvestigationSignal({ ...first, sourceId: randomUUID(), independenceKey: "old-independent", occurredAt: new Date(cleared.resolvedAt!.getTime() - 1) })).reopened).toBe(false);
    expect((await recordInvestigationSignal({ ...first, sourceId: randomUUID(), occurredAt: new Date(cleared.resolvedAt!.getTime() + 1) })).reopened).toBe(false);
    expect((await recordInvestigationSignal({ ...first, sourceId: randomUUID(), independenceKey: "new-call", occurredAt: new Date(cleared.resolvedAt!.getTime() + 2) })).reopened).toBe(true);
    expect(await prisma.investigationDecision.count({ where: { caseId: row.id, action: "CLEARED" } })).toBe(1);
    expect((await prisma.investigationCase.findUniqueOrThrow({ where: { id: row.id } })).level).toBe("C1");
  });
  it("allows one concurrent verdict and rejects changed idempotency payload", async () => {
    const created = await recordInvestigationSignal(signal({ showingId: randomUUID() }));
    const row = await prisma.investigationCase.findUniqueOrThrow({ where: { id: created.caseId } });
    const input = { caseId: row.id, actorId, revision: row.revision, requestKey: randomUUID(), status: "CLEARED" as const, note: "Human decision only" };
    const results = await Promise.allSettled([decideInvestigation(input), decideInvestigation({ ...input, requestKey: randomUUID(), status: "CONFIRMED" })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    await expect(decideInvestigation({ ...input, note: "Changed payload" })).rejects.toBeInstanceOf(InvestigationConflict);
  });
  it("rolls back private timeline and dossier together", async () => {
    const notes = randomUUID();
    await expect(prisma.$transaction(async tx => {
      await logTimeline({ clientId, actor: { kind: "agent", agentId: actorId }, type: "SYSTEM", notes, investigationOnly: true, tx });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await prisma.interaction.count({ where: { clientId, notes } })).toBe(0);
    expect(await prisma.investigationEvidence.count({ where: { summary: notes } })).toBe(0);
  });
});

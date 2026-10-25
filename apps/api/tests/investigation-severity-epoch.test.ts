import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { changeClientAgent } from "../src/lib/changeClientAgent.js";
import { decideInvestigation, investigationCaseKey, recordInvestigationSignal } from "../src/lib/investigationCases.js";
import { setInvestigationSeverity } from "../src/lib/investigationSeverity.js";
import { resolveInvestigationAssignmentEpoch } from "../src/lib/investigationAssignmentEpoch.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
const agents: string[] = [], clients: string[] = []; let token: string;
beforeAll(async () => {
  const password = "epoch-fixture-password";
  for (const role of ["ADMIN", "AGENT", "AGENT"] as const) {
    const phone = `epoch-${randomUUID()}`;
    const agent = await prisma.agent.create({ data: { fullName: "Epoch fixture", phone, role, passwordHash: await bcrypt.hash(password, 4) } }); agents.push(agent.id);
    if (role === "ADMIN") {
      const login = await request(app).post("/api/v1/auth/login").send({ phone, password }); expect(login.status).toBe(200); token = login.body.accessToken;
    }
  }
});
afterAll(async () => {
  await prisma.investigationCase.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.clientWorkflowObservation.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.auditLog.deleteMany({ where: { entityType: "Client", entityId: { in: clients } } });
  await prisma.client.deleteMany({ where: { id: { in: clients } } }); await deleteAgentsWithTraces(agents); await prisma.$disconnect();
});
async function fixture() {
  const client = await prisma.client.create({ data: { fullName: "Epoch client fixture", phone: `epoch-client-${randomUUID()}`, source: "PHONE_CALL", kind: "BUYER", assignedAgentId: agents[1], securityReview: "PENDING" } }); clients.push(client.id);
  const signal = { clientId: client.id, assignmentAt: client.assignedAt, subjectAgentId: agents[1], sourceType: "CALL", sourceId: randomUUID(), kind: "TEST_FACT", independenceKey: randomUUID(), summary: "Isolated source fact", occurredAt: new Date() };
  const created = await recordInvestigationSignal(signal); return { client, signal, created };
}
describe("fact confirmation and ownership epochs", () => {
  it("CONFIRMED is not C4; C4 requires a separate explicit revisioned admin API action", async () => {
    const { created } = await fixture();
    const severityPath = `/api/v1/security/cases/${created.caseId}/severity`;
    const body = { requestKey: randomUUID(), revision: 1, level: "C4", note: "Separate human severity judgement" };
    expect((await request(app).post(severityPath).set("Authorization", `Bearer ${token}`).send(body)).status).toBe(400);
    expect((await request(app).post(severityPath).set("Authorization", `Bearer ${token}`).send({ ...body, confirmC4: true })).status).toBe(409);
    const fact = await decideInvestigation({ caseId: created.caseId, actorId: agents[0], requestKey: randomUUID(), revision: 1, status: "CONFIRMED", note: "Fact confirmed; severity considered separately" });
    expect(fact.level).toBe("C1");
    const explicit = { ...body, revision: 2, confirmC4: true };
    const response = await request(app).post(severityPath).set("Authorization", `Bearer ${token}`).send(explicit);
    expect(response.status).toBe(200); expect(response.body.decision.action).toBe("SET_SEVERITY");
    const replay = await request(app).post(severityPath).set("Authorization", `Bearer ${token}`).send(explicit);
    expect(replay.status).toBe(200); expect(replay.body.decision.id).toBe(response.body.decision.id);
    expect((await prisma.investigationCase.findUniqueOrThrow({ where: { id: created.caseId } }))).toMatchObject({ status: "CONFIRMED", level: "C4", revision: 3 });
  });
  it("A→B→A with reused assignedAt cannot mirror an old case or merge new facts into it", async () => {
    const { client, signal, created } = await fixture();
    for (const toAgentId of [agents[2], agents[1]]) expect((await changeClientAgent({ clientId: client.id, toAgentId, actorId: agents[0], actorName: "Epoch fixture", source: "manual.assign", reason: "Isolated ABA", skipInteraction: true, skipProperties: true })).ok).toBe(true);
    const current = await prisma.client.findUniqueOrThrow({ where: { id: client.id } }); expect(current.assignedAt).toEqual(client.assignedAt);
    const later = await recordInvestigationSignal({ ...signal, sourceId: randomUUID(), independenceKey: randomUUID(), occurredAt: new Date() });
    expect(later.caseId).not.toBe(created.caseId);
    const historical = await recordInvestigationSignal({ ...signal, sourceId: randomUUID(), independenceKey: randomUUID() });
    expect(historical.caseId).toBe(created.caseId);
    const row = await prisma.investigationCase.findUniqueOrThrow({ where: { id: created.caseId } });
    const decision = await decideInvestigation({ caseId: row.id, actorId: agents[0], requestKey: randomUUID(), revision: row.revision, status: "CONFIRMED", note: "Historical fact only" });
    expect(decision.mirrorWarning).toContain("Назначение клиента изменилось");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).securityReview).toBe("PENDING");
  });
  it("ambiguous simultaneous audit transitions are unknown, never ordered by random UUID", async () => {
    const { client } = await fixture(); const at = new Date();
    await prisma.auditLog.createMany({ data: [{ fromAgentId: agents[1], toAgentId: agents[2] }, { fromAgentId: agents[2], toAgentId: agents[1] }].map(meta => ({ action: "CLIENT_AGENT_CHANGE", entityType: "Client", entityId: client.id, agentId: agents[0], agentName: "Fixture", createdAt: at, meta })) });
    expect(await prisma.$transaction(tx => resolveInvestigationAssignmentEpoch(tx, { clientId: client.id, subjectAgentId: agents[1], assignmentAt: client.assignedAt, at }))).toBeNull();
  });
  it("historical null-epoch cases are preserved and may be closed without mirroring or downgrading stored C4", async () => {
    const { client, signal, created } = await fixture();
    await prisma.investigationCase.update({ where: { id: created.caseId }, data: { assignmentEpochKey: null, caseKey: investigationCaseKey(signal), level: "C4" } });
    const saved = await decideInvestigation({ caseId: created.caseId, actorId: agents[0], requestKey: randomUUID(), revision: 1, status: "CONFIRMED", note: "Historical confirmation preserves stored severity" });
    expect(saved.level).toBe("C4"); expect(saved.mirrorWarning).toContain("неизвестно");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).securityReview).toBe("PENDING");
    await expect(setInvestigationSeverity({ caseId: created.caseId, actorId: agents[0], requestKey: randomUUID(), revision: 1, level: "C2", note: "Stale revision rejected" })).rejects.toThrow("Дело изменилось");
  });
});

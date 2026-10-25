import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { refuseClient } from "../src/lib/clientRefuse.js";
import { changeClientAgent } from "../src/lib/changeClientAgent.js";
import { OCCUPIES_SLOT_WHERE } from "../src/lib/leadLimits.js";
import { TASK_WHERE } from "../src/lib/tasks.js";
import { upsertAutoTask, claimAutoTaskSlot } from "../src/lib/autoTasks.js";
import { canTransferClient, transferClientByAgent } from "../src/lib/clientTransfer.js";
import { deferClient, returnDeferredClientToWork } from "../src/lib/deferredClients.js";
import { logTimeline } from "../src/lib/timeline.js";
import { classifyClientLossFault } from "../src/lib/clientLossFault.js";

const run = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const clients: string[] = [];
let agentId: string, directorId: string, token: string, directorToken: string;
let managerId: string, managerToken: string;
let districtId: string, propertyId: string;
const password = "test-refusal-password";

async function makeClient(dualIntent = false) {
  const client = await prisma.client.create({ data: {
    fullName: `Refusal completion ${run}`, phone: `test-refusal-${run}-${clients.length}`,
    source: "PHONE_CALL", kind: "BUYER", assignedAgentId: agentId,
    acceptedAt: new Date(), aiScore: 0, dualIntent,
  } });
  clients.push(client.id);
  return client;
}
function refuse(clientId: string) {
  return refuseClient({ clientId, reason: "BOUGHT_SELF", initiator: "CLIENT",
    actorId: agentId, actorAgentId: agentId, bypassPreCloseGates: true,
    comment: "Клиент сообщил, что приобрёл квартиру самостоятельно" });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 4);
  const agent = await prisma.agent.create({ data: { fullName: `Refusal agent ${run}`,
    phone: `+99291${String(Date.now()).slice(-7)}`, role: "AGENT", passwordHash } });
  agentId = agent.id;
  const director = await prisma.agent.create({ data: { fullName: `Refusal director ${run}`,
    phone: `+99292${String(Date.now()).slice(-7)}`, role: "DIRECTOR", passwordHash } });
  directorId = director.id;
  const manager = await prisma.agent.create({ data: { fullName: `Refusal manager ${run}`,
    phone: `+99293${String(Date.now()).slice(-7)}`, role: "HEAD_OF_SALES", passwordHash } });
  managerId = manager.id;
  const agentLogin = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  const directorLogin = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(agentLogin.status).toBe(200);
  expect(directorLogin.status).toBe(200);
  token = agentLogin.body.accessToken;
  directorToken = directorLogin.body.accessToken;
  const managerLogin = await request(app).post("/api/v1/auth/login").send({ phone: manager.phone, password });
  expect(managerLogin.status).toBe(200);
  managerToken = managerLogin.body.accessToken;
  districtId = (await prisma.district.create({ data: { name: `Refusal ${run}` } })).id;
  propertyId = (await prisma.property.create({ data: { title: `Refusal ${run}`, type: "APARTMENT",
    areaSqm: 60, price: 100000, currency: "USD", districtId, address: "Test address",
    condition: "GOOD", status: "AVAILABLE" } })).id;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.client.deleteMany({ where: { id: { in: clients } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId, managerId] } } });
});

describe("Final refusal per assignment", () => {
  it("does not let a deferred return timer revive a subsequently completed assignment", async () => {
    const c = await makeClient();
    expect((await deferClient({ clientId: c.id, agentId, reason: "WRONG_OBJECT", initiator: "CLIENT" })).ok).toBe(true);
    expect((await refuse(c.id)).ok).toBe(true);
    expect((await returnDeferredClientToWork(c.id, "timer")).ok).toBe(false);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).assignmentCompletedAt).not.toBeNull();
  });
  it.each([false, true])("only director/admin can reassign refused work (dual=%s)", async (dual) => {
    const c = await makeClient(dual);
    expect((await refuse(c.id)).ok).toBe(true);
    expect((await canTransferClient(c.id)).allowed).toBe(false);
    expect(await transferClientByAgent({ clientId: c.id, agentId, reason: "NO_TRUST" })).toMatchObject({ ok: false, status: 409 });
    if (!dual) {
      const accept = await request(app).post(`/api/v1/clients/${c.id}/accept`)
        .set("Authorization", `Bearer ${token}`).send({});
      expect(accept.status).toBe(409);
      const activate = await request(app).post(`/api/v1/clients/${c.id}/activate`)
        .set("Authorization", `Bearer ${token}`).send({});
      expect(activate.status).toBe(403);
    }
    const decline = await request(app).post(`/api/v1/clients/${c.id}/decline`)
      .set("Authorization", `Bearer ${token}`).send({});
    expect(decline.status).toBe(409);
    const denied = await request(app).post(`/api/v1/clients/${c.id}/assign`)
      .set("Authorization", `Bearer ${managerToken}`).send({ agentId });
    expect(denied.status).toBe(403);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).assignmentRefusedAt).not.toBeNull();
    const allowed = await request(app).post(`/api/v1/clients/${c.id}/assign`)
      .set("Authorization", `Bearer ${directorToken}`).send({ agentId });
    expect(allowed.status).toBe(200);
    const assigned = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(assigned.assignmentRefusedAt).toBeNull();
    expect(assigned.assignmentCompletedAt).toBeNull();
  });
  it("stops unfinished tasks and automatic tasks without deleting completed work", async () => {
    const c = await makeClient();
    const open = await prisma.interaction.create({ data: { clientId: c.id, agentId, type: "MESSAGE",
      notes: "Pending task", nextAction: "Call", nextActionDate: new Date(Date.now() - 86400000) } });
    const done = await prisma.interaction.create({ data: { clientId: c.id, agentId, type: "MESSAGE",
      notes: "Completed task", nextAction: "Call", nextActionDate: new Date(), completedAt: new Date() } });
    const historicalScore = await prisma.royalScoreEvent.create({ data: { agentId, kind: "task_overdue", delta: -1,
      reason: "Historical missed deadline", sourceId: `historical-task-${open.id}` } });
    expect((await refuse(c.id)).ok).toBe(true);
    const visible = await prisma.interaction.findMany({ where: { clientId: c.id, ...TASK_WHERE }, select: { id: true } });
    expect(visible.map(r => r.id)).toContain(done.id);
    expect(visible.map(r => r.id)).not.toContain(open.id);
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: open.id } })).nextAction).toBe("Call");
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: open.id } })).taskCancelledAt).not.toBeNull();
    expect(await classifyClientLossFault(c.id)).toBe("client_lost_agent_fault");
    expect((await prisma.royalScoreEvent.findUniqueOrThrow({ where: { id: historicalScore.id } })).delta).toBe(-1);
    const task = await upsertAutoTask({ clientId: c.id, kind: "no_answer_retry", nextAction: "Call again",
      nextActionDate: new Date(), notes: "New task must not appear", actor: { kind: "system", source: "test", subjectAgentId: agentId } });
    expect(task.interactionId).toBeNull();
    expect(await claimAutoTaskSlot(c.id, "no_answer_retry", "Call again", new Date())).toEqual({ assignToNewRecord: false });
    const late = await logTimeline({ clientId: c.id, actor: { kind: "agent", agentId }, type: "MESSAGE",
      notes: "Late task callback", nextAction: "Call late", nextActionDate: new Date() });
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: late.id } })).taskCancelledAt).not.toBeNull();
    expect((await changeClientAgent({ clientId: c.id, toAgentId: agentId, actorId: directorId,
      source: "lifecycle.assign", reason: "New assignment", skipSatellites: true,
      data: { assignedAt: new Date(), acceptedAt: new Date() } })).ok).toBe(true);
    const afterReset = await prisma.interaction.findMany({ where: { clientId: c.id, ...TASK_WHERE }, select: { id: true } });
    expect(afterReset.map(row => row.id)).toEqual([done.id]);
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: open.id } })).completedAt).toBeNull();
    const staleComplete = await request(app).patch(`/api/v1/interactions/${open.id}/complete`)
      .set("Authorization", `Bearer ${token}`).send({});
    expect(staleComplete.status).toBe(403);
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: open.id } })).completedAt).toBeNull();
  });
  it("commits one refusal under concurrency, frees slot, and blocks former holder edits", async () => {
    const c = await makeClient();
    const results = await Promise.all([refuse(c.id), refuse(c.id)]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => r.ok)).toMatchObject({ message: "Отказ сохранён" });
    expect(results.filter(r => !r.ok && r.status === 409)).toHaveLength(1);
    const current = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(current.refusalCount).toBe(1);
    expect(current.assignmentCompletedAt).not.toBeNull();
    expect(current.assignedAgentId).toBe(agentId);
    expect(await prisma.client.count({ where: { id: c.id, ...OCCUPIES_SLOT_WHERE } })).toBe(0);
    expect(await prisma.interaction.count({ where: { clientId: c.id, investigationOnly: false } })).toBe(1);
    expect(await prisma.interaction.count({ where: { clientId: c.id, investigationOnly: true } })).toBe(1);
    const edit = await request(app).patch(`/api/v1/clients/${c.id}`)
      .set("Authorization", `Bearer ${token}`).send({ requirementsNotes: "Must not write" });
    expect(edit.status).toBe(403);
    const note = await request(app).post(`/api/v1/clients/${c.id}/interactions`)
      .set("Authorization", `Bearer ${token}`).send({ type: "MESSAGE", notes: "Must not write" });
    expect(note.status).toBe(403);
  });

  it("serializes a concurrent new task with final refusal", async () => {
    const c = await makeClient();
    const [task, refused] = await Promise.all([
      logTimeline({ clientId: c.id, actor: { kind: "agent", agentId }, type: "MESSAGE", notes: "Racing task",
        nextAction: "Call", nextActionDate: new Date() }),
      refuse(c.id),
    ]);
    expect(refused.ok).toBe(true);
    const row = await prisma.interaction.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.taskCancelledAt).not.toBeNull();
    expect(row.completedAt).toBeNull();
    expect(row.nextAction).toBe("Call");
  });
  it("does not turn a cancelled future deadline into later fault", async () => {
    const c = await makeClient();
    await logTimeline({ clientId: c.id, actor: { kind: "agent", agentId }, type: "MESSAGE", notes: "Future task",
      nextAction: "Call", nextActionDate: new Date(Date.now() + 86400000) });
    expect((await refuse(c.id)).ok).toBe(true);
    expect(await classifyClientLossFault(c.id, new Date(Date.now() + 172800000))).toBe("client_lost_no_fault");
  });

  it("same-agent explicit reassignment clears completion and allows a new assignment refusal", async () => {
    const c = await makeClient();
    expect((await refuse(c.id)).ok).toBe(true);
    const changed = await changeClientAgent({ clientId: c.id, toAgentId: agentId,
      actorId: directorId, source: "lifecycle.assign", reason: "New assignment", skipSatellites: true,
      data: { assignedAt: new Date(), acceptedAt: new Date() } });
    expect(changed.ok).toBe(true);
    const current = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(current.assignmentRefusedAt).toBeNull();
    expect(current.assignmentCompletedAt).toBeNull();
    expect((await refuse(c.id)).ok).toBe(true);
  });

  it.each(["dual", "deal"] as const)("keeps work and slot for %s, but rejects repeat refusal and verdict must not archive", async (kind) => {
    const c = await makeClient(kind === "dual");
    const existingTask = await logTimeline({ clientId: c.id, actor: { kind: "agent", agentId }, type: "MESSAGE",
      notes: "Continue other work", nextAction: "Call", nextActionDate: new Date() });
    await prisma.client.update({ where: { id: c.id }, data: { refusalCount: 100 } });
    if (kind === "deal") await prisma.deal.create({ data: { clientId: c.id, propertyId, agentId, stage: "NEGOTIATION" } });
    expect((await refuse(c.id)).ok).toBe(true);
    expect((await refuse(c.id)).ok).toBe(false);
    let current = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(current.assignedAgentId).toBe(agentId);
    expect(current.assignmentCompletedAt).toBeNull();
    expect(current.status).toBe(c.status);
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: existingTask.id } })).taskCancelledAt).toBeNull();
    expect(await prisma.royalScoreEvent.count({ where: { agentId,
      sourceId: `client-lost-${c.id}` } })).toBe(0);
    expect(await prisma.client.count({ where: { id: c.id, ...OCCUPIES_SLOT_WHERE } })).toBe(1);
    const edit = await request(app).patch(`/api/v1/clients/${c.id}`)
      .set("Authorization", `Bearer ${token}`).send({ requirementsNotes: "Continue the other work" });
    expect(edit.status).toBe(200);
    const verdict = await request(app).post(`/api/v1/clients/${c.id}/security-review`)
      .set("Authorization", `Bearer ${directorToken}`).send({ verdict: "CLEARED", note: "Verified" });
    expect(verdict.status).toBe(200);
    current = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(current.status).not.toBe("ARCHIVED");
    expect(current.assignmentCompletedAt).toBeNull();
  });
});

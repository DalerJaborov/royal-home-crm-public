import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { app } from "../src/app.js";
import { applyManualCorrection, previewManualCorrection } from "../src/lib/manualDataCorrection.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

const actors: string[] = [], clients: string[] = [];
let adminId = "", token = "", agentId = "";
const reason = "PRIVATE_REASON_CANARY: исправление подтверждённой опечатки в имени";
const password = "manual-correction-test-password";
beforeAll(async () => {
  const hash = await bcrypt.hash(password, 4);
  for (const role of ["ADMIN", "AGENT"] as const) {
    const phone = `manual-correction-${randomUUID()}`;
    const actor = await prisma.agent.create({ data: { fullName: `Synthetic correction ${role}`, phone, passwordHash: hash, role } });
    actors.push(actor.id);
    if (role === "AGENT") agentId = actor.id;
    else {
      adminId = actor.id;
      const login = await request(app).post("/api/v1/auth/login").send({ phone, password });
      expect(login.status).toBe(200); token = login.body.accessToken;
    }
  }
});
afterAll(async () => {
  await prisma.manualDataCorrection.deleteMany({ where: { actorId: { in: actors } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.client.deleteMany({ where: { id: { in: clients } } });
  await deleteAgentsWithTraces(actors);
});
async function fixture() {
  const client = await prisma.client.create({ data: { fullName: "Synthetic original", phone: `manual-client-${randomUUID()}`, source: "WALK_IN", kind: "BUYER", assignedAgentId: agentId } });
  clients.push(client.id); return client;
}
function input(clientId: string) {
  return { requestKey: randomUUID(), actorId: adminId, reason, operation: "CLIENT_LABELS", targets: [{ clientId, patch: { fullName: "Synthetic corrected" } }] };
}
async function planFor(clientId: string) {
  const plan = await previewManualCorrection(input(clientId), true);
  if (!("id" in plan)) throw new Error("Expected persisted plan");
  return plan;
}
describe("controlled manual data correction", () => {
  it("defaults to no writes and inventories actual background readers", async () => {
    const client = await fixture();
    const before = await prisma.manualDataCorrection.count({ where: { actorId: adminId } });
    const preview = await previewManualCorrection(input(client.id));
    expect(preview).toMatchObject({ mode: "DRY_RUN", writes: 0 });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).fullName).toBe(client.fullName);
    expect(await prisma.manualDataCorrection.count({ where: { actorId: adminId } })).toBe(before);
    expect(preview.impact).toMatchObject({ triggersExternalCalls: false, writesWorkflow: false });
    expect(JSON.stringify(preview.impact)).toContain("cron.");
  });
  it("writes one system history and actual author audit atomically, repeat is harmless", async () => {
    const client = await fixture(), plan = await planFor(client.id);
    const command = { planId: plan.id, actorId: adminId, planHash: plan.planHash, impactReviewed: true };
    expect((await applyManualCorrection(command)).status).toBe("APPLIED");
    expect((await applyManualCorrection(command)).status).toBe("ALREADY_APPLIED");
    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(after.fullName).toBe("Synthetic corrected"); expect(after.assignedAgentId).toBe(agentId);
    expect(after.status).toBe(client.status); expect(after.assignmentCompletedAt).toBe(client.assignmentCompletedAt);
    const history = await prisma.interaction.findMany({ where: { clientId: client.id } });
    expect(history).toHaveLength(1); expect(history[0]).toMatchObject({ actorKind: "SYSTEM", agentId: null });
    expect(history[0].notes).not.toContain("PRIVATE_REASON_CANARY");
    const audit = await prisma.auditLog.findMany({ where: { entityId: client.id, action: "CLIENT_MANUAL_CORRECTION" } });
    expect(audit).toHaveLength(1); expect(audit[0].agentId).toBe(adminId);
  });
  it("rejects stale data and rolls back the entire multi-card plan", async () => {
    const first = await fixture(), second = await fixture();
    const plan = await previewManualCorrection({ ...input(first.id), targets: [{ clientId: first.id, patch: { fullName: "First correction" } }, { clientId: second.id, patch: { fullName: "Second correction" } }] }, true);
    if (!("id" in plan)) throw new Error("Expected plan");
    await prisma.client.update({ where: { id: second.id }, data: { fullName: "Concurrent correction" } });
    await expect(applyManualCorrection({ planId: plan.id, actorId: adminId, planHash: plan.planHash, impactReviewed: true })).rejects.toThrow("изменилась");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: first.id } })).fullName).toBe(first.fullName);
    expect(await prisma.interaction.count({ where: { clientId: first.id } })).toBe(0);
    expect((await prisma.manualDataCorrection.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe("PLANNED");
  });
  it("denies ordinary actors and arbitrary workflow/security/ownership patches", async () => {
    const client = await fixture();
    await expect(previewManualCorrection({ ...input(client.id), actorId: agentId })).rejects.toThrow("администратору");
    await expect(previewManualCorrection({ ...input(client.id), targets: [{ clientId: client.id, patch: { fullName: "Name", securityReview: "CLEARED", assignedAgentId: adminId } }] })).rejects.toThrow();
  });
  it("rejects tampering, expired plans and revoked privileges", async () => {
    const client = await fixture(), plan = await planFor(client.id);
    const command = { planId: plan.id, actorId: adminId, planHash: plan.planHash, impactReviewed: true };
    await prisma.manualDataCorrection.update({ where: { id: plan.id }, data: { reason: "tampered reason" } });
    await expect(applyManualCorrection(command)).rejects.toThrow("изменено");
    const expired = await planFor(client.id);
    await prisma.manualDataCorrection.update({ where: { id: expired.id }, data: { createdAt: new Date(Date.now() - 31 * 60_000) } });
    await expect(applyManualCorrection({ ...command, planId: expired.id, planHash: expired.planHash })).rejects.toThrow("истёк");
    const revoked = await planFor(client.id);
    await prisma.agent.update({ where: { id: adminId }, data: { permissions: { granted: [], revoked: ["settings.manage"] } } });
    try { await expect(applyManualCorrection({ ...command, planId: revoked.id, planHash: revoked.planHash })).rejects.toThrow("администратору"); }
    finally { await prisma.agent.update({ where: { id: adminId }, data: { permissions: {} } }); }
  });
  it("server execution gate stays closed even for an authenticated administrator", async () => {
    const saved = process.env.MANUAL_DATA_CORRECTIONS_LIVE; delete process.env.MANUAL_DATA_CORRECTIONS_LIVE;
    try {
      const client = await fixture(), plan = await planFor(client.id);
      const response = await request(app).post(`/api/v1/maintenance/data-corrections/${plan.id}/apply`).set("Authorization", `Bearer ${token}`).send({ planHash: plan.planHash, impactReviewed: true });
      expect(response.status).toBe(409);
      expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).fullName).toBe(client.fullName);
    } finally { if (saved !== undefined) process.env.MANUAL_DATA_CORRECTIONS_LIVE = saved; }
  });
});

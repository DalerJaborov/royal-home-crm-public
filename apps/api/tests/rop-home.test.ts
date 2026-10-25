import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { startSellerControl, commandSellerControl } from "../src/lib/sellerControlEpisodes.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
const actors: Array<{ id: string; token: string }> = [];
const clients: string[] = [];
let backup: unknown;
let createdSettings = false;
let fixture: { taskId: string; episodeId: string; clientId: string };
beforeAll(async () => {
  const existing = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { sellerControlConfig: true, companyDaysOff: true } });
  backup = existing; createdSettings = !existing;
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", sellerControlConfig: { agentDueWorkingDays: 1, ropReceiptDueWorkingDays: 1, ropActionDueWorkingDays: 2 } },
    update: { sellerControlConfig: { agentDueWorkingDays: 1, ropReceiptDueWorkingDays: 1, ropActionDueWorkingDays: 2 }, companyDaysOff: [] } });
  for (const role of ["HEAD_OF_SALES", "HEAD_OF_SALES", "AGENT", "ADMIN", "SECURITY"] as const) {
    const password = "rop-home-isolated-fixture";
    const actor = await prisma.agent.create({ data: { phone: `rop-${randomUUID()}`, fullName: `Rop fixture ${role}`, role, weeklyDaysOff: [], passwordHash: await bcrypt.hash(password, 4) } });
    const login = await request(app).post("/api/v1/auth/login").send({ phone: actor.phone, password });
    expect(login.status).toBe(200); actors.push({ id: actor.id, token: login.body.accessToken });
  }
});
async function createWork(ropId = actors[0].id) {
  const past = new Date(Date.now() - 10 * 86400000);
  const client = await prisma.client.create({ data: { fullName: "Rop home client", phone: `rop-client-${randomUUID()}`, source: "PHONE_CALL", kind: "SELLER",
    assignedAgentId: actors[2].id, assignedAt: past, acceptedAt: past, sellerDeclaredPropertyCount: 2,
    sellerDeclaredPropertyCountAt: new Date(past.getTime() + 1000), securityReview: "PENDING", securityNote: "PRIVATE_ROP_SENTINEL" } });
  clients.push(client.id);
  const episode = await startSellerControl({ clientId: client.id, ropAgentId: ropId, actorId: actors[3].id, requestKey: randomUUID(), live: true }, new Date(Date.now() - 5 * 86400000));
  await commandSellerControl(episode.id, { requestKey: randomUUID(), revision: episode.revision, action: "TICK" }, null);
  const ready = await prisma.sellerControlEpisode.findUniqueOrThrow({ where: { id: episode.id } });
  expect(ready.status).toBe("ROP_RECEIPT"); expect(ready.ropTaskId).toBeTruthy();
  return { taskId: ready.ropTaskId!, episodeId: ready.id, clientId: client.id };
}
beforeEach(async () => { vi.stubEnv("SELLER_CONTROL_INTERNAL_LIVE", "explicitly-approved"); fixture = await createWork(); });
afterEach(async () => {
  vi.unstubAllEnvs();
  await prisma.sellerControlEpisode.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.auditLog.deleteMany({ where: { entityType: "Client", entityId: { in: clients } } });
  await prisma.client.deleteMany({ where: { id: { in: clients } } }); clients.length = 0;
});
afterAll(async () => {
  if (createdSettings) await prisma.settings.deleteMany({ where: { id: "singleton" } });
  else if (backup) await prisma.settings.update({ where: { id: "singleton" }, data: backup as { sellerControlConfig: object; companyDaysOff: number[] } });
  await deleteAgentsWithTraces(actors.map(actor => actor.id)); await prisma.$disconnect();
});
const get = (index = 0, suffix = "") => request(app).get(`/api/v1/dashboard/sales-control${suffix}`).set("Authorization", `Bearer ${actors[index].token}`);
const respond = (index: number, body: object) => request(app).post(`/api/v1/interactions/${fixture.taskId}/work-response`).set("Authorization", `Bearer ${actors[index].token}`).send(body);
describe("dedicated ROP ordinary work cabinet", () => {
  it("does not let more than 100 retained completed episodes hide pending work", async () => {
    const original = await prisma.sellerControlEpisode.findUniqueOrThrow({ where: { id: fixture.episodeId } });
    const older = new Date(original.createdAt.getTime() - 86400000);
    const taskIds = Array.from({ length: 102 }, () => randomUUID());
    await prisma.interaction.createMany({ data: taskIds.map(id => ({ id, clientId: fixture.clientId,
      actorKind: "SYSTEM" as const, subjectAgentId: actors[0].id, type: "SYSTEM" as const,
      notes: "Completed historical work", nextAction: "Historical task", completedAt: older, nextActionDate: older })) });
    await prisma.sellerControlEpisode.createMany({ data: taskIds.map(ropTaskId => ({
      episodeKey: randomUUID(), clientId: fixture.clientId, agentId: original.agentId,
      assignmentAt: original.assignmentAt, ropAgentId: actors[0].id, ropTaskId,
      status: "DIRECTOR", executionMode: "LIVE", createdAt: older,
    })) });
    const result = await get();
    expect(result.status).toBe(200);
    expect(result.body.tasks.map((task: { id: string }) => task.id)).toEqual([fixture.taskId]);
    expect(result.body.limited).toBe(false);
  });
  it("hides cancelled tasks and disables responses for a frozen ROP", async () => {
    await prisma.agent.update({ where: { id: actors[0].id }, data: { frozenAt: new Date() } });
    try { expect((await get()).body.actionsEnabled).toBe(false); }
    finally { await prisma.agent.update({ where: { id: actors[0].id }, data: { frozenAt: null } }); }
    await prisma.interaction.update({ where: { id: fixture.taskId }, data: { taskCancelledAt: new Date() } });
    expect((await get()).body.tasks).toEqual([]);
    expect((await respond(0, { requestKey: randomUUID(), action: "RECEIPT" })).status).toBe(404);
  });
  it("does not revive an ordinary task removed from the calendar", async () => {
    await prisma.interaction.update({ where: { id: fixture.taskId }, data: { nextAction: null } });
    expect((await get()).body.tasks).toEqual([]);
    expect((await respond(0, { requestKey: randomUUID(), action: "RECEIPT" })).status).toBe(404);
  });
  it("returns only the exact assignee's neutral task, without investigation metadata", async () => {
    const other = await createWork(actors[1].id);
    const response = await get(); expect(response.status).toBe(200);
    expect(response.body.tasks.map((task: { id: string }) => task.id)).toEqual([fixture.taskId]);
    expect(response.body.tasks[0].responseAction).toBe("RECEIPT");
    const text = JSON.stringify(response.body);
    for (const forbidden of ["PRIVATE_ROP_SENTINEL", "securityReview", "securityNote", "episodeId", fixture.episodeId, other.taskId, "DIRECTOR"]) expect(text).not.toContain(forbidden);
    expect((await get(1)).body.tasks.map((task: { id: string }) => task.id)).toEqual([other.taskId]);
  });
  it("does not open the cabinet or private cases to other roles", async () => {
    expect((await get(2)).status).toBe(403); expect((await get(4)).status).toBe(403);
    expect((await request(app).get("/api/v1/security/cases").set("Authorization", `Bearer ${actors[0].token}`)).status).toBe(403);
    expect((await get(0, `?agentId=${actors[1].id}`)).status).toBe(400);
  });
  it("accepts actual receipt and action, aligns the task deadline, and preserves idempotency", async () => {
    const receipt = { requestKey: randomUUID(), action: "RECEIPT" };
    expect((await respond(0, receipt)).status).toBe(204); expect((await respond(0, receipt)).status).toBe(204);
    const afterReceipt = await prisma.sellerControlEpisode.findUniqueOrThrow({ where: { id: fixture.episodeId } });
    const task = await prisma.interaction.findUniqueOrThrow({ where: { id: fixture.taskId } });
    expect(afterReceipt.status).toBe("ROP_ACTION"); expect(task.nextActionDate).toEqual(afterReceipt.ropActionDueAt); expect(task.completedAt).toBeNull();
    expect((await get()).body.tasks[0].responseAction).toBe("ACTION");
    expect((await respond(0, { requestKey: randomUUID(), action: "ACTION" })).status).toBe(400);
    const action = { requestKey: randomUUID(), action: "ACTION", note: "Проверил работу с клиентом и согласовал дальнейшие действия" };
    expect((await respond(0, action)).status).toBe(204); expect((await respond(0, action)).status).toBe(204);
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: fixture.taskId } })).completedAt).not.toBeNull();
    expect((await prisma.sellerControlEpisode.findUniqueOrThrow({ where: { id: fixture.episodeId } })).status).toBe("ROP_ACTION");
    expect((await get()).body.tasks).toEqual([]);
    expect(await prisma.sellerControlEvent.count({ where: { episodeId: fixture.episodeId, type: "ROP_ACTION_RECORDED" } })).toBe(1);
  });
  it("rejects another ROP and does not let reads create or acknowledge work", async () => {
    const before = await prisma.sellerControlEvent.count({ where: { episodeId: fixture.episodeId } });
    expect((await respond(1, { requestKey: randomUUID(), action: "RECEIPT" })).status).toBe(404);
    await get(); await get(); expect(await prisma.sellerControlEvent.count({ where: { episodeId: fixture.episodeId } })).toBe(before);
  });
  it("hides cancelled or private task bindings and preserves the execution gate", async () => {
    vi.stubEnv("SELLER_CONTROL_INTERNAL_LIVE", "");
    const disabled = await get(); expect(disabled.body.actionsEnabled).toBe(false); expect(disabled.body.tasks[0].responseAction).toBeNull();
    expect((await respond(0, { requestKey: randomUUID(), action: "RECEIPT" })).status).toBe(409);
    await prisma.interaction.update({ where: { id: fixture.taskId }, data: { investigationOnly: true } });
    expect((await get()).body.tasks).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { randomInt } from "node:crypto";

const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { assignPendingLeads } = await import("../src/leads.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

/**
 * Карточка, восстановленная из Корзины без агента, не пропадает из виду
 * (23.09.2026, проверка раздачи, пункты 20 и 24). Раньше при уволенном агенте
 * она получала escalatedAt без агента: волна её пропускала, пуша не было.
 */

const phone = () => `+99296${randomInt(1_000_000, 9_999_999)}`;
const password = "testpass123";
let directorId = "";
let directorToken = "";
let firedId = "";
let freeId = "";
let frozenId = "";
let savedStrategy: string | null = null;
const clientIds: string[] = [];

async function trashedClient(assignedAgentId: string | null) {
  const c = await prisma.client.create({
    data: {
      fullName: `Из Корзины ${randomInt(1000, 9999)}`,
      phone: phone(),
      source: "PHONE_CALL",
      kind: "BUYER",
      status: "NEW",
      assignedAgentId,
      acceptedAt: assignedAgentId ? new Date(Date.now() - 86_400_000) : null,
      deletedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 4);
  const director = await prisma.agent.create({ data: { fullName: "Директор Корзины", phone: phone(), role: "DIRECTOR", passwordHash } });
  directorId = director.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  directorToken = login.body.accessToken;
  firedId = (await prisma.agent.create({ data: { fullName: "Уволен", phone: phone(), role: "AGENT", passwordHash, isActive: false } })).id;
  freeId = (await prisma.agent.create({ data: { fullName: "Принимает", phone: phone(), role: "AGENT", passwordHash } })).id;
  frozenId = (await prisma.agent.create({ data: { fullName: "Заморожен на время отпуска", phone: phone(), role: "AGENT", passwordHash, frozenAt: new Date(), absenceKind: "VACATION" } })).id;
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { leadDistributionStrategy: true } });
  savedStrategy = s?.leadDistributionStrategy ?? null;
  await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: "round_robin" } });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([directorId, firedId, freeId, frozenId]);
  if (savedStrategy) await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: savedStrategy } });
  await prisma.$disconnect();
});

describe("восстановление из Корзины без агента", () => {
  it.each(["current-only", "historical-only", "current-with-active-history"] as const)("замороженный владелец не получает восстановленную карточку: %s", async (scenario) => {
    const c = await trashedClient(scenario === "historical-only" ? null : frozenId);
    const historical = scenario === "historical-only" ? frozenId : scenario === "current-with-active-history" ? freeId : null;
    await prisma.client.update({ where: { id: c.id }, data: { lastAgentId: historical } });
    const res = await request(app).post(`/api/v1/clients/${c.id}/restore`).set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(204);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.deletedAt).toBeNull();
    expect(after.assignedAgentId).toBe(scenario === "current-with-active-history" ? freeId : null);
    expect(after.assignedAgentId).not.toBe(frozenId);
    expect(after.acceptedAt).toBeNull();
    expect(after.escalatedAt).toBeNull();
  });

  it("восстановление завершённого назначения у замороженного не переоткрывает его и сохраняет DEFERRED", async () => {
    const c = await trashedClient(frozenId);
    const completedAt = new Date();
    const deferredUntil = new Date(Date.now() + 86_400_000);
    await prisma.client.update({ where: { id: c.id }, data: {
      lastAgentId: freeId, assignmentRefusedAt: completedAt, assignmentCompletedAt: completedAt,
      workStatus: "DEFERRED", deferredUntil,
    } });
    const res = await request(app).post(`/api/v1/clients/${c.id}/restore`).set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(204);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.assignedAgentId).toBe(frozenId);
    expect(after.assignmentCompletedAt).toEqual(completedAt);
    expect(after.assignmentRefusedAt).toEqual(completedAt);
    expect(after.workStatus).toBe("DEFERRED");
    expect(after.deferredUntil).toEqual(deferredUntil);
  });

  it("возвращает прежнему активному агенту, сохраняя отказ отдельно от обычного возврата", async () => {
    const c = await trashedClient(null);
    await prisma.client.update({ where: { id: c.id }, data: { lastAgentId: freeId } });
    const res = await request(app).post(`/api/v1/clients/${c.id}/restore`).set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(204);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).assignedAgentId).toBe(freeId);
  });

  it("не переоткрывает завершённое назначение восстановлением из корзины", async () => {
    const c = await trashedClient(null);
    const completedAt = new Date();
    await prisma.client.update({ where: { id: c.id }, data: { lastAgentId: freeId, assignmentRefusedAt: completedAt, assignmentCompletedAt: completedAt } });
    const res = await request(app).post(`/api/v1/clients/${c.id}/restore`).set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(204);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.assignedAgentId).toBeNull();
    expect(after.assignmentCompletedAt).toEqual(completedAt);
    expect(after.assignmentRefusedAt).toEqual(completedAt);
  });

  it("действующий текущий владелец важнее истории прежнего агента", async () => {
    const c = await trashedClient(freeId);
    await prisma.client.update({ where: { id: c.id }, data: { lastAgentId: directorId } });
    const res = await request(app).post(`/api/v1/clients/${c.id}/restore`).set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(204);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).assignedAgentId).toBe(freeId);
  });
  it("агент уволен — карточка в очереди раздачи, руководство получает пуш, волна её отдаёт", async () => {
    const c = await trashedClient(firedId);
    sendPushToAgents.mockClear();
    const res = await request(app).post(`/api/v1/clients/${c.id}/restore`).set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(204);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.assignedAgentId).toBeNull();
    expect(after.escalatedAt).toBeNull();
    expect(after.acceptedAt).toBeNull();
    expect(
      sendPushToAgents.mock.calls.some((call) => (call as unknown as [string[], { tag?: string }])[1]?.tag === `restore-no-agent-${c.id}`)
    ).toBe(true);

    await assignPendingLeads();
    const assigned = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(assigned.assignedAgentId).not.toBeNull();
    expect(assigned.assignedAgentId).not.toBe(firedId);
  });

  it("лежала в Корзине вовсе без агента — тоже в очередь и с пушем", async () => {
    const c = await trashedClient(null);
    sendPushToAgents.mockClear();
    const res = await request(app).post(`/api/v1/clients/${c.id}/restore`).set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(204);
    expect(
      sendPushToAgents.mock.calls.some((call) => (call as unknown as [string[], { tag?: string }])[1]?.tag === `restore-no-agent-${c.id}`)
    ).toBe(true);
  });
});

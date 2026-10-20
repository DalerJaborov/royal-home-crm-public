import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * GET /agents/:id/overview — раздел «problems» (владелец 16.09.2026: «по-крупному,
 * чтобы не искать что где когда»). Собирает красные флаги «Контроля руководителя»
 * (routes/oversight.ts) для ОДНОГО агента — переиспользует те же WHERE-условия и
 * хелперы (overdueTasksWhere и т.п.), а не копирует их логику.
 *
 * Главная проверяемая мысль — СУЖЕНИЕ ПО АГЕНТУ РАБОТАЕТ ЧЕСТНО: просроченная
 * задача одного агента не должна протекать в карточку другого, и агент без
 * проблем должен видеть настоящий ноль, а не что-то забытое общим списком.
 */

const runId = Date.now();
const password = "testpass123";
const clientIds: string[] = [];
const interactionIds: string[] = [];
let agentAId = "";
let agentBId = "";
let agentAPhone = "";
let directorPhone = "";

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken ?? res.body.token;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentAPhone = `+992963${String(runId).slice(-7)}`;
  const agentBPhone = `+992964${String(runId).slice(-7)}`;
  directorPhone = `+992965${String(runId).slice(-7)}`;

  const [agentA, agentB] = await Promise.all([
    prisma.agent.create({ data: { fullName: `Проблемы Агент А ${runId}`, phone: agentAPhone, role: "AGENT", passwordHash } }),
    prisma.agent.create({ data: { fullName: `Проблемы Агент Б ${runId}`, phone: agentBPhone, role: "AGENT", passwordHash } }),
  ]);
  agentAId = agentA.id;
  agentBId = agentB.id;
  await prisma.agent.create({
    data: { fullName: `Проблемы Директор ${runId}`, phone: directorPhone, role: "DIRECTOR", passwordHash },
  });

  const client = await prisma.client.create({
    data: {
      fullName: `Просрочка ${runId}`,
      phone: `+992966${String(runId).slice(-7)}`,
      source: "INSTAGRAM",
      kind: "BUYER",
      assignedAgentId: agentAId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(client.id);

  const task = await prisma.interaction.create({
    data: {
      clientId: client.id,
      agentId: agentAId,
      type: "CALL",
      notes: "тестовая просроченная задача",
      nextAction: "Перезвонить",
      nextActionDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      completedAt: null,
    },
  });
  interactionIds.push(task.id);
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentAId, agentBId] } } });
  await prisma.agent.deleteMany({ where: { phone: directorPhone } });
});

describe("GET /agents/:id/overview — problems", () => {
  it("просроченная задача агента А видна в его карточке", async () => {
    const token = await login(directorPhone);
    const res = await request(app).get(`/api/v1/agents/${agentAId}/overview`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.problems.overdueTasks.total).toBeGreaterThanOrEqual(1);
    const found = res.body.problems.overdueTasks.items.find((t: { client: { fullName: string } }) => t.client.fullName.includes(`Просрочка ${runId}`));
    expect(found).toBeDefined();
  });

  it("та же задача НЕ протекает в карточку агента Б — сужение по агенту честное", async () => {
    const token = await login(directorPhone);
    const res = await request(app).get(`/api/v1/agents/${agentBId}/overview`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.problems.overdueTasks.total).toBe(0);
    expect(res.body.problems.overdueTasks.items).toEqual([]);
  });

  it("агент без проблем — честный ноль по всем категориям, не забытый общий список", async () => {
    const token = await login(directorPhone);
    const res = await request(app).get(`/api/v1/agents/${agentBId}/overview`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const p = res.body.problems;
    expect(p.overdueTasks.total).toBe(0);
    expect(p.stalledClients.total).toBe(0);
    expect(p.silentAfterShowing.total).toBe(0);
    expect(p.refusedHighScore.total).toBe(0);
    expect(p.endlessNegotiations.total).toBe(0);
    expect(p.sellerPropertyMissing.total).toBe(0);
    expect(p.lossSeries).toBeNull();
  });
});

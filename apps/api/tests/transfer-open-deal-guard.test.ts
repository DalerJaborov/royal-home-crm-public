import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { changeClientAgent } from "../src/lib/changeClientAgent.js";

/**
 * ОТКРЫТАЯ СДЕЛКА БЛОКИРУЕТ ПЕРЕДАЧУ КЛИЕНТА (ночная проверка 24.09.2026,
 * находка №208/С2-4, решение владельца — сделку не переносить, а передачу
 * запрещать).
 *
 * До починки `/assign` и «Передать» меняли `Client.assignedAgentId`, а
 * `Deal.agentId` оставался прежним: у прежнего агента 403 на правку своей же
 * сделки (routes/deals.ts сверяет владение по Deal.agentId), у нового
 * владельца карточки — 409 при попытке завести вторую сделку по тому же
 * объекту, комиссия продолжала копиться на прежнем агенте.
 */

const runId = Date.now();
const password = "testpass123";
const phone = (n: number) => `+992900${String(runId).slice(-6)}${n}`;

let districtId = "";
let directorId = "";
let directorToken = "";
let agentAId = ""; // прежний владелец
let agentBId = ""; // получатель
const clientIds: string[] = [];
const propertyIds: string[] = [];

async function makeBuyer(idx: number) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент открытой сделки ${runId}-${idx}`,
      phone: phone(idx),
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentAId,
      assignedAt: new Date(Date.now() - 3_600_000),
      acceptedAt: new Date(Date.now() - 3_600_000),
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeProperty(idx: number) {
  const p = await prisma.property.create({
    data: {
      title: `Объект для сделки ${runId}-${idx}`,
      type: "APARTMENT",
      areaSqm: 55,
      price: 90000,
      currency: "USD",
      districtId,
      address: `Тест ${runId}-${idx}`,
      condition: "GOOD",
      status: "AVAILABLE",
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 4);
  districtId = (await prisma.district.create({ data: { name: `Открытая сделка ${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: `Директор передачи ${runId}`, phone: phone(9), role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  agentAId = (
    await prisma.agent.create({ data: { fullName: `Агент А сделки ${runId}`, phone: phone(1), role: "AGENT", passwordHash } })
  ).id;
  agentBId = (
    await prisma.agent.create({ data: { fullName: `Агент Б сделки ${runId}`, phone: phone(2), role: "AGENT", passwordHash } })
  ).id;

  const login = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  directorToken = login.body.accessToken;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentAId, agentBId, directorId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("POST /clients/:id/assign — открытая сделка", () => {
  it("сделка в работе (NEGOTIATION) — 409, владелец не меняется", async () => {
    const client = await makeBuyer(1);
    const property = await makeProperty(1);
    await prisma.deal.create({
      data: { clientId: client.id, propertyId: property.id, agentId: agentAId, stage: "NEGOTIATION" },
    });

    const res = await request(app)
      .post(`/api/v1/clients/${client.id}/assign`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ agentId: agentBId });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/открытая сделка/);

    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.assignedAgentId).toBe(agentAId);
    const deal = await prisma.deal.findFirst({ where: { clientId: client.id } });
    expect(deal?.agentId).toBe(agentAId);
  });

  it("сделка отменена (CANCELLED) — передача проходит, 200", async () => {
    const client = await makeBuyer(2);
    const property = await makeProperty(2);
    await prisma.deal.create({
      data: { clientId: client.id, propertyId: property.id, agentId: agentAId, stage: "CANCELLED" },
    });

    const res = await request(app)
      .post(`/api/v1/clients/${client.id}/assign`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ agentId: agentBId });

    expect(res.status).toBe(200);
    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.assignedAgentId).toBe(agentBId);
  });
});

describe("changeClientAgent(source: \"transfer\") — открытая сделка", () => {
  it("«Передать» кнопкой (actorId задан) с открытой сделкой — отказ, владелец не меняется", async () => {
    const client = await makeBuyer(3);
    const property = await makeProperty(3);
    await prisma.deal.create({
      data: { clientId: client.id, propertyId: property.id, agentId: agentAId, stage: "PENDING_APPROVAL" },
    });

    const result = await changeClientAgent({
      clientId: client.id,
      toAgentId: agentBId,
      reason: "тест: передача при открытой сделке",
      actorId: agentAId,
      source: "transfer",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("open_deal");
    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.assignedAgentId).toBe(agentAId);
  });

  it("автоматика (actorId не передан, тот же источник) — открытая сделка НЕ мешает", async () => {
    const client = await makeBuyer(4);
    const property = await makeProperty(4);
    await prisma.deal.create({
      data: { clientId: client.id, propertyId: property.id, agentId: agentAId, stage: "NEGOTIATION" },
    });

    const result = await changeClientAgent({
      clientId: client.id,
      toAgentId: agentBId,
      reason: "тест: автоматическое освобождение места в портфеле",
      source: "transfer",
    });

    expect(result.ok).toBe(true);
    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.assignedAgentId).toBe(agentBId);
  });
});

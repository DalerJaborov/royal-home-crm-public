import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

/**
 * СДЕЛКА РУКОВОДИТЕЛЯ — НА АГЕНТА КЛИЕНТА (глубокая проверка 02.10.2026, F1).
 *
 * Единственный путь создания сделки из интерфейса — блок «Сделка по объекту»
 * на карточке объекта — agentId не передаёт никогда. Сервер у руководителя
 * (право clients.assign) брал `data.agentId ?? req.agent.id`, то есть самого
 * руководителя: сделка, объект (assignedAgentId) и баллы за закрытие уходили
 * ему, а агент клиента сделку не видел вовсе (агент видит только свои сделки).
 *
 * Теперь без явного agentId сделка заводится на агента клиента; явный выбор
 * руководителя по-прежнему главнее; отключённый агент клиента не получает
 * сделку — тогда она на того, кто её заводит.
 */

const runId = Date.now();

let districtId = "";
let directorId = "";
let agentId = "";
let otherAgentId = "";
let goneAgentId = "";
let directorToken = "";
const clientIds: string[] = [];
const propertyIds: string[] = [];

async function makeBuyer(suffix: string, assignedAgentId: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `Покупатель F1 ${suffix} ${runId}`,
      phone: `+99293${String(runId).slice(-6)}${suffix}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c.id;
}

async function makeProperty(suffix: string) {
  const p = await prisma.property.create({
    data: {
      title: `Объект F1 ${suffix} ${runId}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 100000,
      currency: "USD",
      districtId,
      address: `Тест F1 ${suffix}`,
      condition: "GOOD",
      status: "AVAILABLE",
    },
  });
  propertyIds.push(p.id);
  return p.id;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район F1 ${runId}` } })).id;
  const tail = String(runId).slice(-6);
  const director = await prisma.agent.create({
    data: { fullName: `Директор F1 ${runId}`, phone: `+99294${tail}1`, role: "DIRECTOR", passwordHash: "x" },
  });
  const agent = await prisma.agent.create({
    data: { fullName: `Агент F1 ${runId}`, phone: `+99294${tail}2`, role: "AGENT", passwordHash: "x" },
  });
  const other = await prisma.agent.create({
    data: { fullName: `Другой агент F1 ${runId}`, phone: `+99294${tail}3`, role: "AGENT", passwordHash: "x" },
  });
  const gone = await prisma.agent.create({
    data: { fullName: `Ушедший агент F1 ${runId}`, phone: `+99294${tail}4`, role: "AGENT", passwordHash: "x", isActive: false },
  });
  directorId = director.id;
  agentId = agent.id;
  otherAgentId = other.id;
  goneAgentId = gone.id;
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([directorId, agentId, otherAgentId, goneAgentId]);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("POST /deals руководителем без agentId (F1)", () => {
  it("сделка и объект записываются на агента клиента, а не на руководителя", async () => {
    const clientId = await makeBuyer("1", agentId);
    const propertyId = await makeProperty("1");
    const res = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ clientId, propertyId, stage: "NEGOTIATION" });
    expect(res.status).toBe(201);
    expect(res.body.agentId).toBe(agentId);
    const prop = await prisma.property.findUnique({ where: { id: propertyId } });
    expect(prop?.assignedAgentId).toBe(agentId);
  });

  it("явный выбор агента руководителем главнее агента клиента", async () => {
    const clientId = await makeBuyer("2", agentId);
    const propertyId = await makeProperty("2");
    const res = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ clientId, propertyId, agentId: otherAgentId });
    expect(res.status).toBe(201);
    expect(res.body.agentId).toBe(otherAgentId);
  });

  it("агент клиента отключён — сделка на того, кто её заводит", async () => {
    const clientId = await makeBuyer("3", goneAgentId);
    const propertyId = await makeProperty("3");
    const res = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ clientId, propertyId });
    expect(res.status).toBe(201);
    expect(res.body.agentId).toBe(directorId);
  });
});

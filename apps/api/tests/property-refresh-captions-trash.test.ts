import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ГЛУБОКАЯ ПРОВЕРКА 02.10.2026, П9 — «Обновить подписи» у объекта из Корзины.
 *
 * Соседние пути (finish-edit, social-removed-by-hand, список репостов) объект из
 * Корзины отсекают, а refresh-captions — нет: по удалённому объекту рассылались
 * подписи во внешние каналы и писался журнал. Корзина — 404, как у соседей.
 */

const runId = `${Date.now()}`.slice(-7);
const password = "testpass123";
const agentIds: string[] = [];
let districtId: string;
let propertyId: string;
let agentToken: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Подписи-П9-${runId}` } })).id;
  const agent = await prisma.agent.create({
    data: { fullName: `Агент П9 ${runId}`, phone: `+992988${runId}`, role: "AGENT", passwordHash },
  });
  agentIds.push(agent.id);
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект П9 ${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 40000,
        currency: "USD",
        districtId,
        address: `Тест ${runId}`,
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId: agent.id,
        assignedAgentId: agent.id,
        deletedAt: new Date(),
      },
    })
  ).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  agentToken = login.body.accessToken;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("П9: подписи у объекта из Корзины не обновляются", () => {
  it("refresh-captions — 404", async () => {
    const res = await request(app)
      .post(`/api/v1/properties/${propertyId}/refresh-captions`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(404);
  });
});

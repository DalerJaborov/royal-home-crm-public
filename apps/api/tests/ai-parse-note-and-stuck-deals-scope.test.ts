import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: vi.fn(async () => ({ interaction: { type: "CALL", notes: "заметка" }, clientUpdates: {} })),
}));

import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { createTestAgent } from "./helpers/ownAgent.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Находка №157 (ночная проверка 24.09.2026):
 *  1. POST /ai/parse-note брал клиента из Корзины — читал его данные и тратил модель;
 *  2. «зависшие сделки» в GET /ai/insights скоупились правом на клиентов
 *     (clients.viewAll), а не на сделки (deals.viewAll): сотрудник с точечной
 *     галочкой на клиентов видел чужие сделки.
 */

const runId = Date.now();
let ownerId = "";
let viewerId = "";
let viewerToken = "";
let ownerToken = "";
let trashedClientId = "";
let dealClientId = "";
let propertyId = "";
let districtId = "";
let dealId = "";

beforeAll(async () => {
  ownerId = await createTestAgent("Скоуп Хозяин");
  viewerId = await createTestAgent("Скоуп Смотрящий");
  // Точечная галочка: все клиенты — да, все сделки — нет.
  await prisma.agent.update({ where: { id: viewerId }, data: { permissions: { granted: ["clients.viewAll"], revoked: [] } } });
  ownerToken = signAccessToken({ sub: ownerId, role: "AGENT" });
  viewerToken = signAccessToken({ sub: viewerId, role: "AGENT" });

  const phone = () => `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`;
  trashedClientId = (
    await prisma.client.create({
      data: { fullName: "Из Корзины", phone: phone(), source: "WALK_IN", assignedAgentId: ownerId, acceptedAt: new Date(), deletedAt: new Date() },
    })
  ).id;
  dealClientId = (
    await prisma.client.create({
      data: { fullName: "Сделочный", phone: phone(), source: "WALK_IN", assignedAgentId: ownerId, acceptedAt: new Date() },
    })
  ).id;
  districtId = (await prisma.district.create({ data: { name: `Скоуп-район-${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Скоуп объект ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        windowCount: 3,
        price: 300000,
        currency: "TJS",
        districtId,
        address: `Скоуп ${runId}`,
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId: ownerId,
      },
    })
  ).id;
  dealId = (
    await prisma.deal.create({
      data: { clientId: dealClientId, propertyId, agentId: ownerId, startedAt: new Date("1990-01-01T00:00:00Z") },
    })
  ).id;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: { in: [trashedClientId, dealClientId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await deleteAgentsWithTraces([ownerId, viewerId]);
});

describe("POST /ai/parse-note", () => {
  it("клиент из Корзины — 404, как и на остальных маршрутах карточки", async () => {
    const res = await request(app)
      .post("/api/v1/ai/parse-note")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ text: "звонил, хочет трёшку", clientId: trashedClientId });
    expect(res.status).toBe(404);
  });
});

describe("GET /ai/insights → stuckDeals", () => {
  it("свои сделки видны хозяину", async () => {
    const res = await request(app).get("/api/v1/ai/insights").set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect((res.body.stuckDeals as { id: string }[]).map((d) => d.id)).toContain(dealId);
  });

  it("чужая сделка не видна сотруднику с правом на клиентов, но без права на сделки", async () => {
    const res = await request(app).get("/api/v1/ai/insights").set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    expect((res.body.stuckDeals as { id: string }[]).map((d) => d.id)).not.toContain(dealId);
  });
});

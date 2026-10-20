import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ГЛУБОКАЯ ПРОВЕРКА 02.10.2026, П8 (из аудита прав) — подбор объектов под клиента
 * (`GET /clients/:id/match`) работал и для клиента из Корзины, и для лида, которого
 * агент ещё не принял. Подбор строится по бюджету, району и комнатам клиента —
 * то есть косвенно раскрывает требования, которые карточка до принятия скрывает
 * (gateUntilAccepted в clients/card.ts).
 *
 * Правило: Корзина — 404; до принятия своему агенту — пустой подбор (не 403:
 * карточка запрашивает подбор сразу при открытии, и отказ выглядел бы поломкой).
 */

const runId = `${Date.now()}`.slice(-7);
const password = "testpass123";
const agentIds: string[] = [];
const clientIds: string[] = [];
let districtId: string;
let propertyId: string;
let pendingId: string;
let acceptedId: string;
let deletedId: string;
let agentToken: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Подбор-П8-${runId}` } })).id;
  const agent = await prisma.agent.create({
    data: { fullName: `Агент П8 ${runId}`, phone: `+992987${runId}`, role: "AGENT", passwordHash },
  });
  agentIds.push(agent.id);
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект П8 ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        rooms: 2,
        price: 50000,
        currency: "USD",
        districtId,
        address: `Тест ${runId}`,
        condition: "GOOD",
        status: "AVAILABLE",
      },
    })
  ).id;
  const make = async (i: number, extra: Record<string, unknown>) => {
    const c = await prisma.client.create({
      data: {
        fullName: `Покупатель П8-${i} ${runId}`,
        phone: `+99298${i}${runId}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agent.id,
        budgetMax: 60000,
        currency: "USD",
        desiredDistrictId: districtId,
        desiredRooms: 2,
        ...extra,
      },
    });
    clientIds.push(c.id);
    return c.id;
  };
  pendingId = await make(1, { acceptedAt: null, assignedAt: new Date() });
  acceptedId = await make(2, { acceptedAt: new Date() });
  deletedId = await make(3, { acceptedAt: new Date(), deletedAt: new Date() });
  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  agentToken = login.body.accessToken;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("П8: подбор под клиента — те же гейты, что у карточки", () => {
  it("принятый клиент — подбор находит объект", async () => {
    const res = await request(app).get(`/api/v1/clients/${acceptedId}/match`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect((res.body.properties as { id: string }[]).some((p) => p.id === propertyId)).toBe(true);
  });

  it("лид до принятия — подбор пуст", async () => {
    const res = await request(app).get(`/api/v1/clients/${pendingId}/match`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.properties).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it("клиент в Корзине — не найден", async () => {
    const res = await request(app).get(`/api/v1/clients/${deletedId}/match`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(404);
  });
});

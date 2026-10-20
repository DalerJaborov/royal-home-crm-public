import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Ночная проверка 24.09.2026, №153: показ с несуществующим или удалённым
 * объектом падал 500 (внешний ключ / откат транзакции на счётчике просмотров).
 * Теперь — 404 «Объект не найден», и запись показа не остаётся.
 */

const runId = Date.now();
const password = "testpass123";
let agentId: string;
let token: string;
let clientId: string;
let propertyId: string;
let trashedPropertyId: string;
let districtId: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Район показа без объекта ${runId}` } })).id;
  agentId = (
    await prisma.agent.create({ data: { fullName: "Агент показа без объекта", phone: `+992911${runId}`, role: "AGENT", passwordHash } })
  ).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: `+992911${runId}`, password });
  token = login.body.accessToken as string;
  clientId = (
    await prisma.client.create({
      data: { fullName: `Клиент показа без объекта ${runId}`, phone: `+992912${runId}`, source: "WHATSAPP", assignedAgentId: agentId, acceptedAt: new Date() },
    })
  ).id;
  const base = { type: "APARTMENT", areaSqm: 50, price: 40000, currency: "TJS", districtId, address: "Тестовая показа, 1", condition: "GOOD", status: "AVAILABLE", assignedAgentId: agentId } as const;
  propertyId = (await prisma.property.create({ data: { ...base, title: `Живой объект показа ${runId}` } })).id;
  trashedPropertyId = (await prisma.property.create({ data: { ...base, title: `Удалённый объект показа ${runId}`, deletedAt: new Date() } })).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, trashedPropertyId] } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

const post = (propertyIdValue: string) =>
  request(app)
    .post(`/api/v1/clients/${clientId}/interactions`)
    .set("Authorization", `Bearer ${token}`)
    .send({ type: "SHOWING", notes: "Показ", propertyId: propertyIdValue });

describe("показ с объектом, которого нет (№153)", () => {
  it("несуществующий объект — 404, а не 500, записи нет", async () => {
    const res = await post(randomUUID());
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Объект не найден/);
    expect(await prisma.interaction.count({ where: { clientId, type: "SHOWING" } })).toBe(0);
  });

  it("объект в корзине — 404, запись не создаётся", async () => {
    const res = await post(trashedPropertyId);
    expect(res.status).toBe(404);
    expect(await prisma.interaction.count({ where: { clientId, type: "SHOWING" } })).toBe(0);
  });

  it("живой объект — 201 и счётчик просмотров растёт", async () => {
    const res = await post(propertyId);
    expect(res.status).toBe(201);
    const p = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, select: { viewsCount: true } });
    expect(p.viewsCount).toBe(1);
  });
});

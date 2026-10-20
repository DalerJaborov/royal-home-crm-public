import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * GET /clients/:id/match — score и distanceM в ответе (17.09.2026,
 * docs/match-policy-plan-17-09.md, раздел 6, «Одна функция «Подбор»»).
 *
 * Панель подбора должна показывать «Совпало X%» и расстояние до желаемого места
 * прямо на карточке объекта, не выводя их на фронте по своей формуле — та же
 * шкала (scoreClientProperty), что на карточке объекта, и то же расстояние,
 * что уже используется для сортировки.
 */

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let token: string;
let districtId: string;
let clientId: string;
let propertyNearId: string;
let propertyNoCoordsId: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент счёта подбора ${runId}`, phone: `+992909${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  token = (
    await request(app).post("/api/v1/auth/login").send({ phone: `+992909${runId}`, password })
  ).body.accessToken;

  districtId = (await prisma.district.create({ data: { name: `Тест-мета-подбора-${runId}` } })).id;

  // Совпадает по координатам с желаемым местом клиента — distanceM должен быть
  // числом (0 или около), а не null.
  const propertyNear = await prisma.property.create({
    data: {
      title: `Объект рядом ${runId}`,
      type: "APARTMENT",
      areaSqm: 60,
      rooms: 3,
      price: 300_000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "AVAILABLE",
      lat: 38.5598,
      lng: 68.787,
    },
  });
  propertyNearId = propertyNear.id;

  // Тот же район (проходит фильтр и без координат — buildPropertyMatchWhere: район
  // ИЛИ радиус, не оба обязательны), но без точки — distanceM обязан быть null.
  const propertyNoCoords = await prisma.property.create({
    data: {
      title: `Объект без точки ${runId}`,
      type: "APARTMENT",
      areaSqm: 58,
      rooms: 3,
      price: 305_000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 2",
      condition: "GOOD",
      status: "AVAILABLE",
    },
  });
  propertyNoCoordsId = propertyNoCoords.id;

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент счёта подбора ${runId}`,
      phone: `+992910${runId}`,
      source: "WEBSITE",
      kind: "BUYER",
      status: "NEW",
      currency: "TJS",
      budgetMax: 350_000,
      desiredDistrictId: districtId,
      desiredRooms: 3,
      assignedAgentId: agentId,
      // Принятый лид: до принятия подбор агенту пуст (глубокая проверка 02.10.2026, П8).
      acceptedAt: new Date(),
      desiredPlaces: { create: [{ lat: 38.5598, lng: 68.787, radiusM: 1000, label: "Тестовый ориентир" }] },
    },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyNearId, propertyNoCoordsId] } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("GET /clients/:id/match — score и distanceM", () => {
  it("score в диапазоне 0..100, distanceM числом для объекта с координатами", async () => {
    const res = await request(app).get(`/api/v1/clients/${clientId}/match`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const near = res.body.properties.find((p: { id: string }) => p.id === propertyNearId);
    expect(near).toBeDefined();
    expect(typeof near.score).toBe("number");
    expect(near.score).toBeGreaterThanOrEqual(0);
    expect(near.score).toBeLessThanOrEqual(100);
    expect(typeof near.distanceM).toBe("number");
    expect(near.distanceM).toBeLessThan(50); // те же координаты, что у желаемого места
  });

  it("distanceM — null у объекта без координат", async () => {
    const res = await request(app).get(`/api/v1/clients/${clientId}/match`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const noCoords = res.body.properties.find((p: { id: string }) => p.id === propertyNoCoordsId);
    expect(noCoords).toBeDefined();
    expect(noCoords.distanceM).toBeNull();
    expect(typeof noCoords.score).toBe("number");
  });
});

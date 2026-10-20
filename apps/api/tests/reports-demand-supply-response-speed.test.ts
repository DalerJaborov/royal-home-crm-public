import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { DemandSupplyResponse, ResponseSpeedResponse } from "@royal-home/shared";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * GET /reports/demand-supply и /reports/response-speed (03.10.2026): настоящие
 * запросы к базе под чистой свёрткой — relation-фильтры groupBy, предфильтр
 * ждущих покупателей, потолки. Свёртка проверена отдельно на фикстурах
 * (demand-supply-fold / response-speed-fold), здесь — что запросы собираются,
 * отвечают нужной формой и видят свежие записи.
 */

const runId = Date.now();
const DAY = 86_400_000;
let managerId: string;
let managerToken: string;
let agentId: string;
let districtId: string;
const clientIds: string[] = [];
let propertyId: string;

beforeAll(async () => {
  const manager = await prisma.agent.create({
    data: { fullName: "Руководитель спроса", phone: `+992951${String(runId).slice(-8)}`, role: "MANAGER", passwordHash: "x" },
  });
  managerId = manager.id;
  managerToken = signAccessToken({ sub: manager.id, role: "MANAGER" });
  const agent = await prisma.agent.create({
    data: { fullName: "Агент спроса", phone: `+992952${String(runId).slice(-8)}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;

  districtId = (await prisma.district.create({ data: { name: `Тест-спрос-${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект спроса ${runId}`,
        type: "APARTMENT",
        rooms: 2,
        areaSqm: 60,
        price: 400000,
        currency: "TJS",
        districtId,
        condition: "GOOD",
        status: "AVAILABLE",
      },
    })
  ).id;

  // Три ждущих покупателя 2-комнатной в этом районе; созданы 10 дней назад, агент взялся через 30 минут;
  // один из них дошёл до показа.
  const created = new Date(Date.now() - 10 * DAY);
  for (let i = 0; i < 3; i++) {
    const c = await prisma.client.create({
      data: {
        fullName: `Покупатель спроса ${runId}-${i}`,
        phone: `+99295${i}${String(runId).slice(-7)}`,
        source: "WALK_IN",
        kind: "BUYER",
        desiredDistrictId: districtId,
        desiredRooms: 2,
        budgetMax: 500000,
        currency: "TJS",
        createdAt: created,
        firstContactAt: new Date(created.getTime() + 30 * 60_000),
        lastContactAt: new Date(),
      },
    });
    clientIds.push(c.id);
  }
  await prisma.interaction.create({
    data: { clientId: clientIds[0], agentId, type: "SHOWING", notes: `Показ спроса ${runId}`, propertyId },
  });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await deleteAgentsWithTraces([managerId, agentId]);
  await prisma.$disconnect();
});

describe("GET /reports/demand-supply", () => {
  it("видит свежие желания и объект: ячейка «район × 2 комнаты» собрана", async () => {
    const res = await request(app).get("/api/v1/reports/demand-supply").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const body = res.body as DemandSupplyResponse;
    expect(body.rooms).toEqual(["1", "2", "3", "4+"]);
    const cell = body.cells.find((c) => c.districtId === districtId && c.rooms === "2");
    expect(cell).toBeDefined();
    expect(cell!.demand).toBe(3);
    expect(cell!.supply).toBe(1);
    expect(cell!.ratio).toBe(3);
    expect(cell!.verdict).toBe("shortage");
    expect(cell!.demandMedianBudget).toBe(500000);
    expect(cell!.supplyMedianPrice).toBe(400000);
    // Список «никто не ищет» отдаётся с честным счётом; наш объект под спрос подходит и в него не входит.
    expect(body.unsought).not.toBeNull();
    expect(body.unsought!.items.some((p) => p.propertyId === propertyId)).toBe(false);
  });

  it("мусор в query — 400", async () => {
    const res = await request(app)
      .get("/api/v1/reports/demand-supply?unsoughtLimit=abc")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(400);
  });

  it("без входа — 401", async () => {
    const res = await request(app).get("/api/v1/reports/demand-supply");
    expect(res.status).toBe(401);
  });
});

describe("GET /reports/response-speed", () => {
  it("корзина 15–60 минут видит наших троих, один из них дошёл до показа", async () => {
    const res = await request(app).get("/api/v1/reports/response-speed").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const body = res.body as ResponseSpeedResponse;
    expect(body.days).toBe(90);
    expect(body.matureAfterDays).toBe(3);
    expect(body.buckets.map((b) => b.key)).toEqual(["lt1", "m1to5", "m5to15", "m15to60", "gt60", "none"]);
    const b = body.buckets.find((x) => x.key === "m15to60")!;
    // В общей базе могут быть и чужие обращения — отсюда «не меньше».
    expect(b.leads).toBeGreaterThanOrEqual(3);
    expect(b.reachedShowing).toBeGreaterThanOrEqual(1);
    expect(body.leads).toBeGreaterThanOrEqual(3);
  });

  it("days вне допустимого — 400", async () => {
    const res = await request(app)
      .get("/api/v1/reports/response-speed?days=1")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(400);
  });
});

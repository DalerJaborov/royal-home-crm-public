import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * GET /ai/insights → staleProperties по роли (docs/TASKS.md, «дашборд агента
 * против ТЗ» 07.09.2026).
 *
 * Шесть из семи категорий подсказок панели (likelyDeals, forgottenClients,
 * overdueTasks, staleSellers, stuckDeals, hotWithoutDeal) уже скоупились лично
 * агенту через `ownAgentId` (scopeToOwnAgent, по праву clients.viewAll).
 * «Объект простаивает» до этой правки считался по ВСЕМУ агентству для всех
 * ролей — рядовой агент видел в своей персональной панели чужой объект, на
 * который повлиять не может. Признак личной ответственности за объект —
 * `intakeAgentId` (тот, кто принял его у собственника), тот же, что у
 * переключателя «Мои объекты» в каталоге.
 */

const runId = Date.now();
const password = "testpass123";
const veryOld = new Date("1990-01-01T00:00:00Z");

let districtId = "";
let directorId = "";
let agentAId = "";
let agentBId = "";
let propertyAId = "";
let propertyBId = "";
let tokenAgentA = "";
let tokenDirector = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);

  districtId = (await prisma.district.create({ data: { name: `Тест-простой-${runId}` } })).id;

  const director = await prisma.agent.create({
    data: { fullName: `Простой Дир ${runId}`, phone: `+992960${String(runId).slice(-7)}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;

  const agentA = await prisma.agent.create({
    data: { fullName: `Простой Агент А ${runId}`, phone: `+992961${String(runId).slice(-7)}`, role: "AGENT", passwordHash },
  });
  agentAId = agentA.id;

  const agentB = await prisma.agent.create({
    data: { fullName: `Простой Агент Б ${runId}`, phone: `+992962${String(runId).slice(-7)}`, role: "AGENT", passwordHash },
  });
  agentBId = agentB.id;

  const propertyBase = {
    title: `Простаивает ${runId}`,
    type: "APARTMENT" as const,
    areaSqm: 50,
    windowCount: 3,
    price: 300000,
    currency: "TJS" as const,
    districtId,
    address: `Тестовая простой, ${runId}`,
    condition: "GOOD" as const,
    status: "AVAILABLE" as const,
    // Явно старше порога 21 день (routes/ai.ts, computeStalePropertyInsights) —
    // и заведомо старше любых других данных в базе, чтобы попасть в топ-3.
    createdAt: veryOld,
  };

  const propertyA = await prisma.property.create({
    data: { ...propertyBase, address: `Тестовая простой А, ${runId}`, intakeAgentId: agentAId },
  });
  propertyAId = propertyA.id;

  const propertyB = await prisma.property.create({
    data: { ...propertyBase, address: `Тестовая простой Б, ${runId}`, intakeAgentId: agentBId },
  });
  propertyBId = propertyB.id;

  const loginA = await request(app).post("/api/v1/auth/login").send({ phone: agentA.phone, password });
  expect(loginA.status).toBe(200);
  tokenAgentA = loginA.body.accessToken as string;

  const loginDirector = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(loginDirector.status).toBe(200);
  tokenDirector = loginDirector.body.accessToken as string;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: [propertyAId, propertyBId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentAId, agentBId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("GET /ai/insights → staleProperties по роли", () => {
  it("агенту — только его объект, чужой простаивающий объект не виден", async () => {
    const res = await request(app).get("/api/v1/ai/insights").set("Authorization", `Bearer ${tokenAgentA}`);
    expect(res.status).toBe(200);

    const ids = (res.body.staleProperties as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(propertyAId);
    expect(ids).not.toContain(propertyBId);
  });

  it("руководству — всё агентство, оба простаивающих объекта видны", async () => {
    const res = await request(app).get("/api/v1/ai/insights").set("Authorization", `Bearer ${tokenDirector}`);
    expect(res.status).toBe(200);

    const ids = (res.body.staleProperties as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(propertyAId);
    expect(ids).toContain(propertyBId);
  });
});

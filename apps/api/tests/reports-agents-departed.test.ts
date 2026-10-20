import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * Отчёт «по агентам» сходится с воронкой на той же странице (глубокая проверка
 * 02.10.2026, C17). Отчёт брал только работающих: сделки уволенного в периоде
 * агента пропадали из строк, и сумма «Сделок» по агентам была меньше итога
 * воронки. Теперь в отчёт за период попадает и тот, у кого есть сделки
 * периода, с пометкой «не работает».
 */

const runId = Date.now();
const sfx = String(runId).slice(-7);
let directorId = "";
let goneId = "";
let token = "";
let districtId = "";
let propertyId = "";
let clientId = "";
let dealId = "";

beforeAll(async () => {
  directorId = (await prisma.agent.create({ data: { fullName: "Директор отчёт", phone: `+992934${sfx}`, role: "DIRECTOR", passwordHash: "x" } })).id;
  goneId = (
    await prisma.agent.create({ data: { fullName: `Уволенный ${runId}`, phone: `+992933${sfx}`, role: "AGENT", passwordHash: "x", isActive: false } })
  ).id;
  token = signAccessToken({ sub: directorId, role: "DIRECTOR" });
  districtId = (await prisma.district.create({ data: { name: `Район отчёт ${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: { title: `Объект отчёт ${runId}`, type: "APARTMENT", areaSqm: 40, price: 1000, currency: "TJS", districtId, address: "Тестовая", condition: "GOOD", status: "SOLD" },
    })
  ).id;
  clientId = (await prisma.client.create({ data: { fullName: `Клиент отчёт ${runId}`, phone: `+992932${sfx}`, source: "PHONE_CALL" } })).id;
  dealId = (
    await prisma.deal.create({
      data: { clientId, propertyId, agentId: goneId, stage: "COMPLETED", closedAt: new Date(), commissionAmount: 100, currency: "TJS" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, goneId] } } });
});

describe("C17: отчёт по агентам и уволенный агент", () => {
  it("сделка уволенного в периоде агента есть в отчёте, с пометкой", async () => {
    const res = await request(app).get("/api/v1/reports/agents").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const row = (res.body as { agentId: string; agentName: string; dealsClosed: number }[]).find((r) => r.agentId === goneId);
    expect(row).toBeDefined();
    expect(row!.dealsClosed).toBe(1);
    expect(row!.agentName).toContain("не работает");
  });
});

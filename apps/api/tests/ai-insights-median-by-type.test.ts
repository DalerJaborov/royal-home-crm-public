import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * «ОБЪЕКТ ПРОСТАИВАЕТ: ДОРОЖЕ РЫНКА НА N%» — СРАВНЕНИЕ С ОБЪЕКТАМИ ТОГО ЖЕ ТИПА
 * (находка О9 проверки 02.10.2026).
 *
 * Медиана цены за м² по району считалась по всем типам вместе: участки и
 * коммерция (совсем другая цена за метр) сдвигали медиану квартир, и квартира
 * по рыночной цене показывалась агенту «дороже рынка на сотни процентов».
 */

const runId = Date.now();
const tail = String(runId).slice(-7);
const password = "testpass123";
const veryOld = new Date("1990-01-01T00:00:00Z");
let districtId = "";
let agentId = "";
let token = "";
let staleId = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Медиана-тип-${runId}` } })).id;
  const agent = await prisma.agent.create({
    data: { fullName: `Медиана Агент ${runId}`, phone: `+992963${tail}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const base = { districtId, condition: "GOOD" as const, status: "AVAILABLE" as const, currency: "TJS" as const, address: "Медианная, 1" };
  // Квартиры: 6000 с/м². Участки: 100 с/м² — их больше, и общая медиана уезжает к ним.
  const stale = await prisma.property.create({
    data: { ...base, title: `Квартира простоя ${runId}`, type: "APARTMENT", areaSqm: 50, price: 300000, intakeAgentId: agentId, createdAt: veryOld },
  });
  staleId = stale.id;
  for (let i = 0; i < 2; i++) {
    await prisma.property.create({ data: { ...base, title: `Квартира ${runId}-${i}`, type: "APARTMENT", areaSqm: 60, price: 360000 } });
  }
  for (let i = 0; i < 5; i++) {
    await prisma.property.create({ data: { ...base, title: `Участок ${runId}-${i}`, type: "LAND", areaSqm: 1000, price: 100000 } });
  }
  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { districtId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("GET /ai/insights → staleProperties, медиана района", () => {
  it("квартира сравнивается с квартирами района, а не с участками", async () => {
    const res = await request(app).get("/api/v1/ai/insights").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const row = (res.body.staleProperties as { id: string; medianPricePerSqmInDistrict: number | null; diffPercent: number | null }[]).find(
      (p) => p.id === staleId
    );
    expect(row).toBeDefined();
    expect(row!.medianPricePerSqmInDistrict).toBe(6000);
    expect(row!.diffPercent).toBe(0);
  });
});

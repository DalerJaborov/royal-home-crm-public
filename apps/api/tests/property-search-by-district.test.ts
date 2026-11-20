import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * GET /properties?q=<район> — строка поиска находит объект по имени района (пачка D1,
 * 20.11.2026: «найти объект по району и цене в 2–3 нажатия»). Название объекта район
 * обычно содержит, но не всегда: здесь его нет ни в названии, ни в адресе, ни в
 * описании, и найтись объект может только по району. Цена сужает ту же выдачу.
 */
const runId = Date.now();
const password = "testpass123";
const districtWord = `Ромашкабад${String(runId).slice(-6)}`;
let districtId: string;
let agentPhone = "";
const propertyIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: districtWord } })).id;
  agentPhone = `+992953${String(runId).slice(-7)}`;
  await prisma.agent.create({ data: { fullName: `Поиск Район ${runId}`, phone: agentPhone, role: "AGENT", passwordHash } });
  for (const price of [300000, 900000]) {
    const p = await prisma.property.create({
      data: {
        title: `Квартира без района в названии ${runId}-${price}`, type: "APARTMENT", areaSqm: 60, price, currency: "TJS",
        districtId, address: "ул. Тестовая, 1", condition: "GOOD", status: "AVAILABLE",
      },
    });
    propertyIds.push(p.id);
  }
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { phone: agentPhone } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("GET /properties?q=<район>", () => {
  it("находит объект по имени района и сужает выдачу ценой", async () => {
    const login = await request(app).post("/api/v1/auth/login").send({ phone: agentPhone, password });
    expect(login.status).toBe(200);
    const token = login.body.accessToken ?? login.body.token;

    const all = await request(app).get(`/api/v1/properties?q=${encodeURIComponent(districtWord.toLowerCase())}&pageSize=50`).set("Authorization", `Bearer ${token}`);
    expect(all.status).toBe(200);
    const ids = (all.body.items as { id: string }[]).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(propertyIds));

    const cheap = await request(app).get(`/api/v1/properties?q=${encodeURIComponent(districtWord)}&priceMax=500000&pageSize=50`).set("Authorization", `Bearer ${token}`);
    expect(cheap.status).toBe(200);
    const cheapIds = (cheap.body.items as { id: string }[]).map((p) => p.id);
    expect(cheapIds).toContain(propertyIds[0]);
    expect(cheapIds).not.toContain(propertyIds[1]);
  });
});

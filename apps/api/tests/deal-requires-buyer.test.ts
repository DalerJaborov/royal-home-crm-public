import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ТРЕБОВАНИЕ 10 (аудит 02.09.2026): сделку можно закрыть только при наличии
 * объекта И покупателя. Живой прогон A2 показал, что POST /deals принимает
 * клиента kind=SELLER и создаёт сделку — объект уходит в RESERVED, продавец
 * получает DEAL_CLOSED и бонусы. Защита была только в UI (PropertyDetail.tsx
 * фильтрует список клиентов по BUYER), прямой вызов API её обходил.
 *
 * Фикс: проверка client.kind === "BUYER" в routes/deals.ts перед резервом
 * объекта. Этот тест фиксирует требование, чтобы проверка не потерялась.
 */

const runId = Date.now();
const password = "testpass123";

let districtId = "";
let agentId = "";
let sellerId = "";
let buyerId = "";
let propertyId = "";
let token = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Сделка-покупатель-${runId}` } })).id;
  const agent = await prisma.agent.create({
    data: { fullName: `Агент Покупателя ${runId}`, phone: `+992955${String(runId).slice(-7)}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;

  // Продавец — клиент, по которому сделка должна быть запрещена
  const seller = await prisma.client.create({
    data: {
      fullName: `Продавец ${runId}`,
      phone: `+992956${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      kind: "SELLER",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  sellerId = seller.id;

  // Покупатель — клиент, по которому сделка разрешена
  const buyer = await prisma.client.create({
    data: {
      fullName: `Покупатель ${runId}`,
      phone: `+992957${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  buyerId = buyer.id;

  const property = await prisma.property.create({
    data: {
      title: `Объект для сделки ${runId}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 100000,
      currency: "USD",
      districtId,
      address: `Тест ${runId}`,
      condition: "GOOD",
      status: "AVAILABLE",
    },
  });
  propertyId = property.id;

  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  token = login.body.accessToken;
});

afterAll(async () => {
  // Сделки, если были созданы
  await prisma.deal.deleteMany({ where: { OR: [{ clientId: sellerId }, { clientId: buyerId }] } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: { in: [sellerId, buyerId] } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("POST /deals требует покупателя (требование 10)", () => {
  it("отклоняет создание сделки по продавцу — 409", async () => {
    const res = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: sellerId, propertyId });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/покупатель/i);

    // Убедиться, что сделка НЕ создана
    const deals = await prisma.deal.findMany({ where: { clientId: sellerId } });
    expect(deals).toHaveLength(0);

    // Объект не должен быть зарезервирован
    const prop = await prisma.property.findUnique({ where: { id: propertyId } });
    expect(prop?.status).toBe("AVAILABLE");
  });

  it("разрешает создание сделки по покупателю — 201", async () => {
    const res = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: buyerId, propertyId });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.stage).toBe("NEGOTIATION");

    // Объект зарезервирован
    const prop = await prisma.property.findUnique({ where: { id: propertyId } });
    expect(prop?.status).toBe("RESERVED");
  });
});
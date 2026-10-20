import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * СДЕЛКУ ПО УДАЛЁННОМУ КЛИЕНТУ НЕЛЬЗЯ ЗАКРЫТЬ (27.08.2026, сплошная охота).
 *
 * Мягкое удаление клиента разрешено, когда все его сделки CANCELLED
 * (routes/clients/card.ts) — то есть у карточки в Корзине почти всегда лежит
 * отменённая сделка. Возврата с CANCELLED на рабочую стадию явного запрета не
 * было: POST /deals проверял deletedAt клиента (комментарий там же объясняет
 * почему — «прямой вызов API»), а PATCH /deals/:id — нет. Прямой вызов API мог
 * довести отменённую сделку удалённого клиента до COMPLETED: снапшот долей
 * комиссии, +10 Royal Score, объект уходит на сайт как проданный — а директор
 * не может открыть карточку клиента, чтобы сверить, что произошло: CRM отвечает
 * на неё 404.
 */

const runId = Date.now();
const password = "testpass123";

let districtId = "";
let directorId = "";
let agentId = "";
let clientId = "";
let propertyId = "";
let token = "";
let dealId = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Корзина-сделка-${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: `Дир Корзины ${runId}`, phone: `+992944${String(runId).slice(-7)}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  const agent = await prisma.agent.create({
    data: { fullName: `Агент Корзины ${runId}`, phone: `+992945${String(runId).slice(-7)}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент Корзины ${runId}`,
      phone: `+992946${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
  const property = await prisma.property.create({
    data: {
      title: `Объект Корзины ${runId}`,
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

  const deal = await prisma.deal.create({
    data: { clientId, propertyId, agentId, stage: "CANCELLED", startedAt: new Date() },
  });
  dealId = deal.id;

  // Ровно то условие, при котором удаление клиента разрешено: единственная
  // сделка уже CANCELLED.
  await prisma.client.update({ where: { id: clientId }, data: { deletedAt: new Date() } });

  const login = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  token = login.body.accessToken;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("PATCH /deals/:id блокирует переход стадии по клиенту в Корзине", () => {
  it("вернуть CANCELLED в рабочую стадию — 409, стадия не меняется", async () => {
    const res = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "NEGOTIATION" });
    expect(res.status).toBe(409);

    const fresh = await prisma.deal.findUnique({ where: { id: dealId } });
    expect(fresh?.stage).toBe("CANCELLED");
  });

  it("довести до COMPLETED напрямую — тоже 409", async () => {
    const res = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        stage: "COMPLETED",
        soldPrice: 95000,
        commissionRealtorAmount: 500,
        commissionCompanyAmount: 0,
      });
    expect(res.status).toBe(409);

    const fresh = await prisma.deal.findUnique({ where: { id: dealId } });
    expect(fresh?.stage).toBe("CANCELLED");
  });

  it("правки, не меняющие стадию (например заметка), по-прежнему проходят", async () => {
    const res = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ notes: "Сверка после удаления клиента" });
    expect(res.status).not.toBe(409);
  });
});

describe("GET /deals не показывает активную доску по клиенту в Корзине", () => {
  it("активная (не CANCELLED/COMPLETED) сделка удалённого клиента не в списке", async () => {
    // Возвращаем сделку в рабочую стадию МИМО HTTP (проверка живёт на уровне
    // роута, а нам нужно состояние гонки: клиент уже в Корзине, сделка ещё активна).
    await prisma.deal.update({ where: { id: dealId }, data: { stage: "NEGOTIATION" } });

    const res = await request(app).get("/api/v1/deals").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body).includes(dealId)).toBe(false);

    await prisma.deal.update({ where: { id: dealId }, data: { stage: "CANCELLED" } });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * «Закрыть сделку» доступна только после проведённого показа (спецификация,
 * «Путь покупателя»). Сделку МОЖНО завести раньше показа (переговоры по
 * фото/видео) — блокируется только ЗАВЕРШЕНИЕ (stage → COMPLETED).
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let directorId: string;
let agentId: string;
let token: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function makeClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент показа-сделки ${runId}-${clientIds.length}`,
      phone: `+992947${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeProperty() {
  const p = await prisma.property.create({
    data: {
      title: `Объект показа-сделки ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, показ-сделка",
      condition: "GOOD",
      intakeAgentId: agentId,
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-показ-сделка-${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: "Директор показ-сделки", phone: `+992948${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент показ-сделки", phone: `+992949${runId}`, role: "AGENT", passwordHash },
    })
  ).id;

  const res = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(res.status).toBe(200);
  grantElevation(directorId);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Создание сделки — показ не требуется", () => {
  it("сделку можно завести до показа (переговоры по фото)", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty()]);
    const res = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    expect(res.status).toBe(201);
    dealIds.push(res.body.id);
  });

  it("но сразу закрытой (stage=COMPLETED) завести нельзя вовсе", async () => {
    // Ужесточено 26.08.2026: раньше запрет был только «без показа» (409), но POST
    // в принципе не выполняет денежных эффектов закрытия (closedAt, снапшот долей,
    // SOLD, DEAL_CLOSED, баллы) — сделка-призрак не попадала ни в один отчёт.
    // Терминальные стадии на создании отвергаются целиком, закрытие — только PATCH.
    const [client, property] = await Promise.all([makeClient(), makeProperty()]);
    const res = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId, stage: "COMPLETED" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/закрыт|отменённой/);
    const property2 = await prisma.property.findUnique({ where: { id: property.id } });
    expect(property2?.status).not.toBe("SOLD");
  });
});

describe("Завершение сделки требует проведённый показ", () => {
  it("без показа — 409, объект остаётся зарезервированным, а не проданным", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty()]);
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);

    const res = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "PENDING_APPROVAL" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/показ/);

    const deal = await prisma.deal.findUnique({ where: { id: created.body.id } });
    expect(deal?.stage).toBe("NEGOTIATION");
    const propertyAfter = await prisma.property.findUnique({ where: { id: property.id } });
    expect(propertyAfter?.status).toBe("RESERVED");
  });

  it("показ, назначенный на будущее, не считается — до него ещё не дожили", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty()]);
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        propertyId: property.id,
        agentId,
        type: "SHOWING",
        notes: "Показ назначен",
        // Время обязательно: именно им «назначенный» отличается от «записанного
        // задним числом» (nextActionDate пуст — так пишут уже состоявшийся показ).
        // Без него запись подходит под второй случай, и проверка её засчитает.
        nextActionDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      },
    });
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);

    const res = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "PENDING_APPROVAL" });
    expect(res.status).toBe(409);
  });

  it("проведённый показ (completedAt заполнен) — сделка закрывается", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty()]);
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        propertyId: property.id,
        agentId,
        type: "SHOWING",
        notes: "Показ проведён",
        completedAt: new Date(),
      },
    });
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);

    // Завершение теперь двухшаговое: сначала агент отправляет сделку на закрытие
    // с фактической ценой и комиссией суммой, потом руководитель одобряет.
    const submitted = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        stage: "PENDING_APPROVAL",
        soldPrice: 95000,
        commissionRealtorAmount: 500,
        commissionCompanyAmount: 1200,
      });
    expect(submitted.status).toBe(200);

    const res = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "COMPLETED" });
    expect(res.status).toBe(200);
    const property2 = await prisma.property.findUnique({ where: { id: property.id } });
    expect(property2?.status).toBe("SOLD");
  });

  /**
   * ТУПИК НА ПОСЛЕДНЕМ ШАГЕ, исправленный 14.08.2026.
   *
   * Кнопку «Завершить сделку» открывает hadConductedShowing: показ, до времени
   * которого дожили, там считается проведённым (по тому же признаку CRM спрашивает
   * «Итог показа»). А закрытие сделки требовало собственного, более узкого условия —
   * только `completedAt`. Агент видел открытую кнопку, проходил весь путь и упирался
   * в 409. Определение теперь одно на всю CRM: lib/conductedShowing.ts.
   */
  it("показ, время которого прошло, засчитывается — даже если галочку не поставили", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty()]);
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        propertyId: property.id,
        agentId,
        type: "SHOWING",
        notes: "Показ состоялся, отметить забыли",
        nextActionDate: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);

    const res = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        stage: "PENDING_APPROVAL",
        soldPrice: 95000,
        commissionRealtorAmount: 500,
        commissionCompanyAmount: 1200,
      });
    expect(res.status).toBe(200);
  });

  it("ОТМЕНЁННЫЙ показ не засчитывается, даже если его время прошло", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty()]);
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        propertyId: property.id,
        agentId,
        type: "SHOWING",
        notes: "Клиент отменил",
        nextActionDate: new Date(Date.now() - 2 * 60 * 60 * 1000),
        declinedAt: new Date(),
      },
    });
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);

    const res = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "PENDING_APPROVAL" });
    expect(res.status).toBe(409);
  });

  it("показ по ДРУГОМУ объекту того же клиента не засчитывается", async () => {
    const client = await makeClient();
    const [shownProperty, dealProperty] = await Promise.all([makeProperty(), makeProperty()]);
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        propertyId: shownProperty.id,
        agentId,
        type: "SHOWING",
        notes: "Показ другого объекта",
        completedAt: new Date(),
      },
    });
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: dealProperty.id, agentId });
    dealIds.push(created.body.id);

    const res = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "PENDING_APPROVAL" });
    expect(res.status).toBe(409);
  });
});

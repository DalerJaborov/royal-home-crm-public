import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Фактическая цена продажи при завершении сделки (19.08.2026, просьба владельца).
 *
 * Цена объявления и то, за что реально продали, почти всегда расходятся — торг,
 * скидка. Раньше при завершении сделки Property.soldPrice тихо копировал цену
 * объявления, и «Продано за X» в CRM никогда не совпадало с деньгами, которые
 * реально прошли по сделке. Поле необязательное — если его не передать,
 * поведение прежнее (цена объявления), чтобы не блокировать закрытие сделки
 * там, где торга не было.
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
      fullName: `Клиент цены-продажи ${runId}-${clientIds.length}`,
      phone: `+992951${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeProperty(price: number) {
  const p = await prisma.property.create({
    data: {
      title: `Объект цены-продажи ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 55,
      price,
      currency: "TJS",
      districtId,
      address: "Тестовая, цена продажи",
      condition: "GOOD",
      intakeAgentId: agentId,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function makeShowing(clientId: string, propertyId: string) {
  await prisma.interaction.create({
    data: { clientId, propertyId, agentId, type: "SHOWING", notes: "Показ проведён", completedAt: new Date() },
  });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-цена-продажи-${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: "Директор цена-продажи", phone: `+992952${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент цена-продажи", phone: `+992953${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Фактическая цена продажи (19.08.2026: через PENDING_APPROVAL)", () => {
  it("указана soldPrice при отправке на закрытие — записывается она, а не цена объявления", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty(150000)]);
    await makeShowing(client.id, property.id);
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);

    const submitted = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        stage: "PENDING_APPROVAL",
        soldPrice: 138000,
        commissionRealtorAmount: 500,
        commissionCompanyAmount: 1500,
      });
    expect(submitted.status).toBe(200);
    // Ещё не одобрено — объект не должен становиться проданным заранее.
    const propertyMid = await prisma.property.findUnique({ where: { id: property.id } });
    expect(propertyMid?.status).not.toBe("SOLD");

    const res = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "COMPLETED" });
    expect(res.status).toBe(200);

    const propertyAfter = await prisma.property.findUnique({ where: { id: property.id } });
    expect(propertyAfter?.status).toBe("SOLD");
    expect(Number(propertyAfter?.soldPrice)).toBe(138000);
    // Цена объявления сама не меняется — только фактическая цена продажи.
    expect(Number(propertyAfter?.price)).toBe(150000);
    // Комиссия — просто сумма двух частей (риелтор + компания), введённых агентом,
    // без пересчёта по проценту. Доля интейкера (0,5%) отменена 11.09.2026 — третьего
    // слагаемого больше нет, и сумма равна ровно тому, что агент видел на экране.
    const dealAfter = await prisma.deal.findUnique({ where: { id: created.body.id } });
    expect(Number(dealAfter?.commissionAmount)).toBe(2000);
  });

  it("нельзя отправить на закрытие без цены и комиссии", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty(90000)]);
    await makeShowing(client.id, property.id);
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);

    const res = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "PENDING_APPROVAL" });
    expect(res.status).toBe(400);

    const propertyAfter = await prisma.property.findUnique({ where: { id: property.id } });
    expect(propertyAfter?.status).not.toBe("SOLD");
  });

  it("нельзя завершить сделку в обход отправки на закрытие без цены и комиссии — даже директору", async () => {
    // Директор МОЖЕТ закрыть сделку одним действием, минуя PENDING_APPROVAL
    // (19.08.2026, просьба владельца) — но не пустыми полями: цена и комиссия
    // суммой обязательны что при отправке на согласование, что при прямом закрытии.
    const [client, property] = await Promise.all([makeClient(), makeProperty(90000)]);
    await makeShowing(client.id, property.id);
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);

    const res = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "COMPLETED" });
    expect(res.status).toBe(400);
  });

  it("директор закрывает сделку сам одним действием, минуя PENDING_APPROVAL", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty(120000)]);
    await makeShowing(client.id, property.id);
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);

    const res = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        stage: "COMPLETED",
        soldPrice: 115000,
        commissionRealtorAmount: 600,
        commissionCompanyAmount: 1000,
      });
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe("COMPLETED");

    const propertyAfter = await prisma.property.findUnique({ where: { id: property.id } });
    expect(propertyAfter?.status).toBe("SOLD");
    expect(Number(propertyAfter?.soldPrice)).toBe(115000);
    expect(Number(res.body.commissionAmount)).toBe(1600);
  });

  it("комиссия больше цены продажи — отказ и при отправке на закрытие, и при прямом завершении директором (найдено аудитом 18.09.2026)", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty(90000)]);
    await makeShowing(client.id, property.id);
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);

    const submitted = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "PENDING_APPROVAL", soldPrice: 1000, commissionRealtorAmount: 5000, commissionCompanyAmount: 5000 });
    expect(submitted.status).toBe(400);

    const direct = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "COMPLETED", soldPrice: 1000, commissionRealtorAmount: 5000, commissionCompanyAmount: 5000 });
    expect(direct.status).toBe(400);

    const propertyAfter = await prisma.property.findUnique({ where: { id: property.id } });
    expect(propertyAfter?.status).not.toBe("SOLD");
  });
});

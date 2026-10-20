import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * КАРТОЧКА ОТКРЫВАЕТСЯ И ПО НАСТОЯЩЕМУ id (23.09.2026, аудит №12).
 *
 * Пуши «Клиент просит звонок», «Соединяю с клиентом», «Похоже на дубликат»,
 * «Новый ролик на монтаж» и ещё пять вели на /clients/<UUID> и
 * /properties/<UUID>, а карточки понимали только короткий номер — агент
 * нажимал на пуш и видел «Клиент не найден».
 */

const runId = Date.now();
const password = "testpass123";
let agentId: string;
let token: string;
let clientId: string;
let clientShortId: number;
let districtId: string;
let propertyId: string;
let propertyShortId: number;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Агент ссылки ${runId}`, phone: `+992914${String(runId).slice(-6)}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;

  const phone = `+992915${String(runId).slice(-6)}`;
  await prisma.client.deleteMany({ where: { phone } });
  const client = await prisma.client.create({
    data: { fullName: `Клиент ссылки ${runId}`, phone, source: "PHONE_CALL", assignedAgentId: agentId, acceptedAt: new Date() },
  });
  clientId = client.id;
  clientShortId = client.shortId;

  districtId = (await prisma.district.create({ data: { name: `Тест-район-ссылки-${runId}` } })).id;
  const property = await prisma.property.create({
    data: {
      title: `Объект ссылки ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: `Тестовая, ссылки ${runId}`,
      condition: "GOOD",
      assignedAgentId: agentId,
    },
  });
  propertyId = property.id;
  propertyShortId = property.shortId;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("Карточка по ссылке с настоящим id", () => {
  it("клиент открывается и по короткому номеру, и по id", async () => {
    const byShort = await request(app).get(`/api/v1/clients/${clientShortId}`).set("Authorization", `Bearer ${token}`);
    expect(byShort.status).toBe(200);
    const byId = await request(app).get(`/api/v1/clients/${clientId}`).set("Authorization", `Bearer ${token}`);
    expect(byId.status).toBe(200);
    expect(byId.body.id).toBe(clientId);
    expect(byId.body.shortId).toBe(clientShortId);
  });

  it("объект открывается и по короткому номеру, и по id", async () => {
    const byShort = await request(app).get(`/api/v1/properties/${propertyShortId}`).set("Authorization", `Bearer ${token}`);
    expect(byShort.status).toBe(200);
    const byId = await request(app).get(`/api/v1/properties/${propertyId}`).set("Authorization", `Bearer ${token}`);
    expect(byId.status).toBe(200);
    expect(byId.body.id).toBe(propertyId);
  });

  it("мусор в адресе — по-прежнему «не найден»", async () => {
    const res = await request(app).get(`/api/v1/clients/not-a-card`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

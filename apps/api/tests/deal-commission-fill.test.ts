import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Комиссия сделки: процент и сумма заполняются оба, чем бы ни задали.
 *
 * Разбор 09.08.2026: сумма вычислялась ТОЛЬКО когда пусты оба поля. Руководитель
 * указывал один процент — commissionAmount оставался null, и при закрытии сделки
 * доли интейкера, риелтора и компании считались от нуля: в карточке процент
 * правильный, а денег никто не получал.
 */

const runId = Date.now();
const password = "testpass123";

let districtId = "";
let directorId = "";
let agentId = "";
let clientId = "";
let token = "";
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function makeProperty(price: number) {
  const p = await prisma.property.create({
    data: {
      title: `Комиссия ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 60,
      price,
      currency: "USD",
      districtId,
      address: `Тест ${runId}`,
      condition: "GOOD",
      status: "AVAILABLE",
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Комиссия-${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: `Комиссия Дир ${runId}`, phone: `+992931${String(runId).slice(-7)}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  const agent = await prisma.agent.create({
    data: { fullName: `Комиссия Агент ${runId}`, phone: `+992932${String(runId).slice(-7)}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const client = await prisma.client.create({
    data: {
      fullName: `Комиссия Клиент ${runId}`,
      phone: `+992933${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

async function createDeal(propertyId: string, body: Record<string, unknown>) {
  const res = await request(app)
    .post("/api/v1/deals")
    .set("Authorization", `Bearer ${token}`)
    .send({ clientId, propertyId, agentId, stage: "NEGOTIATION", ...body });
  if (res.body?.id) dealIds.push(res.body.id);
  return res;
}

describe("Комиссия сделки заполняется целиком", () => {
  it("задан только процент — сумма считается от цены объекта", async () => {
    const property = await makeProperty(100000);
    const res = await createDeal(property.id, { commissionPercent: 3 });
    expect(res.status).toBe(201);

    const deal = await prisma.deal.findUnique({ where: { id: res.body.id } });
    expect(Number(deal?.commissionPercent)).toBe(3);
    // Главное: сумма не null. Именно от неё считаются доли при закрытии сделки.
    expect(deal?.commissionAmount).not.toBeNull();
    expect(Number(deal?.commissionAmount)).toBe(3000);
  });

  it("задана только сумма — процент восстанавливается", async () => {
    const property = await makeProperty(200000);
    const res = await createDeal(property.id, { commissionAmount: 5000 });
    expect(res.status).toBe(201);

    const deal = await prisma.deal.findUnique({ where: { id: res.body.id } });
    expect(Number(deal?.commissionAmount)).toBe(5000);
    expect(deal?.commissionPercent).not.toBeNull();
    expect(Number(deal?.commissionPercent)).toBeCloseTo(2.5, 5);
  });

  it("не задано ничего — обе величины берутся из Настроек", async () => {
    const property = await makeProperty(150000);
    const res = await createDeal(property.id, {});
    expect(res.status).toBe(201);

    const deal = await prisma.deal.findUnique({ where: { id: res.body.id } });
    expect(deal?.commissionPercent).not.toBeNull();
    expect(deal?.commissionAmount).not.toBeNull();
    expect(Number(deal?.commissionAmount)).toBeGreaterThan(0);
  });
});

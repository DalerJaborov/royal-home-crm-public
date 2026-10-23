import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { toCents } from "../src/lib/money.js";

/**
 * ПЕРЕОЦЕНКА ЗАКРЫТОЙ СДЕЛКИ ПИШЕТ В БАЗУ ВЫЧИСЛЕННУЮ СУММУ/ПРОЦЕНТ (аудит Codex 04.10.2026, №6).
 *
 * PATCH закрытой сделки с одним процентом (или одной суммой) достраивал вторую
 * величину уже ПОСЛЕ того, как dealFields скопирован из data: пересчитанная сумма
 * шла в доли снапшота и в аудит DEAL_REPRICE_CLOSED, а в колонку не попадала,
 * в базе оставалась старая. Зеркально для суммы без процента.
 */

const runId = Date.now();
const password = "testpass123";
const PRICE = 400025;

let districtId: string;
let directorId: string;
let realtorId: string;
let intakeId: string;
let token: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-reprice-${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: "Директор reprice", phone: `+992936${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  realtorId = (
    await prisma.agent.create({ data: { fullName: "Риелтор reprice", phone: `+992935${runId}`, role: "AGENT", passwordHash } })
  ).id;
  intakeId = (
    await prisma.agent.create({ data: { fullName: "Приёмщик reprice", phone: `+992934${runId}`, role: "AGENT", passwordHash } })
  ).id;

  const res = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(res.status).toBe(200);
  grantElevation(director.id);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, realtorId, intakeId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

/** Закрывает сделку тем же путём, что и живая CRM: агент вводит две суммы. */
async function closeWith(sums: { realtor: number; company: number }) {
  const property = await prisma.property.create({
    data: {
      title: `Объект reprice ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: PRICE,
      currency: "TJS",
      districtId,
      address: "Тестовая, 2",
      condition: "GOOD",
      intakeAgentId: intakeId,
    },
  });
  propertyIds.push(property.id);
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент reprice ${runId}-${clientIds.length}`,
      phone: `+99293${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: realtorId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(client.id);
  await prisma.interaction.create({
    data: {
      clientId: client.id,
      agentId: realtorId,
      propertyId: property.id,
      type: "SHOWING",
      notes: "Показ",
      completedAt: new Date(),
    },
  });

  const created = await request(app)
    .post("/api/v1/deals")
    .set("Authorization", `Bearer ${token}`)
    .send({ clientId: client.id, propertyId: property.id, agentId: realtorId });
  expect(created.status).toBe(201);
  dealIds.push(created.body.id);

  const submitted = await request(app)
    .patch(`/api/v1/deals/${created.body.id}`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      stage: "PENDING_APPROVAL",
      soldPrice: PRICE,
      commissionRealtorAmount: sums.realtor,
      commissionCompanyAmount: sums.company,
    });
  expect(submitted.status).toBe(200);

  const closed = await request(app)
    .patch(`/api/v1/deals/${created.body.id}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ stage: "COMPLETED" });
  expect(closed.status).toBe(200);

  const deal = await prisma.deal.findUnique({ where: { id: created.body.id } });
  return {
    id: deal!.id,
    total: Number(deal!.commissionAmount),
    intake: Number(deal!.commissionIntakeAmount),
    realtor: Number(deal!.commissionRealtorAmount),
    company: Number(deal!.commissionCompanyAmount),
  };
}

describe("Переоценка закрытой сделки: вторая величина доходит до базы", () => {
  it("считает сумму процента от новой цены продажи из того же запроса", async () => {
    const d = await closeWith({ realtor: 2000.12, company: 4000.25 });
    const res = await request(app).patch(`/api/v1/deals/${d.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ soldPrice: 200000, commissionPercent: 3 });
    expect(res.status).toBe(200);
    const after = await prisma.deal.findUniqueOrThrow({ where: { id: d.id } });
    expect(Number(after.soldPrice)).toBe(200000);
    expect(Number(after.commissionAmount)).toBe(6000);
    expect(toCents(after.commissionIntakeAmount) + toCents(after.commissionRealtorAmount) + toCents(after.commissionCompanyAmount)).toBe(600000);
  });

  it("считает процент суммы от новой цены продажи из того же запроса", async () => {
    const d = await closeWith({ realtor: 2000.12, company: 4000.25 });
    const res = await request(app).patch(`/api/v1/deals/${d.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ soldPrice: 200000, commissionAmount: 6000 });
    expect(res.status).toBe(200);
    const after = await prisma.deal.findUniqueOrThrow({ where: { id: d.id } });
    expect(Number(after.soldPrice)).toBe(200000);
    expect(Number(after.commissionPercent)).toBe(3);
  });

  it("пришёл только процент: commissionAmount в базе = цена × процент, доли сходятся с ним", async () => {
    const d = await closeWith({ realtor: 2000.12, company: 4000.25 });
    const res = await request(app)
      .patch(`/api/v1/deals/${d.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ commissionPercent: 3 });
    expect(res.status).toBe(200);

    const after = await prisma.deal.findUnique({ where: { id: d.id } });
    // 400025 × 3 % = 12000.75 ровно
    expect(Number(after!.commissionAmount)).toBe(12000.75);
    expect(Number(after!.commissionPercent)).toBe(3);
    const shares =
      toCents(after!.commissionIntakeAmount) +
      toCents(after!.commissionRealtorAmount) +
      toCents(after!.commissionCompanyAmount);
    expect(shares).toBe(toCents(after!.commissionAmount));
  });

  it("пришла только сумма: commissionPercent в базе = сумма / цена × 100", async () => {
    const d = await closeWith({ realtor: 2000.12, company: 4000.25 });
    const res = await request(app)
      .patch(`/api/v1/deals/${d.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ commissionAmount: 12000.75 });
    expect(res.status).toBe(200);

    const after = await prisma.deal.findUnique({ where: { id: d.id } });
    expect(Number(after!.commissionAmount)).toBe(12000.75);
    // тот же процент, что в соседних ветках: до четырёх знаков, без двоичного хвоста
    expect(Number(after!.commissionPercent)).toBe(3);
  });
});

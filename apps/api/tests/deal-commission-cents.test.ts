import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { toCents } from "../src/lib/money.js";

/**
 * КОМИССИЯ СЧИТАЕТСЯ ДО КОПЕЙКИ (03.09.2026).
 *
 * Три места, где раньше терялись деньги:
 *   1) сложение введённых долей плавающей точкой — 2000.13 + 4000.25
 *      давало нецелый хвост, и «комиссия всего» расходилась с долями;
 *   2) суммы с долями копейки уходили в базу как есть (колонка DECIMAL(65,30) —
 *      Postgres не округляет ничего), и в выгрузке бухгалтеру всплывал хвост;
 *   3) переоценка закрытой сделки округляла доли до целых СОМОНИ, а разницу
 *      молча забирала компания.
 *
 * 0,5% «за приём объекта» отменены 11.09.2026 — агент вводит только две суммы
 * (риелтор/компания), commissionIntakeAmount у новых сделок всегда 0.
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
  districtId = (await prisma.district.create({ data: { name: `Тест-район-копейки-${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: "Директор копеек", phone: `+992936${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  realtorId = (
    await prisma.agent.create({ data: { fullName: "Риелтор копеек", phone: `+992935${runId}`, role: "AGENT", passwordHash } })
  ).id;
  intakeId = (
    await prisma.agent.create({ data: { fullName: "Приёмщик копеек", phone: `+992934${runId}`, role: "AGENT", passwordHash } })
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
      title: `Объект копеек ${runId}-${propertyIds.length}`,
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
      fullName: `Клиент копеек ${runId}-${clientIds.length}`,
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

describe("Комиссия с копейками", () => {
  it("сумма двух долей с копейками равна комиссии сделки ровно, доля интейка всегда 0", async () => {
    // 2000.12 + 4000.25: в двоичной арифметике сумма таких долей может дать хвост.
    const d = await closeWith({ realtor: 2000.12, company: 4000.25 });
    expect(d.total).toBe(6000.37);
    expect(d.intake).toBe(0);
    expect(toCents(d.realtor) + toCents(d.company)).toBe(toCents(d.total));
  });

  it("доли копейки не попадают в базу: сумма округляется на границе схемы", async () => {
    // Форма прислала «1000.456» — в колонке DECIMAL(65,30) это осталось бы как есть.
    const d = await closeWith({ realtor: 1000.456, company: 2000 });
    expect(d.realtor).toBe(1000.46);
    expect(d.total).toBe(3000.46);
    expect(d.intake).toBe(0);
    expect(toCents(d.realtor) + toCents(d.company)).toBe(toCents(d.total));
  });

  it("переоценка закрытой сделки сохраняет пропорции и снова сходится до копейки, доля интейка остаётся 0", async () => {
    const d = await closeWith({ realtor: 2000.12, company: 4000.25 });

    const repriced = await request(app)
      .patch(`/api/v1/deals/${d.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ commissionAmount: 7333.33 });
    expect(repriced.status).toBe(200);

    const after = await prisma.deal.findUnique({ where: { id: d.id } });
    const intake = toCents(after!.commissionIntakeAmount);
    const realtor = toCents(after!.commissionRealtorAmount);
    const company = toCents(after!.commissionCompanyAmount);
    // Главное: доли по-прежнему складываются в комиссию, копейка в копейку.
    expect(intake + realtor + company).toBe(toCents(7333.33));
    expect(intake).toBe(0);
    // И пропорции старого снапшота сохранены — не пересчитано заново по процентам.
    expect(company / (realtor + company)).toBeCloseTo(toCents(d.company) / toCents(d.total), 3);
    // Доля риелтора не округлена до целых сомони — именно так терялись деньги агентов.
    expect(Number.isInteger(realtor / 100)).toBe(false);
  });
});

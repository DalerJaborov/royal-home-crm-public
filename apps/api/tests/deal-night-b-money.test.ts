import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { dushanbeWallClock, DUSHANBE_OFFSET_MS } from "../src/lib/dushanbeTime.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * Ночная проверка 24.09.2026, добивка 01.10 — круг «Сделки, деньги»:
 * №212 (обнуление долей закрытой сделки), №214 (уход из PENDING_APPROVAL назад),
 * №215 (комиссия не больше цены по ИТОГОВЫМ значениям), №219 (одна цена продажи
 * для Property и Deal).
 */

const runId = Date.now();
const password = "testpass123";
const sfx = String(runId).slice(-7);

let districtId: string;
let directorId: string;
let agentId: string;
let directorToken: string;
let agentToken: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

/** Закрытие в прошлом месяце по Душанбе — тогда строка зарплаты уже «заведена». */
function lastMonthClose(): { closedAt: Date; month: string } {
  const wall = dushanbeWallClock();
  const prev = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - 1, 15, 12, 0));
  return {
    closedAt: new Date(prev.getTime() - DUSHANBE_OFFSET_MS),
    month: `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`,
  };
}

async function makeDeal(opts: {
  stage: "PENDING_APPROVAL" | "COMPLETED";
  soldPrice: number;
  realtor: number;
  company: number;
  commissionAmount?: number;
  closedAt?: Date;
}) {
  const idx = clientIds.length;
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент №Б ${runId}-${idx}`,
      phone: `+9929${idx}${sfx}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(client.id);
  const property = await prisma.property.create({
    data: {
      title: `Объект №Б ${runId}-${idx}`,
      type: "APARTMENT",
      areaSqm: 55,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, №Б",
      condition: "GOOD",
      status: opts.stage === "COMPLETED" ? "SOLD" : "RESERVED",
      createdById: agentId,
    },
  });
  propertyIds.push(property.id);
  const deal = await prisma.deal.create({
    data: {
      clientId: client.id,
      propertyId: property.id,
      agentId,
      stage: opts.stage,
      currency: "TJS",
      soldPrice: opts.soldPrice,
      commissionRealtorAmount: opts.realtor,
      commissionCompanyAmount: opts.company,
      commissionAmount: opts.commissionAmount ?? opts.realtor + opts.company,
      closedAt: opts.closedAt ?? null,
    },
  });
  dealIds.push(deal.id);
  return { dealId: deal.id, propertyId: property.id };
}

const patch = (id: string, token: string, body: object) =>
  request(app).patch(`/api/v1/deals/${id}`).set("Authorization", `Bearer ${token}`).send(body);

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-№Б-${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: "Директор №Б", phone: `+992971${sfx}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  const agent = await prisma.agent.create({
    data: { fullName: "Агент №Б", phone: `+992972${sfx}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const [d, a] = await Promise.all([
    request(app).post("/api/v1/auth/login").send({ phone: director.phone, password }),
    request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password }),
  ]);
  directorToken = d.body.accessToken as string;
  agentToken = a.body.accessToken as string;
});

afterAll(async () => {
  await prisma.expense.deleteMany({ where: { agentId } });
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("№212 обнуление долей закрытой сделки доходит до комиссии и зарплатной строки", () => {
  it("commissionAmount обнуляется, авто-строка зарплаты — тоже, ручная не трогается", async () => {
    const { closedAt, month } = lastMonthClose();
    const { dealId } = await makeDeal({ stage: "COMPLETED", soldPrice: 100000, realtor: 500, company: 1000, closedAt });
    // Авто-строка за месяц закрытия уже заведена ночным тиком.
    const autoKey = `salary:${agentId}:${month}`;
    await prisma.expense.create({
      data: { autoKey, autoFingerprint: "TJS:500", month: new Date(`${month}-01T00:00:00.000Z`), amount: 500, currency: "TJS", category: "SALARY", agentId, note: "авто" },
    });

    const res = await patch(dealId, directorToken, { commissionRealtorAmount: 0, commissionCompanyAmount: 0 });
    expect(res.status).toBe(200);

    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    expect(Number(deal.commissionAmount)).toBe(0);
    expect(Number(deal.commissionRealtorAmount)).toBe(0);

    const row = await waitFor(
      () => prisma.expense.findUnique({ where: { autoKey } }),
      (r) => r !== null && Number(r.amount) === 0,
    );
    expect(Number(row!.amount)).toBe(0);
  });

  it("ручная строка зарплаты (manualEditedAt) при обнулении остаётся как есть", async () => {
    const { closedAt, month } = lastMonthClose();
    const { dealId } = await makeDeal({ stage: "COMPLETED", soldPrice: 100000, realtor: 500, company: 1000, closedAt });
    const autoKey = `salary:${agentId}:${month}`;
    await prisma.expense.upsert({
      where: { autoKey },
      update: { amount: 777, manualEditedAt: new Date(), autoFingerprint: "TJS:500" },
      create: { autoKey, autoFingerprint: "TJS:500", month: new Date(`${month}-01T00:00:00.000Z`), amount: 777, currency: "TJS", category: "SALARY", agentId, manualEditedAt: new Date() },
    });
    const res = await patch(dealId, directorToken, { commissionRealtorAmount: 0, commissionCompanyAmount: 0 });
    expect(res.status).toBe(200);
    const row = await prisma.expense.findUniqueOrThrow({ where: { autoKey } });
    expect(Number(row.amount)).toBe(777);
    await prisma.expense.deleteMany({ where: { autoKey } });
  });
});

describe("№214 любой уход из PENDING_APPROVAL назад — решение руководителя", () => {
  it("агент не может вернуть сделку на переговоры", async () => {
    const { dealId } = await makeDeal({ stage: "PENDING_APPROVAL", soldPrice: 95000, realtor: 500, company: 1000 });
    const res = await patch(dealId, agentToken, { stage: "NEGOTIATION" });
    expect(res.status).toBe(403);
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    expect(deal.stage).toBe("PENDING_APPROVAL");
  });

  it("руководитель без причины — 400, с причиной — 200 и суммы обнулены", async () => {
    const { dealId } = await makeDeal({ stage: "PENDING_APPROVAL", soldPrice: 95000, realtor: 500, company: 1000 });
    const noReason = await patch(dealId, directorToken, { stage: "AGREEMENT_PENDING" });
    expect(noReason.status).toBe(400);
    const ok = await patch(dealId, directorToken, { stage: "AGREEMENT_PENDING", rejectReason: "Поправьте цифры" });
    expect(ok.status).toBe(200);
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    expect(deal.stage).toBe("AGREEMENT_PENDING");
    expect(deal.soldPrice).toBeNull();
    expect(deal.commissionRealtorAmount).toBeNull();
    expect(deal.commissionCompanyAmount).toBeNull();
    expect(deal.commissionAmount).toBeNull();
  });
});

describe("№215 комиссия не больше цены — по итоговым значениям", () => {
  it("директор правит долю на сделке в PENDING_APPROVAL так, что комиссия > цены — 400", async () => {
    const { dealId } = await makeDeal({ stage: "PENDING_APPROVAL", soldPrice: 95000, realtor: 500, company: 1000 });
    const res = await patch(dealId, directorToken, { commissionRealtorAmount: 99000 });
    expect(res.status).toBe(400);
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    expect(Number(deal.commissionRealtorAmount)).toBe(500);
  });

  it("директор снижает цену ниже уже введённой комиссии — 400", async () => {
    const { dealId } = await makeDeal({ stage: "PENDING_APPROVAL", soldPrice: 95000, realtor: 500, company: 1000 });
    const res = await patch(dealId, directorToken, { soldPrice: 1000 });
    expect(res.status).toBe(400);
  });

  it("«Одобрить» сделку, у которой сохранённая комиссия больше цены — 400, сделка не закрыта", async () => {
    const { dealId, propertyId } = await makeDeal({ stage: "PENDING_APPROVAL", soldPrice: 1000, realtor: 800, company: 800 });
    const res = await patch(dealId, directorToken, { stage: "COMPLETED" });
    expect(res.status).toBe(400);
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    expect(deal.stage).toBe("PENDING_APPROVAL");
    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.status).toBe("RESERVED");
  });

  it("исправление ОБЕИХ величин одним запросом проходит (проверка по итогам, а не по телу)", async () => {
    const { dealId } = await makeDeal({ stage: "PENDING_APPROVAL", soldPrice: 1000, realtor: 800, company: 800 });
    const res = await patch(dealId, directorToken, { soldPrice: 50000 });
    expect(res.status).toBe(200);
  });
});

describe("№219 одна цена продажи для объекта и сделки", () => {
  it("«Одобрить» с новой ценой в теле: Property.soldPrice == Deal.soldPrice == новая", async () => {
    const { dealId, propertyId } = await makeDeal({ stage: "PENDING_APPROVAL", soldPrice: 90000, realtor: 500, company: 1000 });
    const res = await patch(dealId, directorToken, { stage: "COMPLETED", soldPrice: 95000 });
    expect(res.status).toBe(200);
    const [deal, property] = await Promise.all([
      prisma.deal.findUniqueOrThrow({ where: { id: dealId } }),
      prisma.property.findUniqueOrThrow({ where: { id: propertyId } }),
    ]);
    expect(Number(deal.soldPrice)).toBe(95000);
    expect(Number(property.soldPrice)).toBe(95000);
  });
});

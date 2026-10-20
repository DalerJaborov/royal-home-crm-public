import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * Выгрузка бухгалтерии берёт цену продажи СДЕЛКИ (глубокая проверка 02.10.2026,
 * C13). Директор правит цену закрытой сделки — пишется только Deal.soldPrice, а
 * выгрузка брала Property.soldPrice: на экране новая цена, в файле старая.
 */

const runId = Date.now();
const password = "testpass123";
let directorId = "";
let token = "";
let districtId = "";
let propertyId = "";
let clientId = "";
let dealId = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const director = await prisma.agent.create({
    data: { fullName: "Директор выгрузка", phone: `+992936${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  grantElevation(directorId);
  token = res.body.accessToken as string;
  districtId = (await prisma.district.create({ data: { name: `Район выгрузка ${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект выгрузка ${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 90000,
        soldPrice: 100000,
        currency: "TJS",
        districtId,
        address: "Тестовая, выгрузка",
        condition: "GOOD",
        status: "SOLD",
      },
    })
  ).id;
  clientId = (
    await prisma.client.create({ data: { fullName: `Клиент выгрузка ${runId}`, phone: `+992935${runId}`, source: "PHONE_CALL" } })
  ).id;
  dealId = (
    await prisma.deal.create({
      data: {
        clientId,
        propertyId,
        agentId: directorId,
        stage: "COMPLETED",
        closedAt: new Date(),
        soldPrice: 123456,
        commissionAmount: 2000,
        commissionRealtorAmount: 1000,
        commissionCompanyAmount: 1000,
        currency: "TJS",
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
});

describe("C13: цена продажи в выгрузке бухгалтерии", () => {
  it("берётся из сделки, а не с карточки объекта", async () => {
    const res = await request(app).get("/api/v1/expenses/export?months=1").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const line = res.text.split("\n").find((l) => l.includes(`Объект выгрузка ${runId}`));
    expect(line).toBeDefined();
    expect(line).toContain('"123456.00"');
    expect(line).not.toContain('"100000.00"');
  });
});

/**
 * Сумма повторяющегося платежа — до копейки (глубокая проверка 02.10.2026, C14).
 * Схема шаблона пропускала 100.456 как есть, и доли копейки уходили в авто-строку
 * расхода каждый месяц — мимо общего правила «деньги на входе не точнее копейки».
 */
describe("C14: сумма повторяющегося платежа", () => {
  it("округляется до копейки; меньше копейки — отказ", async () => {
    const res = await request(app)
      .post("/api/v1/expenses/recurring")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: `Аренда ${runId}`, amount: 100.456, dayOfMonth: 5 });
    expect(res.status).toBe(201);
    const row = await prisma.recurringExpense.findUnique({ where: { id: res.body.id } });
    expect(Number(row?.amount)).toBe(100.46);
    await prisma.recurringExpense.delete({ where: { id: res.body.id } });

    const tiny = await request(app)
      .post("/api/v1/expenses/recurring")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: `Копейка ${runId}`, amount: 0.004, dayOfMonth: 5 });
    expect(tiny.status).toBe(400);
  });
});

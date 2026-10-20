import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { upsertSalaryExpenses } from "../src/lib/financeAutomation.js";
import { DUSHANBE_OFFSET_MS, dushanbeWallClock } from "../src/lib/dushanbeTime.js";

/**
 * Правка долей закрытой сделки доходит до зарплатной строки её месяца
 * (глубокая проверка 02.10.2026, C12). Раньше строка пересчитывалась только
 * при обнулении (аннулировании), а ночной тик смотрит лишь прошлый месяц:
 * правка доли у июльской сделки в октябре оставляла «Зарплату июля» старой
 * навсегда — «Выплаты» 700, «Зарплата» 500.
 */

const runId = Date.now();
const password = "testpass123";
const wall = dushanbeWallClock();
const old = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - 3, 1));
const oldMonth = `${old.getUTCFullYear()}-${String(old.getUTCMonth() + 1).padStart(2, "0")}`;
const closedAt = new Date(Date.UTC(old.getUTCFullYear(), old.getUTCMonth(), 10, 12) - DUSHANBE_OFFSET_MS);

let directorId = "";
let agentId = "";
let token = "";
let districtId = "";
let propertyId = "";
let clientId = "";
let dealId = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const director = await prisma.agent.create({
    data: { fullName: "Директор доли", phone: `+992939${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  agentId = (
    await prisma.agent.create({ data: { fullName: "Агент доли", phone: `+992938${runId}`, role: "AGENT", passwordHash } })
  ).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  grantElevation(directorId);
  token = res.body.accessToken as string;
  districtId = (await prisma.district.create({ data: { name: `Район доли ${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект доли ${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 100000,
        currency: "TJS",
        districtId,
        address: "Тестовая, доли",
        condition: "GOOD",
        status: "SOLD",
      },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: { fullName: `Клиент доли ${runId}`, phone: `+992937${runId}`, source: "PHONE_CALL", assignedAgentId: agentId },
    })
  ).id;
  dealId = (
    await prisma.deal.create({
      data: {
        clientId,
        propertyId,
        agentId,
        stage: "COMPLETED",
        closedAt,
        soldPrice: 100000,
        commissionAmount: 1500,
        commissionRealtorAmount: 500,
        commissionCompanyAmount: 1000,
        currency: "TJS",
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.expense.deleteMany({ where: { autoKey: `salary:${agentId}:${oldMonth}` } });
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
});

describe("C12: доля риелтора закрытой сделки поправлена через три месяца", () => {
  it("зарплатная строка месяца закрытия догоняет новую долю", async () => {
    await upsertSalaryExpenses(oldMonth);
    const before = await prisma.expense.findUnique({ where: { autoKey: `salary:${agentId}:${oldMonth}` } });
    expect(Number(before?.amount)).toBe(500);

    const res = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ commissionRealtorAmount: 700, commissionCompanyAmount: 800 });
    expect(res.status).toBe(200);

    const after = await prisma.expense.findUnique({ where: { autoKey: `salary:${agentId}:${oldMonth}` } });
    expect(Number(after?.amount)).toBe(700);
  });
});

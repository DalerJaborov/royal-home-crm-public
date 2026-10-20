import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { buildExpenseForecast, upsertSalaryExpenses } from "../src/lib/financeAutomation.js";
import { buildFinancePulse } from "../src/lib/financePulse.js";
import { DUSHANBE_OFFSET_MS, dushanbeWallClock } from "../src/lib/dushanbeTime.js";

/**
 * Доля риелтора вычитается из прибыли ОДИН раз (глубокая проверка 02.10.2026, C2).
 *
 * Доход компании в «Финансах» и «Пульсе» — уже без доли риелтора. Ночной крон
 * 1-го числа заводит строку «Зарплата» на каждого агента — это ТЕ ЖЕ доли.
 * Раньше прибыль = доход компании − все расходы, включая эти строки: доля
 * агента вычиталась дважды, сентябрьская прибыль 1-го октября проваливалась в
 * ноль, а пульт писал «Заработали сегодня −1 000».
 *
 * БД общая на все файлы — сравниваем ДЕЛЬТЫ до/после своих фикстур.
 */

const runId = Date.now();
const password = "testpass123";
const wall = dushanbeWallClock();
const prev = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - 1, 1));
const prevMonth = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
const closedAt = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), 15, 12) - DUSHANBE_OFFSET_MS);

let adminId = "";
let agentId = "";
let districtId = "";
let clientId = "";
let propertyId = "";
let dealId = "";
let token = "";

async function prevMonthProfit(): Promise<{ profit: number; companyRevenue: number }> {
  const res = await request(app).get("/api/v1/expenses/summary?months=2").set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  const row = (res.body.months as { month: string; profit: number; companyRevenue: number }[]).find((m) => m.month === prevMonth);
  if (!row) throw new Error(`нет месяца ${prevMonth} в сводке`);
  return { profit: row.profit, companyRevenue: row.companyRevenue };
}

async function pulse() {
  const buckets = await buildFinancePulse();
  const month = buckets.find((b) => b.period === "month")!;
  const today = buckets.find((b) => b.period === "today")!;
  return { prevMonthBalance: month.previousBalanceTjs, todayBalance: today.balanceTjs };
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: `Прибыль директор ${runId}`, phone: `+992931${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Прибыль риелтор ${runId}`, phone: `+992932${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  districtId = (await prisma.district.create({ data: { name: `Прибыль-район-${runId}` } })).id;
  clientId = (
    await prisma.client.create({
      data: { fullName: `Прибыль клиент ${runId}`, phone: `+992933${runId}`, source: "WALK_IN", assignedAgentId: agentId },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Прибыль объект ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 100000,
        currency: "TJS",
        districtId,
        address: "Тестовая прибыльная, 1",
        condition: "GOOD",
        status: "SOLD",
        createdById: agentId,
      },
    })
  ).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  expect(res.status).toBe(200);
  grantElevation(adminId);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.expense.deleteMany({ where: { autoKey: `salary:${agentId}:${prevMonth}` } });
  if (dealId) await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, agentId] } } });
});

describe("C2: доля риелтора не вычитается из прибыли дважды", () => {
  it("строка «Зарплата из сделок» не съедает прибыль, уже очищенную от доли агента", async () => {
    const before = await prevMonthProfit();
    const pulseBefore = await pulse();

    dealId = (
      await prisma.deal.create({
        data: {
          clientId,
          propertyId,
          agentId,
          stage: "COMPLETED",
          closedAt,
          currency: "TJS",
          commissionAmount: 2000,
          commissionRealtorAmount: 1000,
          commissionCompanyAmount: 1000,
        },
      })
    ).id;

    const withDeal = await prevMonthProfit();
    expect(withDeal.companyRevenue - before.companyRevenue).toBeCloseTo(1000, 2);
    expect(withDeal.profit - before.profit).toBeCloseTo(1000, 2);

    const forecastBefore = await buildExpenseForecast();
    // Ночной тик 1-го числа: строка «Зарплата» = доля риелтора 1 000.
    await upsertSalaryExpenses(prevMonth);
    // Прогноз перерасхода сравнивает траты, а не доли агентов: в текущем месяце
    // такой строки нет никогда, значит и в среднем прошлых её быть не должно.
    expect((await buildExpenseForecast()).averageTjs).toBe(forecastBefore.averageTjs);
    const row = await prisma.expense.findUnique({ where: { autoKey: `salary:${agentId}:${prevMonth}` } });
    expect(Number(row?.amount)).toBe(1000);

    const after = await prevMonthProfit();
    // Компания оставила себе 1 000 — и после зарплатной строки тоже.
    expect(after.profit - before.profit).toBeCloseTo(1000, 2);

    const pulseAfter = await pulse();
    // «Пульс» за прошлый месяц — та же прибыль, что в «Финансах».
    expect(pulseAfter.prevMonthBalance - pulseBefore.prevMonthBalance).toBeCloseTo(1000, 2);
    // «Заработали сегодня» на пульте не уходит в минус от заведённой зарплаты.
    expect(pulseAfter.todayBalance - pulseBefore.todayBalance).toBeCloseTo(0, 2);
  });
});

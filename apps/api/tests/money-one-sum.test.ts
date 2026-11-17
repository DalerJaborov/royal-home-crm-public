import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { buildExpenseSummary, filteredExpenses } from "../src/lib/expenseQueries.js";
import { buildFinancePulse } from "../src/lib/financePulse.js";
import { liveMonthlyMoney } from "../src/lib/monthlyReport.js";
import { loadMoneyContext, expenseCentsToTjs, fromCents } from "../src/lib/money.js";
import { dushanbeDateString, dushanbeMonthRange } from "../src/lib/dushanbeTime.js";
import { upsertAiExpenses } from "../src/lib/ads/adExpenseSync.js";
import { fullMonthKeysWithin } from "../src/lib/expenseAccounting.js";

/**
 * ОДНА СУММА НА ВСЕХ ЭКРАНАХ (аудит денег 17.11.2026). Один и тот же месяц расходов в «Финансах»
 * (и PDF, и у Шабнам — buildExpenseSummary), в месячном отчёте, в списке «за период» (через него
 * же инструмент Шабнам list_expenses) должен давать одно число. Месяц 2003-го — свой, без чужих строк.
 */

const stamp = String(Date.now()).slice(-7);
const M = "2003-05";
const monthDate = new Date(`${M}-01T00:00:00.000Z`);
let directorId: string;
let token: string;
let reportId: string;
let adId: string;

beforeAll(async () => {
  directorId = (await prisma.agent.create({ data: { fullName: "Директор сверки", phone: `+992986${stamp}`, role: "DIRECTOR", passwordHash: "x" } })).id;
  token = signAccessToken({ sub: directorId, role: "DIRECTOR" });
  await prisma.expense.deleteMany({ where: { month: monthDate } });
  // Ручной расход с днём оплаты, автострока рекламы и оценка ИИ без дня — как октябрь на проде.
  await prisma.expense.createMany({ data: [
    { category: "OFFICE", amount: 7822, currency: "TJS", month: monthDate, paymentDate: new Date(`${M}-11T00:00:00.000Z`), note: "Аренда", exchangeRate: 1 },
    { category: "ADVERTISING", source: "INSTAGRAM", amount: 905.92, currency: "USD", month: monthDate, autoKey: `ads:META:${M}`, note: "авто" },
    { category: "OTHER", amount: 44.98, currency: "USD", month: monthDate, autoKey: `ai:${M}`, note: "авто" },
  ] });
  // Снимок отчёта, собранный «до» поздних расходов: 8 786,32 с., как на проде.
  const periodStart = dushanbeMonthRange(M).from;
  await prisma.monthlyReport.deleteMany({ where: { periodStart } });
  reportId = (await prisma.monthlyReport.create({ data: { periodStart, metrics: {
    publicInteractionScopeVersion: 1, funnel: [], commission: 0, dealsCompleted: 0, expenses: 8786.32, agents: [], sources: [], propertiesAdded: 0, propertiesSold: 0, districtDemand: [],
  } } })).id;
});

afterAll(async () => {
  await prisma.expense.deleteMany({ where: { month: monthDate } });
  await prisma.monthlyReport.deleteMany({ where: { id: reportId } });
  if (adId) await prisma.ad.deleteMany({ where: { id: adId } });
  await prisma.expense.deleteMany({ where: { autoKey: `ads:META:test-pulse-${stamp}` } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
});

describe("одна сумма расходов месяца", () => {
  it("«Финансы» = список «с 1-го по последнее» (он же у Шабнам) = месячный отчёт", async () => {
    const money = await loadMoneyContext();
    const expected = fromCents((await prisma.expense.findMany({ where: { month: monthDate, deletedAt: null } })).reduce((s, e) => s + expenseCentsToTjs(e, money), 0));

    const finance = (await buildExpenseSummary({ months: 1, through: M })).months.find((m) => m.month === M)!;
    expect(finance.totalExpenses).toBe(expected);

    const period = await filteredExpenses({ from: `${M}-01`, to: `${M}-31` });
    expect(fromCents(period.reduce((s, e) => s + expenseCentsToTjs(e, money), 0))).toBe(expected);

    const live = await liveMonthlyMoney(M);
    expect(live?.expenses).toBe(expected);

    const res = await request(app).get("/api/v1/reports/monthly").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const report = (res.body as { id: string; metrics: { expenses: number; expensesAtClose: number } }[]).find((r) => r.id === reportId)!;
    expect(report.metrics.expenses).toBe(expected);
    expect(report.metrics.expensesAtClose).toBe(8786.32);
  });

  it("часть месяца не берёт месячные автостроки целиком; весь месяц — берёт", async () => {
    expect(fullMonthKeysWithin(`${M}-05`, `${M}-20`)).toBeNull();
    expect(fullMonthKeysWithin(`${M}-01`, `${M}-31`)).toEqual({ gte: monthDate, lte: monthDate });
    const part = await filteredExpenses({ from: `${M}-05`, to: `${M}-20` });
    expect(part.map((e) => e.note)).toEqual(["Аренда"]);
  });
});

describe("«Пульс» за неделю — реклама по дням, не вся строка месяца", () => {
  it("строка рекламы месяца не падает целиком на день заведения; дневной расход кабинета — падает", async () => {
    const money = await loadMoneyContext();
    const before = await buildFinancePulse();
    adId = (await prisma.ad.create({ data: { externalId: `test-pulse-${stamp}`, name: "Тест пульса" } })).id;
    await prisma.adSpendDaily.create({ data: { adId, date: new Date(`${dushanbeDateString()}T00:00:00.000Z`), spend: 10, currency: "USD" } });
    const thisMonth = new Date(`${dushanbeDateString().slice(0, 7)}-01T00:00:00.000Z`);
    await prisma.expense.create({ data: { category: "ADVERTISING", source: "INSTAGRAM", amount: 300, currency: "USD", month: thisMonth, autoKey: `ads:META:test-pulse-${stamp}`, note: "авто" } });
    const after = await buildFinancePulse();
    const week = (b: typeof before) => b.find((x) => x.period === "week")!;
    const month = (b: typeof before) => b.find((x) => x.period === "month")!;
    expect(Math.round((week(after).expenseTjs - week(before).expenseTjs) * 100) / 100).toBe(fromCents(Math.round(1000 * money.usdToTjs)));
    expect(Math.round((month(after).expenseTjs - month(before).expenseTjs) * 100) / 100).toBe(fromCents(Math.round(30000 * money.usdToTjs)));
    expect(Number.isInteger(Math.round(week(after).balanceTjs * 100))).toBe(true);
  });
});

describe("оценка ИИ — месяц по Душанбе", () => {
  it("обращение в 23:30 последнего дня по Душанбе — в этом месяце, не в следующем", async () => {
    const M2 = "2003-06";
    await prisma.expense.deleteMany({ where: { autoKey: { in: [`ai:${M2}`, "ai:2003-07"] } } });
    const late = new Date(dushanbeMonthRange(M2).to.getTime() - 30 * 60_000);
    const log = await prisma.aiLog.create({ data: { endpoint: `test-one-sum-${stamp}`, model: "gemini-3.5-flash", costUsd: 1.5, ms: 1, ok: true, createdAt: late } });
    try {
      await upsertAiExpenses([M2, "2003-07"]);
      expect(Number((await prisma.expense.findUnique({ where: { autoKey: `ai:${M2}` } }))?.amount)).toBe(1.5);
      expect(await prisma.expense.findUnique({ where: { autoKey: "ai:2003-07" } })).toBeNull();
    } finally {
      await prisma.aiLog.delete({ where: { id: log.id } });
      await prisma.expense.deleteMany({ where: { autoKey: { in: [`ai:${M2}`, "ai:2003-07"] } } });
    }
  });

  it("ручная правка строки ИИ не перезаписывается, сумма пишется ровно двумя знаками", async () => {
    const M3 = "2003-08";
    const at = new Date(dushanbeMonthRange(M3).from.getTime() + 86_400_000);
    const log = await prisma.aiLog.create({ data: { endpoint: `test-one-sum-${stamp}`, model: "gemini-3.5-flash", costUsd: 0.1 + 0.2, ms: 1, ok: true, createdAt: at } });
    try {
      await upsertAiExpenses([M3]);
      const row = (await prisma.expense.findUnique({ where: { autoKey: `ai:${M3}` } }))!;
      expect(row.amount.toString()).toBe("0.3");
      await prisma.expense.update({ where: { id: row.id }, data: { amount: 10, manualEditedAt: new Date() } });
      await upsertAiExpenses([M3]);
      expect(Number((await prisma.expense.findUnique({ where: { id: row.id } }))!.amount)).toBe(10);
    } finally {
      await prisma.aiLog.delete({ where: { id: log.id } });
      await prisma.expense.deleteMany({ where: { autoKey: `ai:${M3}` } });
    }
  });
});

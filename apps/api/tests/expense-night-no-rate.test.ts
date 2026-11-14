import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { processWorkspaceRecurringExpenses, todayExpenseDay } from "../src/lib/expenseWorkspace.js";
import { processRecurringExpenses } from "../src/lib/financeAutomation.js";
import { waitForCount } from "./helpers/waitFor.js";

/**
 * Ночь без курса доллара (повторное ревью 10.11.2026, п. 3): долларовая подписка с автооплатой не
 * обрывает остальные — аренда в сомони заводится и оплачивается, долларовая остаётся планом,
 * причина — в журнале ошибок. FALLBACK_USD_TO_TJS при записи не подставляется.
 */
const stamp = String(Date.now()).slice(-8);
const ids: string[] = [];
let previousRate: unknown = null;
const today = todayExpenseDay();

beforeAll(async () => {
  const s = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" }, select: { usdToTjsRate: true } });
  previousRate = s.usdToTjsRate;
  await prisma.settings.update({ where: { id: "singleton" }, data: { usdToTjsRate: null } });
});
afterAll(async () => {
  await prisma.expense.deleteMany({ where: { recurringId: { in: ids } } });
  await prisma.expense.deleteMany({ where: { autoKey: { in: ids.map((id) => `rec:${id}:${today.slice(0, 7)}`) } } });
  await prisma.recurringExpense.deleteMany({ where: { id: { in: ids } } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { usdToTjsRate: previousRate as number | null } });
});

describe("ночные повторяющиеся платежи без курса доллара", () => {
  it("новые шаблоны: доллар остаётся планом с записью в журнал, сомони оплачиваются — цикл не обрывается", async () => {
    const usd = await prisma.recurringExpense.create({ data: { title: `Хостинг ${stamp}`, amount: 22, currency: "USD", category: "OFFICE", dayOfMonth: Number(today.slice(8, 10)), startsOn: today, autoPay: true } });
    const tjs = await prisma.recurringExpense.create({ data: { title: `Аренда ${stamp}`, amount: 5000, currency: "TJS", category: "OFFICE", dayOfMonth: Number(today.slice(8, 10)), startsOn: today, autoPay: true } });
    ids.push(usd.id, tjs.id);
    await processWorkspaceRecurringExpenses();
    const usdRow = await prisma.expense.findFirstOrThrow({ where: { recurringId: usd.id } });
    const tjsRow = await prisma.expense.findFirstOrThrow({ where: { recurringId: tjs.id } });
    expect(usdRow.status).toBe("PLANNED");
    expect(usdRow.exchangeRate).toBeNull();
    expect(tjsRow.status).toBe("PAID");
    await waitForCount(() => prisma.errorLog.count({ where: { message: { contains: `Хостинг ${stamp}` } } }), 1);
  });

  it("старые шаблоны: автооплата доллара без курса — план, а не PAID без курса", async () => {
    const day = Number(today.slice(8, 10));
    const legacy = await prisma.recurringExpense.create({ data: { title: `Старый хостинг ${stamp}`, amount: 10, currency: "USD", category: "OFFICE", dayOfMonth: Math.min(day, 28), autoPay: true } });
    ids.push(legacy.id);
    await processRecurringExpenses();
    const row = await prisma.expense.findUnique({ where: { autoKey: `rec:${legacy.id}:${today.slice(0, 7)}` } });
    expect(row?.status).toBe("PLANNED");
    expect(row?.exchangeRate).toBeNull();
  });
});

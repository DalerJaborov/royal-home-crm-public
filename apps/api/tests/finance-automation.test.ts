import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// Доставка финансовых уведомлений теперь идёт через общую очередь алармов
// руководству (07.09.2026, часы алармов) — тест не должен плавать в
// зависимости от того, в какой час реально запущен прогон.
vi.mock("../src/lib/workingHours.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/workingHours.js")>()),
  isWithinAlarmHours: async () => true,
}));

const { prisma } = await import("../src/db.js");
const { buildExpenseForecast, processRecurringExpenses, upsertSalaryExpenses } = await import(
  "../src/lib/financeAutomation.js"
);
const { flushDirectorAlertQueue } = await import("../src/lib/directorAlertQueue.js");
const { DUSHANBE_OFFSET_MS, dushanbeWallClock } = await import("../src/lib/dushanbeTime.js");
const { loadMoneyContext, toTjs } = await import("../src/lib/money.js");

/** Автоматика финансов (financeAutomation.ts) трогает живые деньги из ночного
 *  крона, а тестов у неё не было вовсе. Проверяем три обещания модуля:
 *
 *  1. Идемпотентность через Expense.autoKey — сколько бы раз ни сработал крон
 *     (перезапуск контейнера, двойной тик), строка одна.
 *  2. Зарплата считается из СНАПШОТОВ комиссий закрытых (COMPLETED) сделок
 *     прошлого месяца по Душанбе: доли риелтора и интейкера складываются по
 *     агентам, валюта сделки приводится к сомони по курсу из Настроек.
 *  3. Решение человека сильнее пересчёта: удалённая (deletedAt) строка не
 *     воскрешается.
 *
 *  БД общая на все файлы: обе функции сканируют ВСЮ базу, поэтому все проверки —
 *  только по своим строкам (свои агенты, свои autoKey, свои шаблоны), а не по
 *  возвращённым счётчикам и не по абсолютным количествам. */

const runId = Date.now();

// Те же вычисления месяца, что в модуле: прошлый месяц по Душанбе.
const wall = dushanbeWallClock();
const today = wall.getUTCDate();
const prev = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - 1, 1));
const prevMonth = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
const currentMonth = `${wall.getUTCFullYear()}-${String(wall.getUTCMonth() + 1).padStart(2, "0")}`;
const prevMonthStart = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), 1) - DUSHANBE_OFFSET_MS);
const currentMonthStart = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 1) - DUSHANBE_OFFSET_MS);
/** Середина прошлого месяца — гарантированно внутри [from, to) модуля. */
const closedPrevMonth = new Date(prevMonthStart.getTime() + 5 * 24 * 60 * 60 * 1000);

let adminId: string; // активный ADMIN — гарантированный получатель финансовых уведомлений
let realtorId: string;
let intakeId: string;
let districtId: string;
let clientId: string;
let propertyId: string;
const dealIds: string[] = [];
const recurringIds: string[] = [];

let salaryKeyA = ""; // заполняются в beforeAll — id агентов известны только там

let salaryKeyB = "";

async function createDeal(data: {
  stage?: "COMPLETED" | "NEGOTIATION";
  agentId?: string;
  closedAt?: Date;
  currency?: "TJS" | "USD";
  commissionRealtorAmount?: number;
  commissionIntakeAmount?: number;
  commissionIntakeAgentId?: string;
}) {
  const deal = await prisma.deal.create({
    data: {
      clientId,
      propertyId,
      agentId: data.agentId ?? realtorId,
      stage: data.stage ?? "COMPLETED",
      closedAt: data.closedAt ?? closedPrevMonth,
      currency: data.currency ?? "TJS",
      commissionRealtorAmount: data.commissionRealtorAmount,
      commissionIntakeAmount: data.commissionIntakeAmount,
      commissionIntakeAgentId: data.commissionIntakeAgentId,
    },
  });
  dealIds.push(deal.id);
  return deal;
}

/** Уведомления НАШЕГО админа с данным заголовком — чужих директоров не считаем. */
async function adminNotificationCount(title: string): Promise<number> {
  return prisma.notification.count({ where: { agentId: adminId, title } });
}

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: { fullName: `Финансы админ ${runId}`, phone: `+992961${runId}`, role: "ADMIN", passwordHash: "x" },
  });
  adminId = admin.id;
  const realtor = await prisma.agent.create({
    data: { fullName: `Финансы риелтор ${runId}`, phone: `+992962${runId}`, role: "AGENT", passwordHash: "x" },
  });
  realtorId = realtor.id;
  const intake = await prisma.agent.create({
    data: { fullName: `Финансы интейкер ${runId}`, phone: `+992963${runId}`, role: "AGENT", passwordHash: "x" },
  });
  intakeId = intake.id;
  salaryKeyA = `salary:${realtorId}:${prevMonth}`;
  salaryKeyB = `salary:${intakeId}:${prevMonth}`;

  const district = await prisma.district.create({ data: { name: `Финансы-район-${runId}` } });
  districtId = district.id;
  const client = await prisma.client.create({
    data: { fullName: `Финансы клиент ${runId}`, phone: `+992964${runId}`, source: "PHONE_CALL", assignedAgentId: realtorId },
  });
  clientId = client.id;
  const property = await prisma.property.create({
    data: {
      title: `Финансы объект ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      assignedAgentId: realtorId,
    },
  });
  propertyId = property.id;
});

afterAll(async () => {
  // Чистим ВСЁ созданное: строки расходов по своим autoKey, свои шаблоны,
  // уведомления по чужим директорам (заголовки содержат runId), сделки, карточки.
  await prisma.expense.deleteMany({
    where: { autoKey: { in: [salaryKeyA, salaryKeyB, ...recurringIds.map((id) => `rec:${id}:${currentMonth}`)] } },
  });
  await prisma.recurringExpense.deleteMany({ where: { id: { in: recurringIds } } });
  await prisma.notification.deleteMany({ where: { title: { contains: String(runId) } } });
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, realtorId, intakeId] } } });
  await prisma.$disconnect();
});

describe("upsertSalaryExpenses — зарплата из закрытых сделок прошлого месяца", () => {
  it("складывает доли по агентам из снапшотов и приводит валюту к сомони", async () => {
    // Риелтор: 1000 + 250.5 TJS. Интейкер: 500 TJS долей интейка + 100 USD своей сделкой.
    await createDeal({ commissionRealtorAmount: 1000, commissionIntakeAmount: 500, commissionIntakeAgentId: intakeId });
    await createDeal({ commissionRealtorAmount: 250.5 });
    await createDeal({ agentId: intakeId, currency: "USD", commissionRealtorAmount: 100 });
    // Не должны попасть: без комиссии, не COMPLETED, закрыта в ТЕКУЩЕМ месяце.
    await createDeal({});
    await createDeal({ stage: "NEGOTIATION", commissionRealtorAmount: 9999 });
    await createDeal({ commissionRealtorAmount: 8888, closedAt: new Date(currentMonthStart.getTime() + 60_000) });

    await upsertSalaryExpenses();

    const rowA = await prisma.expense.findUnique({ where: { autoKey: salaryKeyA } });
    expect(rowA).not.toBeNull();
    expect(Number(rowA?.amount)).toBe(1250.5);
    expect(rowA?.currency).toBe("TJS");
    expect(rowA?.category).toBe("SALARY");
    expect(rowA?.agentId).toBe(realtorId);
    expect(rowA?.month.toISOString().slice(0, 7)).toBe(prevMonth);

    const money = await loadMoneyContext();
    const expectedB = Math.round((500 + toTjs(100, "USD", money)) * 100) / 100;
    const rowB = await prisma.expense.findUnique({ where: { autoKey: salaryKeyB } });
    expect(Number(rowB?.amount)).toBe(expectedB);
  });

  it("повторный прогон идемпотентен: та же строка, та же сумма, вторых строк нет", async () => {
    const before = await prisma.expense.findUnique({ where: { autoKey: salaryKeyA } });
    await upsertSalaryExpenses();
    const rows = await prisma.expense.findMany({ where: { autoKey: { in: [salaryKeyA, salaryKeyB] } } });
    expect(rows).toHaveLength(2);
    const after = rows.find((r) => r.autoKey === salaryKeyA);
    expect(after?.id).toBe(before?.id);
    expect(Number(after?.amount)).toBe(Number(before?.amount));
  });

  it("новая сделка за тот же месяц ОБНОВЛЯЕТ существующую строку, а не плодит вторую", async () => {
    const before = await prisma.expense.findUnique({ where: { autoKey: salaryKeyA } });
    await createDeal({ commissionRealtorAmount: 100 });
    await upsertSalaryExpenses();
    const after = await prisma.expense.findUnique({ where: { autoKey: salaryKeyA } });
    expect(after?.id).toBe(before?.id);
    expect(Number(after?.amount)).toBe(1350.5);
  });

  it("удалённую человеком строку пересчёт не воскрешает", async () => {
    // «Этой строки быть не должно» — решение человека сильнее автоматики.
    const deletedAt = new Date();
    await prisma.expense.update({ where: { autoKey: salaryKeyB }, data: { deletedAt } });
    await upsertSalaryExpenses();
    const row = await prisma.expense.findUnique({ where: { autoKey: salaryKeyB } });
    expect(row?.deletedAt?.getTime()).toBe(deletedAt.getTime());
    const count = await prisma.expense.count({ where: { agentId: intakeId, category: "SALARY" } });
    expect(count).toBe(1);
  });
});

describe("processRecurringExpenses — повторяющиеся платежи", () => {
  it("в день оплаты заводит строку из шаблона и уведомляет получателей финансов", async () => {
    const title = `Аренда офиса ${runId}`;
    const t = await prisma.recurringExpense.create({
      data: { title, category: "OFFICE", amount: 3000, currency: "TJS", dayOfMonth: Math.min(today, 28) },
    });
    recurringIds.push(t.id);

    await processRecurringExpenses();
    await flushDirectorAlertQueue();

    const row = await prisma.expense.findUnique({ where: { autoKey: `rec:${t.id}:${currentMonth}` } });
    expect(row).not.toBeNull();
    expect(Number(row?.amount)).toBe(3000);
    expect(row?.category).toBe("OFFICE");
    expect(row?.month.toISOString().slice(0, 7)).toBe(currentMonth);
    expect(row?.note).toContain(title);

    const fresh = await prisma.recurringExpense.findUnique({ where: { id: t.id } });
    expect(fresh?.lastCreatedMonth).toBe(currentMonth);
    expect(await adminNotificationCount(`Пора оплатить: ${title}`)).toBe(1);
  });

  it("повторный прогон в тот же месяц не дублирует ни строку, ни уведомление", async () => {
    const title = `Аренда офиса ${runId}`;
    await processRecurringExpenses();
    await flushDirectorAlertQueue();
    const rows = await prisma.expense.findMany({ where: { autoKey: `rec:${recurringIds[0]}:${currentMonth}` } });
    expect(rows).toHaveLength(1);
    expect(await adminNotificationCount(`Пора оплатить: ${title}`)).toBe(1);
  });

  // На 29–31 число dayOfMonth = today + 1 вышел бы за допустимые 1–28 —
  // напоминание в эти дни в проде и не бывает (dayOfMonth ограничен 28).
  it.skipIf(today > 27)("за три дня до срока шлёт напоминание, один раз за месяц, строку не заводит", async () => {
    const title = `Интернет ${runId}`;
    const t = await prisma.recurringExpense.create({
      data: { title, category: "OFFICE", amount: 200, currency: "TJS", dayOfMonth: today + 1 },
    });
    recurringIds.push(t.id);

    await processRecurringExpenses();
    await flushDirectorAlertQueue();
    expect(await adminNotificationCount(`Скоро оплата: ${title}`)).toBe(1);
    const fresh = await prisma.recurringExpense.findUnique({ where: { id: t.id } });
    expect(fresh?.lastRemindedMonth).toBe(currentMonth);
    // День оплаты ещё не настал — строки расхода нет.
    expect(await prisma.expense.findUnique({ where: { autoKey: `rec:${t.id}:${currentMonth}` } })).toBeNull();

    await processRecurringExpenses();
    await flushDirectorAlertQueue();
    expect(await adminNotificationCount(`Скоро оплата: ${title}`)).toBe(1);
  });

  it("выключенный шаблон ничего не создаёт", async () => {
    const t = await prisma.recurringExpense.create({
      data: {
        title: `Выключенный ${runId}`,
        category: "OFFICE",
        amount: 500,
        currency: "TJS",
        dayOfMonth: Math.min(today, 28),
        active: false,
      },
    });
    recurringIds.push(t.id);

    await processRecurringExpenses();
    expect(await prisma.expense.findUnique({ where: { autoKey: `rec:${t.id}:${currentMonth}` } })).toBeNull();
  });
});

describe("buildExpenseForecast — инварианты прогноза", () => {
  it("месяц текущий, прогноз не меньше уже потраченного", async () => {
    // Прогноз — линейная экстраполяция: spent/день × дней в месяце ≥ spent.
    // Абсолютные суммы не проверяем: база общая, чужие строки в неё входят.
    const f = await buildExpenseForecast();
    expect(f.month).toBe(currentMonth);
    expect(f.projectedTjs).toBeGreaterThanOrEqual(f.spentTjs);
    expect(Number.isFinite(f.averageTjs)).toBe(true);
  });
});

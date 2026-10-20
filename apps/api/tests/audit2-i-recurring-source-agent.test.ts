import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * ПОВТОРЯЮЩИЕСЯ ПЛАТЕЖИ НЕСУТ КАНАЛ И СОТРУДНИКА (аудит CRM-07, решение владельца 04.10.2026, вариант B).
 *
 * Шаблон ADVERTISING без канала порождал каждый месяц расход с source=null: реклама
 * выпадала из стоимости лида по каналам, а ручной PATCH такой строки падал. Шаблон
 * SALARY без сотрудника порождал расход с agentId=null (PATCH: «Укажите сотрудника»).
 * Теперь шаблон хранит source/agentId, схема требует их как у expenseCreateSchema, а
 * ночная задача копирует их в расход. СУЩЕСТВУЮЩИЕ шаблоны без этих полей продолжают
 * работать как раньше: переключить «включено» и править сумму можно без канала.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { processRecurringExpenses } = await import("../src/lib/financeAutomation.js");
const { dushanbeWallClock } = await import("../src/lib/dushanbeTime.js");

const runId = Date.now();
const sfx = String(runId).slice(-7);
let directorId = "";
let salaryAgentId = "";
let token = "";
const recurringIds: string[] = [];

// Число оплаты — сегодня по Душанбе (макс. 28): ночной тик заводит строку сразу.
const day = Math.min(dushanbeWallClock().getUTCDate(), 28);
const monthKey = (() => {
  const w = dushanbeWallClock();
  return `${w.getUTCFullYear()}-${String(w.getUTCMonth() + 1).padStart(2, "0")}`;
})();

beforeAll(async () => {
  directorId = (await prisma.agent.create({ data: { fullName: "Директор rec", phone: `+992971${sfx}`, role: "DIRECTOR", passwordHash: "x" } })).id;
  salaryAgentId = (await prisma.agent.create({ data: { fullName: "Сотрудник rec", phone: `+992972${sfx}`, role: "AGENT", passwordHash: "x" } })).id;
  token = signAccessToken({ sub: directorId, role: "DIRECTOR" });
});

afterAll(async () => {
  await prisma.expense.deleteMany({ where: { autoKey: { in: recurringIds.map((id) => `rec:${id}:${monthKey}`) } } });
  await prisma.recurringExpense.deleteMany({ where: { id: { in: recurringIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, salaryAgentId] } } });
});

const post = (body: object) =>
  request(app).post("/api/v1/expenses/recurring").set("Authorization", `Bearer ${token}`).send(body);
const patch = (id: string, body: object) =>
  request(app).patch(`/api/v1/expenses/recurring/${id}`).set("Authorization", `Bearer ${token}`).send(body);

const base = { title: `Платёж ${runId}`, amount: 500, currency: "TJS", dayOfMonth: day };

describe("POST /expenses/recurring: обязательность канала и сотрудника", () => {
  it("реклама без канала отклоняется, с каналом сохраняет source", async () => {
    const bad = await post({ ...base, category: "ADVERTISING" });
    expect(bad.status).toBe(400);

    const ok = await post({ ...base, category: "ADVERTISING", source: "INSTAGRAM" });
    expect(ok.status).toBe(201);
    recurringIds.push(ok.body.id);
    expect(ok.body.source).toBe("INSTAGRAM");
    expect(ok.body.agentId).toBeNull();
  });

  it("зарплата без сотрудника отклоняется, с сотрудником сохраняет agentId", async () => {
    const bad = await post({ ...base, category: "SALARY" });
    expect(bad.status).toBe(400);

    const ok = await post({ ...base, category: "SALARY", agentId: salaryAgentId });
    expect(ok.status).toBe(201);
    recurringIds.push(ok.body.id);
    expect(ok.body.agentId).toBe(salaryAgentId);
    expect(ok.body.source).toBeNull();
  });

  it("офис и прочее канал и сотрудника не хранят", async () => {
    const res = await post({ ...base, category: "OFFICE", source: "INSTAGRAM", agentId: salaryAgentId });
    expect(res.status).toBe(201);
    recurringIds.push(res.body.id);
    expect(res.body.source).toBeNull();
    expect(res.body.agentId).toBeNull();
  });
});

describe("PATCH /expenses/recurring/:id: существующие шаблоны не ломаются", () => {
  async function legacy(category: "ADVERTISING" | "SALARY") {
    const row = await prisma.recurringExpense.create({
      data: { title: `Старый ${category} ${runId}`, category, amount: 700, currency: "USD", dayOfMonth: day },
    });
    recurringIds.push(row.id);
    return row;
  }

  it("выключить старый шаблон без канала можно, категория и валюта не сбрасываются", async () => {
    const row = await legacy("ADVERTISING");

    const res = await patch(row.id, { active: false });

    expect(res.status).toBe(200);
    const after = await prisma.recurringExpense.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.active).toBe(false);
    // Раньше значения по умолчанию схемы (OFFICE/TJS) затирали их при любой правке.
    expect(after.category).toBe("ADVERTISING");
    expect(after.currency).toBe("USD");
  });

  it("правка суммы старого шаблона без канала проходит", async () => {
    const row = await legacy("SALARY");
    const res = await patch(row.id, { amount: 800, dayOfMonth: day });
    expect(res.status).toBe(200);
  });

  it("смена категории на рекламу без канала отклоняется, с каналом принимается и чистит сотрудника", async () => {
    const row = await legacy("SALARY");
    await prisma.recurringExpense.update({ where: { id: row.id }, data: { agentId: salaryAgentId } });

    expect((await patch(row.id, { category: "ADVERTISING" })).status).toBe(400);

    const ok = await patch(row.id, { category: "ADVERTISING", source: "FACEBOOK" });
    expect(ok.status).toBe(200);
    expect(ok.body.source).toBe("FACEBOOK");
    expect(ok.body.agentId).toBeNull();
  });
});

describe("processRecurringExpenses копирует канал и сотрудника в расход", () => {
  it("реклама с каналом, зарплата с сотрудником и старый шаблон без них", async () => {
    const ads = await prisma.recurringExpense.create({
      data: { title: `Реклама ${runId}`, category: "ADVERTISING", source: "INSTAGRAM", amount: 100, dayOfMonth: day },
    });
    const salary = await prisma.recurringExpense.create({
      data: { title: `Оклад ${runId}`, category: "SALARY", agentId: salaryAgentId, amount: 200, dayOfMonth: day },
    });
    const old = await prisma.recurringExpense.create({
      data: { title: `Старая реклама ${runId}`, category: "ADVERTISING", amount: 300, dayOfMonth: day },
    });
    recurringIds.push(ads.id, salary.id, old.id);

    await processRecurringExpenses();

    const key = (id: string) => ({ autoKey: `rec:${id}:${monthKey}` });
    const adsRow = await prisma.expense.findUniqueOrThrow({ where: key(ads.id) });
    expect(adsRow.source).toBe("INSTAGRAM");
    expect(adsRow.agentId).toBeNull();
    const salaryRow = await prisma.expense.findUniqueOrThrow({ where: key(salary.id) });
    expect(salaryRow.agentId).toBe(salaryAgentId);
    expect(salaryRow.source).toBeNull();
    // Старый шаблон по-прежнему создаёт расход, как раньше (без канала).
    const oldRow = await prisma.expense.findUniqueOrThrow({ where: key(old.id) });
    expect(oldRow.source).toBeNull();
    expect(Number(oldRow.amount)).toBe(300);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { processRecurringExpenses } from "../src/lib/financeAutomation.js";
import { expenseCentsToTjs } from "../src/lib/money.js";

vi.mock("../src/lib/directorAlertQueue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/directorAlertQueue.js")>()),
  enqueueDirectorAlert: vi.fn(async () => undefined),
}));

let actorId: string;
let token: string;
let originalRate: number;
const expenseIds: string[] = [];
const recurringIds: string[] = [];
const auth = () => ({ Authorization: `Bearer ${token}` });

async function createExpense(overrides: Record<string, unknown> = {}) {
  const response = await request(app).post("/api/v1/expenses").set(auth()).send({
    category: "OFFICE", amount: 100, note: "Night finance regression fixture",
    currency: "USD", status: "PLANNED", month: "2020-01", paymentDate: "2020-01-15",
    ...overrides,
  });
  expect(response.status).toBe(201);
  expenseIds.push(response.body.id);
  return response.body;
}

beforeAll(async () => {
  originalRate = Number((await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } })).usdToTjsRate);
  const actor = await prisma.agent.create({ data: {
    fullName: "Night finance fixture", phone: `test-night-finance-${randomUUID()}`,
    passwordHash: "test-placeholder", role: "DIRECTOR",
  } });
  actorId = actor.id;
  token = signAccessToken({ sub: actorId, role: "DIRECTOR" });
});
beforeEach(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { usdToTjsRate: 10 } });
});
afterAll(async () => {
  await prisma.expense.deleteMany({ where: { OR: [{ id: { in: expenseIds } }, { recurringId: { in: recurringIds } }] } });
  await prisma.recurringExpense.deleteMany({ where: { id: { in: recurringIds } } });
  if (actorId) await prisma.agent.delete({ where: { id: actorId } });
  if (originalRate) await prisma.settings.update({ where: { id: "singleton" }, data: { usdToTjsRate: originalRate } });
});

describe("expense payment final-state accounting", () => {
  it.each([false, true])("captures the rate when PATCH pays a plan (full form: %s)", async (fullForm) => {
    const opening = await createExpense();
    expect(opening.exchangeRate).toBeNull();
    const paid = await request(app).patch(`/api/v1/expenses/${opening.id}`).set(auth()).send({
      version: opening.version, status: "PAID",
      ...(fullForm ? { amount: 100, currency: "USD", month: "2020-01", paymentDate: "2020-01-15", note: opening.note } : {}),
    });
    expect(paid.status).toBe(200);
    expect(Number(paid.body.exchangeRate)).toBe(10);
    expect(paid.body.rateCapturedAt).toBeTruthy();
    const stored = await prisma.expense.findUniqueOrThrow({ where: { id: opening.id } });
    expect(expenseCentsToTjs(stored, { usdToTjs: 20 })).toBe(100000);
  });

  it("keeps a supplied planned rate on payment instead of replacing it", async () => {
    const opening = await createExpense({ exchangeRate: 12 });
    const paid = await request(app).patch(`/api/v1/expenses/${opening.id}`).set(auth()).send({ version: opening.version, status: "PAID" });
    expect(paid.status).toBe(200);
    expect(Number(paid.body.exchangeRate)).toBe(12);
  });

  it("keeps a changed-currency plan without a rate until actual payment", async () => {
    const opening = await createExpense({ currency: "TJS" });
    const changed = await request(app).patch(`/api/v1/expenses/${opening.id}`).set(auth()).send({ version: opening.version, currency: "USD" });
    expect(changed.status).toBe(200);
    expect(changed.body.exchangeRate).toBeNull();
    await prisma.settings.update({ where: { id: "singleton" }, data: { usdToTjsRate: 12 } });
    const paid = await request(app).post(`/api/v1/expenses/${opening.id}/pay`).set(auth()).send({ paymentDate: "2020-01-15" });
    expect(paid.status).toBe(200);
    expect(Number(paid.body.exchangeRate)).toBe(12);
  });

  it("derives a paid expense month from the retained payment date on partial PATCH", async () => {
    const opening = await createExpense({ status: "PAID" });
    const changed = await request(app).patch(`/api/v1/expenses/${opening.id}`).set(auth()).send({ version: opening.version, month: "2020-02" });
    expect(changed.status).toBe(200);
    expect(changed.body.paymentDate).toBe("2020-01-15");
    expect(changed.body.month.slice(0, 7)).toBe("2020-01");
  });

  it("preserves editable accounting month for paid historical expenses with unknown date", async () => {
    const opening = await createExpense({ status: "PAID", paymentDate: null });
    const changed = await request(app).patch(`/api/v1/expenses/${opening.id}`).set(auth()).send({ version: opening.version, month: "2020-02" });
    expect(changed.status).toBe(200);
    expect(changed.body.paymentDate).toBeNull();
    expect(changed.body.month.slice(0, 7)).toBe("2020-02");
  });

  it("freezes the current rate for legacy USD automatic payments", async () => {
    const template = await prisma.recurringExpense.create({ data: {
      title: "Night legacy rate fixture", amount: 100, currency: "USD", category: "OFFICE",
      dayOfMonth: 1, autoPay: true,
    } });
    recurringIds.push(template.id);
    await processRecurringExpenses();
    const row = await prisma.expense.findFirstOrThrow({ where: { recurringId: template.id } });
    expect(row.status).toBe("PAID");
    expect(Number(row.exchangeRate)).toBe(10);
    expect(row.rateCapturedAt).not.toBeNull();
    expect(expenseCentsToTjs(row, { usdToTjs: 20 })).toBe(100000);
  });
});

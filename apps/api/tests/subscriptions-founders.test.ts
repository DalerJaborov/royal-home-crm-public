import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { upsertAiExpenses } from "../src/lib/ads/adExpenseSync.js";
import { createExpense, deleteExpense } from "../src/lib/expenseCommands.js";
import { confirmAssistantAction, createPendingAssistantAction, undoAssistantAction } from "../src/lib/assistantActions.js";
import { parseBatchArgs, resolveRows } from "../src/ai/assistant/tools/expenseBatchTool.js";

/**
 * Подписки и взносы учредителей на настоящей базе (17.11.2026).
 * Месяц 2002-го — чтобы не встретить строки других тестов.
 */

const stamp = String(Date.now()).slice(-7);
const M = "2002-04";
const monthDate = new Date(`${M}-01T00:00:00.000Z`);
let directorId: string;
let token: string;
const founderIds: string[] = [];

async function cleanMonth() {
  await prisma.expense.deleteMany({ where: { month: monthDate } });
  await prisma.aiLog.deleteMany({ where: { endpoint: `test-subs-${stamp}` } });
}

beforeAll(async () => {
  await cleanMonth();
  directorId = (await prisma.agent.create({ data: { fullName: "Директор подписок", phone: `+992984${stamp}`, role: "DIRECTOR", passwordHash: "x" } })).id;
  token = signAccessToken({ sub: directorId, role: "DIRECTOR" });
  await prisma.aiLog.createMany({ data: [
    { endpoint: `test-subs-${stamp}`, provider: "google", model: "gemini-3.5-flash", costUsd: 30, ms: 1, ok: true, createdAt: new Date(`${M}-10T10:00:00.000Z`) },
    { endpoint: `test-subs-${stamp}`, provider: null, model: "gpt-image-1", costUsd: 10, ms: 1, ok: true, createdAt: new Date(`${M}-11T10:00:00.000Z`) },
  ] });
});

afterAll(async () => {
  await cleanMonth();
  await prisma.founderContribution.deleteMany({ where: { OR: [{ createdById: directorId }, { founderId: { in: founderIds } }] } });
  await prisma.founder.deleteMany({ where: { id: { in: founderIds } } });
  await prisma.auditLog.deleteMany({ where: { agentId: directorId } });
  await prisma.assistantAction.deleteMany({ where: { agentId: directorId } }).catch(() => undefined);
  await prisma.agent.deleteMany({ where: { id: directorId } });
});

describe("счёт поставщика сильнее оценки ИИ", () => {
  it("без счёта оценка 40 $; счёт Gemini снимает 30 $ и называет причину; удалили счёт — оценка вернулась", async () => {
    await upsertAiExpenses([M]);
    const ai = () => prisma.expense.findUnique({ where: { autoKey: `ai:${M}` } });
    expect(Number((await ai())!.amount)).toBe(40);

    const { expense } = await createExpense({ category: "OTHER", amount: 2000, currency: "TJS", month: M, note: "Оплата Gemini" }, { agentId: directorId });
    expect(expense.vendor).toBe("GEMINI");
    const after = (await ai())!;
    expect(Number(after.amount)).toBe(10);
    expect(after.note).toContain("Gemini");

    await deleteExpense(expense.id);
    expect(Number((await ai())!.amount)).toBe(40);
  });

  it("«Оплата ИИ» без названия сервиса — по-прежнему «уже учтено»", async () => {
    const err = await createExpense({ category: "OTHER", amount: 2000, currency: "TJS", month: M, note: "ОПЛАТА ИИ" }, { agentId: directorId }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409 });
  });
});

describe("подписка с поставщиком", () => {
  it("шаблон хранит поставщика, строка месяца его копирует, ручная «синяя галочка» — «уже учтено»", async () => {
    const res = await request(app).post("/api/v1/expenses/recurring").set("Authorization", `Bearer ${token}`)
      .send({ title: "Meta Verified", amount: 160, currency: "TJS", category: "OTHER", dayOfMonth: 5, period: "MONTH", startsOn: `${M}-05`, endsOn: `${M}-30`, autoPay: false, vendor: "META_VERIFIED" });
    expect(res.status).toBe(201);
    expect(res.body.vendor).toBe("META_VERIFIED");
    const pay = await request(app).post(`/api/v1/expenses/recurring/${res.body.id}/pay`).set("Authorization", `Bearer ${token}`).send({ dueDate: `${M}-05`, paymentDate: `${M}-05` });
    expect(pay.status).toBeLessThan(300);
    const row = await prisma.expense.findFirst({ where: { recurringId: res.body.id } });
    expect(row?.vendor).toBe("META_VERIFIED");

    const dup = await request(app).post("/api/v1/expenses").set("Authorization", `Bearer ${token}`)
      .send({ category: "OTHER", amount: 170, currency: "TJS", month: M, note: "Синяя галочка Instagram" });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("AUTO_EXPENSE_OVERLAP");
    await prisma.expense.deleteMany({ where: { recurringId: res.body.id } });
    await prisma.recurringExpense.delete({ where: { id: res.body.id } });
  });
});

describe("учредители и взносы через API", () => {
  const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);

  it("трое из миграции на месте; добавить, переименовать, удалить с историей, вернуть", async () => {
    const list = await auth(request(app).get("/api/v1/founders"));
    expect(list.status).toBe(200);
    expect(list.body.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(["Баходур", "Илхом", "Мирсаид"]));

    const created = await auth(request(app).post("/api/v1/founders")).send({ name: `Тест ${stamp}` });
    expect(created.status).toBe(201);
    founderIds.push(created.body.id);
    expect((await auth(request(app).post("/api/v1/founders")).send({ name: `тест ${stamp}` })).status).toBe(409);
    const renamed = await auth(request(app).patch(`/api/v1/founders/${created.body.id}`)).send({ name: `Тестов ${stamp}` });
    expect(renamed.body.name).toBe(`Тестов ${stamp}`);

    const c = await auth(request(app).post("/api/v1/founders/contributions")).send({ founderId: created.body.id, amount: 5000, currency: "TJS", date: `${M}-15`, note: "Взнос" });
    expect(c.status).toBe(201);
    expect(c.body.amountTjs).toBe(5000);
    // Отмена правки шлёт exchangeRate: null — принимается, курс не трогается.
    const patched = await auth(request(app).patch(`/api/v1/founders/contributions/${c.body.id}`)).send({ amount: 5500, exchangeRate: null });
    expect(patched.status).toBe(200);
    expect(patched.body.amount).toBe("5500");

    expect((await auth(request(app).delete(`/api/v1/founders/${created.body.id}`))).status).toBe(200);
    const totals = await auth(request(app).get(`/api/v1/founders/totals?month=${M}`));
    const row = totals.body.founders.find((f: { founderId: string }) => f.founderId === created.body.id);
    expect(row).toMatchObject({ deleted: true, monthTjs: 5500, allTimeTjs: 5500 });
    const refused = await auth(request(app).post("/api/v1/founders/contributions")).send({ founderId: created.body.id, amount: 1, currency: "TJS", date: `${M}-16` });
    expect(refused.status).toBe(400);

    expect((await auth(request(app).patch(`/api/v1/founders/${created.body.id}/restore`))).body.deleted).toBe(false);
  });

  it("взнос будущим числом и без права записи не проходит", async () => {
    const [f] = (await auth(request(app).get("/api/v1/founders"))).body as { id: string }[];
    const future = await auth(request(app).post("/api/v1/founders/contributions")).send({ founderId: f!.id, amount: 1, currency: "TJS", date: "2199-01-01" });
    expect(future.status).toBe(400);
    const agentId = (await prisma.agent.create({ data: { fullName: "Агент без финансов", phone: `+992985${stamp}`, role: "AGENT", passwordHash: "x" } })).id;
    try {
      const res = await request(app).post("/api/v1/founders/contributions").set("Authorization", `Bearer ${signAccessToken({ sub: agentId, role: "AGENT" })}`)
        .send({ founderId: f!.id, amount: 1, currency: "TJS", date: `${M}-16` });
      expect(res.status).toBe(403);
    } finally {
      await prisma.agent.delete({ where: { id: agentId } });
    }
  });
});

describe("пачка Шабнам: взнос учредителя", () => {
  const actor = () => ({ agentId: directorId, channel: "telegram" as const, telegramPrivate: true, can: () => true });

  it("«Взнос от Баходура» — взнос, не расход; откат убирает взнос в корзину", async () => {
    const items = [
      { title: "Взнос от Баходура", amount: 7000, currency: "TJS", date: `${M}-20` },
      { title: "Вода для кулера", amount: 60, currency: "TJS", date: `${M}-20` },
    ];
    const rows = await resolveRows(parseBatchArgs({ items }));
    expect(rows[0]!.founder?.name).toBe("Баходур");
    expect(rows[1]!.founder).toBeUndefined();

    const unknown = await resolveRows(parseBatchArgs({ items: [{ title: "Взнос", amount: 1, currency: "TJS", date: `${M}-20`, founderName: "Неизвестный" }] }));
    expect(unknown[0]!.problem).toContain("нет в списке");

    const action = await createPendingAssistantAction(actor(), "add_expenses", { lang: "ru", items, chatRef: `subs-${stamp}` });
    const done = await confirmAssistantAction(action.id, actor());
    const result = (done.action as { result?: { contributionIds?: string[]; expenseIds?: string[] } }).result;
    expect(result?.contributionIds).toHaveLength(1);
    expect(result?.expenseIds).toHaveLength(1);
    const contribution = await prisma.founderContribution.findUnique({ where: { id: result!.contributionIds![0]! } });
    expect(Number(contribution!.amount)).toBe(7000);
    expect(await prisma.expense.count({ where: { month: monthDate, note: "Взнос от Баходура" } })).toBe(0);

    await undoAssistantAction(action.id, actor());
    expect((await prisma.founderContribution.findUnique({ where: { id: contribution!.id } }))!.deletedAt).not.toBeNull();
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { createExpense, deleteExpense, ExpenseCommandError, restoreExpense, updateExpense } from "../src/lib/expenseCommands.js";
import { warnManualOverlapsForAuto } from "../src/lib/expenseAutoOverlap.js";
import { parseBatchArgs, resolveRows } from "../src/ai/assistant/tools/expenseBatchTool.js";

/**
 * Одна дверь записи расхода (createExpense) и пачка Шабнам не пишут молча то, что CRM уже
 * считает сама; автоматическая строка, появившаяся после ручной, поднимает тревогу (14.11.2026).
 * Месяцы 2001-го — чтобы не встретить автоматические строки других тестов.
 */

const stamp = Date.now().toString(36);
const M1 = "2001-02";
const M2 = "2001-03";
const months = [M1, M2].map((m) => new Date(`${m}-01T00:00:00.000Z`));
const agentId = `test-overlap-${stamp}`;

async function clean() {
  await prisma.expense.deleteMany({ where: { month: { in: months } } });
}

beforeAll(async () => {
  await clean();
  await prisma.expense.create({ data: {
    autoKey: `ads:META:${M1}`, month: months[0]!, amount: 905.92, currency: "USD", category: "ADVERTISING", source: "INSTAGRAM", note: "авто",
  } });
});
afterAll(clean);

describe("createExpense: расход, уже учтённый автоматически", () => {
  it("реклама Instagram за тот же месяц — 409 с суммой кабинета; с подтверждением — пишется", async () => {
    const body = { category: "ADVERTISING", source: "INSTAGRAM", amount: 7278, currency: "TJS", month: M1, note: "ТАРГЕТ" };
    const error = await createExpense(body, { agentId }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExpenseCommandError);
    expect((error as ExpenseCommandError).status).toBe(409);
    expect((error as ExpenseCommandError).body.code).toBe("AUTO_EXPENSE_OVERLAP");
    expect((error as ExpenseCommandError).body.error).toContain("905,92 $");
    expect(await prisma.expense.count({ where: { month: months[0]!, autoKey: null } })).toBe(0);

    const { expense } = await createExpense({ ...body, confirmAutoOverlap: true }, { agentId });
    expect(Number(expense.amount)).toBe(7278);
    expect(expense).not.toHaveProperty("confirmAutoOverlap");
  });

  it("другой расход того же месяца пишется без вопросов", async () => {
    const { expense } = await createExpense({ category: "OFFICE", amount: 400, currency: "TJS", month: M1, note: "Свет офис" }, { agentId });
    expect(expense.id).toBeTruthy();
  });

  it("повтор того же запроса с тем же ключом не спотыкается о проверку и не пишет второй раз", async () => {
    const body = { category: "OTHER", amount: 2000, currency: "TJS", month: M2, note: "Оплата ИИ" };
    const first = await createExpense(body, { agentId, requestKey: `overlap-retry-${stamp}` });
    await prisma.expense.create({ data: { autoKey: `ai:${M2}`, month: months[1]!, amount: 44.98, currency: "USD", category: "OTHER", note: "авто" } });
    const again = await createExpense(body, { agentId, requestKey: `overlap-retry-${stamp}` });
    expect(again.expense.id).toBe(first.expense.id);
  });
});

describe("пачка Шабнам", () => {
  it("строка «ТАРГЕТ (инстаграм-фейсбук)» помечена «уже учтено», соседняя — нет; подтверждённая — без пометки", async () => {
    const args = parseBatchArgs({ items: [
      { title: "ТАРГЕТ (инстаграм-фейсбук)", amount: 7278, currency: "TJS", month: M1 },
      { title: "Вода для кулера", amount: 60, currency: "TJS", month: M1 },
    ] });
    const rows = await resolveRows(args);
    expect(rows[0]!.body).toMatchObject({ category: "ADVERTISING", source: "INSTAGRAM" });
    expect(rows[0]!.autoOverlap).toContain("уже учтён автоматически");
    expect(rows[1]!.autoOverlap).toBeUndefined();

    const confirmed = await resolveRows(parseBatchArgs({ items: [
      { title: "ТАРГЕТ (инстаграм-фейсбук)", amount: 7278, currency: "TJS", month: M1, confirmAutoOverlap: true },
    ] }));
    expect(confirmed[0]!.autoOverlap).toBeUndefined();
    expect(confirmed[0]!.body.confirmAutoOverlap).toBe(true);
  });
});

describe("пачка: подтверждение только отдельным вызовом", () => {
  it("смешанный вызов (вся пачка + флаг у одной строки) отклоняется — остальные не запишутся второй раз", () => {
    expect(() => parseBatchArgs({ items: [
      { title: "ТАРГЕТ", amount: 7278, currency: "TJS", month: M1, confirmAutoOverlap: true },
      { title: "Вода", amount: 60, currency: "TJS", month: M1 },
    ] })).toThrow(/отдельным вызовом/);
  });
});

describe("правка и возврат из корзины тоже проверяются", () => {
  it("ручную строку перевели в «таргет Instagram» того же месяца — 409; сумму у неё поменять можно", async () => {
    const { expense } = await createExpense({ category: "OFFICE", amount: 300, currency: "TJS", month: M1, note: "Интернет" }, { agentId });
    const err = await updateExpense(expense.id, { category: "ADVERTISING", source: "INSTAGRAM", note: "Таргет", version: expense.version }).catch((e: unknown) => e);
    expect((err as ExpenseCommandError).body?.code).toBe("AUTO_EXPENSE_OVERLAP");
    const ok = await updateExpense(expense.id, { amount: 350, category: "OFFICE", note: "Интернет", version: expense.version });
    expect(Number(ok.expense.amount)).toBe(350);
  });

  it("строка из корзины, повторяющая автоматическую, без подтверждения не возвращается", async () => {
    const row = await prisma.expense.create({ data: { month: months[0]!, amount: 100, currency: "USD", category: "OTHER", note: "Таргет фейсбук", createdById: agentId } });
    await deleteExpense(row.id);
    const err = await restoreExpense(row.id).catch((e: unknown) => e);
    expect((err as ExpenseCommandError).body?.code).toBe("AUTO_EXPENSE_OVERLAP");
    const back = await restoreExpense(row.id, { confirmAutoOverlap: true });
    expect(back.deletedAt).toBeNull();
  });
});

describe("обратная сторона: автоматическая строка пришла после ручной", () => {
  it("ручная «Таргет инстаграм» за месяц находится и уходит тревогой", async () => {
    const month = "2001-04";
    const date = new Date(`${month}-01T00:00:00.000Z`);
    months.push(date);
    await prisma.expense.create({ data: { month: date, amount: 500, currency: "TJS", category: "OTHER", note: "Таргет инстаграм", createdById: agentId } });
    await prisma.expense.create({ data: { month: date, amount: 300, currency: "TJS", category: "OFFICE", note: "Интернет", createdById: agentId } });
    await prisma.expense.create({ data: { autoKey: `ads:META:${month}`, month: date, amount: 60, currency: "USD", category: "ADVERTISING", source: "INSTAGRAM", note: "авто" } });
    expect(await warnManualOverlapsForAuto(`ads:META:${month}`, month)).toBe(1);
  });
});

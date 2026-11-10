import { z } from "zod";
import { EXPENSE_CATEGORIES, expenseDateSchema, expenseListQuerySchema } from "@royal-home/shared";
import { buildExpenseForecast } from "../../../lib/financeAutomation.js";
import { ExpenseCommandError } from "../../../lib/expenseCommands.js";
import {
  buildExpensePivot, buildExpenseSummary, filteredExpenses, listArchivedExpenses, listExpenseCategories, listExpenses,
  listRecurringExpenses,
} from "../../../lib/expenseQueries.js";
import { ExpenseLifecycleError, todayExpenseDay, upcomingExpenses } from "../../../lib/expenseWorkspace.js";
import { expenseCentsToTjs, fromCents, loadMoneyContext } from "../../../lib/money.js";
import { plainField } from "./safeField.js";
import { findCategoryByTitle, financeReadAllowed } from "./expenseToolSupport.js";
import type { AssistantReadToolPlugin, AssistantToolContext } from "./types.js";

/**
 * ЧТЕНИЕ РАСХОДОВ ДЛЯ ШАБНАМ — те же функции, что экран «Расходы» (lib/expenseQueries.ts).
 * Право — finance.view, как у всего раздела; в общей группе Telegram недоступно.
 * Строки из базы (названия, контрагенты) отдаются модели через plainField.
 */

const opt = <T extends z.ZodTypeAny>(schema: T) => schema.nullish().transform((v) => v ?? undefined);
const month = opt(z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/));
const denied = { error: "Раздел «Финансы» вам не открыт — спросите руководителя" };

function guard<A>(schema: z.ZodType<A>, run: (args: A, ctx: AssistantToolContext) => Promise<unknown>) {
  return async (raw: Record<string, unknown>, ctx: AssistantToolContext) => {
    if (!financeReadAllowed(ctx.actor)) return denied;
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) return { error: "Неверные параметры: проверьте месяц (ГГГГ-ММ) и даты (ГГГГ-ММ-ДД)" };
    try {
      return await run(parsed.data, ctx);
    } catch (err) {
      if (err instanceof ExpenseCommandError) return { error: err.body.error };
      if (err instanceof ExpenseLifecycleError) return { error: err.message };
      throw err;
    }
  };
}

/** Поля строки списка, которые видит модель (вид строки — expenseDtos в lib/expenseWorkspace.ts). */
interface ListedExpense {
  id: string; note: string | null; amount: unknown; currency: string; amountTjs: number; status: string;
  paymentDate: string | null; month: Date; category: string; counterparty: string | null;
  recurringId: string | null; autoKey: string | null;
}

const listArgs = z.object({
  month, from: opt(expenseDateSchema), to: opt(expenseDateSchema),
  status: opt(z.enum(["PAID", "PLANNED"])), rootCategory: opt(z.enum(EXPENSE_CATEGORIES)),
  categoryTitle: opt(z.string().trim().max(100)), q: opt(z.string().trim().max(200)),
  counterparty: opt(z.string().trim().max(200)),
  limit: opt(z.coerce.number().int().min(1).max(30)),
});

export const listExpensesTool: AssistantReadToolPlugin = {
  name: "list_expenses",
  level: "A",
  description:
    "Список расходов компании с фильтрами, как экран «Расходы»: месяц, период по дате оплаты, статус (PAID — оплачено, " +
    "PLANNED — ждёт оплаты), раздел (ADVERTISING, SALARY, OFFICE, OTHER), подраздел, поиск по названию/контрагенту. " +
    "Возвращает до 30 строк с id (по нему меняют, удаляют, оплачивают) и сумму всех подходящих в сомони.",
  parameters: {
    type: "object",
    properties: {
      month: { type: "string", description: "YYYY-MM" },
      from: { type: "string", description: "Начало периода YYYY-MM-DD (по дате оплаты)" },
      to: { type: "string", description: "Конец периода YYYY-MM-DD" },
      status: { type: "string", enum: ["PAID", "PLANNED"] },
      rootCategory: { type: "string", enum: [...EXPENSE_CATEGORIES] },
      categoryTitle: { type: "string", description: "Название подраздела из справочника" },
      q: { type: "string", description: "Слова из названия или контрагента" },
      counterparty: { type: "string" },
      limit: { type: "number", description: "Сколько строк, до 30 (по умолчанию 15)" },
    },
  },
  statusPhrase: "Смотрю расходы…",
  allowed: financeReadAllowed,
  run: guard(listArgs, async (args) => {
    const category = await findCategoryByTitle(args.categoryTitle);
    if (args.categoryTitle && !category) return { error: `Подраздел «${plainField(args.categoryTitle, 60)}» не найден в справочнике` };
    const filters = {
      month: args.month, from: args.from, to: args.to, status: args.status, rootCategory: args.rootCategory,
      categoryId: category?.id, q: args.q, counterparty: args.counterparty,
    };
    const query = expenseListQuerySchema.parse({ ...filters, page: 1, pageSize: args.limit ?? 15 });
    const [page, all, money] = await Promise.all([listExpenses(query), filteredExpenses(query), loadMoneyContext()]);
    // С номером страницы список всегда приходит объектом { items, total }.
    const { items, total } = page as unknown as { items: ListedExpense[]; total: number };
    const sumTjs = fromCents(all.reduce((sum, e) => sum + expenseCentsToTjs(e, money), 0));
    return {
      total, sumTjs, shown: items.length,
      items: items.map((e) => ({
        id: e.id, title: plainField(e.note, 120), amount: Number(e.amount), currency: e.currency, amountTjs: e.amountTjs,
        status: e.status, date: e.paymentDate, month: e.month.toISOString().slice(0, 7), category: e.category,
        counterparty: plainField(e.counterparty, 80), recurring: Boolean(e.recurringId), auto: Boolean(e.autoKey),
      })),
    };
  }),
};

const summaryArgs = z.object({ months: opt(z.coerce.number().int().min(1).max(12)), through: month });

export const getExpenseSummaryTool: AssistantReadToolPlugin = {
  name: "get_expense_summary",
  level: "A",
  description:
    "Сводка «Финансов» по месяцам, как экран: доход (комиссии), доля компании, расходы по разделам, прибыль, стоимость лида. " +
    "months — сколько месяцев назад от through (по умолчанию 1), through — последний месяц YYYY-MM (по умолчанию текущий).",
  parameters: {
    type: "object",
    properties: {
      months: { type: "number", description: "1–12" },
      through: { type: "string", description: "YYYY-MM" },
    },
  },
  statusPhrase: "Считаю сводку…",
  allowed: financeReadAllowed,
  run: guard(summaryArgs, async (args) => {
    const summary = await buildExpenseSummary({ months: args.months ?? 1, through: args.through });
    return {
      currency: summary.currency, usdToTjsRate: summary.usdToTjsRate, truncated: summary.truncated,
      months: summary.months.map((m) => ({
        month: m.month, revenue: m.revenue, companyRevenue: m.companyRevenue, realtorPayouts: m.realtorPayouts,
        expenses: m.expenses, totalExpenses: m.totalExpenses, operatingExpenses: m.operatingExpenses, profit: m.profit,
        leads: m.leads, costPerLead: m.costPerLead,
      })),
    };
  }),
};

export const getExpenseForecastTool: AssistantReadToolPlugin = {
  name: "get_expense_forecast",
  level: "A",
  description: "Прогноз расходов текущего месяца по темпу трат и сравнение со средним трёх прошлых месяцев, как на экране «Расходы».",
  statusPhrase: "Считаю прогноз…",
  allowed: financeReadAllowed,
  run: guard(z.object({}).passthrough(), async () => buildExpenseForecast()),
};

const pivotArgs = z.object({ month, from: opt(expenseDateSchema), to: opt(expenseDateSchema), rootCategory: opt(z.enum(EXPENSE_CATEGORIES)) });

export const getExpensePivotTool: AssistantReadToolPlugin = {
  name: "get_expense_pivot",
  level: "A",
  description: "Разбивка оплаченных расходов: подраздел × месяц, в сомони (таблица «Разбивка» на экране). Для вопросов «сколько по каким статьям».",
  parameters: {
    type: "object",
    properties: {
      month: { type: "string", description: "YYYY-MM" },
      from: { type: "string", description: "YYYY-MM-DD" },
      to: { type: "string", description: "YYYY-MM-DD" },
      rootCategory: { type: "string", enum: [...EXPENSE_CATEGORIES] },
    },
  },
  statusPhrase: "Собираю разбивку…",
  allowed: financeReadAllowed,
  run: guard(pivotArgs, async (args) => {
    const pivot = await buildExpensePivot(expenseListQuerySchema.parse(args));
    return { ...pivot, rows: pivot.rows.slice(0, 40).map((row) => ({ ...row, title: plainField(row.title, 80) })) };
  }),
};

export const listRecurringExpensesTool: AssistantReadToolPlugin = {
  name: "list_recurring_expenses",
  level: "A",
  description:
    "Повторяющиеся платежи (подписки: аренда, интернет…) с id и датой ближайшего платежа, плюс календарь платежей " +
    "текущего месяца (оплачено / ждёт / пропущено). По id и dueDate платёж оплачивают или пропускают.",
  statusPhrase: "Смотрю повторяющиеся платежи…",
  allowed: financeReadAllowed,
  run: guard(z.object({}).passthrough(), async () => {
    const today = todayExpenseDay();
    const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const [templates, upcoming] = await Promise.all([listRecurringExpenses(), upcomingExpenses(`${today.slice(0, 7)}-01`, monthEnd)]);
    return {
      templates: templates.slice(0, 50).map((t) => ({
        id: t.id, title: plainField(t.title, 100), amount: Number(t.amount), currency: t.currency, category: t.category,
        period: t.period, dayOfMonth: t.dayOfMonth, active: t.active, autoPay: t.autoPay, nextDate: t.nextDate,
      })),
      thisMonth: upcoming.filter((u) => u.recurringId).slice(0, 50).map((u) => ({
        recurringId: u.recurringId, expenseId: u.expenseId ?? null, dueDate: u.dueDate, status: u.status,
        title: plainField(u.title, 100), amount: Number(u.amount), currency: u.currency,
      })),
    };
  }),
};

const archiveArgs = z.object({ from: opt(expenseDateSchema), to: opt(expenseDateSchema) });

export const listExpenseArchiveTool: AssistantReadToolPlugin = {
  name: "list_expense_archive",
  level: "A",
  description: "Удалённые расходы (корзина расходов) за период удаления, с id — их можно вернуть restore_expense.",
  parameters: { type: "object", properties: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" } } },
  statusPhrase: "Смотрю корзину расходов…",
  allowed: financeReadAllowed,
  run: guard(archiveArgs, async (args) => {
    const rows = await listArchivedExpenses(args.from, args.to);
    return {
      total: rows.length,
      items: rows.slice(0, 30).map((e) => ({
        id: e.id, title: plainField(e.note, 120), amount: Number(e.amount), currency: e.currency, category: e.category,
        month: e.month.toISOString().slice(0, 7), deletedAt: e.deletedAt?.toISOString().slice(0, 10) ?? null,
      })),
    };
  }),
};

export const listExpenseCategoriesTool: AssistantReadToolPlugin = {
  name: "list_expense_categories",
  level: "A",
  description: "Справочник подразделов расходов (id, название, раздел, бюджет, траты за месяц).",
  parameters: { type: "object", properties: { month: { type: "string", description: "YYYY-MM" } } },
  statusPhrase: "Смотрю категории расходов…",
  allowed: financeReadAllowed,
  run: guard(z.object({ month }), async (args) => {
    const rows = await listExpenseCategories(args.month ?? todayExpenseDay().slice(0, 7));
    return rows.slice(0, 60).map((c) => ({
      id: c.id, title: plainField(c.title, 80), rootCategory: c.rootCategory, parentId: c.parentId, active: c.active,
      budgetMonthly: c.budgetMonthly === null ? null : Number(c.budgetMonthly), spentTjs: c.spentTjs, usageCount: c.usageCount,
    }));
  }),
};

export const expenseReadTools: readonly AssistantReadToolPlugin[] = [
  listExpensesTool, getExpenseSummaryTool, getExpenseForecastTool, getExpensePivotTool,
  listRecurringExpensesTool, listExpenseArchiveTool, listExpenseCategoriesTool,
];

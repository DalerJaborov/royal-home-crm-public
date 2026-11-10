import { z } from "zod";
import {
  CLIENT_SOURCES, EXPENSE_CATEGORIES, EXPENSE_PAYMENT_METHODS, EXPENSE_PERIODS, expenseDateSchema, type ExpenseCategory,
} from "@royal-home/shared";
import { prisma } from "../../../db.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { logAgentAudit } from "../../../lib/audit.js";
import { AssistantActionError, type AssistantActionActor, type AssistantActionExecutor, type AssistantActionPreview } from "../../../lib/assistantActions.js";
import {
  changeRecurringOccurrence, createExpenseCategory, createRecurringExpense, deleteExpense, deleteRecurringExpense,
  restoreExpense, restoreRecurringExpense, setExpensePayment, updateExpense, updateExpenseCategory, updateRecurringExpense,
} from "../../../lib/expenseCommands.js";
import { plainField } from "./safeField.js";
import {
  asActionError, asPluginExecutor, assertFinanceWriter, categoryLabel, EXPENSE_LANGS, expenseLabels, findAgentByName,
  findCategoryByTitle, financeWriteAllowed, moneyText, type ExpenseLang,
} from "./expenseToolSupport.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * ИЗМЕНЕНИЯ РАСХОДОВ ЧЕРЕЗ ШАБНАМ (10.11.2026). Каждое — карточка «было → станет» с
 * кнопкой подтверждения и «Отмена»; исполнение — та же функция, что маршрут REST
 * (lib/expenseCommands.ts). Права — finance.view + finance.manage, свежие на нажатии.
 * В REST у расходов нет requireElevation (проверено по routes/expenses.ts и
 * routes/expenseWorkspace.ts 10.11.2026), поэтому кода Google Authenticator здесь нет;
 * появится step-up в REST — исполнитель обязан закрыть Telegram (`channels: ["crm"]`).
 */

const opt = <T extends z.ZodTypeAny>(schema: T) => schema.nullish().transform((v) => v ?? undefined);
const lang = opt(z.enum(EXPENSE_LANGS));
const monthSchema = z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/);

type Snapshot = Record<string, unknown>;

/** Действие в журнале — то же имя, что пишет REST-маршрут этого действия. */
const AUDIT_ACTION: Record<string, string> = {
  update_expense: "UPDATE", delete_expense: "DELETE", restore_expense: "RESTORE", pay_expense: "UPDATE",
  undo_expense_payment: "UPDATE", create_recurring_expense: "CREATE", update_recurring_expense: "UPDATE",
  delete_recurring_expense: "DELETE", recurring_expense_payment: "UPDATE", create_expense_category: "CREATE",
  update_expense_category: "UPDATE",
};
interface ExpenseToolSpec<A extends { lang?: ExpenseLang }> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  statusPhrase: string;
  schema: z.ZodType<A>;
  snapshot: (args: A) => Promise<Snapshot>;
  preview: (args: A, snapshot: Snapshot) => Promise<AssistantActionPreview> | AssistantActionPreview;
  execute: (args: A, snapshot: Snapshot, actor: AssistantActionActor) => Promise<{ result: unknown; entityType: string; entityId: string | null }>;
  undo?: (args: A, ctx: { result: unknown }) => Promise<void>;
  irreversible?: boolean;
}

function makeTool<A extends { lang?: ExpenseLang }>(spec: ExpenseToolSpec<A>): AssistantWriteToolPlugin {
  const executor: AssistantActionExecutor<A> = {
    tool: spec.name,
    requires: ["finance.view", "finance.manage"],
    channels: ["crm", "telegram"],
    privateTelegram: true,
    parseArgs(raw) {
      const parsed = spec.schema.safeParse(raw);
      if (!parsed.success) throw new AssistantActionError(400, "BAD_ARGS", "Не хватает данных для действия с расходом");
      return parsed.data;
    },
    async authorize(_args, actor) {
      await assertFinanceWriter(actor);
    },
    async snapshot(args, actor) {
      await assertFinanceWriter(actor);
      return spec.snapshot(args).catch(asActionError);
    },
    async buildPreview(args, snapshot) {
      const preview = await spec.preview(args, snapshot);
      return spec.irreversible ? { ...preview, irreversible: true } : preview;
    },
    async execute(args, actor, { snapshotBefore, actionId }) {
      await assertFinanceWriter(actor);
      const done = await spec.execute(args, snapshotBefore, actor).catch(asActionError);
      // История расхода, как у REST (logAudit), но с «было → стало» и источником: что где могло
      // пойти не так, видно в журнале действий и в get_expense_history (владелец 10.11.2026).
      const after = await spec.snapshot(args).catch(() => null);
      logAgentAudit(actor.agentId, AUDIT_ACTION[spec.name] ?? "UPDATE", done.entityType, done.entityId, {
        source: "assistant", tool: spec.name, actionId, channel: actor.channel,
        before: snapshotBefore as Prisma.InputJsonValue, after: (after ?? null) as Prisma.InputJsonValue,
      });
      return { result: done.result, audit: { entityType: done.entityType, entityId: done.entityId } };
    },
    ...(spec.undo ? {
      async undo(args: A, actor: AssistantActionActor, ctx: { result: unknown }) {
        await assertFinanceWriter(actor);
        await spec.undo!(args, ctx).catch(asActionError);
      },
    } : {}),
  };
  return {
    name: spec.name, level: "C", description: spec.description, parameters: spec.parameters,
    statusPhrase: spec.statusPhrase, allowed: financeWriteAllowed, executor: asPluginExecutor<A>(executor),
  };
}

// ─────────────────────────── одна строка расхода ───────────────────────────

async function loadExpense(id: string, { deleted = false } = {}) {
  const row = await prisma.expense.findUnique({ where: { id } });
  if (!row || (deleted ? !row.deletedAt : row.deletedAt)) {
    throw new AssistantActionError(404, "NOT_FOUND", deleted ? "В корзине расходов такой записи нет" : "Расход не найден");
  }
  return row;
}

type ExpenseRow = Awaited<ReturnType<typeof loadExpense>>;
function expenseView(row: ExpenseRow) {
  return {
    version: row.version, title: row.note, amount: row.amount.toString(), currency: row.currency, status: row.status,
    month: row.month.toISOString().slice(0, 7), date: row.paymentDate?.toISOString().slice(0, 10) ?? null,
    category: row.category, categoryId: row.categoryId, counterparty: row.counterparty, deleted: row.deletedAt !== null,
  };
}
/**
 * Подписи карточки одного расхода на языке собеседника (ru/tg). Рамка карточки в Telegram берёт язык
 * содержимого (renderBundleCard): таджикская подпись — таджикская рамка, без двух языков в одном сообщении.
 */
const PREVIEW = {
  ru: { expense: "Расход", amount: "Сумма", when: "Когда", root: "Раздел", status: "Статус", today: "сегодня",
    update: (t: string) => `Изменить расход «${t}»`, remove: (t: string) => `Удалить расход «${t}»`, restore: (t: string) => `Вернуть расход «${t}»`,
    pay: (t: string) => `Оплатить «${t}»`, unpay: (t: string) => `Отменить оплату «${t}»`,
    inTrash: "в корзине расходов", trash: "в корзине", removeRisk: "Пропадёт из сумм и отчётов; вернуть можно из корзины." },
  tg: { expense: "Харҷ", amount: "Маблағ", when: "Кай", root: "Модда", status: "Ҳолат", today: "имрӯз",
    update: (t: string) => `Тағйири харҷ «${t}»`, remove: (t: string) => `Харҷи «${t}»-ро нест кардан`, restore: (t: string) => `Харҷи «${t}»-ро баргардондан`,
    pay: (t: string) => `Пардохти харҷи «${t}»`, unpay: (t: string) => `Пардохти харҷи «${t}»-ро бекор кардан`,
    inTrash: "дар сабади харҷҳо", trash: "дар сабад", removeRisk: "Аз ҳисобу ҳисоботҳо мебарояд; аз сабад баргардондан мумкин аст." },
} as const;
const preview = (l: ExpenseLang | undefined) => PREVIEW[l === "tg" ? "tg" : "ru"];

function describe(view: Snapshot, l: ExpenseLang): Record<string, string> {
  const labels = expenseLabels(l);
  const p = preview(l);
  return {
    [p.expense]: plainField(String(view.title ?? ""), 100) ?? "—",
    [p.amount]: moneyText(Number(view.amount), view.currency as "TJS" | "USD", l),
    [p.when]: String(view.date ?? view.month),
    [p.root]: categoryLabel(l, view.category as ExpenseCategory),
    [p.status]: view.status === "PAID" ? labels.paid : labels.planned,
  };
}

const idArgs = z.object({ expenseId: z.uuid(), lang });
const idParams = (extra: Record<string, unknown> = {}) => ({
  type: "object",
  properties: { expenseId: { type: "string", description: "id расхода из list_expenses" }, lang: { type: "string", enum: [...EXPENSE_LANGS] }, ...extra },
  required: ["expenseId"],
});

const updateArgs = z.object({
  expenseId: z.uuid(), lang,
  title: opt(z.string().trim().min(1).max(300)),
  amount: opt(z.coerce.number().positive().max(99_999_999.99)),
  currency: opt(z.enum(["TJS", "USD"])),
  date: opt(expenseDateSchema),
  month: opt(monthSchema),
  category: opt(z.enum(EXPENSE_CATEGORIES)),
  categoryTitle: opt(z.string().trim().max(100)),
  counterparty: opt(z.string().trim().max(200)),
  paymentMethod: opt(z.enum(EXPENSE_PAYMENT_METHODS)),
  source: opt(z.enum(CLIENT_SOURCES)),
  agentName: opt(z.string().trim().max(120)),
}).refine((a) => Object.keys(a).some((k) => !["expenseId", "lang"].includes(k) && a[k as keyof typeof a] !== undefined), "nothing to change");

async function updateBody(args: z.infer<typeof updateArgs>): Promise<Record<string, unknown>> {
  const definition = await findCategoryByTitle(args.categoryTitle);
  if (args.categoryTitle && !definition) throw new AssistantActionError(400, "CATEGORY_NOT_FOUND", `Подраздел «${plainField(args.categoryTitle, 60)}» не найден`);
  const agent = args.agentName ? await findAgentByName(args.agentName) : null;
  if (args.agentName && !agent) throw new AssistantActionError(400, "AGENT_NOT_FOUND", "Не нашла одного такого сотрудника — уточните имя");
  return {
    ...(args.title !== undefined ? { note: args.title } : {}),
    ...(args.amount !== undefined ? { amount: args.amount } : {}),
    ...(args.currency !== undefined ? { currency: args.currency } : {}),
    ...(args.date !== undefined ? { paymentDate: args.date } : {}),
    ...(args.month !== undefined ? { month: args.month } : {}),
    ...(definition ? { category: definition.rootCategory, categoryId: definition.id } : args.category ? { category: args.category } : {}),
    ...(args.counterparty !== undefined ? { counterparty: args.counterparty } : {}),
    ...(args.paymentMethod !== undefined ? { paymentMethod: args.paymentMethod } : {}),
    ...(args.source !== undefined ? { source: args.source } : {}),
    ...(agent ? { agentId: agent.id } : {}),
  };
}

const updateExpenseTool = makeTool({
  name: "update_expense",
  description: "Изменить записанный расход (название, сумму, валюту, дату, месяц, раздел, контрагента) по id из list_expenses. " +
    "Карточка «было → станет», человек подтверждает. Передавай только то, что меняют.",
  parameters: idParams({
    title: { type: "string" }, amount: { type: "number" }, currency: { type: "string", enum: ["TJS", "USD"] },
    date: { type: "string", description: "Дата оплаты YYYY-MM-DD" }, month: { type: "string", description: "YYYY-MM" },
    category: { type: "string", enum: [...EXPENSE_CATEGORIES] }, categoryTitle: { type: "string" },
    counterparty: { type: "string" }, source: { type: "string", enum: [...CLIENT_SOURCES] }, agentName: { type: "string" },
  }),
  statusPhrase: "Готовлю правку расхода…",
  schema: updateArgs,
  snapshot: async (args) => expenseView(await loadExpense(args.expenseId)),
  async preview(args, snapshot) {
    const l = args.lang ?? "ru";
    const body = await updateBody(args);
    const after = {
      ...snapshot,
      ...(body.note !== undefined ? { title: body.note } : {}),
      ...(body.amount !== undefined ? { amount: String(body.amount) } : {}),
      ...(body.currency !== undefined ? { currency: body.currency } : {}),
      ...(body.paymentDate !== undefined ? { date: body.paymentDate } : {}),
      ...(body.month !== undefined ? { month: body.month } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
    };
    return { title: preview(l).update(plainField(String(snapshot.title ?? ""), 60) ?? ""), was: describe(snapshot, l), becomes: describe(after, l) };
  },
  async execute(args, snapshot) {
    const { expense } = await updateExpense(args.expenseId, { ...(await updateBody(args)), version: Number(snapshot.version) });
    return { result: { expenseId: expense.id }, entityType: "Expense", entityId: expense.id };
  },
});

const deleteExpenseTool = makeTool({
  name: "delete_expense",
  description: "Удалить расход по id (в корзину расходов, его можно вернуть restore_expense). Карточка подтверждения.",
  parameters: idParams(),
  statusPhrase: "Готовлю удаление расхода…",
  schema: idArgs,
  snapshot: async (args) => expenseView(await loadExpense(args.expenseId)),
  preview: (args, snapshot) => ({
    title: preview(args.lang).remove(plainField(String(snapshot.title ?? ""), 60) ?? ""),
    was: describe(snapshot, args.lang ?? "ru"),
    becomes: { [preview(args.lang).expense]: preview(args.lang).inTrash },
    risk: preview(args.lang).removeRisk,
  }),
  async execute(args, snapshot) {
    const row = await deleteExpense(args.expenseId, Number(snapshot.version));
    return { result: { expenseId: row.id }, entityType: "Expense", entityId: row.id };
  },
  undo: async (args) => { await restoreExpense(args.expenseId); },
});

const restoreExpenseTool = makeTool({
  name: "restore_expense",
  description: "Вернуть удалённый расход из корзины расходов по id из list_expense_archive.",
  parameters: idParams(),
  statusPhrase: "Готовлю возврат расхода…",
  schema: idArgs,
  snapshot: async (args) => expenseView(await loadExpense(args.expenseId, { deleted: true })),
  preview: (args, snapshot) => ({
    title: preview(args.lang).restore(plainField(String(snapshot.title ?? ""), 60) ?? ""),
    was: { [preview(args.lang).expense]: preview(args.lang).trash },
    becomes: describe(snapshot, args.lang ?? "ru"),
  }),
  async execute(args) {
    const row = await restoreExpense(args.expenseId);
    return { result: { expenseId: row.id }, entityType: "Expense", entityId: row.id };
  },
});

const payArgs = z.object({ expenseId: z.uuid(), lang, paymentDate: opt(expenseDateSchema) });

const payExpenseTool = makeTool({
  name: "pay_expense",
  description: "Отметить расход «ждёт оплаты» оплаченным (paymentDate — день оплаты, по умолчанию сегодня). Будущую дату нельзя.",
  parameters: idParams({ paymentDate: { type: "string", description: "YYYY-MM-DD" } }),
  statusPhrase: "Готовлю оплату…",
  schema: payArgs,
  snapshot: async (args) => expenseView(await loadExpense(args.expenseId)),
  preview(args, snapshot) {
    if (snapshot.status === "PAID") throw new AssistantActionError(409, "ALREADY_PAID", "Этот расход уже оплачен");
    const l = args.lang ?? "ru";
    return { title: preview(l).pay(plainField(String(snapshot.title ?? ""), 60) ?? ""), was: describe(snapshot, l),
      becomes: { [preview(l).status]: expenseLabels(l).paid, [preview(l).when]: args.paymentDate ?? preview(l).today } };
  },
  async execute(args) {
    const row = await setExpensePayment(args.expenseId, true, args.paymentDate ? { paymentDate: args.paymentDate } : {});
    return { result: { expenseId: row.id }, entityType: "Expense", entityId: row.id };
  },
  undo: async (args) => { await setExpensePayment(args.expenseId, false, {}); },
});

const undoPaymentTool = makeTool({
  name: "undo_expense_payment",
  description: "Отменить отметку об оплате расхода (вернуть в «ждёт оплаты»), если её ставили кнопкой «Оплатить».",
  parameters: idParams(),
  statusPhrase: "Готовлю отмену оплаты…",
  schema: idArgs,
  snapshot: async (args) => expenseView(await loadExpense(args.expenseId)),
  preview(args, snapshot) {
    if (snapshot.status !== "PAID") throw new AssistantActionError(409, "NOT_PAID", "Этот расход и так не оплачен");
    const l = args.lang ?? "ru";
    return { title: preview(l).unpay(plainField(String(snapshot.title ?? ""), 60) ?? ""), was: describe(snapshot, l),
      becomes: { [preview(l).status]: expenseLabels(l).planned } };
  },
  async execute(args) {
    const row = await setExpensePayment(args.expenseId, false, {});
    return { result: { expenseId: row.id }, entityType: "Expense", entityId: row.id };
  },
});

// ─────────────────────────── повторяющиеся ───────────────────────────

async function loadRecurring(id: string, { deleted = false } = {}) {
  const row = await prisma.recurringExpense.findUnique({ where: { id } });
  if (!row || (deleted ? !row.deletedAt : row.deletedAt)) throw new AssistantActionError(404, "NOT_FOUND", "Повторяющийся платёж не найден");
  return row;
}
type RecurringRow = Awaited<ReturnType<typeof loadRecurring>>;
const recurringView = (row: RecurringRow) => ({
  title: row.title, amount: row.amount.toString(), currency: row.currency, category: row.category, dayOfMonth: row.dayOfMonth,
  period: row.period, active: row.active, autoPay: row.autoPay, startsOn: row.startsOn, endsOn: row.endsOn,
  skippedDates: row.skippedDates, deleted: row.deletedAt !== null, updatedAt: row.updatedAt.toISOString(),
});
function describeRecurring(view: Snapshot, l: ExpenseLang): Record<string, string> {
  return {
    Платёж: plainField(String(view.title ?? ""), 100) ?? "—",
    Сумма: moneyText(Number(view.amount), view.currency as "TJS" | "USD", l),
    Число: String(view.dayOfMonth),
    Раздел: categoryLabel(l, view.category as ExpenseCategory),
    Включён: view.active ? "да" : "нет",
  };
}

const recurringFields = {
  title: opt(z.string().trim().min(1).max(200)),
  amount: opt(z.coerce.number().positive().max(99_999_999.99)),
  currency: opt(z.enum(["TJS", "USD"])),
  category: opt(z.enum(EXPENSE_CATEGORIES)),
  categoryTitle: opt(z.string().trim().max(100)),
  dayOfMonth: opt(z.coerce.number().int().min(1).max(31)),
  period: opt(z.enum(EXPENSE_PERIODS)),
  startsOn: opt(expenseDateSchema),
  endsOn: opt(expenseDateSchema),
  autoPay: opt(z.boolean()),
  counterparty: opt(z.string().trim().max(200)),
  paymentMethod: opt(z.enum(EXPENSE_PAYMENT_METHODS)),
  note: opt(z.string().max(500)),
  source: opt(z.enum(CLIENT_SOURCES)),
  agentName: opt(z.string().trim().max(120)),
};
const recurringParams = {
  title: { type: "string" }, amount: { type: "number" }, currency: { type: "string", enum: ["TJS", "USD"] },
  category: { type: "string", enum: [...EXPENSE_CATEGORIES] }, categoryTitle: { type: "string" },
  dayOfMonth: { type: "number", description: "Число месяца 1–31" }, period: { type: "string", enum: [...EXPENSE_PERIODS] },
  startsOn: { type: "string", description: "YYYY-MM-DD" }, endsOn: { type: "string", description: "YYYY-MM-DD" },
  autoPay: { type: "boolean", description: "Отмечать оплаченным автоматически" },
  counterparty: { type: "string" }, source: { type: "string", enum: [...CLIENT_SOURCES] }, agentName: { type: "string" },
  lang: { type: "string", enum: [...EXPENSE_LANGS] },
};

async function recurringBody(args: Partial<Record<keyof typeof recurringFields, unknown>>): Promise<Record<string, unknown>> {
  const definition = await findCategoryByTitle(args.categoryTitle as string | undefined);
  if (args.categoryTitle && !definition) throw new AssistantActionError(400, "CATEGORY_NOT_FOUND", "Такого подраздела нет в справочнике");
  const agent = args.agentName ? await findAgentByName(args.agentName as string) : null;
  if (args.agentName && !agent) throw new AssistantActionError(400, "AGENT_NOT_FOUND", "Не нашла одного такого сотрудника — уточните имя");
  const { categoryTitle: _c, agentName: _a, ...rest } = args;
  void _c; void _a;
  return Object.fromEntries(Object.entries({
    ...rest,
    ...(definition ? { category: definition.rootCategory, categoryId: definition.id } : {}),
    ...(agent ? { agentId: agent.id } : {}),
  }).filter(([, v]) => v !== undefined));
}

const createRecurringArgs = z.object({ ...recurringFields, title: z.string().trim().min(1).max(200), amount: z.coerce.number().positive().max(99_999_999.99), dayOfMonth: z.coerce.number().int().min(1).max(31), lang });

const createRecurringTool = makeTool({
  name: "create_recurring_expense",
  description: "Завести повторяющийся платёж (аренда, интернет, подписка): название, сумма, число месяца, раздел, период. Карточка подтверждения.",
  parameters: { type: "object", properties: recurringParams, required: ["title", "amount", "dayOfMonth"] },
  statusPhrase: "Готовлю повторяющийся платёж…",
  schema: createRecurringArgs,
  snapshot: async () => ({}),
  async preview(args) {
    const body = await recurringBody(args);
    return { title: `Новый повторяющийся платёж «${plainField(args.title, 60) ?? ""}»`, was: {},
      becomes: describeRecurring({ ...body, amount: String(args.amount), currency: args.currency ?? "TJS", category: body.category ?? "OFFICE", active: true }, args.lang ?? "ru") };
  },
  async execute(args) {
    const row = await createRecurringExpense(await recurringBody(args));
    return { result: { recurringId: row.id }, entityType: "RecurringExpense", entityId: row.id };
  },
  undo: async (_args, { result }) => { await deleteRecurringExpense((result as { recurringId: string }).recurringId); },
});

const updateRecurringArgs = z.object({ recurringId: z.uuid(), active: opt(z.boolean()), ...recurringFields, lang });

const updateRecurringTool = makeTool({
  name: "update_recurring_expense",
  description: "Изменить повторяющийся платёж по id из list_recurring_expenses: сумму, число, период, включить/выключить (active).",
  parameters: { type: "object", properties: { recurringId: { type: "string" }, active: { type: "boolean" }, ...recurringParams }, required: ["recurringId"] },
  statusPhrase: "Готовлю правку платежа…",
  schema: updateRecurringArgs,
  snapshot: async (args) => recurringView(await loadRecurring(args.recurringId)),
  async preview(args, snapshot) {
    const { recurringId: _r, lang: l, ...patch } = args;
    void _r;
    const body = await recurringBody(patch);
    if (!Object.keys(body).length && patch.active === undefined) throw new AssistantActionError(400, "BAD_ARGS", "Что изменить в платеже?");
    const after = { ...snapshot, ...body, ...(body.amount !== undefined ? { amount: String(body.amount) } : {}), ...(patch.active !== undefined ? { active: patch.active } : {}) };
    return { title: `Изменить платёж «${plainField(String(snapshot.title ?? ""), 60) ?? ""}»`, was: describeRecurring(snapshot, l ?? "ru"), becomes: describeRecurring(after, l ?? "ru") };
  },
  async execute(args) {
    const { recurringId, lang: _l, active, ...patch } = args;
    void _l;
    const { row } = await updateRecurringExpense(recurringId, { ...(await recurringBody(patch)), ...(active !== undefined ? { active } : {}) });
    return { result: { recurringId: row.id }, entityType: "RecurringExpense", entityId: row.id };
  },
});

const recurringIdArgs = z.object({ recurringId: z.uuid(), lang });
const recurringIdParams = { type: "object", properties: { recurringId: { type: "string" }, lang: { type: "string", enum: [...EXPENSE_LANGS] } }, required: ["recurringId"] };

const deleteRecurringTool = makeTool({
  name: "delete_recurring_expense",
  description: "Удалить повторяющийся платёж по id (шаблон уходит в корзину, уже записанные платежи остаются).",
  parameters: recurringIdParams,
  statusPhrase: "Готовлю удаление платежа…",
  schema: recurringIdArgs,
  snapshot: async (args) => recurringView(await loadRecurring(args.recurringId)),
  preview: (args, snapshot) => ({
    title: `Удалить повторяющийся платёж «${plainField(String(snapshot.title ?? ""), 60) ?? ""}»`,
    was: describeRecurring(snapshot, args.lang ?? "ru"), becomes: { Платёж: "больше не будет ставиться" },
    risk: "Записанные платежи останутся; шаблон можно вернуть.",
  }),
  async execute(args) {
    await deleteRecurringExpense(args.recurringId);
    return { result: { recurringId: args.recurringId }, entityType: "RecurringExpense", entityId: args.recurringId };
  },
  undo: async (args) => { await restoreRecurringExpense(args.recurringId); },
});

const occurrenceArgs = z.object({
  recurringId: z.uuid(), dueDate: expenseDateSchema, action: z.enum(["pay", "skip", "undo", "undo-payment"]),
  paymentDate: opt(expenseDateSchema), lang,
});
const OCCURRENCE_TITLE = { pay: "Оплатить", skip: "Пропустить", undo: "Вернуть пропущенный", "undo-payment": "Отменить оплату" } as const;

const recurringOccurrenceTool = makeTool({
  name: "recurring_expense_payment",
  description: "Платёж повторяющегося расхода за дату (dueDate из list_recurring_expenses): action=pay — оплатить, skip — пропустить " +
    "в этом периоде, undo — вернуть пропущенный, undo-payment — отменить оплату.",
  parameters: {
    type: "object",
    properties: {
      recurringId: { type: "string" }, dueDate: { type: "string", description: "YYYY-MM-DD" },
      action: { type: "string", enum: ["pay", "skip", "undo", "undo-payment"] }, paymentDate: { type: "string", description: "YYYY-MM-DD" },
      lang: { type: "string", enum: [...EXPENSE_LANGS] },
    },
    required: ["recurringId", "dueDate", "action"],
  },
  statusPhrase: "Готовлю платёж…",
  schema: occurrenceArgs,
  snapshot: async (args) => recurringView(await loadRecurring(args.recurringId)),
  preview: (args, snapshot) => ({
    title: `${OCCURRENCE_TITLE[args.action]}: «${plainField(String(snapshot.title ?? ""), 60) ?? ""}» за ${args.dueDate}`,
    was: describeRecurring(snapshot, args.lang ?? "ru"),
    becomes: { Действие: OCCURRENCE_TITLE[args.action], Дата: args.paymentDate ?? args.dueDate },
  }),
  async execute(args, _snapshot, actor) {
    const { expense } = await changeRecurringOccurrence(args.recurringId, args.action,
      { dueDate: args.dueDate, ...(args.paymentDate ? { paymentDate: args.paymentDate } : {}) }, actor.agentId);
    return { result: { recurringId: args.recurringId, expenseId: expense?.id ?? null }, entityType: "RecurringExpense", entityId: args.recurringId };
  },
});

// ─────────────────────────── категории ───────────────────────────

const createCategoryArgs = z.object({
  title: z.string().trim().min(1).max(100), rootCategory: z.enum(EXPENSE_CATEGORIES),
  parentTitle: opt(z.string().trim().max(100)), budgetMonthly: opt(z.coerce.number().min(0).max(99_999_999.99)), lang,
});

const createCategoryTool = makeTool({
  name: "create_expense_category",
  description: "Добавить подраздел в справочник расходов (например «Аренда» в разделе OFFICE), с бюджетом на месяц по желанию.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" }, rootCategory: { type: "string", enum: [...EXPENSE_CATEGORIES] },
      parentTitle: { type: "string", description: "Родительский подраздел, если есть" }, budgetMonthly: { type: "number" },
      lang: { type: "string", enum: [...EXPENSE_LANGS] },
    },
    required: ["title", "rootCategory"],
  },
  statusPhrase: "Готовлю подраздел…",
  schema: createCategoryArgs,
  snapshot: async () => ({}),
  async preview(args) {
    if (await findCategoryByTitle(args.title)) throw new AssistantActionError(409, "EXISTS", "Такой подраздел уже есть");
    return { title: `Новый подраздел «${plainField(args.title, 60) ?? ""}»`, was: {},
      becomes: { Подраздел: args.title, Раздел: categoryLabel(args.lang ?? "ru", args.rootCategory),
        ...(args.budgetMonthly !== undefined ? { Бюджет: moneyText(args.budgetMonthly, "TJS", args.lang ?? "ru") } : {}) } };
  },
  async execute(args) {
    const parent = args.parentTitle ? await findCategoryByTitle(args.parentTitle) : null;
    if (args.parentTitle && !parent) throw new AssistantActionError(400, "CATEGORY_NOT_FOUND", "Родительский подраздел не найден");
    const row = await createExpenseCategory({
      title: args.title, rootCategory: args.rootCategory, icon: "tag", color: "#7F97B4",
      ...(parent ? { parentId: parent.id } : {}), ...(args.budgetMonthly !== undefined ? { budgetMonthly: args.budgetMonthly } : {}),
    });
    return { result: { categoryId: row.id }, entityType: "ExpenseCategoryDefinition", entityId: row.id };
  },
});

const updateCategoryArgs = z.object({
  categoryId: z.uuid(), title: opt(z.string().trim().min(1).max(100)), budgetMonthly: opt(z.coerce.number().min(0).max(99_999_999.99)),
  active: opt(z.boolean()), lang,
});

const updateCategoryTool = makeTool({
  name: "update_expense_category",
  description: "Изменить подраздел справочника расходов по id из list_expense_categories: название, бюджет, скрыть (active=false) или вернуть.",
  parameters: {
    type: "object",
    properties: { categoryId: { type: "string" }, title: { type: "string" }, budgetMonthly: { type: "number" }, active: { type: "boolean" }, lang: { type: "string", enum: [...EXPENSE_LANGS] } },
    required: ["categoryId"],
  },
  statusPhrase: "Готовлю правку подраздела…",
  schema: updateCategoryArgs,
  async snapshot(args) {
    const row = await prisma.expenseCategoryDefinition.findUnique({ where: { id: args.categoryId } });
    if (!row) throw new AssistantActionError(404, "NOT_FOUND", "Подраздел не найден");
    return { title: row.title, budgetMonthly: row.budgetMonthly?.toString() ?? null, active: row.active, updatedAt: row.updatedAt.toISOString() };
  },
  preview: (args, snapshot) => ({
    title: `Изменить подраздел «${plainField(String(snapshot.title ?? ""), 60) ?? ""}»`,
    was: { Название: String(snapshot.title), Бюджет: String(snapshot.budgetMonthly ?? "—"), Виден: snapshot.active ? "да" : "нет" },
    becomes: {
      Название: args.title ?? String(snapshot.title),
      Бюджет: args.budgetMonthly !== undefined ? String(args.budgetMonthly) : String(snapshot.budgetMonthly ?? "—"),
      Виден: (args.active ?? snapshot.active) ? "да" : "нет",
    },
  }),
  async execute(args) {
    const row = await updateExpenseCategory(args.categoryId, {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.budgetMonthly !== undefined ? { budgetMonthly: args.budgetMonthly } : {}),
      ...(args.active !== undefined ? { active: args.active } : {}),
    });
    return { result: { categoryId: row.id }, entityType: "ExpenseCategoryDefinition", entityId: row.id };
  },
});


export const expenseWriteTools: readonly AssistantWriteToolPlugin[] = [
  updateExpenseTool, deleteExpenseTool, restoreExpenseTool, payExpenseTool, undoPaymentTool,
  createRecurringTool, updateRecurringTool, deleteRecurringTool, recurringOccurrenceTool,
  createCategoryTool, updateCategoryTool,
];

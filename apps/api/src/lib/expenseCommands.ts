import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CLIENT_SOURCES, expenseCategorySchema, expenseCreateSchema, expensePaymentSchema, expenseUpdateSchema,
  recurringOccurrenceSchema, recurringWorkspaceFields, type ClientSource,
} from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { Prisma, type Expense, type RecurringExpense } from "../generated/prisma/client.js";
import { NO_USD_RATE_TEXT, roundMoney, usdRateForWrite, type MoneyContext } from "./money.js";
import {
  changeExpensePayment, expenseDay, ExpenseLifecycleError, materializeOccurrence, occurrenceDates, todayExpenseDay,
  validateExpenseCategory,
} from "./expenseWorkspace.js";

/**
 * ОДНА ДВЕРЬ ЗАПИСИ РАСХОДОВ (10.11.2026).
 *
 * Раньше тела маршрутов `routes/expenses.ts` и `routes/expenseWorkspace.ts` были
 * единственным местом, где жили правила записи (категория раздела, «будущий платёж —
 * план», ключ повтора, обнуление чужих полей категории). Помощница Шабнам и чек из
 * Telegram писали в базу в обход — со своими упрощёнными проверками. Теперь и REST,
 * и помощница зовут ЭТИ функции; маршрут только разбирает HTTP и пишет аудит.
 *
 * Ошибка правила — `ExpenseCommandError` с готовым телом ответа REST: маршрут
 * отдаёт его как есть, поэтому поведение REST не изменилось ни в коде, ни в тексте.
 */
export class ExpenseCommandError extends Error {
  constructor(readonly status: number, readonly body: { error: string; [key: string]: unknown }) {
    super(body.error);
    this.name = "ExpenseCommandError";
  }
}

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): never => {
  throw new ExpenseCommandError(status, { error, ...extra });
};

/** "2026-07" → Date первого дня месяца (UTC, чтобы не плавать по таймзонам). */
export function expenseMonthToDate(month: string): Date {
  return new Date(`${month}-01T00:00:00.000Z`);
}

const IDEMPOTENCY_HEADER_KEY = /^[A-Za-z0-9:_-]{8,120}$/;

export interface CreateExpenseOptions {
  agentId: string;
  /** Заголовок Idempotency-Key из REST: проверяется здесь, в том же порядке, что раньше. */
  idempotencyKey?: string;
  /** Внутренний ключ повтора (помощница, чек): пишется как есть, без префикса сотрудника. */
  requestKey?: string;
  db?: TxClient;
  /** Курс, уже прочитанный для пачки: одна выборка Настроек на пачку, а не на строку. */
  money?: MoneyContext;
}

/** POST /expenses. Возвращает строку и месяц из запроса (для аудита). */
export async function createExpense(raw: unknown, opts: CreateExpenseOptions): Promise<{ expense: Expense; month: string }> {
  const parsed = expenseCreateSchema.safeParse(raw);
  if (!parsed.success) fail(400, "Неверные данные", { details: parsed.error!.flatten() });
  const { month, ...rest } = parsed.data!;
  if (rest.amount > 99_999_999.99) fail(400, "Сумма слишком большая");
  if (!await validateExpenseCategory(rest.categoryId, rest.category)) fail(400, "Выберите категорию соответствующего раздела");
  const key = opts.idempotencyKey;
  if (key && !IDEMPOTENCY_HEADER_KEY.test(key)) fail(400, "Неверный ключ запроса");
  const requestKey = opts.requestKey ?? (key ? `${opts.agentId}:${key}` : undefined);
  const db = opts.db ?? prisma;
  const fingerprint = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");
  // Доллар без своего курса пишется только по курсу из Настроек: запасное число FALLBACK_USD_TO_TJS
  // курсом не является (решение владельца 10.11.2026; та же дверь у помощницы) — без курса 409.
  const needsRate = rest.currency === "USD" && rest.exchangeRate == null && rest.status !== "PLANNED";
  const settingsRate = needsRate ? await usdRateForWrite(db, opts.money) : null;
  if (needsRate && !settingsRate) fail(409, NO_USD_RATE_TEXT, { code: "NO_USD_RATE" });
  const rate = rest.currency === "USD" ? (rest.exchangeRate ?? (rest.status === "PLANNED" ? null : settingsRate)) : 1;
  const data = {
    ...rest,
    paymentDate: rest.paymentDate ? expenseDay(rest.paymentDate) : null,
    month: expenseMonthToDate((rest.status ?? "PAID") === "PAID" && rest.paymentDate ? rest.paymentDate.slice(0, 7) : month),
    createdById: opts.agentId,
    exchangeRate: rate,
    rateCapturedAt: rate != null ? new Date() : null,
    requestKey,
    ...(requestKey ? { autoFingerprint: fingerprint } : {}),
  };
  if ((rest.status ?? "PAID") === "PAID" && rest.paymentDate && rest.paymentDate > todayExpenseDay()) {
    fail(400, "Будущий платёж запишите как план");
  }
  const expense = requestKey
    ? await db.expense.upsert({ where: { requestKey }, update: {}, create: data })
    : await db.expense.create({ data });
  if (requestKey && expense.autoFingerprint !== fingerprint) {
    fail(409, "Этот ключ уже использован для другого расхода", { code: "IDEMPOTENCY_CONFLICT" });
  }
  return { expense, month };
}

/** PATCH /expenses/:id. `changed` — поля запроса, для аудита. */
export async function updateExpense(id: string, raw: unknown): Promise<{ expense: Expense; changed: string[] }> {
  const parsed = expenseUpdateSchema.safeParse(raw);
  if (!parsed.success) fail(400, "Неверные данные", { details: parsed.error!.flatten() });
  const { month, version, ...rest } = parsed.data!;
  // expenseUpdateSchema — partial без superRefine создания, поэтому обязательность
  // проверяется здесь, по ИТОГОВОМУ состоянию строки (26.08.2026): раньше PATCH
  // { category: "ADVERTISING" } по расходу без канала проходил молча, и стоимость
  // лида по каналам теряла эту сумму; обратная смена оставляла устаревший source.
  const current = await prisma.expense.findUnique({ where: { id } });
  if (!current || current.deletedAt) fail(404, "Расход не найден");
  const row = current!;
  // Cached legacy clients may still issue a deliberate one-field PATCH. A full
  // form snapshot without its opening version must never overwrite newer edits.
  const changedFields = Object.keys(parsed.data!).filter(key => key !== "version");
  if (version === undefined && changedFields.length > 1) {
    fail(409, "Обновите страницу и снова откройте расход: старая форма не передаёт версию записи", { code: "EXPENSE_VERSION_REQUIRED" });
  }
  if (version !== undefined && version !== row.version) {
    fail(409, "Расход изменён другим сотрудником. Обновите запись перед сохранением", { code: "EXPENSE_VERSION_CONFLICT" });
  }
  if (rest.amount !== undefined && rest.amount > 99_999_999.99) fail(400, "Сумма слишком большая");
  if (!await validateExpenseCategory(rest.categoryId === undefined ? row.categoryId : rest.categoryId, rest.category ?? row.category, row)) {
    fail(400, "Категория не соответствует разделу");
  }
  // Смена валюты на доллар без курса — тот же отказ, что у создания (без FALLBACK_USD_TO_TJS).
  const switchesToUsd = rest.exchangeRate === undefined && rest.currency === "USD" && rest.currency !== row.currency;
  const switchRate = switchesToUsd ? await usdRateForWrite() : null;
  if (switchesToUsd && !switchRate) fail(409, NO_USD_RATE_TEXT, { code: "NO_USD_RATE" });
  const money = { usdToTjs: switchRate ?? 1 };
  const finalPaymentDate = rest.paymentDate === undefined ? row.paymentDate?.toISOString().slice(0, 10) : rest.paymentDate;
  if ((rest.status ?? row.status) === "PAID" && finalPaymentDate && finalPaymentDate > todayExpenseDay()) {
    fail(400, "Будущий платёж запишите как план");
  }
  const finalCategory = rest.category ?? row.category;
  const finalSource = rest.source === undefined ? row.source : rest.source;
  const finalAgentId = rest.agentId === undefined ? row.agentId : rest.agentId;
  const finalNote = rest.note === undefined ? row.note : rest.note;
  if (finalCategory === "ADVERTISING" && !finalSource) fail(400, "Укажите канал рекламы");
  if (finalCategory === "SALARY" && !finalAgentId) fail(400, "Укажите сотрудника");
  if ((finalCategory === "OFFICE" || finalCategory === "OTHER") && !finalNote?.trim()) {
    fail(400, "Укажите комментарий — куда пошли деньги");
  }
  // Поля чужой категории обнуляются сами: канал имеет смысл только у рекламы,
  // сотрудник — только у зарплаты; оставить их значит врать отчётам.
  const clearStale = {
    ...(finalCategory !== "ADVERTISING" ? { source: null } : {}),
    ...(finalCategory !== "SALARY" ? { agentId: null } : {}),
  };
  try {
    const expense = await prisma.expense.update({
      where: { id, version: version ?? row.version, deletedAt: null },
      data: {
        ...rest,
        ...clearStale,
        version: { increment: 1 }, paymentUndo: Prisma.DbNull,
        ...(rest.paymentDate !== undefined ? { paymentDate: rest.paymentDate ? expenseDay(rest.paymentDate) : null } : {}),
        ...(rest.exchangeRate !== undefined
          ? { exchangeRate: (rest.currency ?? row.currency) === "USD" ? rest.exchangeRate : 1, rateCapturedAt: rest.exchangeRate != null ? new Date() : null }
          : rest.currency !== undefined && rest.currency !== row.currency
            ? { exchangeRate: rest.currency === "USD" ? money.usdToTjs : 1, rateCapturedAt: new Date() }
            : {}),
        ...((rest.status ?? row.status) === "PAID" && rest.paymentDate
          ? { month: expenseMonthToDate(rest.paymentDate.slice(0, 7)) }
          : month ? { month: expenseMonthToDate(month) } : {}),
        // Правку СУММЫ у авто-строки помечаем: ночная автоматика (зарплаты,
        // реклама, ИИ) такую строку больше не пересчитывает — раньше она молча
        // откатывала исправление директора ближайшей ночью (аудит №4).
        ...(rest.amount !== undefined && row.autoKey ? { manualEditedAt: new Date() } : {}),
      },
    });
    return { expense, changed: Object.keys(parsed.data!) };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      fail(409, "Расход изменён другим сотрудником. Обновите запись перед сохранением", { code: "EXPENSE_VERSION_CONFLICT" });
    }
    throw err;
  }
}

/** DELETE /expenses/:id — мягкое удаление: запись остаётся в архиве. */
export async function deleteExpense(id: string, version?: number): Promise<Expense> {
  try {
    return await prisma.expense.update({
      where: { id, ...(version !== undefined ? { version, deletedAt: null } : {}) },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      if (version !== undefined) fail(409, "Расход уже изменён. Обновите запись перед удалением", { code: "EXPENSE_VERSION_CONFLICT" });
      fail(404, "Расход не найден");
    }
    throw err;
  }
}

/** PATCH /expenses/:id/restore — вернуть из архива. */
export async function restoreExpense(id: string): Promise<Expense> {
  try {
    return await prisma.expense.update({ where: { id }, data: { deletedAt: null } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") fail(404, "Расход не найден");
    throw err;
  }
}

/** POST /expenses/:id/pay и /:id/undo-payment. */
export async function setExpensePayment(id: string, paid: boolean, raw: unknown): Promise<Expense> {
  const p = expensePaymentSchema.safeParse(raw);
  if (!p.success) fail(400, "Неверная дата");
  try {
    return await changeExpensePayment(id, paid, p.data!.paymentDate);
  } catch (error) {
    if (error instanceof ExpenseLifecycleError) fail(error.status, error.message);
    throw error;
  }
}

// ─────────────────────────── повторяющиеся платежи ───────────────────────────

/**
 * Поля шаблона БЕЗ значений по умолчанию: на них строится и создание, и правка.
 * `.partial()` схемы со значениями по умолчанию в Zod 4 всё равно подставляет их
 * (category=OFFICE, currency=TJS), и любая правка шаблона («выключить», «сумма»)
 * молча затирала категорию и валюту (найдено при CRM-07, 04.10.2026).
 */
const recurringFields = {
  ...recurringWorkspaceFields,
  title: z.string().min(1).max(200),
  // До копейки, как любые деньги на входе (C14, 02.10.2026; правило — в
  // packages/shared/src/schemas.ts у money()): доли копейки из шаблона уходили
  // в авто-строку расхода каждый месяц.
  amount: z.coerce.number().transform(roundMoney).pipe(z.number().positive().max(99_999_999.99)),
  currency: z.enum(["TJS", "USD"]),
  category: z.enum(["ADVERTISING", "SALARY", "OFFICE", "OTHER"]),
  /** 1–31; occurrenceDates clamps only the occurrence in a shorter month. */
  dayOfMonth: z.coerce.number().int().min(1).max(31),
  note: z.string().max(500).optional(),
  // nullish, не optional: канал/сотрудника при смене категории надо уметь ЯВНО
  // стереть (undefined выпадает из JSON и очисткой не является).
  source: z.enum(CLIENT_SOURCES).nullish(),
  agentId: z.guid().nullish(),
};

/**
 * Что обязательно у шаблона, как у expenseCreateSchema (CRM-07, решение владельца
 * 04.10.2026): реклама — канал, зарплата — сотрудник; для остальных категорий они не
 * нужны. Нужны, потому что ночная задача копирует их в расход, а расход без канала
 * выпадает из стоимости лида, без сотрудника не правится.
 */
function recurringAttributionIssue(
  category: string,
  source: string | null | undefined,
  agentId: string | null | undefined
): { path: "source" | "agentId"; message: string } | null {
  if (category === "ADVERTISING" && !source) return { path: "source", message: "Укажите канал рекламы" };
  if (category === "SALARY" && !agentId) return { path: "agentId", message: "Укажите сотрудника" };
  return null;
}

export const recurringSchema = z
  .object({
    ...recurringFields,
    currency: recurringFields.currency.default("TJS"),
    category: recurringFields.category.default("OFFICE"),
  })
  .superRefine((data, ctx) => {
    const issue = recurringAttributionIssue(data.category, data.source, data.agentId);
    if (issue) ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
  });

export const recurringPatchSchema = z.object(recurringFields).partial().extend({ active: z.boolean().optional() });

/** POST /expenses/recurring. */
export async function createRecurringExpense(raw: unknown): Promise<RecurringExpense> {
  const parsed = recurringSchema.safeParse(raw);
  if (!parsed.success) fail(400, "Неверные данные", { details: parsed.error!.flatten() });
  const data = parsed.data!;
  // Поля чужой категории не храним: канал имеет смысл только у рекламы, сотрудник —
  // только у зарплаты (то же правило, что у PATCH расхода).
  if (data.startsOn && data.endsOn && data.endsOn < data.startsOn) fail(400, "Конец подписки раньше начала");
  if (!await validateExpenseCategory(data.categoryId, data.category)) fail(400, "Неверная категория подписки");
  return prisma.recurringExpense.create({
    data: {
      ...data,
      ...(!data.startsOn && (data.period !== undefined || data.autoPay !== undefined || data.dayOfMonth > 28) ? { startsOn: todayExpenseDay() } : {}),
      source: data.category === "ADVERTISING" ? data.source : null,
      agentId: data.category === "SALARY" ? data.agentId : null,
    },
  });
}

/** PATCH /expenses/recurring/:id. */
export async function updateRecurringExpense(id: string, raw: unknown): Promise<{ row: RecurringExpense; changed: string[] }> {
  const parsed = recurringPatchSchema.safeParse(raw);
  if (!parsed.success) fail(400, "Неверные данные", { details: parsed.error!.flatten() });
  const patch = parsed.data!;
  const existing = await prisma.recurringExpense.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) fail(404, "Шаблон не найден");
  const start = patch.startsOn === undefined ? existing!.startsOn : patch.startsOn;
  const end = patch.endsOn === undefined ? existing!.endsOn : patch.endsOn;
  if (start && end && end < start) fail(400, "Конец подписки раньше начала");
  if (!await validateExpenseCategory(patch.categoryId === undefined ? existing!.categoryId : patch.categoryId, patch.category ?? existing!.category, existing!)) {
    fail(400, "Неверная категория подписки");
  }
  // Обязательность канала/сотрудника проверяется по ИТОГОВОМУ состоянию, но только
  // когда правка трогает категорию или сами эти поля: СУЩЕСТВУЮЩИЙ шаблон без канала
  // (заведён до CRM-07) можно выключить или поправить сумму, не выбирая канал.
  const touchesAttribution = patch.category !== undefined || patch.source !== undefined || patch.agentId !== undefined;
  let attributionData: { source?: ClientSource | null; agentId?: string | null } = {};
  if (touchesAttribution) {
    const current = await prisma.recurringExpense.findUnique({
      where: { id },
      select: { category: true, source: true, agentId: true },
    });
    if (!current) fail(404, "Шаблон не найден");
    const finalCategory = patch.category ?? current!.category;
    const finalSource = patch.source === undefined ? current!.source : patch.source;
    const finalAgentId = patch.agentId === undefined ? current!.agentId : patch.agentId;
    const issue = recurringAttributionIssue(finalCategory, finalSource, finalAgentId);
    if (issue) fail(400, issue.message);
    attributionData = {
      source: finalCategory === "ADVERTISING" ? finalSource : null,
      agentId: finalCategory === "SALARY" ? finalAgentId : null,
    };
  }
  try {
    const row = await prisma.recurringExpense.update({ where: { id }, data: { ...patch, ...attributionData } });
    return { row, changed: Object.keys(patch) };
  } catch (err) {
    // Только «записи нет» — 404 (№154). Любой другой отказ базы раньше выглядел как
    // «Шаблон не найден» и не попадал в журнал ошибок — пробрасываем в общий обработчик.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") fail(404, "Шаблон не найден");
    throw err;
  }
}

/** DELETE /expenses/recurring/:id — мягко, шаблон можно вернуть. */
export async function deleteRecurringExpense(id: string): Promise<void> {
  try {
    await prisma.recurringExpense.update({ where: { id }, data: { deletedAt: new Date() } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") fail(404, "Шаблон не найден");
    throw err;
  }
}

/** PATCH /expenses/recurring/:id/restore. */
export async function restoreRecurringExpense(id: string): Promise<RecurringExpense> {
  const t = await prisma.recurringExpense.findUnique({ where: { id } });
  if (!t) fail(404, "Подписка не найдена");
  return prisma.recurringExpense.update({ where: { id: t!.id }, data: { deletedAt: null } });
}

export type RecurringOccurrenceAction = "pay" | "skip" | "undo" | "undo-payment";

/** POST /expenses/recurring/:id/{pay,skip,undo,undo-payment}. null — пропуск записан. */
export async function changeRecurringOccurrence(
  id: string, action: RecurringOccurrenceAction, raw: unknown, agentId: string,
): Promise<{ expense: Expense | null; dueDate: string }> {
  const p = recurringOccurrenceSchema.safeParse(raw);
  if (!p.success) fail(400, "Неверная дата платежа");
  const t = await prisma.recurringExpense.findUnique({ where: { id } });
  if (!t || t.deletedAt) fail(404, "Подписка не найдена");
  const template = t!;
  const day = p.data!.dueDate;
  if (!occurrenceDates(template, day, day).includes(day)) fail(400, "Дата не относится к подписке");
  try {
    const expense = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "RecurringExpense" WHERE "id"=${template.id} FOR UPDATE`;
      const latest = await tx.recurringExpense.findUnique({ where: { id: template.id } });
      if (!latest || latest.deletedAt) throw new ExpenseLifecycleError(404, "Подписка удалена");
      let row = await materializeOccurrence(latest, day, "PLANNED", agentId, undefined, tx);
      await tx.$queryRaw`SELECT "id" FROM "Expense" WHERE "id"=${row.id} FOR UPDATE`;
      row = (await tx.expense.findUnique({ where: { id: row.id } }))!;
      if (row.deletedAt) throw new ExpenseLifecycleError(409, "Платёж удалён. Сначала восстановите расход");
      if (action === "skip") {
        if (row.status === "PAID") throw new ExpenseLifecycleError(409, "Оплаченный платёж нельзя пропустить");
        await tx.recurringExpense.update({ where: { id: template.id }, data: { skippedDates: { set: [...new Set([...latest.skippedDates, day])] } } });
        return null;
      }
      const changed = await changeExpensePayment(row.id, action === "pay", p.data!.paymentDate, tx);
      await tx.recurringExpense.update({ where: { id: template.id }, data: { skippedDates: { set: latest.skippedDates.filter(d => d !== day) } } });
      return changed;
    });
    return { expense, dueDate: day };
  } catch (error) {
    if (error instanceof ExpenseLifecycleError) fail(error.status, error.message);
    throw error;
  }
}

// ─────────────────────────── категории ───────────────────────────

/** POST /expenses/categories. */
export async function createExpenseCategory(raw: unknown) {
  const parsed = expenseCategorySchema.safeParse(raw);
  if (!parsed.success) fail(400, "Некорректная категория", { details: parsed.error!.flatten() });
  const data = parsed.data!;
  if (data.parentId) {
    const parent = await prisma.expenseCategoryDefinition.findUnique({ where: { id: data.parentId } });
    if (!parent || parent.rootCategory !== data.rootCategory) fail(400, "Родительская категория не соответствует разделу");
  }
  return prisma.expenseCategoryDefinition.create({ data });
}

/** PATCH /expenses/categories/:id. */
export async function updateExpenseCategory(id: string, raw: unknown) {
  const parsed = expenseCategorySchema.partial().safeParse(raw);
  if (!parsed.success) fail(400, "Некорректная категория");
  const data = parsed.data!;
  const row = await prisma.expenseCategoryDefinition.findUnique({ where: { id } });
  if (!row) fail(404, "Категория не найдена");
  if (data.rootCategory && data.rootCategory !== row!.rootCategory) fail(400, "Раздел существующей категории менять нельзя");
  const parentId = data.parentId === undefined ? row!.parentId : data.parentId;
  if (parentId) {
    let next: string | null = parentId;
    const visited = new Set([row!.id]);
    for (let i = 0; next && i < 100; i++) {
      if (visited.has(next)) fail(400, "Цикл категорий недопустим");
      visited.add(next);
      const parent: { rootCategory: string; parentId: string | null } | null =
        await prisma.expenseCategoryDefinition.findUnique({ where: { id: next }, select: { rootCategory: true, parentId: true } });
      if (!parent || parent.rootCategory !== row!.rootCategory) fail(400, "Неверная родительская категория");
      next = parent!.parentId;
    }
    if (next) fail(400, "Слишком глубокие категории");
  }
  return prisma.expenseCategoryDefinition.update({ where: { id: row!.id }, data });
}

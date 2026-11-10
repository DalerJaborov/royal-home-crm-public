import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CLIENT_SOURCES, EXPENSE_CATEGORIES, EXPENSE_PAYMENT_METHODS, expenseCreateSchema, expenseDateSchema,
  type ExpenseCategory,
} from "@royal-home/shared";
import { prisma, type TxClient } from "../../../db.js";
import { AssistantActionError, type AssistantActionExecutor } from "../../../lib/assistantActions.js";
import { canonicalJson } from "../../../lib/canonicalJson.js";
import { createExpense } from "../../../lib/expenseCommands.js";
import { todayExpenseDay } from "../../../lib/expenseWorkspace.js";
import { expenseCentsToTjs, fromCents, loadMoneyContext, roundMoney } from "../../../lib/money.js";
import { plainField } from "./safeField.js";
import {
  asActionError, asPluginExecutor, assertFinanceWriter, categoryLabel, EXPENSE_LANGS, expenseLabels, findAgentByName,
  findCategoryByTitle, financeWriteAllowed, moneyText, type ExpenseLang,
} from "./expenseToolSupport.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * add_expenses — ПАЧКА РАСХОДОВ ОДНОЙ КАРТОЧКОЙ (10.11.2026, жалоба владельца: фото
 * таблицы «ОКТЯБРЬ 2026» из 12 строк и голосовое — помощница ответила «вносите сами»).
 *
 * Один вход для всех источников: текст и голос разбирает модель и зовёт этот
 * инструмент; фото таблицы/нескольких чеков разбирает telegram/assistantExpenseReceipt.ts
 * и создаёт то же действие напрямую. Запись — только `createExpense` (та же функция,
 * что POST /expenses), все строки в ОДНОЙ транзакции брокера вместе с захватом нажатия:
 * двойное «Записать» исполняет пачку ровно один раз.
 *
 * Повтор того же фото/текста не даёт двойную запись: у каждой строки ключ повтора
 * `asst-exp:<ключ пачки>:<номер>` (уникальный индекс Expense.requestKey). Ключ пачки —
 * хэш содержимого фото или нормализованных строк; две карточки одной пачки
 * сериализуются блокировкой по ключу, вторая видит записанное и отказывает.
 */

export const ADD_EXPENSES_TOOL = "add_expenses";
/** Не ограничение для людей, а предохранитель: таблица больше этого — несколько карточек. */
export const MAX_BATCH_ROWS = 1000;
const monthSchema = z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/);
const opt = <T extends z.ZodTypeAny>(schema: T) => schema.nullish().transform((v) => v ?? undefined);

const rowSchema = z.object({
  title: z.string().trim().min(1).max(200),
  amount: z.coerce.number().transform(roundMoney).pipe(z.number().positive().max(99_999_999.99)),
  currency: opt(z.enum(["TJS", "USD"])),
  date: opt(expenseDateSchema),
  month: opt(monthSchema),
  category: opt(z.enum(EXPENSE_CATEGORIES)),
  categoryTitle: opt(z.string().trim().max(100)),
  counterparty: opt(z.string().trim().max(200)),
  paymentMethod: opt(z.enum(EXPENSE_PAYMENT_METHODS)),
  status: opt(z.enum(["PAID", "PLANNED"])),
  source: opt(z.enum(CLIENT_SOURCES)),
  agentName: opt(z.string().trim().max(120)),
});

const argsSchema = z.object({
  items: z.array(rowSchema).min(1).max(MAX_BATCH_ROWS),
  lang: opt(z.enum(EXPENSE_LANGS)),
  /** Хэш фото (ставит только вход из Telegram); модель его не знает. */
  sourceHash: opt(z.string().regex(/^[0-9a-f]{64}$/)),
  /** Человек прямо сказал, что это НОВЫЕ такие же расходы, а не повтор. */
  repeat: opt(z.boolean()),
  repeatNonce: opt(z.uuid()),
});

export interface BatchRow {
  title: string; amount: number; currency: "TJS" | "USD"; month: string; status: "PAID" | "PLANNED";
  date?: string; category: ExpenseCategory; categoryTitle?: string; counterparty?: string;
  paymentMethod?: (typeof EXPENSE_PAYMENT_METHODS)[number]; source?: (typeof CLIENT_SOURCES)[number]; agentName?: string;
}
export interface BatchArgs { items: BatchRow[]; lang: ExpenseLang; sourceHash?: string; repeat?: boolean; repeatNonce?: string }

/**
 * Нормализация детерминирована: брокер хранит РАЗОБРАННЫЕ аргументы и на нажатии
 * разбирает их снова — результат обязан совпасть с показанным.
 * Дата в будущем — план (REST отказывает «будущий платёж запишите как план»).
 */
export function parseBatchArgs(raw: unknown, now = new Date()): BatchArgs {
  const parsed = argsSchema.safeParse(raw);
  if (!parsed.success) throw new AssistantActionError(400, "BAD_ARGS", "Не поняла строки расходов: нужны название и сумма у каждой");
  const today = todayExpenseDay(now);
  const currentMonth = today.slice(0, 7);
  const items = parsed.data.items.map((row): BatchRow => {
    const month = row.date ? row.date.slice(0, 7) : row.month ?? currentMonth;
    const future = row.date ? row.date > today : month > currentMonth;
    const status = row.status === "PAID" && !future ? "PAID" : row.status === "PLANNED" || future ? "PLANNED" : "PAID";
    return {
      title: row.title, amount: row.amount, currency: row.currency ?? "TJS", month, status,
      ...(row.date ? { date: row.date } : {}),
      category: row.category ?? "OTHER",
      ...(row.categoryTitle ? { categoryTitle: row.categoryTitle } : {}),
      ...(row.counterparty ? { counterparty: row.counterparty } : {}),
      ...(row.paymentMethod ? { paymentMethod: row.paymentMethod } : {}),
      ...(row.source ? { source: row.source } : {}),
      ...(row.agentName ? { agentName: row.agentName } : {}),
    };
  });
  return {
    items, lang: parsed.data.lang ?? "ru",
    ...(parsed.data.sourceHash ? { sourceHash: parsed.data.sourceHash } : {}),
    ...(parsed.data.repeat ? { repeat: true, repeatNonce: parsed.data.repeatNonce ?? randomUUID() } : {}),
  };
}

/** Ключ пачки: фото — по байтам, текст/голос — по нормализованным строкам. */
export function batchKey(args: Pick<BatchArgs, "items" | "sourceHash" | "repeatNonce">): string {
  const base = args.sourceHash ? `photo:${args.sourceHash}` : `rows:${canonicalJson(args.items.map(row => ({
    ...row, title: row.title.toLowerCase().replace(/\s+/gu, " "),
    ...(row.counterparty ? { counterparty: row.counterparty.toLowerCase() } : {}),
  })))}`;
  return createHash("sha256").update(args.repeatNonce ? `${base}|${args.repeatNonce}` : base).digest("hex");
}

export const batchRequestKeyPrefix = (key: string) => `asst-exp:${key}:`;

/** Записана ли уже пачка с этим фото (вход из Telegram проверяет до платного разбора). */
export async function recordedPhotoBatch(sourceHash: string) {
  const prefix = batchRequestKeyPrefix(batchKey({ items: [], sourceHash }));
  return prisma.expense.findFirst({ where: { requestKey: { startsWith: prefix } }, select: { createdAt: true, deletedAt: true } });
}

interface ResolvedRow { body: Record<string, unknown>; problem?: string }

async function resolveRows(args: BatchArgs, db: TxClient = prisma): Promise<ResolvedRow[]> {
  const out: ResolvedRow[] = [];
  // Тысяча строк таблицы — не тысяча запросов: подраздел и сотрудник ищутся раз на имя.
  const definitions = new Map<string, Awaited<ReturnType<typeof findCategoryByTitle>>>();
  const agents = new Map<string, Awaited<ReturnType<typeof findAgentByName>>>();
  for (const row of args.items) {
    const titleKey = row.categoryTitle?.toLowerCase() ?? "";
    if (!definitions.has(titleKey)) definitions.set(titleKey, await findCategoryByTitle(row.categoryTitle, db));
    const definition = definitions.get(titleKey) ?? null;
    const category = definition?.rootCategory ?? row.category;
    const agentKey = row.agentName?.toLowerCase() ?? "";
    if (category === "SALARY" && !agents.has(agentKey)) agents.set(agentKey, await findAgentByName(row.agentName, db));
    const agent = category === "SALARY" ? agents.get(agentKey) ?? null : null;
    const body: Record<string, unknown> = {
      category, amount: row.amount, currency: row.currency, month: row.month, status: row.status,
      paymentDate: row.date ?? null, note: row.title,
      ...(definition ? { categoryId: definition.id } : {}),
      ...(row.counterparty ? { counterparty: row.counterparty } : {}),
      ...(row.paymentMethod ? { paymentMethod: row.paymentMethod } : {}),
      ...(category === "ADVERTISING" && row.source ? { source: row.source } : {}),
      ...(agent ? { agentId: agent.id } : {}),
    };
    const check = expenseCreateSchema.safeParse(body);
    const problem = category === "SALARY" && !agent
      ? `«${row.title}»: назовите сотрудника, которому зарплата`
      : category === "ADVERTISING" && !row.source
        ? `«${row.title}»: какой канал рекламы (Instagram, Facebook…)?`
        : check.success ? undefined : `«${row.title}»: ${check.error.issues[0]?.message ?? "проверьте строку"}`;
    out.push({ body, ...(problem ? { problem } : {}) });
  }
  return out;
}

async function existingBatch(prefix: string, db: TxClient = prisma) {
  return db.expense.findMany({ where: { requestKey: { startsWith: prefix } }, select: { id: true, createdAt: true, deletedAt: true, version: true }, orderBy: { requestKey: "asc" }, take: MAX_BATCH_ROWS + 1 });
}

/** Снимок записанного: версия и «в корзине» — откат не затрёт правку строки после записи. */
function recordedState(rows: { version: number; deletedAt: Date | null }[]) {
  return rows.map(row => ({ version: row.version, deleted: row.deletedAt !== null }));
}

function duplicateError(rows: { createdAt: Date; deletedAt: Date | null }[]): AssistantActionError {
  const when = rows[0]!.createdAt.toISOString().slice(0, 10);
  const deleted = rows.every(row => row.deletedAt);
  return new AssistantActionError(409, "DUPLICATE", deleted
    ? `Эти расходы уже записывали ${when} и потом удалили — их можно вернуть из корзины расходов`
    : `Эти расходы уже записаны ${when}, второй раз не записываю`, { recordedOn: when, deleted });
}

const executor: AssistantActionExecutor<BatchArgs> = {
  tool: ADD_EXPENSES_TOOL,
  requires: ["finance.view", "finance.manage"],
  channels: ["crm", "telegram"],
  privateTelegram: true,
  transactional: true,
  transactionTimeoutMs: 120_000,
  parseArgs: (raw) => parseBatchArgs(raw),
  async authorize(_args, actor) {
    await assertFinanceWriter(actor);
  },
  async snapshot(args, actor, tx) {
    await assertFinanceWriter(actor, tx);
    const prefix = batchRequestKeyPrefix(batchKey(args));
    // Две карточки одной пачки (фото прислали дважды) — по очереди: вторая увидит первую.
    if (tx) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`;
    const [existing, rows] = await Promise.all([existingBatch(prefix, tx), resolveRows(args, tx)]);
    return { existing: recordedState(existing), rows: rows.map(row => row.body) };
  },
  async buildPreview(args, snapshot) {
    if (Array.isArray(snapshot.existing) && snapshot.existing.length > 0) throw duplicateError(await existingBatch(batchRequestKeyPrefix(batchKey(args))));
    const rows = await resolveRows(args);
    const problems = rows.flatMap(row => row.problem ? [row.problem] : []);
    if (problems.length) {
      throw new AssistantActionError(400, "ROWS_INVALID", `Не хватает данных: ${problems.slice(0, 5).join("; ")}`, { problems });
    }
    const labels = expenseLabels(args.lang);
    const money = await loadMoneyContext();
    const titles = new Map((await prisma.expenseCategoryDefinition.findMany({
      where: { id: { in: rows.flatMap(row => typeof row.body.categoryId === "string" ? [row.body.categoryId] : []) } },
      select: { id: true, title: true },
    })).map(row => [row.id, row.title]));
    const totalCents = args.items.reduce((sum, row) => sum + expenseCentsToTjs({ amount: row.amount, currency: row.currency, exchangeRate: null }, money), 0);
    const becomes: Record<string, string> = {};
    args.items.forEach((row, i) => {
      const body = rows[i]!.body;
      becomes[String(i + 1)] = [
        `${plainField(row.title, 80) ?? ""} — ${moneyText(row.amount, row.currency, args.lang)}`,
        row.date ?? row.month,
        categoryLabel(args.lang, body.category as ExpenseCategory, typeof body.categoryId === "string" ? titles.get(body.categoryId) : null),
        row.status === "PAID" ? labels.paid : labels.planned,
      ].join(" · ");
    });
    const usd = args.items.some(row => row.currency === "USD");
    return {
      title: `${labels.check(args.items.length)}, ${labels.total} ${moneyText(fromCents(totalCents), "TJS", args.lang)}`,
      was: {},
      becomes,
      ...(usd ? { risk: `${labels.rate}: 1 $ = ${money.usdToTjs}` } : {}),
    };
  },
  async execute(args, actor, { actionId, tx }) {
    if (!tx) throw new Error("add_expenses requires the confirmation transaction");
    await assertFinanceWriter(actor, tx);
    const prefix = batchRequestKeyPrefix(batchKey(args));
    const existing = await existingBatch(prefix, tx);
    if (existing.length) throw duplicateError(existing);
    const rows = await resolveRows(args, tx);
    if (rows.some(row => row.problem)) throw new AssistantActionError(409, "STALE", "Данные изменились, проверьте ещё раз");
    const agent = await tx.agent.findUnique({ where: { id: actor.agentId }, select: { fullName: true } });
    const money = await loadMoneyContext(tx);
    const ids: string[] = [];
    const audits: { action: string; entityType: string; entityId: string; agentId: string; agentName: string; meta: Record<string, string | number> }[] = [];
    for (const [i, row] of rows.entries()) {
      const { expense, month } = await createExpense(row.body, { agentId: actor.agentId, requestKey: `${prefix}${i}`, db: tx, money }).catch(asActionError);
      ids.push(expense.id);
      audits.push({
        action: "EXPENSE_CREATE", entityType: "Expense", entityId: expense.id, agentId: actor.agentId, agentName: agent?.fullName ?? "Неизвестно",
        meta: { amount: Number(expense.amount), category: expense.category, month, source: "assistant", actionId, channel: actor.channel },
      });
    }
    // След каждой строки, как у POST /expenses, — одной вставкой на пачку.
    await tx.auditLog.createMany({ data: audits });
    return { result: { expenseIds: ids, count: ids.length }, audit: { entityType: "Expense", entityId: ids[0] ?? null } };
  },
  transactionalUndo: {
    matches: (result) => Array.isArray((result as { expenseIds?: unknown } | null)?.expenseIds),
    async execute(args, actor, { tx, result, assertSnapshot }) {
      await assertFinanceWriter(actor, tx);
      const prefix = batchRequestKeyPrefix(batchKey(args));
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`;
      assertSnapshot({ existing: recordedState(await existingBatch(prefix, tx)), rows: (await resolveRows(args, tx)).map(row => row.body) });
      const ids = (result as { expenseIds: string[] }).expenseIds;
      // Откат = в корзину, как «Удалить» на экране: запись остаётся в архиве.
      await tx.expense.updateMany({ where: { id: { in: ids }, deletedAt: null }, data: { deletedAt: new Date(), version: { increment: 1 } } });
      return {};
    },
  },
};

export const addExpensesPlugin: AssistantWriteToolPlugin = {
  name: ADD_EXPENSES_TOOL,
  level: "C",
  description:
    "Записать один или несколько расходов компании одной карточкой «Проверьте N расходов» (человек нажимает «Записать»). " +
    "Звать, когда просят внести/записать расход или трату: «аренда офиса 5000 сомони за ноябрь», «интернет 400, бензин 122 вчера», " +
    "голосом или текстом, на любом языке. Каждую названную трату — отдельной строкой items; сумма числом; " +
    "валюта TJS (сомони) по умолчанию, USD если сказали доллары; дата YYYY-MM-DD, если назван день («вчера» — посчитай от сегодня), " +
    "иначе month YYYY-MM, если назван месяц. category: ADVERTISING (реклама, нужен source), SALARY (зарплата, нужен agentName), " +
    "OFFICE (аренда, интернет, связь, канцтовары, коммуналка), OTHER (остальное: бензин, такси, еда). " +
    "categoryTitle — только если человек назвал подраздел из справочника. lang — язык человека (ru, tg, uz, en). " +
    "repeat=true только если человек прямо сказал, что это НОВЫЕ такие же траты, а не повтор. " +
    "Сумм и строк не придумывай: чего не сказали — спроси. После вызова ответь одной фразой: проверьте и нажмите «Записать».",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: `Строки расходов, до ${MAX_BATCH_ROWS}`,
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Что оплатили, словами человека" },
            amount: { type: "number", description: "Сумма числом" },
            currency: { type: "string", enum: ["TJS", "USD"] },
            date: { type: "string", description: "День оплаты YYYY-MM-DD" },
            month: { type: "string", description: "Месяц YYYY-MM, если назван месяц без дня" },
            category: { type: "string", enum: [...EXPENSE_CATEGORIES] },
            categoryTitle: { type: "string", description: "Подраздел из справочника, если назван" },
            counterparty: { type: "string", description: "Кому заплатили, если назвали" },
            status: { type: "string", enum: ["PAID", "PLANNED"], description: "PLANNED — ещё не оплачено" },
            source: { type: "string", enum: [...CLIENT_SOURCES], description: "Канал рекламы для ADVERTISING" },
            agentName: { type: "string", description: "Сотрудник для SALARY" },
          },
          required: ["title", "amount"],
        },
      },
      lang: { type: "string", enum: [...EXPENSE_LANGS] },
      repeat: { type: "boolean" },
    },
    required: ["items"],
  },
  statusPhrase: "Готовлю расходы на проверку…",
  allowed: financeWriteAllowed,
  executor: asPluginExecutor<BatchArgs>(executor),
};

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CLIENT_SOURCES, EXPENSE_CATEGORIES, EXPENSE_PAYMENT_METHODS, expenseCreateSchema, expenseDateSchema,
  type ExpenseCategory,
} from "@royal-home/shared";
import { prisma, type TxClient } from "../../../db.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { AssistantActionError, type AssistantActionActor, type AssistantActionExecutor } from "../../../lib/assistantActions.js";
import { canonicalJson } from "../../../lib/canonicalJson.js";
import { createExpense } from "../../../lib/expenseCommands.js";
import { todayExpenseDay } from "../../../lib/expenseWorkspace.js";
import { expenseCentsToTjs, fromCents, loadMoneyContext, loadUsdRateInfo, NO_USD_RATE_TEXT, roundMoney, type MoneyContext } from "../../../lib/money.js";
import { plainField } from "./safeField.js";
import {
  asActionError, asPluginExecutor, assertFinanceWriter, categoryLabel, EXPENSE_LANGS, expenseLabels,
  findCategoryByTitle, financeWriteAllowed, moneyText, type ExpenseLang,
} from "./expenseToolSupport.js";
import type { AssistantWriteToolPlugin } from "./types.js";
import { findActiveAgentByName } from "../../../lib/agentNameLookup.js";
import { AD_CHANNELS, adChannelOf, salaryNameOf, specialArticleOf } from "../expenseArticles.js";

/**
 * add_expenses — ПАЧКА РАСХОДОВ ОДНОЙ КАРТОЧКОЙ (10.11.2026, жалоба владельца: фото таблицы
 * «ОКТЯБРЬ 2026» из 12 строк и голосовое — помощница ответила «вносите сами»).
 *
 * Один вход для всех источников: текст и голос разбирает модель и зовёт этот инструмент; фото,
 * альбом, Excel/CSV разбирает telegram/assistantExpense*.ts и создаёт то же действие напрямую.
 * Запись — только `createExpense` (та же функция, что POST /expenses), все строки в ОДНОЙ
 * транзакции брокера вместе с захватом нажатия: двойное «Записать» исполняет пачку один раз,
 * ошибка в любой строке откатывает всю пачку.
 *
 * КЛЮЧ ПОВТОРА СТРОКИ (ревью 10.11.2026):
 * - строка из фото/файла — `asst-exp:<хэш источника>:<номер строки в источнике>`: тот же чек или
 *   таблица в альбоме, отдельно или файлом второй раз не запишется; сверка идёт и с
 *   `tg-receipt:<хэш>` одиночного чека;
 * - строка из текста/голоса — `asst-exp:<сотрудник + сообщение>:<номер>`: повтор того же
 *   сообщения не пишет дважды, а второе «такси 30» другим сообщением — новая запись (похожее
 *   на уже записанное карточка только помечает).
 */

export const ADD_EXPENSES_TOOL = "add_expenses";
/** Не ограничение для людей, а предохранитель: таблица больше этого — несколько карточек. */
export const MAX_BATCH_ROWS = 1000;
const monthSchema = z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/);
const opt = <T extends z.ZodTypeAny>(schema: T) => schema.nullish().transform((v) => v ?? undefined);
const hash64 = z.string().regex(/^[0-9a-f]{64}$/);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const rowSchema = z.object({
  title: z.string().trim().min(1).max(200),
  amount: z.coerce.number().transform(roundMoney).pipe(z.number().positive().max(99_999_999.99)),
  currency: opt(z.enum(["TJS", "USD"])),
  /** Названа другая валюта (евро, рубли): такую строку не пишем, пока нет новых валют. */
  otherCurrency: opt(z.string().trim().max(12)),
  date: opt(expenseDateSchema),
  month: opt(monthSchema),
  category: opt(z.enum(EXPENSE_CATEGORIES)),
  categoryTitle: opt(z.string().trim().max(100)),
  counterparty: opt(z.string().trim().max(200)),
  paymentMethod: opt(z.enum(EXPENSE_PAYMENT_METHODS)),
  status: opt(z.enum(["PAID", "PLANNED"])),
  source: opt(z.enum(CLIENT_SOURCES)),
  agentName: opt(z.string().trim().max(120)),
  /** Сотрудник, выбранный кнопкой в карточке (не модель): id из списка кандидатов. */
  agentId: opt(z.uuid()),
  /** Строка как её прочитали (ячейки таблицы, строка фото) — для истории расхода. */
  sourceText: opt(z.string().max(500)),
  /** Валюты в источнике не было — поставлена валюта пачки, карточка просит проверить. */
  currencyUnstated: opt(z.boolean()),
  /** Хэш фото/файла этой строки и её номер в нём — ключ повтора по источнику. */
  sourceHash: opt(hash64),
  sourceIndex: opt(z.number().int().min(0).max(100_000)),
});

export const BATCH_SOURCE_KINDS = ["photo", "album", "xlsx", "xls", "csv", "pdf", "chat"] as const;

const argsSchema = z.object({
  items: z.array(rowSchema).min(1).max(MAX_BATCH_ROWS),
  lang: opt(z.enum(EXPENSE_LANGS)),
  /** Хэш фото/файла всей пачки (вход из Telegram); строки без своего хэша берут его. */
  sourceHash: opt(hash64),
  /** Откуда пачка: для журнала действий («что где могло пойти не так»). */
  source: opt(z.object({ kind: z.enum(BATCH_SOURCE_KINDS), messageId: opt(z.number().int().positive().max(2_147_483_647)) })),
  /** Слова человека этого хода (текст или расшифровка голоса) — ставит ядро, не модель. */
  sourceText: opt(z.string().max(1000)),
  /** Сообщение хода (ключ Telegram `tg:<чат>:<сообщение>`) — ставит ядро, не модель. */
  chatRef: opt(z.string().trim().min(1).max(200)),
});

export interface BatchRow {
  title: string; amount: number; currency: "TJS" | "USD"; month: string; status: "PAID" | "PLANNED";
  date?: string; category: ExpenseCategory; categoryTitle?: string; counterparty?: string;
  paymentMethod?: (typeof EXPENSE_PAYMENT_METHODS)[number]; source?: (typeof CLIENT_SOURCES)[number]; agentName?: string;
  sourceText?: string; currencyUnstated?: true; otherCurrency?: string; sourceHash?: string; sourceIndex?: number;
  agentId?: string;
}
export interface BatchArgs {
  items: BatchRow[]; lang: ExpenseLang;
  source?: { kind: (typeof BATCH_SOURCE_KINDS)[number]; messageId?: number }; sourceText?: string; chatRef?: string;
}

/** Валюта пачки: та, что явно названа у большинства строк; никто не назвал — сомони. */
export function batchCurrency(rows: readonly { currency?: "TJS" | "USD"; currencyUnstated?: boolean }[]): "TJS" | "USD" {
  const stated = rows.filter((row) => row.currency && !row.currencyUnstated).map((row) => row.currency);
  const usd = stated.filter((c) => c === "USD").length;
  return usd > stated.length - usd ? "USD" : "TJS";
}

/**
 * Нормализация детерминирована: брокер хранит РАЗОБРАННЫЕ аргументы и на нажатии разбирает их
 * снова — результат обязан совпасть с показанным. Дата в будущем — план (REST: «будущий платёж
 * запишите как план»). Метка сообщения без хода (прямой вызов) — от строк и минуты: повтор той же
 * просьбы в ту же минуту склеивается брокером, а не пишется дважды.
 */
export function parseBatchArgs(raw: unknown, now = new Date()): BatchArgs {
  const parsed = argsSchema.safeParse(raw);
  if (!parsed.success) throw new AssistantActionError(400, "BAD_ARGS", "Не поняла строки расходов: нужны название и сумма у каждой");
  const today = todayExpenseDay(now);
  const currentMonth = today.slice(0, 7);
  // Валюту не угадываем молча: строка без валюты получает валюту пачки и пометку «проверьте».
  const fallbackCurrency = batchCurrency(parsed.data.items);
  const items = parsed.data.items.map((row, i): BatchRow => {
    const unstated = row.currencyUnstated === true || !row.currency;
    const month = row.date ? row.date.slice(0, 7) : row.month ?? currentMonth;
    const future = row.date ? row.date > today : month > currentMonth;
    const status = row.status === "PAID" && !future ? "PAID" : row.status === "PLANNED" || future ? "PLANNED" : "PAID";
    const sourceHash = row.sourceHash ?? parsed.data.sourceHash;
    return {
      title: row.title, amount: row.amount, currency: unstated ? fallbackCurrency : row.currency!, month, status,
      ...(unstated ? { currencyUnstated: true as const } : {}),
      ...(row.otherCurrency ? { otherCurrency: row.otherCurrency } : {}),
      ...(row.date ? { date: row.date } : {}),
      category: row.category ?? "OTHER",
      ...(row.categoryTitle ? { categoryTitle: row.categoryTitle } : {}),
      ...(row.counterparty ? { counterparty: row.counterparty } : {}),
      ...(row.paymentMethod ? { paymentMethod: row.paymentMethod } : {}),
      ...(row.source ? { source: row.source } : {}),
      ...(row.agentName ? { agentName: row.agentName } : {}),
      ...(row.agentId ? { agentId: row.agentId } : {}),
      ...(row.sourceText ? { sourceText: row.sourceText } : {}),
      ...(sourceHash ? { sourceHash, sourceIndex: row.sourceIndex ?? i } : {}),
    };
  });
  const needsChatRef = items.some((row) => !row.sourceHash);
  const chatRef = parsed.data.chatRef
    ?? (needsChatRef ? `rows:${sha(canonicalJson(items.map(({ sourceText: _s, ...row }) => row)))}:${Math.floor(now.getTime() / 60_000)}` : undefined);
  return {
    items, lang: parsed.data.lang ?? "ru",
    ...(parsed.data.source ? { source: { kind: parsed.data.source.kind, ...(parsed.data.source.messageId ? { messageId: parsed.data.source.messageId } : {}) } } : {}),
    ...(parsed.data.sourceText ? { sourceText: parsed.data.sourceText } : {}),
    ...(chatRef ? { chatRef } : {}),
  };
}

/** Префикс ключей строк одного фото/файла — общий у фото, альбома и таблицы. */
export const sourceKeyPrefix = (sourceHash: string) => `asst-exp:${sha(`photo:${sourceHash}`)}:`;
const chatKeyPrefix = (agentId: string, chatRef: string) => `asst-exp:${sha(`chat:${agentId}:${chatRef}`)}:`;

/** Ключ повтора каждой строки пачки (Expense.requestKey, уникальный индекс). */
export function rowRequestKeys(args: BatchArgs, agentId: string): string[] {
  return args.items.map((row, i) => row.sourceHash
    ? `${sourceKeyPrefix(row.sourceHash)}${row.sourceIndex ?? i}`
    : `${chatKeyPrefix(agentId, args.chatRef ?? "")}${i}`);
}

/** Уже записанное из этого фото/файла: ключи пачки, альбома и одиночного чека `tg-receipt:`. */
export function sourceRecordedWhere(hashes: readonly string[]): Prisma.ExpenseWhereInput[] {
  return hashes.flatMap((hash) => [{ requestKey: { startsWith: sourceKeyPrefix(hash) } }, { requestKey: `tg-receipt:${hash}` }]);
}

/** Записано ли уже что-то из этого фото или файла (вход из Telegram проверяет до платного разбора). */
export async function recordedSource(sourceHash: string) {
  return prisma.expense.findFirst({ where: { OR: sourceRecordedWhere([sourceHash]) }, select: { createdAt: true, deletedAt: true } });
}

/** Один текст отказа без курса — у REST и помощницы (lib/money.ts). */
export const NO_RATE_MESSAGE = NO_USD_RATE_TEXT;

/**
 * Курс для пачки: долларовая строка пишется только при курсе, заданном в Настройках. Без него
 * loadMoneyContext подставил бы FALLBACK_USD_TO_TJS — запасное число, а не курс; такую запись не делаем.
 */
export async function rateContextFor(args: Pick<BatchArgs, "items">, db?: TxClient): Promise<MoneyContext> {
  if (!args.items.some((row) => row.currency === "USD")) return loadMoneyContext(db);
  const info = await loadUsdRateInfo(db);
  if (!info.rate) throw new AssistantActionError(409, "NO_RATE", NO_RATE_MESSAGE);
  return { usdToTjs: info.rate, verified: true };
}

export interface ResolvedRow {
  body: Record<string, unknown>;
  problem?: string;
  /**
   * Реклама без канала / зарплата без сотрудника: REST такую строку не примет. Карточка называет
   * это и даёт выбрать канал или сотрудника кнопкой («Править → строка N»); не выбрали — «Прочее».
   */
  downgraded?: "salary" | "ads";
  /** Для зарплаты: похожих сотрудников несколько — кого предложить кнопками. */
  candidates?: { id: string; fullName: string }[];
  /** Что поняли: сотрудник зарплаты и канал рекламы — показываются у строки в карточке. */
  agentName?: string;
  source?: string;
  categoryTitle?: string;
}

type AgentPick = { agent: { id: string; fullName: string } | null; candidates: { id: string; fullName: string }[] };

/**
 * Строки → тела POST /expenses. Реклама и зарплата узнаются по словам строки (словарь статей):
 * канал — по названию площадки, сотрудник — по имени через общую дверь `lib/agentNameLookup.ts`
 * (однофамильцев не выбираем за человека). Не узнали — строка пометится и пойдёт в «Прочее»,
 * если человек не выберет кнопкой; одна такая строка не валит файл. Чужая валюта — проблема строки.
 */
export async function resolveRows(args: BatchArgs, db: TxClient = prisma): Promise<ResolvedRow[]> {
  const out: ResolvedRow[] = [];
  // Тысяча строк таблицы — не тысяча запросов: подраздел и сотрудник ищутся раз на имя.
  const definitions = new Map<string, Awaited<ReturnType<typeof findCategoryByTitle>>>();
  const picks = new Map<string, AgentPick>();
  for (const row of args.items) {
    const titleKey = row.categoryTitle?.toLowerCase() ?? "";
    if (!definitions.has(titleKey)) definitions.set(titleKey, await findCategoryByTitle(row.categoryTitle, db));
    let definition = definitions.get(titleKey) ?? null;
    let category: ExpenseCategory = definition?.rootCategory ?? row.category;
    const words = `${row.categoryTitle ?? ""} ${row.title}`;
    const special = specialArticleOf(words);
    if (category === "OTHER" && !definition && special === "ads") category = "ADVERTISING";
    if (category === "OTHER" && !definition && special === "salary") category = "SALARY";
    const source = category === "ADVERTISING" ? row.source ?? adChannelOf(`${words} ${row.counterparty ?? ""}`) ?? undefined : undefined;
    let pick: AgentPick = { agent: null, candidates: [] };
    if (category === "SALARY") {
      const key = row.agentId ? `id:${row.agentId}` : `name:${(row.agentName ?? salaryNameOf(row.title)).toLowerCase()}`;
      if (!picks.has(key)) picks.set(key, await pickAgent(row, db));
      pick = picks.get(key)!;
    }
    let downgraded: ResolvedRow["downgraded"];
    if ((category === "SALARY" && !pick.agent) || (category === "ADVERTISING" && !source)) {
      downgraded = category === "SALARY" ? "salary" : "ads";
      category = "OTHER";
      definition = null;
    }
    const body: Record<string, unknown> = {
      category, amount: row.amount, currency: row.currency, month: row.month, status: row.status,
      paymentDate: row.date ?? null, note: row.title,
      ...(definition ? { categoryId: definition.id } : {}),
      ...(row.counterparty ? { counterparty: row.counterparty } : {}),
      ...(row.paymentMethod ? { paymentMethod: row.paymentMethod } : {}),
      ...(category === "ADVERTISING" && source ? { source } : {}),
      ...(category === "SALARY" && pick.agent ? { agentId: pick.agent.id } : {}),
    };
    const check = expenseCreateSchema.safeParse(body);
    const problem = row.otherCurrency
      ? `«${row.title}»: валюта ${row.otherCurrency} пока не поддерживается — укажите в сомони или $`
      : check.success ? undefined : `«${row.title}»: ${check.error.issues[0]?.message ?? "проверьте строку"}`;
    out.push({
      body, ...(problem ? { problem } : {}), ...(downgraded ? { downgraded } : {}),
      ...(downgraded === "salary" && pick.candidates.length ? { candidates: pick.candidates } : {}),
      ...(category === "SALARY" && pick.agent ? { agentName: pick.agent.fullName } : {}),
      ...(category === "ADVERTISING" && source ? { source } : {}),
      ...(definition ? { categoryTitle: definition.title } : {}),
    });
  }
  return out;
}

async function pickAgent(row: BatchRow, db: TxClient): Promise<AgentPick> {
  if (row.agentId) {
    const agent = await db.agent.findFirst({ where: { id: row.agentId, isActive: true }, select: { id: true, fullName: true } });
    return { agent, candidates: [] };
  }
  const name = row.agentName ?? salaryNameOf(row.title);
  if (!name) return { agent: null, candidates: [] };
  const match = await findActiveAgentByName(name);
  // Сам выбираем только при полном совпадении имени: «Ахмад» не становится «Ахмадов Фарход» молча —
  // единственное частичное совпадение идёт кнопкой, как однофамильцы (повторное ревью 10.11.2026).
  const norm = (text: string) => text.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  if (match.kind === "one" && norm(match.agent.fullName) === norm(name)) return { agent: match.agent, candidates: [] };
  return { agent: null, candidates: match.kind === "many" ? match.candidates : match.kind === "one" ? [match.agent] : [] };
}

async function existingBatch(args: BatchArgs, agentId: string, db: TxClient = prisma) {
  const keys = rowRequestKeys(args, agentId);
  const hashes = [...new Set(args.items.flatMap((row) => (row.sourceHash ? [row.sourceHash] : [])))];
  return db.expense.findMany({
    where: { OR: [{ requestKey: { in: keys } }, ...sourceRecordedWhere(hashes)] },
    select: { id: true, createdAt: true, deletedAt: true, version: true, requestKey: true },
    orderBy: { requestKey: "asc" }, take: MAX_BATCH_ROWS + 1,
  });
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

/** Блокировка по источникам пачки: две карточки одного фото или сообщения — строго по очереди. */
async function lockSources(args: BatchArgs, agentId: string, tx: TxClient) {
  const locks = [...new Set(rowRequestKeys(args, agentId).map((key) => key.slice(0, key.lastIndexOf(":") + 1)))].sort();
  for (const key of locks) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
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
    if (tx) await lockSources(args, actor.agentId, tx);
    const [existing, rows] = await Promise.all([existingBatch(args, actor.agentId, tx), resolveRows(args, tx)]);
    return { existing: recordedState(existing), rows: rows.map(row => row.body) };
  },
  async buildPreview(args, snapshot, actor) {
    if (Array.isArray(snapshot.existing) && snapshot.existing.length > 0) throw duplicateError(await existingBatch(args, actor.agentId));
    const rows = await resolveRows(args);
    const problems = rows.flatMap(row => row.problem ? [row.problem] : []);
    if (problems.length) {
      throw new AssistantActionError(400, "ROWS_INVALID", `Не хватает данных: ${problems.slice(0, 5).join("; ")}`, { problems });
    }
    const labels = expenseLabels(args.lang);
    const money = await rateContextFor(args);
    const totalCents = args.items.reduce((sum, row) => sum + expenseCentsToTjs({ amount: row.amount, currency: row.currency, exchangeRate: null }, money), 0);
    const becomes: Record<string, string> = {};
    args.items.forEach((row, i) => {
      const resolved = rows[i]!;
      becomes[String(i + 1)] = [
        `${plainField(row.title, 80) ?? ""} — ${moneyText(row.amount, row.currency, args.lang)}`,
        row.date ?? row.month,
        categoryLabel(args.lang, resolved.body.category as ExpenseCategory, resolved.categoryTitle ?? null),
        ...(resolved.agentName ? [`👥 ${plainField(resolved.agentName, 60)}`] : []),
        ...(resolved.source ? [`📣 ${AD_CHANNELS.find((c) => c.source === resolved.source)?.label ?? resolved.source}`] : []),
        row.status === "PAID" ? labels.paid : labels.planned,
      ].join(" · ");
    });
    const usd = args.items.some(row => row.currency === "USD");
    return {
      title: `${labels.check(args.items.length)}, ${labels.total} ${moneyText(fromCents(totalCents), "TJS", args.lang)}`,
      was: {},
      becomes,
      ...(usd ? { risk: `${labels.rate}: 1 $ = ${money.usdToTjs} с.` } : {}),
    };
  },
  async execute(args, actor, { actionId, tx }) {
    if (!tx) throw new Error("add_expenses requires the confirmation transaction");
    await assertFinanceWriter(actor, tx);
    const existing = await existingBatch(args, actor.agentId, tx);
    if (existing.length) throw duplicateError(existing);
    const rows = await resolveRows(args, tx);
    if (rows.some(row => row.problem)) throw new AssistantActionError(409, "STALE", "Данные изменились, проверьте ещё раз");
    const agent = await tx.agent.findUnique({ where: { id: actor.agentId }, select: { fullName: true } });
    // Тот же курс, что показан в карточке и что запишется в exchangeRate (lib/expenseCommands.ts).
    const money = await rateContextFor(args, tx);
    const keys = rowRequestKeys(args, actor.agentId);
    const ids: string[] = [];
    const audits: { action: string; entityType: string; entityId: string; agentId: string; agentName: string; meta: Prisma.InputJsonValue }[] = [];
    for (const [i, row] of rows.entries()) {
      const { expense, month } = await createExpense(row.body, { agentId: actor.agentId, requestKey: keys[i]!, db: tx, money }).catch(asActionError);
      ids.push(expense.id);
      audits.push(expenseCreateAudit(args, i, row, expense, month, actor, actionId, agent?.fullName ?? "Неизвестно"));
    }
    // След каждой строки, как у POST /expenses, — одной вставкой на пачку.
    await tx.auditLog.createMany({ data: audits });
    return { result: { expenseIds: ids, count: ids.length }, audit: { entityType: "Expense", entityId: ids[0] ?? null } };
  },
  transactionalUndo: {
    matches: (result) => Array.isArray((result as { expenseIds?: unknown } | null)?.expenseIds),
    async execute(args, actor, { tx, result, assertSnapshot }) {
      await assertFinanceWriter(actor, tx);
      await lockSources(args, actor.agentId, tx);
      assertSnapshot({ existing: recordedState(await existingBatch(args, actor.agentId, tx)), rows: (await resolveRows(args, tx)).map(row => row.body) });
      const ids = (result as { expenseIds: string[] }).expenseIds;
      // Откат = в корзину, как «Удалить» на экране: запись остаётся в архиве.
      await tx.expense.updateMany({ where: { id: { in: ids }, deletedAt: null }, data: { deletedAt: new Date(), version: { increment: 1 } } });
      return {};
    },
  },
};

/**
 * История расхода (владелец 10.11.2026: «чтобы всегда можно было посмотреть, что где могло пойти
 * не так»): что прочитали, что поняли, валюта и откуда она, курс, источник и сообщение.
 */
function expenseCreateAudit(
  args: BatchArgs, i: number, row: ResolvedRow,
  expense: { id: string; amount: unknown; category: string; currency: string; exchangeRate: unknown },
  month: string, actor: AssistantActionActor, actionId: string, agentName: string,
) {
  const item = args.items[i]!;
  return {
    action: "EXPENSE_CREATE", entityType: "Expense", entityId: expense.id, agentId: actor.agentId, agentName,
    meta: {
      amount: Number(expense.amount), category: expense.category, month, source: "assistant", actionId, channel: actor.channel,
      currency: expense.currency, exchangeRate: expense.exchangeRate === null ? null : Number(expense.exchangeRate),
      currencyUnstated: item.currencyUnstated === true,
      ...(row.downgraded ? { downgradedFrom: row.downgraded === "salary" ? "SALARY" : "ADVERTISING" } : {}),
      sourceKind: args.source?.kind ?? "chat", ...(args.source?.messageId ? { messageId: args.source.messageId } : {}),
      ...(item.sourceHash ? { sourceHash: item.sourceHash.slice(0, 16), sourceLine: (item.sourceIndex ?? i) + 1 } : {}),
      sourceText: (item.sourceText ?? args.sourceText ?? item.title).slice(0, 500), line: i + 1,
    } satisfies Prisma.InputJsonValue,
  };
}

export const addExpensesPlugin: AssistantWriteToolPlugin = {
  name: ADD_EXPENSES_TOOL,
  level: "C",
  description:
    "Записать один или несколько расходов компании одной карточкой «Проверьте N расходов» (человек нажимает «Записать»). " +
    "Звать, когда просят внести/записать расход или трату: «аренда офиса 5000 сомони за ноябрь», «интернет 400, бензин 122 вчера», " +
    "голосом или текстом, на любом языке. Каждую названную трату — отдельной строкой items; сумма числом; " +
    "currency — только если валюту назвали (TJS — сомони, USD — доллары); не назвали — не ставь, карточка спросит. " +
    "Другая валюта (евро, рубли) — otherCurrency, такую строку CRM пока не запишет. " +
    "Дата YYYY-MM-DD, если назван день («вчера» — посчитай от сегодня), иначе month YYYY-MM, если назван месяц. " +
    "category: ADVERTISING (реклама, нужен source), SALARY (зарплата, нужен agentName), " +
    "OFFICE (аренда, интернет, связь, канцтовары, коммуналка), OTHER (остальное: бензин, такси, еда). " +
    "categoryTitle — только если человек назвал подраздел из справочника. lang — язык человека (ru, tg, uz, en). " +
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
            currency: { type: "string", enum: ["TJS", "USD"], description: "Только если валюту назвали" },
            otherCurrency: { type: "string", description: "Названная валюта, если не сомони и не доллары (€, ₽…)" },
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
    },
    required: ["items"],
  },
  statusPhrase: "Готовлю расходы на проверку…",
  allowed: financeWriteAllowed,
  // Сообщение хода и слова человека ставит ядро: модель не может склеить чужие записи или
  // приписать пачке не те слова (ключ повтора текста/голоса — сотрудник + сообщение).
  bindContext: ({ sourceHash: _h, chatRef: _c, sourceText: _t, source: _s, items, ...args }, ctx) => ({
    ...args,
    items: Array.isArray(items)
      ? items.map((row) => {
        if (!row || typeof row !== "object") return row;
        const { sourceHash: _rh, sourceIndex: _ri, sourceText: _rt, currencyUnstated: _ru, agentId: _ra, ...rest } = row as Record<string, unknown>;
        return rest;
      })
      : items,
    source: { kind: "chat" },
    ...(ctx.turnKey ? { chatRef: ctx.turnKey } : {}),
    ...(ctx.question ? { sourceText: ctx.question.slice(0, 1000) } : {}),
  }),
  executor: asPluginExecutor<BatchArgs>(executor),
};

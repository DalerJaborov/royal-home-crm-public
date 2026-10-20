import type { Prisma, RecurringExpense, Expense } from "../generated/prisma/client.js";
import { z } from "zod";
import { expenseListQuerySchema, EXPENSE_CATEGORY_LABELS, EXPENSE_METHOD_LABELS, type ExpenseSortKey, type ExpenseUpcomingItem } from "@royal-home/shared";
import { prisma } from "../db.js";
import { expenseCentsToTjs, fromCents, loadMoneyContext, type MoneyContext } from "./money.js";
import { Prisma as PrismaRuntime } from "../generated/prisma/client.js";
type ExpenseTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
export class ExpenseLifecycleError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}
const undoSchema = z.object({ status: z.literal("PLANNED"), paymentDate: z.string().nullable(), month: z.string(), exchangeRate: z.string().nullable(), rateCapturedAt: z.string().nullable(), version: z.number().int() });
/** Serialise pay, undo and edits on the expense row; duplicate pay never overwrites the original date. */
export async function changeExpensePayment(id: string, paid: boolean, paymentDate?: string, transaction?: ExpenseTransaction) {
    const actual = paymentDate ?? todayExpenseDay();
    if (paid && actual > todayExpenseDay())
        throw new ExpenseLifecycleError(400, "Будущий платёж запишите как план, а не как оплату");
    const money = await loadMoneyContext();
    const run = async (tx: ExpenseTransaction) => {
        await tx.$queryRaw `SELECT "id" FROM "Expense" WHERE "id"=${id} FOR UPDATE`;
        const current = await tx.expense.findUnique({ where: { id } });
        if (!current || current.deletedAt)
            throw new ExpenseLifecycleError(404, "Расход не найден");
        if (paid) {
            if (current.status === "PAID")
                return current;
            return tx.expense.update({ where: { id }, data: { status: "PAID", paymentDate: expenseDay(actual), month: expenseDay(`${actual.slice(0, 7)}-01`),
                    exchangeRate: current.exchangeRate ?? (current.currency === "USD" ? money.usdToTjs : 1), rateCapturedAt: current.rateCapturedAt ?? new Date(), version: { increment: 1 },
                    paymentUndo: { status: "PLANNED", paymentDate: current.paymentDate?.toISOString() ?? null, month: current.month.toISOString(), exchangeRate: current.exchangeRate?.toString() ?? null, rateCapturedAt: current.rateCapturedAt?.toISOString() ?? null, version: current.version + 1 } } });
        }
        if (current.status === "PLANNED")
            return current;
        const old = undoSchema.safeParse(current.paymentUndo);
        if (!old.success || old.data.version !== current.version)
            throw new ExpenseLifecycleError(409, "Оплату нельзя отменить: запись уже изменена или была оплачена ранее");
        return tx.expense.update({ where: { id }, data: { status: "PLANNED", paymentDate: old.data.paymentDate ? new Date(old.data.paymentDate) : null, month: new Date(old.data.month), exchangeRate: old.data.exchangeRate, rateCapturedAt: old.data.rateCapturedAt ? new Date(old.data.rateCapturedAt) : null, paymentUndo: PrismaRuntime.DbNull, version: { increment: 1 }, manualEditedAt: new Date() } });
    };
    return transaction ? run(transaction) : prisma.$transaction(run);
}
export function expenseDay(value: string): Date { return new Date(`${value}T00:00:00.000Z`); }
export function todayExpenseDay(now = new Date()): string { return new Date(now.getTime() + 5 * 3600000).toISOString().slice(0, 10); }
export function occurrenceDates(template: Pick<RecurringExpense, "startsOn" | "endsOn" | "period" | "dayOfMonth">, from: string, to: string): string[] {
    const anchor = template.startsOn ?? `${from.slice(0, 7)}-01`;
    const start = expenseDay(anchor);
    const dates: string[] = [];
    for (let i = 0; i < 5200; i++) {
        const date = new Date(start);
        if (template.period === "WEEK")
            date.setUTCDate(start.getUTCDate() + i * 7);
        else {
            const months = i * (template.period === "YEAR" ? 12 : template.period === "QUARTER" ? 3 : 1);
            date.setUTCDate(1);
            date.setUTCMonth(start.getUTCMonth() + months);
            const max = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
            date.setUTCDate(Math.min(template.dayOfMonth, max));
        }
        const key = date.toISOString().slice(0, 10);
        if (key > to || template.endsOn && key > template.endsOn)
            break;
        if (key >= from && key >= anchor)
            dates.push(key);
        if (dates.length > 400)
            throw new Error("Слишком большой период платежей");
    }
    return dates;
}
export function expenseWhere(query: z.infer<typeof expenseListQuerySchema>): Prisma.ExpenseWhereInput {
    return { deletedAt: null,
        ...(query.month ? { month: expenseDay(`${query.month}-01`) } : {}),
        ...(query.status ? { status: query.status } : {}), ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.recurringId ? { recurringId: query.recurringId } : {}),
        ...(query.rootCategory ? { category: query.rootCategory } : {}), ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
        ...(query.counterparty ? { counterparty: { contains: query.counterparty, mode: "insensitive" } } : {}),
        ...(query.from || query.to ? { paymentDate: { ...(query.from ? { gte: expenseDay(query.from) } : {}), ...(query.to ? { lte: expenseDay(query.to) } : {}) } } : {}),
        ...(query.q ? { OR: [{ note: { contains: query.q, mode: "insensitive" } }, { counterparty: { contains: query.q, mode: "insensitive" } }] } : {}) };
}
/** Sort lightweight descriptors across the complete filtered set, then fetch only a page's receipts/full records. */
export async function orderedExpenseIds(where:Prisma.ExpenseWhereInput, sortBy:ExpenseSortKey,direction:"asc"|"desc",context?:MoneyContext) {
    const rows=await prisma.expense.findMany({where,take:20001,select:{id:true,paymentDate:true,note:true,category:true,categoryId:true,counterparty:true,paymentMethod:true,createdById:true,amount:true,currency:true,exchangeRate:true}});
    if(rows.length>20000)throw new ExpenseLifecycleError(413,"Для сортировки сузьте период: больше 20 000 расходов");
    return sortExpenseIds(rows,sortBy,direction,context);
}
type ExpenseSortRow = Pick<Expense,"id"|"paymentDate"|"note"|"category"|"categoryId"|"counterparty"|"paymentMethod"|"createdById"|"amount"|"currency"|"exchangeRate">;
export async function sortExpenseIds(rows:ExpenseSortRow[],sortBy:ExpenseSortKey,direction:"asc"|"desc",context?:MoneyContext) {
    const [authors,categories,money]=await Promise.all([
        sortBy==="author"?prisma.agent.findMany({where:{id:{in:[...new Set(rows.flatMap(r=>r.createdById?[r.createdById]:[]))]}},select:{id:true,fullName:true}}):[],
        sortBy==="category"?prisma.expenseCategoryDefinition.findMany({select:{id:true,title:true}}):[],
        sortBy==="amount"?(context??loadMoneyContext()):null,
    ]);
    const names=new Map(authors.map(a=>[a.id,a.fullName]));const titles=new Map(categories.map(c=>[c.id,c.title]));
    const methods:Readonly<Record<string,string>>=EXPENSE_METHOD_LABELS;
    const prepared=rows.map(r=>({id:r.id,value:sortBy==="date"?r.paymentDate?.getTime()??null:sortBy==="title"?r.note:sortBy==="category"?(r.categoryId?titles.get(r.categoryId):undefined)??EXPENSE_CATEGORY_LABELS[r.category]:sortBy==="counterparty"?r.counterparty:sortBy==="method"?(r.paymentMethod?methods[r.paymentMethod]??r.paymentMethod:null):sortBy==="author"?(r.createdById?names.get(r.createdById)??null:null):expenseCentsToTjs(r,money!)}));
    const collator=new Intl.Collator("ru",{numeric:true,sensitivity:"base"});const sign=direction==="asc"?1:-1;
    prepared.sort((a,b)=>{if(a.value==null||b.value==null)return a.value==null&&b.value==null?a.id.localeCompare(b.id):a.value==null?1:-1;const value=typeof a.value==="number"&&typeof b.value==="number"?a.value-b.value:collator.compare(String(a.value),String(b.value));return value*sign||a.id.localeCompare(b.id);});
    return prepared.map(r=>r.id);
}
export async function validateExpenseCategory(id: string | null | undefined, root: string, previous?: { categoryId: string | null; category: string }): Promise<boolean> {
    if (!id)
        return true;
    const category = await prisma.expenseCategoryDefinition.findUnique({ where: { id } });
    // Existing archived assignments remain valid; new assignments still require active categories.
    const unchanged = previous?.categoryId === id && previous.category === root;
    return !!category && (category.active || unchanged) && category.rootCategory === root;
}
export function expenseDto<T extends {
    id: string;
    paymentDate: Date | null;
    receipts?: {
        id: string;
        originalName: string;
        mimeType: string;
        size: number;
    }[];
}>(row: T) {
    return { ...row, requestKey: undefined, autoFingerprint: undefined, paymentUndo: undefined, paymentDate: row.paymentDate?.toISOString().slice(0, 10) ?? null,
        ...(row.receipts ? { receipts: row.receipts.map(({ id, originalName, mimeType, size }) => ({ id, originalName, mimeType, size, url: `/api/v1/expenses/${row.id}/receipts/${id}/file` })) } : {}) };
}
export async function expenseDtos<T extends {
    id: string;
    createdById: string | null;
    paymentDate: Date | null;
    amount: Parameters<typeof expenseCentsToTjs>[0]["amount"];
    currency: "USD" | "TJS";
    exchangeRate?: {
        toString(): string;
    } | number | null;
    receipts?: {
        id: string;
        originalName: string;
        mimeType: string;
        size: number;
    }[];
}>(rows: T[], context?:MoneyContext) {
    const [authors, money] = await Promise.all([prisma.agent.findMany({ where: { id: { in: [...new Set(rows.flatMap(r => r.createdById ? [r.createdById] : []))] } }, select: { id: true, fullName: true } }), context??loadMoneyContext()]);
    return rows.map(row => ({ ...expenseDto(row), createdBy: authors.find(a => a.id === row.createdById) ?? null, amountTjs: fromCents(expenseCentsToTjs(row, money)) }));
}
export async function materializeOccurrence(template: RecurringExpense, dueDate: string, status: "PLANNED" | "PAID", actorId?: string, paymentDate?: string, transaction?: ExpenseTransaction) {
    const money = await loadMoneyContext();
    const autoKey = template.startsOn ? `rec:${template.id}:${dueDate}` : `rec:${template.id}:${dueDate.slice(0, 7)}`;
    const db = transaction ?? prisma;
    if (template.startsOn) {
        const legacy = await db.expense.findUnique({ where: { autoKey: `rec:${template.id}:${dueDate.slice(0, 7)}` } });
        if (legacy)
            return legacy;
    }
    const existing = await db.expense.findUnique({ where: { recurringId_occurrenceDate: { recurringId: template.id, occurrenceDate: dueDate } } });
    if (existing)
        return existing;
    return db.expense.upsert({ where: { autoKey }, update: {}, create: { autoKey, recurringId: template.id, occurrenceDate: dueDate,
            month: expenseDay(`${dueDate.slice(0, 7)}-01`), amount: template.amount, currency: template.currency, category: template.category,
            source: template.source, agentId: template.agentId, note: template.title, categoryId: template.categoryId, counterparty: template.counterparty,
            paymentMethod: template.paymentMethod, status, paymentDate: status === "PAID" ? expenseDay(paymentDate ?? dueDate) : expenseDay(dueDate),
            createdById: actorId, exchangeRate: status === "PAID" ? (template.currency === "USD" ? money.usdToTjs : 1) : null, rateCapturedAt: status === "PAID" ? new Date() : null } });
}
export async function upcomingExpenses(from: string, to: string): Promise<ExpenseUpcomingItem[]> {
    const [templates, expenses] = await Promise.all([
        prisma.recurringExpense.findMany({ where: { active: true, deletedAt: null }, take: 1000 }),
        prisma.expense.findMany({ where: { deletedAt: null, OR: [{ paymentDate: { gte: expenseDay(from), lte: expenseDay(to) } }, { occurrenceDate: { gte: from, lte: to } }, { autoKey: { startsWith: "rec:" }, month: { gte: expenseDay(`${from.slice(0, 7)}-01`), lte: expenseDay(`${to.slice(0, 7)}-01`) } }] }, take: 5001 }),
    ]);
    if (expenses.length > 5000 || templates.length >= 1000)
        throw new ExpenseLifecycleError(413, "Сузьте период календаря");
    const rows: ExpenseUpcomingItem[] = expenses.filter(e => e.paymentDate || e.occurrenceDate).map(e => ({ id: e.id, expenseId: e.id, recurringId: e.recurringId ?? undefined, dueDate: e.status === "PAID" && e.paymentDate ? e.paymentDate.toISOString().slice(0, 10) : e.occurrenceDate ?? e.paymentDate!.toISOString().slice(0, 10), status: e.status as "PAID" | "PLANNED", title: e.note ?? e.category, amount: String(e.amount), currency: e.currency, category: e.category, categoryId: e.categoryId, counterparty: e.counterparty, paymentMethod: e.paymentMethod as ExpenseUpcomingItem["paymentMethod"] })).filter(e => e.dueDate >= from && e.dueDate <= to);
    for (const t of templates)
        for (const day of occurrenceDates(t, from, to)) {
            const key = t.startsOn ? `rec:${t.id}:${day}` : `rec:${t.id}:${day.slice(0, 7)}`;
            const e = expenses.find(e => e.autoKey === key);
            if (e?.status === "PAID" && !rows.some(r => r.expenseId === e.id))
                continue;
            if (e && rows.some(r => r.expenseId === e.id)) {
                const row = rows.find(r => r.expenseId === e.id)!;
                if (t.skippedDates.includes(day))
                    row.status = "SKIPPED";
                continue;
            }
            rows.push({ id: e?.id ?? `rec:${t.id}:${day}`, expenseId: e?.id, recurringId: t.id, dueDate: day, status: t.skippedDates.includes(day) ? "SKIPPED" : e?.status === "PAID" ? "PAID" : "PLANNED", title: t.title, amount: String(e?.amount ?? t.amount), currency: e?.currency ?? t.currency, category: t.category, categoryId: t.categoryId, counterparty: t.counterparty, paymentMethod: t.paymentMethod as ExpenseUpcomingItem["paymentMethod"] });
        }
    return rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}
/** Explicit opt-in only: legacy templates keep their established monthly accounting. */
export async function processWorkspaceRecurringExpenses(): Promise<number> {
    const today = todayExpenseDay();
    let count = 0;
    const templates = await prisma.recurringExpense.findMany({ where: { active: true, deletedAt: null, startsOn: { not: null } } });
    for (const t of templates) {
        if (!t.startsOn)
            continue;
        for (const day of occurrenceDates(t, t.startsOn, today)) {
            if (t.skippedDates.includes(day))
                continue;
            await prisma.$transaction(async (tx) => {
                await tx.$queryRaw `SELECT "id" FROM "RecurringExpense" WHERE "id"=${t.id} FOR UPDATE`;
                const latest = await tx.recurringExpense.findUnique({ where: { id: t.id } });
                if (!latest || latest.deletedAt || !latest.active || latest.skippedDates.includes(day))
                    return;
                const row = await materializeOccurrence(latest, day, "PLANNED", undefined, undefined, tx);
                if (latest.autoPay && row.status === "PLANNED" && !row.deletedAt && !row.manualEditedAt)
                    await changeExpensePayment(row.id, true, day, tx);
            });
            count++;
        }
    }
    return count;
}

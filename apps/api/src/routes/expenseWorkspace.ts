import { Router, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import { z } from "zod";
import sharp from "sharp";
import path from "node:path";
import { expenseCategorySchema, expenseListQuerySchema, expensePaymentSchema, recurringOccurrenceSchema, EXPENSE_METHOD_LABELS, EXPENSE_CATEGORY_LABELS, type ExpensePivot } from "@royal-home/shared";
import { prisma } from "../db.js";
import { requirePermission } from "../auth/middleware.js";
import { expenseDay, expenseDto, expenseWhere, materializeOccurrence, occurrenceDates, todayExpenseDay, upcomingExpenses, changeExpensePayment, ExpenseLifecycleError,sortExpenseIds } from "../lib/expenseWorkspace.js";
import { expenseCentsToTjs, fromCents, loadMoneyContext } from "../lib/money.js";
import { logAudit } from "../lib/audit.js";
import { csvSafeText } from "../lib/csv.js";
import { sendDocumentFile } from "../telegram/api.js";
import { dealDocumentUpload } from "../upload.js";
import { anyParams } from "../lib/routeParams.js";
import { saveDealDocumentFile, deleteDealDocumentFile, dealDocumentFilePath } from "../lib/dealDocumentFiles.js";
/** Mounted after authenticated finance.view middleware; every mutation separately requires finance.manage. */
export const expenseWorkspaceRouter = Router();
const write = requirePermission("finance.manage");
const idSchema = z.uuid();
expenseWorkspaceRouter.param("id", (req, res, next, id) => { if (!idSchema.safeParse(id).success)
    return res.status(400).json({ error: "Некорректный идентификатор" }); next(); });
expenseWorkspaceRouter.get("/categories", async (req, res) => {
    const p = expenseListQuerySchema.safeParse(req.query);
    if (!p.success)
        return res.status(400).json({ error: "Неверные фильтры категорий" });
    const month = p.data.month ?? todayExpenseDay().slice(0, 7);
    const cutoff = new Date(Date.now() - 90 * 86400000);
    const [categories, expenses, money] = await Promise.all([prisma.expenseCategoryDefinition.findMany({ orderBy: { title: "asc" } }), prisma.expense.findMany({ where: { deletedAt: null, status: "PAID", OR: [{ month: expenseDay(`${month}-01`) }, { createdAt: { gte: cutoff } }] }, take: 20001 }), loadMoneyContext()]);
    if (expenses.length > 20000)
        throw new ExpenseLifecycleError(413, "Слишком много расходов для справочника");
    res.json(categories.map(c => { const ids = new Set([c.id]); for (let i = 0; i < categories.length; i++) {
        let changed = false;
        for (const child of categories)
            if (child.parentId && ids.has(child.parentId) && !ids.has(child.id)) {
                ids.add(child.id);
                changed = true;
            }
        if (!changed)
            break;
    } const isRoot = /^00000000-0000-4000-8000-00000000000[1-4]$/.test(c.id); const matches = expenses.filter(e => isRoot ? e.category === c.rootCategory : !!e.categoryId && ids.has(e.categoryId)); return { ...c, usageCount: matches.filter(e => e.createdAt >= cutoff).length, spentTjs: fromCents(matches.filter(e => e.month.toISOString().slice(0, 7) === month).reduce((sum, e) => sum + expenseCentsToTjs(e, money), 0)) }; }).sort((a, b) => b.usageCount - a.usageCount || a.title.localeCompare(b.title, "ru")));
});
expenseWorkspaceRouter.get("/counterparties", async (req, res) => {
    const p = expenseListQuerySchema.safeParse(req.query);
    if (!p.success)
        return res.status(400).json({ error: "Неверный поиск" });
    const [expenses, money] = await Promise.all([prisma.expense.findMany({ where: { deletedAt: null, counterparty: { not: null, ...(p.data.q ? { contains: p.data.q, mode: "insensitive" } : {}) } }, take: 20001 }), loadMoneyContext()]);
    if (expenses.length > 20000)
        throw new ExpenseLifecycleError(413, "Уточните поиск контрагента");
    const parties = new Map<string, {
        title: string;
        count: number;
        paidCents: number;
    }>();
    for (const e of expenses) {
        if (!e.counterparty?.trim())
            continue;
        const row = parties.get(e.counterparty) ?? { title: e.counterparty, count: 0, paidCents: 0 };
        row.count++;
        if (e.status === "PAID")
            row.paidCents += expenseCentsToTjs(e, money);
        parties.set(row.title, row);
    }
    res.json([...parties.values()].sort((a, b) => b.count - a.count).slice(0, 200).map(p => ({ title: p.title, count: p.count, totalPaidTjs: fromCents(p.paidCents) })));
});
expenseWorkspaceRouter.post("/categories", write, async (req, res) => {
    const parsed = expenseCategorySchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: "Некорректная категория", details: parsed.error.flatten() });
    if (parsed.data.parentId) {
        const parent = await prisma.expenseCategoryDefinition.findUnique({ where: { id: parsed.data.parentId } });
        if (!parent || parent.rootCategory !== parsed.data.rootCategory)
            return res.status(400).json({ error: "Родительская категория не соответствует разделу" });
    }
    const row = await prisma.expenseCategoryDefinition.create({ data: parsed.data });
    logAudit(req, "CREATE", "ExpenseCategoryDefinition", row.id, {});
    res.status(201).json(row);
});
expenseWorkspaceRouter.patch("/categories/:id", write, async (req, res) => {
    const parsed = expenseCategorySchema.partial().safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: "Некорректная категория" });
    const row = await prisma.expenseCategoryDefinition.findUnique({ where: { id: req.params.id } });
    if (!row)
        return res.status(404).json({ error: "Категория не найдена" });
    if (parsed.data.rootCategory && parsed.data.rootCategory !== row.rootCategory)
        return res.status(400).json({ error: "Раздел существующей категории менять нельзя" });
    const parentId = parsed.data.parentId === undefined ? row.parentId : parsed.data.parentId;
    if (parentId) {
        let next: string | null = parentId;
        const visited = new Set([row.id]);
        for (let i = 0; next && i < 100; i++) {
            if (visited.has(next))
                return res.status(400).json({ error: "Цикл категорий недопустим" });
            visited.add(next);
            const parent: {
                rootCategory: string;
                parentId: string | null;
            } | null = await prisma.expenseCategoryDefinition.findUnique({ where: { id: next }, select: { rootCategory: true, parentId: true } });
            if (!parent || parent.rootCategory !== row.rootCategory)
                return res.status(400).json({ error: "Неверная родительская категория" });
            next = parent.parentId;
        }
        if (next)
            return res.status(400).json({ error: "Слишком глубокие категории" });
    }
    const updated = await prisma.expenseCategoryDefinition.update({ where: { id: row.id }, data: parsed.data });
    logAudit(req, "UPDATE", "ExpenseCategoryDefinition", row.id, {});
    res.json(updated);
});
expenseWorkspaceRouter.get("/upcoming", async (req, res) => {
    const today = todayExpenseDay();
    const p = expenseListQuerySchema.safeParse({ from: `${today.slice(0, 7)}-01`, to: new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10), ...req.query });
    if (!p.success)
        return res.status(400).json({ error: "Некорректный период" });
    if ((expenseDay(p.data.to!).getTime() - expenseDay(p.data.from!).getTime()) / 86400000 > 366)
        return res.status(400).json({ error: "Выберите не больше года" });
    res.json(await upcomingExpenses(p.data.from!, p.data.to!));
});
async function filteredExpenses(query: unknown) { const p = expenseListQuerySchema.parse(query); const rows = await prisma.expense.findMany({ where: expenseWhere(p), take: 20001, orderBy: [{ month: "asc" }, { createdAt: "asc" }] }); if (rows.length > 20000)
    throw new ExpenseLifecycleError(413, "Сузьте период: более 20 000 расходов"); return rows; }
expenseWorkspaceRouter.get("/pivot", async (req, res) => {
    const p = expenseListQuerySchema.safeParse(req.query);
    if (!p.success)
        return res.status(400).json({ error: "Некорректные фильтры" });
    const [expenses, categories, money] = await Promise.all([filteredExpenses({ ...p.data, status: "PAID" }), prisma.expenseCategoryDefinition.findMany(), loadMoneyContext()]);
    const result: ExpensePivot = { months: [], rows: [], totalTjs: 0 };
    const groups = new Map<string, ExpensePivot["rows"][number]>();
    let total = 0;
    for (const e of expenses) {
        const month = e.month.toISOString().slice(0, 7);
        if (!result.months.includes(month))
            result.months.push(month);
        const key = e.categoryId ?? e.category;
        const cat = categories.find(c => c.id === e.categoryId);
        let row = groups.get(key);
        if (!row) {
            row = { categoryId: key, title: cat?.title ?? e.category, rootCategory: e.category, color: cat?.color ?? "#7F97B4", values: {} };
            groups.set(key, row);
        }
        const amount = expenseCentsToTjs(e, money);
        row.values[month] = (row.values[month] ?? 0) + amount;
        total += amount;
    }
    result.months.sort();
    result.rows = [...groups.values()].map(r => ({ ...r, values: Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, fromCents(v)])) }));
    result.totalTjs = fromCents(total);
    res.json(result);
});
async function expenseCsv(query: unknown) {
    const filters=expenseListQuerySchema.parse(query);
    const [loaded,money]=await Promise.all([filteredExpenses(filters),loadMoneyContext()]);
    const [authors,categories]=await Promise.all([prisma.agent.findMany({where:{id:{in:[...new Set(loaded.flatMap(e=>e.createdById?[e.createdById]:[]))]}},select:{id:true,fullName:true}}),prisma.expenseCategoryDefinition.findMany({select:{id:true,title:true}})]);
    const authorNames=new Map(authors.map(a=>[a.id,a.fullName]));const titles=new Map(categories.map(c=>[c.id,c.title]));
    const byId=new Map(loaded.map(e=>[e.id,e]));const rows=filters.sortBy?(await sortExpenseIds(loaded,filters.sortBy,filters.sortDirection,money)).map(id=>byId.get(id)!):loaded;
    const methods:Readonly<Record<string,string>>=EXPENSE_METHOD_LABELS;
    const q=(v:unknown)=>`"${csvSafeText(String(v??"")).replace(/"/g,'""')}"`;
    return "\uFEFF"+[["Дата оплаты","Месяц","Название","Категория","Кому","Способ оплаты","Кто внёс","Статус","Сумма","Валюта","Сумма, с."].map(q).join(";"),...rows.map(e=>[e.paymentDate?.toISOString().slice(0,10)??"",e.month.toISOString().slice(0,7),e.note,(e.categoryId?titles.get(e.categoryId):undefined)??EXPENSE_CATEGORY_LABELS[e.category],e.counterparty,e.paymentMethod?methods[e.paymentMethod]??e.paymentMethod:"",e.createdById?authorNames.get(e.createdById)??"":"",e.status==="PAID"?"Оплачено":"План",String(e.amount).replace(".",","),e.currency,fromCents(expenseCentsToTjs(e,money)).toFixed(2).replace(".",",")].map(q).join(";"))].join("\r\n");
}
expenseWorkspaceRouter.get("/export", async (req, res, next) => {
    if (!["month", "from", "to", "status", "categoryId", "rootCategory", "counterparty", "paymentMethod", "q", "recurringId", "sortBy", "sortDirection"].some(k => k in req.query))
        return next();
    if (!expenseListQuerySchema.safeParse(req.query).success)
        return res.status(400).json({ error: "Некорректные фильтры" });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="royal-home-expenses.csv"');
    res.send(await expenseCsv(req.query));
});
expenseWorkspaceRouter.post("/export/telegram", async (req, res) => {
    if (!expenseListQuerySchema.safeParse(req.query).success)
        return res.status(400).json({ error: "Некорректные фильтры" });
    const actor = await prisma.agent.findUnique({ where: { id: req.agent!.id }, select: { telegramChatId: true } });
    if (!actor?.telegramChatId)
        return res.status(409).json({ error: "Привяжите свой Telegram в профиле" });
    const csv = await expenseCsv(req.query);
    try {
        await sendDocumentFile(String(actor.telegramChatId), Buffer.from(csv), "royal-home-expenses.csv");
    }
    catch {
        return res.status(503).json({ error: "Telegram не принял файл. Повторите отправку позже" });
    }
    logAudit(req, "FINANCE_EXPORT", "Expense", null, { destination: "ownTelegram" });
    res.json({ ok: true });
});
function expensePaymentHandler(action:"pay"|"undo-payment"):RequestHandler<{id:string}> {
    return async (req, res) => {
        const p = expensePaymentSchema.safeParse(req.body);
        if (!p.success)
            return res.status(400).json({ error: "Неверная дата" });
        try {
            const row = await changeExpensePayment(req.params.id, action === "pay", p.data.paymentDate);
            logAudit(req, "UPDATE", "Expense", row.id, { paymentAction: action });
            res.json(expenseDto(row));
        }
        catch (error) {
            if (error instanceof ExpenseLifecycleError)
                return res.status(error.status).json({ error: error.message });
            throw error;
        }
    };
}
expenseWorkspaceRouter.post("/:id/pay",write,expensePaymentHandler("pay"));
expenseWorkspaceRouter.post("/:id/undo-payment",write,expensePaymentHandler("undo-payment"));
function recurringPaymentHandler(action:"pay"|"skip"|"undo"|"undo-payment"):RequestHandler<{id:string}> {
    return async (req, res) => {
        const p = recurringOccurrenceSchema.safeParse(req.body);
        if (!p.success)
            return res.status(400).json({ error: "Неверная дата платежа" });
        const t = await prisma.recurringExpense.findUnique({ where: { id: req.params.id } });
        if (!t || t.deletedAt)
            return res.status(404).json({ error: "Подписка не найдена" });
        const day = p.data.dueDate;
        if (!occurrenceDates(t, day, day).includes(day))
            return res.status(400).json({ error: "Дата не относится к подписке" });
        try {
            const result = await prisma.$transaction(async (tx) => {
                await tx.$queryRaw `SELECT "id" FROM "RecurringExpense" WHERE "id"=${t.id} FOR UPDATE`;
                const latest = await tx.recurringExpense.findUnique({ where: { id: t.id } });
                if (!latest || latest.deletedAt)
                    throw new ExpenseLifecycleError(404, "Подписка удалена");
                let row = await materializeOccurrence(latest, day, "PLANNED", req.agent!.id, undefined, tx);
                await tx.$queryRaw `SELECT "id" FROM "Expense" WHERE "id"=${row.id} FOR UPDATE`;
                row = (await tx.expense.findUnique({ where: { id: row.id } }))!;
                if (row.deletedAt)
                    throw new ExpenseLifecycleError(409, "Платёж удалён. Сначала восстановите расход");
                if (action === "skip") {
                    if (row.status === "PAID")
                        throw new ExpenseLifecycleError(409, "Оплаченный платёж нельзя пропустить");
                    await tx.recurringExpense.update({ where: { id: t.id }, data: { skippedDates: { set: [...new Set([...latest.skippedDates, day])] } } });
                    return null;
                }
                const expense = await changeExpensePayment(row.id, action === "pay", p.data.paymentDate, tx);
                await tx.recurringExpense.update({ where: { id: t.id }, data: { skippedDates: { set: latest.skippedDates.filter(d => d !== day) } } });
                return expense;
            });
            logAudit(req, "UPDATE", "RecurringExpense", t.id, { paymentAction: action, dueDate: day });
            res.json(result ? expenseDto(result) : { ok: true });
        }
        catch (error) {
            if (error instanceof ExpenseLifecycleError)
                return res.status(error.status).json({ error: error.message });
            throw error;
        }
    };
}
expenseWorkspaceRouter.post("/recurring/:id/pay",write,recurringPaymentHandler("pay"));
expenseWorkspaceRouter.post("/recurring/:id/skip",write,recurringPaymentHandler("skip"));
expenseWorkspaceRouter.post("/recurring/:id/undo",write,recurringPaymentHandler("undo"));
expenseWorkspaceRouter.post("/recurring/:id/undo-payment",write,recurringPaymentHandler("undo-payment"));
expenseWorkspaceRouter.patch("/recurring/:id/restore", write, async (req, res) => { const t = await prisma.recurringExpense.findUnique({ where: { id: req.params.id } }); if (!t)
    return res.status(404).json({ error: "Подписка не найдена" }); res.json(await prisma.recurringExpense.update({ where: { id: t.id }, data: { deletedAt: null } })); logAudit(req, "RESTORE", "RecurringExpense", t.id, {}); });
expenseWorkspaceRouter.post("/:id/receipts", write, anyParams(dealDocumentUpload.single("file")), async (req, res) => {
    const e = await prisma.expense.findUnique({ where: { id: req.params.id } });
    if (!e || e.deletedAt)
        return res.status(404).json({ error: "Расход не найден" });
    if (!req.file)
        return res.status(400).json({ error: "Чек не получен" });
    let buffer = req.file.buffer;
    let mime = req.file.mimetype;
    if (mime === "application/pdf") {
        if (buffer.subarray(0, 5).toString() !== "%PDF-")
            return res.status(400).json({ error: "Файл не является PDF" });
    }
    else {
        try {
            buffer = await sharp(buffer, { limitInputPixels: 40000000 }).rotate().jpeg({ quality: 90 }).toBuffer();
            mime = "image/jpeg";
        }
        catch {
            return res.status(400).json({ error: "Изображение повреждено или слишком большое" });
        }
    }
    const fileName = saveDealDocumentFile(buffer, mime);
    if (!fileName)
        return res.status(503).json({ error: "Не удалось сохранить чек" });
    try {
        const row = await prisma.expenseReceipt.create({ data: { expenseId: e.id, fileName, originalName: req.file.originalname.slice(0, 200), mimeType: mime, size: buffer.length, uploadedById: req.agent!.id } });
        logAudit(req, "CREATE", "ExpenseReceipt", row.id, {});
        res.status(201).json({ id: row.id, originalName: row.originalName, mimeType: row.mimeType, size: row.size, url: `/api/v1/expenses/${e.id}/receipts/${row.id}/file` });
    }
    catch (error) {
        deleteDealDocumentFile(fileName);
        throw error;
    }
});
expenseWorkspaceRouter.get("/:id/receipts/:receiptId/file", async (req, res) => {
    if (!idSchema.safeParse(req.params.receiptId).success)
        return res.status(400).json({ error: "Неверный чек" });
    const row = await prisma.expenseReceipt.findFirst({ where: { id: req.params.receiptId, expenseId: req.params.id, expense: { deletedAt: null } } });
    if (!row)
        return res.status(404).json({ error: "Чек не найден" });
    const file = dealDocumentFilePath(row.fileName);
    if (!file)
        return res.status(404).json({ error: "Файл не найден" });
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", row.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="receipt.${row.mimeType === "application/pdf" ? "pdf" : "jpg"}"`);
    res.sendFile(path.basename(file), { root: path.dirname(file), cacheControl: false, dotfiles: "deny" }, error => { if (error && !res.headersSent)
        res.status(500).json({ error: "Не удалось прочитать чек" }); });
});
expenseWorkspaceRouter.delete("/:id/receipts/:receiptId", write, async (req, res) => {
    if (!idSchema.safeParse(req.params.receiptId).success)
        return res.status(400).json({ error: "Неверный чек" });
    const row = await prisma.expenseReceipt.findFirst({ where: { id: req.params.receiptId, expenseId: req.params.id, expense: { deletedAt: null } } });
    if (!row)
        return res.status(404).json({ error: "Чек не найден" });
    await prisma.expenseReceipt.delete({ where: { id: row.id } });
    deleteDealDocumentFile(row.fileName);
    logAudit(req, "DELETE", "ExpenseReceipt", row.id, {});
    res.json({ ok: true });
});
expenseWorkspaceRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => { if (error instanceof ExpenseLifecycleError)
    return res.status(error.status).json({ error: error.message }); if (error instanceof z.ZodError)
    return res.status(400).json({ error: "Некорректные фильтры" }); next(error); });

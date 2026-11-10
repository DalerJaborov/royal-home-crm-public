import { Router, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import { z } from "zod";
import sharp from "sharp";
import path from "node:path";
import { expenseListQuerySchema, EXPENSE_METHOD_LABELS, EXPENSE_CATEGORY_LABELS } from "@royal-home/shared";
import { prisma } from "../db.js";
import { requirePermission } from "../auth/middleware.js";
import { expenseDay, expenseDto, todayExpenseDay, upcomingExpenses, ExpenseLifecycleError,sortExpenseIds } from "../lib/expenseWorkspace.js";
import { changeRecurringOccurrence, createExpenseCategory, ExpenseCommandError, restoreRecurringExpense, setExpensePayment, updateExpenseCategory, type RecurringOccurrenceAction } from "../lib/expenseCommands.js";
import { buildExpensePivot, filteredExpenses, listExpenseCategories } from "../lib/expenseQueries.js";
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
/** Ошибка правила из lib/expenseCommands.ts — тот же статус и текст ответа, что раньше. */
function commandFailed(res: Response, err: unknown): boolean {
    if (!(err instanceof ExpenseCommandError))
        return false;
    res.status(err.status).json(err.body);
    return true;
}
const idSchema = z.uuid();
expenseWorkspaceRouter.param("id", (req, res, next, id) => { if (!idSchema.safeParse(id).success)
    return res.status(400).json({ error: "Некорректный идентификатор" }); next(); });
expenseWorkspaceRouter.get("/categories", async (req, res) => {
    const p = expenseListQuerySchema.safeParse(req.query);
    if (!p.success)
        return res.status(400).json({ error: "Неверные фильтры категорий" });
    res.json(await listExpenseCategories(p.data.month ?? todayExpenseDay().slice(0, 7)));
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
    try {
        const row = await createExpenseCategory(req.body);
        logAudit(req, "CREATE", "ExpenseCategoryDefinition", row.id, {});
        res.status(201).json(row);
    }
    catch (err) {
        if (!commandFailed(res, err))
            throw err;
    }
});
expenseWorkspaceRouter.patch("/categories/:id", write, async (req, res) => {
    try {
        const updated = await updateExpenseCategory(req.params.id, req.body);
        logAudit(req, "UPDATE", "ExpenseCategoryDefinition", updated.id, {});
        res.json(updated);
    }
    catch (err) {
        if (!commandFailed(res, err))
            throw err;
    }
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
expenseWorkspaceRouter.get("/pivot", async (req, res) => {
    const p = expenseListQuerySchema.safeParse(req.query);
    if (!p.success)
        return res.status(400).json({ error: "Некорректные фильтры" });
    res.json(await buildExpensePivot(p.data));
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
        try {
            const row = await setExpensePayment(req.params.id, action === "pay", req.body);
            logAudit(req, "UPDATE", "Expense", row.id, { paymentAction: action });
            res.json(expenseDto(row));
        }
        catch (error) {
            if (!commandFailed(res, error))
                throw error;
        }
    };
}
expenseWorkspaceRouter.post("/:id/pay",write,expensePaymentHandler("pay"));
expenseWorkspaceRouter.post("/:id/undo-payment",write,expensePaymentHandler("undo-payment"));
function recurringPaymentHandler(action:RecurringOccurrenceAction):RequestHandler<{id:string}> {
    return async (req, res) => {
        try {
            const { expense, dueDate } = await changeRecurringOccurrence(req.params.id, action, req.body, req.agent!.id);
            logAudit(req, "UPDATE", "RecurringExpense", req.params.id, { paymentAction: action, dueDate });
            res.json(expense ? expenseDto(expense) : { ok: true });
        }
        catch (error) {
            if (!commandFailed(res, error))
                throw error;
        }
    };
}
expenseWorkspaceRouter.post("/recurring/:id/pay",write,recurringPaymentHandler("pay"));
expenseWorkspaceRouter.post("/recurring/:id/skip",write,recurringPaymentHandler("skip"));
expenseWorkspaceRouter.post("/recurring/:id/undo",write,recurringPaymentHandler("undo"));
expenseWorkspaceRouter.post("/recurring/:id/undo-payment",write,recurringPaymentHandler("undo-payment"));
expenseWorkspaceRouter.patch("/recurring/:id/restore", write, async (req, res) => {
    try {
        const row = await restoreRecurringExpense(req.params.id);
        res.json(row);
        logAudit(req, "RESTORE", "RecurringExpense", row.id, {});
    }
    catch (err) {
        if (!commandFailed(res, err))
            throw err;
    }
});
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
    const content = await prisma.expenseReceiptContent.findUnique({ where: { receiptId: row.id }, select: { image: true } });
    const file = content ? null : dealDocumentFilePath(row.fileName);
    if (!content && !file)
        return res.status(404).json({ error: "Файл не найден" });
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", row.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="receipt.${row.mimeType === "application/pdf" ? "pdf" : "jpg"}"`);
    if (content) { res.send(Buffer.from(content.image)); return; }
    res.sendFile(path.basename(file!), { root: path.dirname(file!), cacheControl: false, dotfiles: "deny" }, error => { if (error && !res.headersSent)
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

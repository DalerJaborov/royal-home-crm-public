import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { occurrenceDates, processWorkspaceRecurringExpenses } from "../src/lib/expenseWorkspace.js";
import { expenseCentsToTjs } from "../src/lib/money.js";
import { expenseDateSchema } from "@royal-home/shared";
const provider = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue({ message_id: 1 }) }));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/telegram/api.js")>(), sendDocumentFile: provider.send }));
const stamp = String(Date.now()).slice(-8);
let directorId: string;
let shareholderId: string;
let directorToken: string;
let readonlyToken: string;
const expenseIds: string[] = [];
const recurringIds: string[] = [];
const categoryIds: string[] = [];
const auth = () => ({ Authorization: `Bearer ${directorToken}` });
const expense = (override: Record<string, unknown> = {}) => ({ category: "OFFICE", month: "2020-02", amount: 100, note: "workspace fixture", paymentDate: "2020-02-10", ...override });
async function createExpense(override: Record<string, unknown> = {}) { const r = await request(app).post("/api/v1/expenses").set(auth()).send(expense(override)); expect(r.status).toBe(201); expenseIds.push(r.body.id); return r.body; }
async function createRecurring(override: Record<string, unknown> = {}) { const r = await request(app).post("/api/v1/expenses/recurring").set(auth()).send({ title: `workspace-${stamp}`, amount: 99, currency: "TJS", category: "OFFICE", dayOfMonth: 31, period: "MONTH", startsOn: "2198-02-28", autoPay: false, ...override }); expect(r.status).toBe(201); recurringIds.push(r.body.id); return r.body; }
beforeAll(async () => { const d = await prisma.agent.create({ data: { fullName: `finance ${stamp}`, phone: `+992940${stamp}`, passwordHash: "x", role: "DIRECTOR" } }); directorId = d.id; directorToken = signAccessToken({ sub: d.id, role: "DIRECTOR" }); const s = await prisma.agent.create({ data: { fullName: `readonly ${stamp}`, phone: `+992941${stamp}`, passwordHash: "x", role: "SHAREHOLDER" } }); shareholderId = s.id; readonlyToken = signAccessToken({ sub: s.id, role: "SHAREHOLDER" }); });
afterAll(async () => { await prisma.expense.deleteMany({ where: { OR: [{ id: { in: expenseIds } }, { recurringId: { in: recurringIds } }] } }); await prisma.recurringExpense.deleteMany({ where: { id: { in: recurringIds } } }); await prisma.expenseCategoryDefinition.deleteMany({ where: { id: { in: categoryIds } } }); await prisma.agent.deleteMany({ where: { id: { in: [directorId, shareholderId] } } }); });
describe("expense workspace lifecycle", () => {
    it("rejects a stale full expense snapshot, including a stale undo, without changing money", async () => {
        const opening = await createExpense();
        expect(opening.version).toBe(0);
        const first = await request(app).patch(`/api/v1/expenses/${opening.id}`).set(auth()).send({ version: opening.version, amount: 200, note: "corrected amount" });
        expect(first.status).toBe(200);
        const stale = await request(app).patch(`/api/v1/expenses/${opening.id}`).set(auth()).send({ ...expense(), version: opening.version, note: "stale unrelated edit" });
        expect(stale.status).toBe(409);
        expect(stale.body.code).toBe("EXPENSE_VERSION_CONFLICT");
        const second = await request(app).patch(`/api/v1/expenses/${opening.id}`).set(auth()).send({ version: first.body.version, amount: 300 });
        expect(second.status).toBe(200);
        const undo = await request(app).patch(`/api/v1/expenses/${opening.id}`).set(auth()).send({ version: first.body.version, amount: 100, note: opening.note });
        expect(undo.status).toBe(409);
        const stored = await prisma.expense.findUniqueOrThrow({ where: { id: opening.id } });
        expect(Number(stored.amount)).toBe(300);
        expect(stored.note).toBe("corrected amount");
    });
    it("allows one-field legacy partial edits but refuses a versionless full snapshot", async () => {
        const e = await createExpense();
        const snapshot = await request(app).patch(`/api/v1/expenses/${e.id}`).set(auth()).send({ amount: 999, note: "old cached form" });
        expect(snapshot.status).toBe(409);
        expect(snapshot.body.code).toBe("EXPENSE_VERSION_REQUIRED");
        const single = await request(app).patch(`/api/v1/expenses/${e.id}`).set(auth()).send({ note: "explicit partial edit" });
        expect(single.status).toBe(200);
        expect(Number(single.body.amount)).toBe(100);
        expect(single.body.note).toBe("explicit partial edit");
    });
    it("CAS permits only one simultaneous edit from the same opening version", async () => {
        const e = await createExpense();
        const results = await Promise.all([200,300].map(amount => request(app).patch(`/api/v1/expenses/${e.id}`).set(auth()).send({ version: e.version, amount })));
        expect(results.map(r=>r.status).sort()).toEqual([200,409]);
        const stored = await prisma.expense.findUniqueOrThrow({ where: { id: e.id } });
        expect(Number(stored.amount)).toBe(Number(results.find(r=>r.status===200)!.body.amount));
        expect(stored.version).toBe(e.version+1);
    });
    it("does not undo creation by deleting a subsequently edited expense", async () => {
        const e = await createExpense();
        const updated = await request(app).patch(`/api/v1/expenses/${e.id}`).set(auth()).send({ version: e.version, amount: 200 });
        expect(updated.status).toBe(200);
        const undo = await request(app).delete(`/api/v1/expenses/${e.id}?version=${e.version}`).set(auth());
        expect(undo.status).toBe(409);
        const stored = await prisma.expense.findUniqueOrThrow({ where: { id: e.id } });
        expect(stored.deletedAt).toBeNull();
        expect(Number(stored.amount)).toBe(200);
        expect((await request(app).delete(`/api/v1/expenses/${e.id}?version=${updated.body.version}`).set(auth())).status).toBe(204);
    });
    it("rejects status-only future payment PATCH and leaves every stored field unchanged", async () => {
        const e = await createExpense({ status: "PLANNED", month: "2198-02", paymentDate: "2198-02-10" });
        const before = await prisma.expense.findUniqueOrThrow({ where: { id: e.id } });
        const rejected = await request(app).patch(`/api/v1/expenses/${e.id}`).set(auth()).send({ version: e.version, status: "PAID" });
        expect(rejected.status).toBe(400);
        expect(await prisma.expense.findUniqueOrThrow({ where: { id: e.id } })).toEqual(before);
        expect((await request(app).patch(`/api/v1/expenses/${e.id}`).set(auth()).send({ version: e.version, status: "PAID", paymentDate: "2020-02-10" })).status).toBe(200);
    });
    it("allows unchanged archived categories on edits and subscription disable, but no new assignment", async () => {
        const category = await prisma.expenseCategoryDefinition.create({ data: { title: `archived-${stamp}`, rootCategory: "OFFICE", icon: "Building2", color: "#4E9E88" } });
        categoryIds.push(category.id);
        const e = await createExpense({ categoryId: category.id });
        const template = await createRecurring({ categoryId: category.id });
        await prisma.expenseCategoryDefinition.update({ where: { id: category.id }, data: { active: false } });
        const note = await request(app).patch(`/api/v1/expenses/${e.id}`).set(auth()).send({ version: e.version, category: "OFFICE", categoryId: category.id, note: "corrected archived entry" });
        expect(note.status).toBe(200);
        expect(note.body.categoryId).toBe(category.id);
        expect((await request(app).patch(`/api/v1/expenses/recurring/${template.id}`).set(auth()).send({ active: false })).status).toBe(200);
        const another = await createExpense();
        expect((await request(app).patch(`/api/v1/expenses/${another.id}`).set(auth()).send({ version: another.version, categoryId: category.id })).status).toBe(400);
        const anotherTemplate = await createRecurring();
        expect((await request(app).patch(`/api/v1/expenses/recurring/${anotherTemplate.id}`).set(auth()).send({ categoryId: category.id })).status).toBe(400);
        expect((await request(app).patch(`/api/v1/expenses/${e.id}`).set(auth()).send({ version: note.body.version, category: "OTHER" })).status).toBe(400);
        expect((await request(app).post("/api/v1/expenses").set(auth()).send(expense({ categoryId: category.id }))).status).toBe(400);
    });
    it.each([29,30,31])("retains contractual day %i after a title-only subscription edit and clamps only February", async dayOfMonth => {
        const template = await createRecurring({ startsOn: "2026-01-" + dayOfMonth, dayOfMonth });
        const edited = await request(app).patch(`/api/v1/expenses/recurring/${template.id}`).set(auth()).send({ title: "new title" });
        expect(edited.status).toBe(200);
        expect(edited.body.dayOfMonth).toBe(dayOfMonth);
        expect(occurrenceDates(edited.body, "2026-01-01", "2026-03-31")).toEqual([`2026-01-${dayOfMonth}`, "2026-02-28", `2026-03-${dayOfMonth}`]);
    });
    it("sorts the full filtered set before pagination by frozen TJS instead of mixed raw currencies", async()=>{
        const party=`sorting-${stamp}`;
        const middle=await createExpense({counterparty:party,amount:200,note:"Сортировка средняя"});
        const high=await createExpense({counterparty:party,amount:10,currency:"USD",exchangeRate:30,note:"Сортировка высокая",paymentMethod:"CARD_DIRECTOR",categoryId:"00000000-0000-4000-8000-000000000003"});
        const low=await createExpense({counterparty:party,amount:50,currency:"USD",exchangeRate:1,note:"Сортировка низкая"});
        const found:string[]=[];
        for(let page=1;page<=3;page++){const r=await request(app).get(`/api/v1/expenses?page=${page}&pageSize=1&counterparty=${party}&sortBy=amount&sortDirection=asc`).set(auth());expect(r.status).toBe(200);expect(r.body.total).toBe(3);found.push(r.body.items[0].id);}
        expect(found).toEqual([low.id,middle.id,high.id]);
        const csv=await request(app).get(`/api/v1/expenses/export?counterparty=${party}&page=1&pageSize=1&sortBy=amount&sortDirection=desc`).set(auth());
        expect(csv.status).toBe(200);expect(csv.text).toContain("Кто внёс");expect(csv.text).toContain(`finance ${stamp}`);expect(csv.text).toContain("Карта директора");expect(csv.text).toContain("Офис");
        expect(csv.text.indexOf("Сортировка высокая")).toBeLessThan(csv.text.indexOf("Сортировка средняя"));expect(csv.text.indexOf("Сортировка средняя")).toBeLessThan(csv.text.indexOf("Сортировка низкая"));expect(csv.text).toContain('"300,00"');
    });
    it("sorts real author names across pages and puts unknown historical dates last", async()=>{
        const party=`authors-${stamp}`;const d=await createExpense({counterparty:party,paymentDate:null});const s=await createExpense({counterparty:party,paymentDate:"2020-02-11"});await prisma.expense.update({where:{id:s.id},data:{createdById:shareholderId}});
        const authors=await request(app).get(`/api/v1/expenses?page=1&pageSize=1&counterparty=${party}&sortBy=author&sortDirection=asc`).set(auth());expect(authors.body.items[0].id).toBe(d.id);expect(authors.body.total).toBe(2);
        for(const direction of ["asc","desc"]){const dates=await request(app).get(`/api/v1/expenses?counterparty=${party}&sortBy=date&sortDirection=${direction}`).set(auth());expect(dates.body.map((e:{id:string})=>e.id)).toEqual([s.id,d.id]);}
        expect((await request(app).get("/api/v1/expenses?sortBy=balance").set(auth())).status).toBe(400);
    });
    it("legacy automatic templates now respect OFF as planned without rewriting historical facts", async () => {
        const day = Number(new Date(Date.now() + 5 * 3600000).toISOString().slice(8, 10));
        const legacy = await prisma.recurringExpense.create({ data: { title: `legacy-${stamp}`, amount: 30, dayOfMonth: Math.min(28, day), autoPay: false } });
        recurringIds.push(legacy.id);
        const { processRecurringExpenses } = await import("../src/lib/financeAutomation.js");
        await processRecurringExpenses();
        const rows = await prisma.expense.findMany({ where: { recurringId: legacy.id } });
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe("PLANNED");
        expect(rows[0].paymentDate).not.toBeNull();
        await prisma.recurringExpense.update({ where: { id: legacy.id }, data: { startsOn: rows[0].occurrenceDate, autoPay: true } });
        await processWorkspaceRecurringExpenses();
        const same = await prisma.expense.findMany({ where: { recurringId: legacy.id } });
        expect(same).toHaveLength(1);
        expect(same[0].status).toBe("PAID");
        await request(app).post(`/api/v1/expenses/recurring/${legacy.id}/undo-payment`).set(auth()).send({ dueDate: same[0].occurrenceDate });
        await processWorkspaceRecurringExpenses();
        expect((await prisma.expense.findUnique({ where: { id: same[0].id } }))?.status).toBe("PLANNED");
    });
    it("moves a planned payment into the actual month, then restores its exact original date and rate", async () => {
        const e = await createExpense({ status: "PLANNED", month: "2020-06", paymentDate: "2020-06-30", currency: "USD", exchangeRate: null });
        const [a, b] = await Promise.all([request(app).post(`/api/v1/expenses/${e.id}/pay`).set(auth()).send({ paymentDate: "2020-07-01" }), request(app).post(`/api/v1/expenses/${e.id}/pay`).set(auth()).send({ paymentDate: "2020-07-02" })]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(a.body.paymentDate).toBe(b.body.paymentDate);
        expect(a.body.month.slice(0, 7)).toBe("2020-07");
        const undo = await request(app).post(`/api/v1/expenses/${e.id}/undo-payment`).set(auth()).send({});
        expect(undo.body.paymentDate).toBe("2020-06-30");
        expect(undo.body.month.slice(0, 7)).toBe("2020-06");
        expect(undo.body.exchangeRate).toBeNull();
    });
    it("does not undo an older paid entry, or overwrite a subsequent manual edit", async () => {
        const old = await createExpense();
        expect((await request(app).post(`/api/v1/expenses/${old.id}/undo-payment`).set(auth()).send({})).status).toBe(409);
        const e = await createExpense({ status: "PLANNED" });
        expect((await request(app).post(`/api/v1/expenses/${e.id}/pay`).set(auth()).send({ paymentDate: "2020-02-12" })).status).toBe(200);
        expect((await request(app).patch(`/api/v1/expenses/${e.id}`).set(auth()).send({ note: "manual edit retained" })).status).toBe(200);
        expect((await request(app).post(`/api/v1/expenses/${e.id}/undo-payment`).set(auth()).send({})).status).toBe(409);
        expect((await prisma.expense.findUnique({ where: { id: e.id } }))?.note).toBe("manual edit retained");
    });
    it("rejects future paid dates while preserving a genuine plan", async () => { expect((await request(app).post("/api/v1/expenses").set(auth()).send(expense({ paymentDate: "2198-02-10" }))).status).toBe(400); const e = await createExpense({ status: "PLANNED", paymentDate: "2198-02-10" }); expect((await request(app).post(`/api/v1/expenses/${e.id}/pay`).set(auth()).send({ paymentDate: "2198-02-10" })).status).toBe(400); expect((await prisma.expense.findUnique({ where: { id: e.id } }))?.status).toBe("PLANNED"); });
    it("retains historic paid records with genuinely unknown payment date", async () => { const e = await createExpense({ paymentDate: null }); expect(e.status).toBe("PAID"); expect(e.paymentDate).toBeNull(); expect(e.createdById).toBe(directorId); });
    it("rejects impossible calendar dates and amount above limit", async () => { expect(expenseDateSchema.safeParse("2026-02-31").success).toBe(false); expect(expenseDateSchema.safeParse("2026-13-01").success).toBe(false); expect((await request(app).post("/api/v1/expenses").set(auth()).send(expense({ amount: 100000000 }))).status).toBe(400); });
    it("deduplicates a retried create and rejects key reuse for different data", async () => { const key = `workspace-${stamp}`; const a = await request(app).post("/api/v1/expenses").set(auth()).set("Idempotency-Key", key).send(expense()); expenseIds.push(a.body.id); const b = await request(app).post("/api/v1/expenses").set(auth()).set("Idempotency-Key", key).send(expense()); expect(b.body.id).toBe(a.body.id); await prisma.idempotencyKey.deleteMany({ where: { agentId: directorId, key } }); const c = await request(app).post("/api/v1/expenses").set(auth()).set("Idempotency-Key", key).send(expense({ amount: 999 })); expect(c.status).toBe(409); });
    it("locks supplied USD rate rather than fabricating historical payment-time rate", async () => { const e = await createExpense({ currency: "USD", exchangeRate: 12 }); expect(Number(e.exchangeRate)).toBe(12); expect(e.rateCapturedAt).toBeTruthy(); expect(expenseCentsToTjs({ amount: 100, currency: "USD", exchangeRate: 12 }, { usdToTjs: 99 })).toBe(120000); });
    it("keeps planned money out of summary and pivot until paid, then undo removes it", async () => { const e = await createExpense({ status: "PLANNED", amount: 754.32 }); const base = await request(app).get("/api/v1/expenses/pivot?month=2020-02").set(auth()); const pay = await request(app).post(`/api/v1/expenses/${e.id}/pay`).set(auth()).send({ paymentDate: "2020-02-10" }); expect(pay.body.status).toBe("PAID"); const after = await request(app).get("/api/v1/expenses/pivot?month=2020-02").set(auth()); expect(after.body.totalTjs - base.body.totalTjs).toBeCloseTo(754.32, 2); const summary = await request(app).get("/api/v1/expenses/summary?months=1&through=2020-02").set(auth()); expect(summary.status).toBe(200); expect(summary.body.months[0].month).toBe("2020-02"); expect((await request(app).post(`/api/v1/expenses/${e.id}/undo-payment`).set(auth()).send({})).body.status).toBe("PLANNED"); });
    it("uses real pagination total and server filters, not slice length", async () => { const a = await createExpense({ counterparty: `party-${stamp}`, paymentMethod: "CASH" }); await createExpense({ counterparty: `party-${stamp}`, paymentMethod: "CASH" }); const r = await request(app).get(`/api/v1/expenses?page=1&pageSize=1&counterparty=party-${stamp}&paymentMethod=CASH`).set(auth()); expect(r.status).toBe(200); expect(r.body.total).toBe(2); expect(r.body.items).toHaveLength(1); expect(r.body.items[0].counterparty).toBe(a.counterparty); });
    it("category inheritance is validated and cycles are rejected", async () => { const root = await request(app).post("/api/v1/expenses/categories").set(auth()).send({ title: `root-${stamp}`, rootCategory: "OFFICE", icon: "Building2", color: "#4E9E88", budgetMonthly: 300 }); expect(root.status).toBe(201); categoryIds.push(root.body.id); const child = await request(app).post("/api/v1/expenses/categories").set(auth()).send({ title: `child-${stamp}`, rootCategory: "OFFICE", icon: "Wifi", color: "#4E9E88", parentId: root.body.id }); categoryIds.push(child.body.id); expect(child.status).toBe(201); expect((await request(app).patch(`/api/v1/expenses/categories/${root.body.id}`).set(auth()).send({ parentId: child.body.id })).status).toBe(400); expect((await request(app).post("/api/v1/expenses").set(auth()).send(expense({ category: "OTHER", categoryId: child.body.id }))).status).toBe(400); });
    it("clamps the original day each month, and respects quarter/year/week bounds", () => { expect(occurrenceDates({ startsOn: "2026-02-28", endsOn: null, period: "MONTH", dayOfMonth: 31 }, "2026-02-01", "2026-04-30")).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]); expect(occurrenceDates({ startsOn: "2026-01-10", endsOn: "2026-07-10", period: "QUARTER", dayOfMonth: 10 }, "2026-01-01", "2026-12-31")).toEqual(["2026-01-10", "2026-04-10", "2026-07-10"]); expect(occurrenceDates({ startsOn: "2026-01-10", endsOn: null, period: "WEEK", dayOfMonth: 10 }, "2026-01-10", "2026-01-24")).toEqual(["2026-01-10", "2026-01-17", "2026-01-24"]); });
    it("pay is idempotent, skip is undoable, paid cannot be skipped", async () => { const t = await createRecurring(); const p = `/api/v1/expenses/recurring/${t.id}`; let r = await request(app).post(`${p}/pay`).set(auth()).send({ dueDate: "2198-02-28", paymentDate: "2020-02-27" }); expect(r.status).toBe(200); const id = r.body.id; r = await request(app).post(`${p}/pay`).set(auth()).send({ dueDate: "2198-02-28" }); expect(r.body.id).toBe(id); expect(r.body.paymentDate).toBe("2020-02-27"); expect((await request(app).post(`${p}/skip`).set(auth()).send({ dueDate: "2198-02-28" })).status).toBe(409); expect((await request(app).post(`${p}/undo-payment`).set(auth()).send({ dueDate: "2198-02-28" })).body.status).toBe("PLANNED"); expect((await request(app).post(`${p}/skip`).set(auth()).send({ dueDate: "2198-02-28" })).status).toBe(200); const u = await request(app).get("/api/v1/expenses/upcoming?from=2198-02-01&to=2198-02-28").set(auth()); expect(u.body.find((e: {
        recurringId: string;
    }) => e.recurringId === t.id).status).toBe("SKIPPED"); expect((await request(app).post(`${p}/undo-payment`).set(auth()).send({ dueDate: "2198-02-28" })).status).toBe(200); });
    it("soft deletion has a genuine restore with same template ID", async () => { const t = await createRecurring(); expect((await request(app).delete(`/api/v1/expenses/recurring/${t.id}`).set(auth())).status).toBe(200); const r = await request(app).patch(`/api/v1/expenses/recurring/${t.id}/restore`).set(auth()).send({}); expect(r.status).toBe(200); expect(r.body.id).toBe(t.id); expect(r.body.deletedAt).toBeNull(); });
    it("uploads protected genuine receipt bytes and rejects spoofed content", async () => { const e = await createExpense(); expect((await request(app).post(`/api/v1/expenses/${e.id}/receipts`).set(auth()).attach("file", Buffer.from("fake pdf"), { filename: "fake.pdf", contentType: "application/pdf" })).status).toBe(400); const r = await request(app).post(`/api/v1/expenses/${e.id}/receipts`).set(auth()).attach("file", Buffer.from("%PDF-1.4\n%%EOF\n"), { filename: "receipt.pdf", contentType: "application/pdf" }); expect(r.status).toBe(201); expect((await request(app).get(r.body.url)).status).toBe(401); expect((await request(app).get(r.body.url).set(auth())).status).toBe(200); expect((await request(app).delete(`/api/v1/expenses/${e.id}/receipts/${r.body.id}`).set(auth())).status).toBe(200); });
    it("readonly direct mutations remain forbidden", async () => { expect((await request(app).post("/api/v1/expenses").set("Authorization", `Bearer ${readonlyToken}`).send(expense())).body.code).toBe("READ_ONLY_ROLE"); expect((await request(app).post("/api/v1/expenses/export/telegram").set("Authorization", `Bearer ${readonlyToken}`).send({})).status).toBe(403); });
    it("exports actual actor-only Telegram data via mocked provider", async () => { expect((await request(app).post("/api/v1/expenses/export/telegram").set(auth()).send({})).status).toBe(409); await prisma.agent.update({ where: { id: directorId }, data: { telegramChatId: `test-chat-${stamp}` } }); const r = await request(app).post("/api/v1/expenses/export/telegram?month=2020-02").set(auth()).send({}); expect(r.status).toBe(200); expect(provider.send).toHaveBeenCalledWith(`test-chat-${stamp}`, expect.any(Buffer), "royal-home-expenses.csv"); });
    it("new scheduled templates create planned rows with no real provider calls", async () => { const now = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10); const t = await createRecurring({ startsOn: now, dayOfMonth: Number(now.slice(-2)) }); await processWorkspaceRecurringExpenses(); const rows = await prisma.expense.findMany({ where: { recurringId: t.id } }); expect(rows).toHaveLength(1); expect(rows[0].status).toBe("PLANNED"); await processWorkspaceRecurringExpenses(); expect(await prisma.expense.count({ where: { recurringId: t.id } })).toBe(1); });
});

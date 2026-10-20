import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { csvSafeText } from "../src/lib/csv.js";

/**
 * Ночная проверка 24.09.2026, добивка 01.10: №216 (CSV-инъекция в выгрузках) и
 * №154 (правка/удаление регулярного расхода глотали любую ошибку как 404).
 */

const runId = Date.now();
const sfx = String(runId).slice(-7);
let directorId: string;
let agentId: string;
let directorToken: string;
let districtId: string;
let clientId: string;
let propertyId: string;
let dealId: string;
let expenseId: string;
let propertyDirId: string;

const FORMULA_CLIENT = `=HYPERLINK("http://evil.example","Нажмите")`;
const FORMULA_TITLE = `+cmd|' /C calc'!A0`;
const FORMULA_NOTE = `@SUM(1+1)`;

beforeAll(async () => {
  directorId = (await prisma.agent.create({ data: { fullName: "Директор csv", phone: `+992981${sfx}`, role: "DIRECTOR", passwordHash: "x" } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: "Агент csv", phone: `+992982${sfx}`, role: "AGENT", passwordHash: "x" } })).id;
  directorToken = signAccessToken({ sub: directorId, role: "DIRECTOR" });
  districtId = (await prisma.district.create({ data: { name: `Район csv ${runId}` } })).id;
  clientId = (
    await prisma.client.create({ data: { fullName: FORMULA_CLIENT, phone: `+992983${sfx}`, source: "PHONE_CALL", assignedAgentId: agentId } })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: { title: FORMULA_TITLE, type: "APARTMENT", areaSqm: 50, price: 100000, currency: "TJS", districtId, address: "ул. Тест", condition: "GOOD", status: "SOLD", createdById: agentId },
    })
  ).id;
  dealId = (
    await prisma.deal.create({
      data: { clientId, propertyId, agentId, stage: "COMPLETED", currency: "TJS", soldPrice: 90000, commissionAmount: 1500, commissionRealtorAmount: 500, commissionCompanyAmount: 1000, closedAt: new Date() },
    })
  ).id;
  expenseId = (
    await prisma.expense.create({ data: { month: new Date(), amount: 100, currency: "TJS", category: "OFFICE", note: FORMULA_NOTE } })
  ).id;
  propertyDirId = (
    await prisma.property.create({
      data: { title: "=1+1", type: "APARTMENT", areaSqm: 50, price: 1, currency: "TJS", districtId, address: "@cmd", condition: "GOOD", status: "AVAILABLE", createdById: agentId },
    })
  ).id;
});

afterAll(async () => {
  await prisma.expense.deleteMany({ where: { id: expenseId } });
  await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, propertyDirId] } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
});

describe("csvSafeText (№216)", () => {
  it("значения-формулы получают апостроф, обычный текст и числа — нет", () => {
    for (const bad of ["=1+1", "+cmd", "-cmd", "@SUM(A1)", "\tтаб", "\rвозврат"]) {
      expect(csvSafeText(bad)).toBe(`'${bad}`);
    }
    for (const ok of ["Умед", "12.50", "-1200.50", "+992901234567", "", null, undefined, "а=б"]) {
      expect(csvSafeText(ok)).toBe(String(ok ?? ""));
    }
  });
});

describe("выгрузки не исполняют формулы (№216)", () => {
  it("GET /expenses/export: имя клиента, объект и примечание расхода — с апострофом", async () => {
    const res = await request(app).get("/api/v1/expenses/export?months=2").set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    const text = res.text;
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example"",""Нажмите"")"`);
    expect(text).toContain(`"'+cmd|' /C calc'!A0"`);
    expect(text).toContain(`"'@SUM(1+1)"`);
    // Ни одна ячейка не начинается с формулы.
    expect(text).not.toMatch(/(^|;)"[=+@]/m);
  });

  it("GET /properties/export: название и адрес объекта — с апострофом", async () => {
    const res = await request(app).get("/api/v1/properties/export?format=csv").set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`"'=1+1"`);
    expect(res.text).toContain(`"'@cmd"`);
  });

  // Глубокая проверка 02.10.2026, C18: русский Excel открывал каталог
  // кракозябрами в одну колонку — без BOM и через запятую. Теперь как у
  // выгрузки бухгалтерии: BOM, «;», строки через \r\n.
  it("GET /properties/export: открывается в русском Excel — BOM и точка с запятой", async () => {
    const res = await request(app).get("/api/v1/properties/export?format=csv").set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    const [header] = res.text.slice(1).split("\r\n");
    expect(header.split(";").length).toBeGreaterThan(5);
    expect(res.headers["content-type"]).toContain("charset=utf-8");
  });
});

describe("регулярные расходы: отказ базы — не «не найдено» (№154)", () => {
  it("несуществующий шаблон — по-прежнему 404 (и PATCH, и DELETE)", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    const p = await request(app).patch(`/api/v1/expenses/recurring/${missing}`).set("Authorization", `Bearer ${directorToken}`).send({ title: "x" });
    expect(p.status).toBe(404);
    const d = await request(app).delete(`/api/v1/expenses/recurring/${missing}`).set("Authorization", `Bearer ${directorToken}`);
    expect(d.status).toBe(404);
  });

  it("сбой базы на update — 500, а не 404", async () => {
    const row=await prisma.recurringExpense.create({data:{title:"failure fixture",amount:10,dayOfMonth:1}});
    const spy = vi.spyOn(prisma.recurringExpense, "update").mockImplementation((() => Promise.reject(new Error("база недоступна"))) as never);
    try {
      const res = await request(app).patch(`/api/v1/expenses/recurring/${row.id}`).set("Authorization", `Bearer ${directorToken}`).send({ title: "x" });
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
      await prisma.recurringExpense.delete({where:{id:row.id}});
    }
  });

  it("сбой базы на delete — 500, а не 404", async () => {
    const row=await prisma.recurringExpense.create({data:{title:"failure fixture",amount:10,dayOfMonth:1}});
    const spy = vi.spyOn(prisma.recurringExpense, "update").mockImplementation((() => Promise.reject(new Error("база недоступна"))) as never);
    try {
      const res = await request(app).delete(`/api/v1/expenses/recurring/${row.id}`).set("Authorization", `Bearer ${directorToken}`);
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
      await prisma.recurringExpense.delete({where:{id:row.id}});
    }
  });
});

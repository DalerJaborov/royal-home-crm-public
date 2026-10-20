import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * НОЧНАЯ ПРОВЕРКА 24.09.2026, находка №1 («круг 3»): googleBudgetToken в схеме
 * settingsUpdateSchema принимал строку любой длины — владелец мог вписать
 * однозначное значение, и добавленный рядом rateLimit на POST /google-budget
 * только замедлил бы перебор, а не сделал бы короткий секрет надёжным. Схема
 * теперь требует минимум 24 символа для непустого значения (тот же порядок
 * энтропии, что у propertyShareLink), а пустая строка — «секрет не задан» —
 * по-прежнему проходит: так поле очищается.
 */

const runId = Date.now();
const password = "testpass123";

let adminId: string;
let adminToken: string;
let savedToken: string | null = null;

function patch(body: Record<string, unknown>) {
  return request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`).send(body);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ бюджетного токена", phone: `+992935${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = res.body.accessToken;
  grantElevation(adminId);

  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedToken = current.googleBudgetToken;
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { googleBudgetToken: savedToken } });
  await prisma.agent.delete({ where: { id: adminId } });
  await prisma.$disconnect();
});

describe("PATCH /settings — googleBudgetToken требует минимальную длину", () => {
  it("значение короче 24 символов отклоняется", async () => {
    const res = await patch({ googleBudgetToken: "short-token-12" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/24 символ/);

    const fresh = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { googleBudgetToken: true } });
    expect(fresh?.googleBudgetToken).toBe(savedToken);
  });

  it("значение от 24 символов сохраняется", async () => {
    const value = `long-enough-google-budget-token-${runId}`;
    expect(value.length).toBeGreaterThanOrEqual(24);
    const res = await patch({ googleBudgetToken: value });
    expect(res.status).toBe(200);

    const fresh = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { googleBudgetToken: true } });
    expect(fresh?.googleBudgetToken).toBe(value);
  });

  it("пустая строка по-прежнему очищает поле", async () => {
    const res = await patch({ googleBudgetToken: "" });
    expect(res.status).toBe(200);

    // Поле не шифруется и идёт через `...rest` как есть (в отличие от секретных
    // полей вида metaAppSecret, которые PATCH явно переводит "" -> null) —
    // «очищено» здесь означает пустую строку, а не null.
    const fresh = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { googleBudgetToken: true } });
    expect(fresh?.googleBudgetToken).toBe("");
  });
});

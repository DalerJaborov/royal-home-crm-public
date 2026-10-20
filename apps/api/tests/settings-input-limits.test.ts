import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * Ночная проверка 24.09.2026, №167: список дежурных по входящим и поля аккаунта
 * мессенджера принимали массивы и строки любой длины (потолок — только общий
 * мегабайт тела). Теперь у каждого поля есть предел, и перебор — это 400.
 */

const runId = Date.now();
const password = "testpass123";
/** Отказ именно от схемы, а не от последующей проверки существования сотрудника или Meta. */
const MESSAGE = /Некорректные данные|Неверные данные|Некорректные настройки|details/;
let adminId = "";
let adminToken = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: `Админ пределов настроек ${runId}`, phone: `+992964${String(runId).slice(-7)}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = res.body.accessToken;
  grantElevation(adminId);
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: adminId } });
});

describe("пределы длины в настройках (№167)", () => {
  it("PATCH /settings: 100 000 дежурных — 400", async () => {
    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ incomingDutyAgentIds: Array(100000).fill("x") });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(MESSAGE);
  });

  it("PATCH /settings: слишком длинный id дежурного — 400", async () => {
    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ incomingDutyAgentIds: ["x".repeat(500)] });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(MESSAGE);
  });

  it.each(["externalId", "title", "token"] as const)("POST /settings/messenger-accounts: %s на 10 000 знаков — 400", async (field) => {
    const body: Record<string, string> = { channel: "INSTAGRAM", externalId: "123", title: "Аккаунт", token: "t" };
    body[field] = "я".repeat(10000);
    const res = await request(app).post("/api/v1/settings/messenger-accounts").set("Authorization", `Bearer ${adminToken}`).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(MESSAGE);
  });

  it("POST /settings/messenger-accounts: systemPrompt на 100 000 знаков — 400", async () => {
    const res = await request(app)
      .post("/api/v1/settings/messenger-accounts")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ channel: "INSTAGRAM", externalId: "123", title: "Аккаунт", token: "t", systemPrompt: "я".repeat(100000) });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(MESSAGE);
  });
});

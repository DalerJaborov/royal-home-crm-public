import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Привязка личного Telegram-чата сотрудника (POST /me/telegram-link,
 * POST /me/telegram-unlink, 01.09.2026) — самообслуживание без участия
 * разработчика. Реальную обработку /start <код> в Telegram проверяет
 * tests/telegram-agent-link.test.ts; здесь — только выдача кода и отвязка.
 */

const runId = Date.now();
const phone = `+99298${runId.toString().slice(-7)}`;
const password = "testpass123";

let agentId: string;
let token: string;

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: {
      fullName: "Сотрудник привязки Telegram",
      phone,
      role: "AGENT",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  agentId = agent.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken;
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { phone } });
});

describe("GET /me — признак привязки", () => {
  it("непривязанный чат — telegramLinked: false", async () => {
    const res = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.telegramLinked).toBe(false);
    // Сам chatId наружу не отдаётся ни в каком виде.
    expect(res.body.telegramChatId).toBeUndefined();
  });
});

describe("POST /me/telegram-link", () => {
  it("выдаёт одноразовый код, записывает его агенту", async () => {
    const res = await request(app).post("/api/v1/me/telegram-link").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.code).toBe("string");
    expect(res.body.code.length).toBeGreaterThan(8);

    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(agent.telegramLinkCode).toBe(res.body.code);
  });

  it("повторный вызов перезаписывает прежний код — старым воспользоваться уже нельзя", async () => {
    const first = await request(app).post("/api/v1/me/telegram-link").set("Authorization", `Bearer ${token}`);
    const second = await request(app).post("/api/v1/me/telegram-link").set("Authorization", `Bearer ${token}`);
    expect(first.body.code).not.toBe(second.body.code);

    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(agent.telegramLinkCode).toBe(second.body.code);
  });
});

describe("POST /me/telegram-unlink", () => {
  it("сбрасывает привязку и код", async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { telegramChatId: "12345", telegramLinkCode: "leftover" } });

    const res = await request(app).post("/api/v1/me/telegram-unlink").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(agent.telegramChatId).toBeNull();
    expect(agent.telegramLinkCode).toBeNull();

    const me = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${token}`);
    expect(me.body.telegramLinked).toBe(false);
  });
});

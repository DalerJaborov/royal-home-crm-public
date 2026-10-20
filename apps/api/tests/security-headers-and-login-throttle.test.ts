import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

// Провайдер СМС в тестовой базе не подключён — подменяем только отправку: проверяется
// задержка входа, а не доставка кода.
vi.mock("../src/lib/sms/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/sms/index.js")>()),
  sendSms: async () => ({ ok: true as const, id: "t", parts: 1 }),
}));
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { __resetLoginThrottleForTests, clearLoginFailures, recordLoginFailure } from "../src/lib/loginThrottle.js";

/**
 * Пункт 6 пачки 4 аудита безопасности 11.09.2026:
 *  1. helmet отдаёт Strict-Transport-Security, X-Content-Type-Options,
 *     Referrer-Policy, Permissions-Policy.
 *  2. Вход: 10 неудач подряд по одному телефону за 15 минут — 11-я и далее
 *     задерживаются на ~2с (НЕ блокируются — код всё равно выдаётся, просто с
 *     задержкой). С 19.10.2026 — на пути кода, паролей нет.
 */

const runId = Date.now();
const password = "testpass123";
const phone = `+99297${String(runId).slice(-7)}`;

let createdAgentId: string;

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент Дросселя ${runId}`, phone, passwordHash: await bcrypt.hash(password, 10), role: "AGENT", isActive: true },
  });
  createdAgentId = agent.id;
});

afterAll(async () => {
  await prisma.loginSmsCode.deleteMany({ where: { agentId: createdAgentId } });
  await prisma.agent.deleteMany({ where: { id: createdAgentId } });
});

describe("Заголовки безопасности (helmet + Permissions-Policy)", () => {
  it("ответ несёт все четыре заголовка", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.headers["strict-transport-security"]).toBeTruthy();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBeTruthy();
    expect(res.headers["permissions-policy"]).toBeTruthy();
  });
});

describe("Задержка входа после 10 неудач по телефону за 15 минут", () => {
  // С 19.10.2026 вход — по коду (routes/auth.ts /login/code). Неудачи копятся тем
  // же счётчиком: неверный код и запрос кода на чужой номер (recordLoginFailure).
  // Десять неверных кодов подряд упираются ещё и в лимит попыток кода по
  // сотруднику (8 за 5 минут), поэтому неудачи здесь заносятся напрямую — ровно
  // так, как их заносит /login/verify-code.
  const askCode = () => request(app).post("/api/v1/auth/login/code").send({ phone });

  it("до порога запрос кода отвечает быстро", async () => {
    __resetLoginThrottleForTests();
    await prisma.loginSmsCode.deleteMany({ where: { agentId: createdAgentId } });
    const start = Date.now();
    const res = await askCode();
    expect(res.status).toBe(200);
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it("после 10 неудач — следующий ответ приходит с задержкой ~2с, но вход всё равно возможен", async () => {
    __resetLoginThrottleForTests();
    await prisma.loginSmsCode.deleteMany({ where: { agentId: createdAgentId } });
    for (let i = 0; i < 10; i++) recordLoginFailure(phone);
    const start = Date.now();
    const res = await askCode();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    // НЕ блокировка: код всё равно выдаётся.
    expect(res.status).toBe(200);
    expect(res.body.pendingToken).toBeTruthy();
  });

  it("неверный код на чужой номер тоже копит неудачи этого номера", async () => {
    __resetLoginThrottleForTests();
    const stranger = `+99296${String(runId).slice(-7)}`;
    for (let i = 0; i < 10; i++) await request(app).post("/api/v1/auth/login/code").send({ phone: stranger });
    const start = Date.now();
    await request(app).post("/api/v1/auth/login/code").send({ phone: stranger });
    expect(Date.now() - start).toBeGreaterThanOrEqual(1900);
  });

  it("успешный вход сбрасывает счётчик неудач для этого телефона", async () => {
    __resetLoginThrottleForTests();
    await prisma.loginSmsCode.deleteMany({ where: { agentId: createdAgentId } });
    for (let i = 0; i < 10; i++) recordLoginFailure(phone);
    const issued = await askCode();
    expect(issued.body.devCode ?? null).toBeNull();
    // Код из базы не достать (хранится хеш) — успех входа проверяем тем же путём,
    // что и сервер: verify-code при верном коде зовёт clearLoginFailures.
    clearLoginFailures(phone);
    await prisma.loginSmsCode.deleteMany({ where: { agentId: createdAgentId } });
    const start = Date.now();
    const res = await askCode();
    expect(res.status).toBe(200);
    expect(Date.now() - start).toBeLessThan(1500);
  });
});

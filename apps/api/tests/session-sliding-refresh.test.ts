import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { refreshTtlMs } from "../src/auth/jwt.js";

/**
 * Срок refresh-cookie обязан отсчитываться от последней активности, а не от ввода
 * пароля.
 *
 * Так было: POST /auth/refresh продлевал строку Session (touchSession), но саму
 * cookie не трогал — она оставалась подписанной на 30 дней от логина. Человек,
 * работавший в CRM каждый день, ровно через 30 суток попадал на экран входа и не
 * мог войти: пароля он за месяц ни разу не вводил. Поймано 14.09.2026 на проде —
 * агент вылетел день в день, и в ту же неделю подходил срок ещё у четверых,
 * включая директора и админа.
 */

const runId = Date.now();
const password = "testpass123";
const phone = `+992906${String(runId).slice(-7)}`;
let agentId: string;

function refreshCookieFrom(res: request.Response): string | undefined {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.find((c) => c.startsWith("refreshToken="));
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: "Тест Скользящей Сессии", phone, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) },
  });
  agentId = agent.id;
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Скользящий срок refresh-cookie", () => {
  it("обновление токена перевыпускает refresh-cookie на полный срок заново", async () => {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .set("User-Agent", "SlidingRefreshAgent/1.0")
      .send({ phone, password });
    expect(login.status).toBe(200);

    const loginCookie = refreshCookieFrom(login);
    expect(loginCookie, "вход обязан выдать refresh-cookie").toBeDefined();

    const refreshed = await request(app)
      .post("/api/v1/auth/refresh")
      .set("User-Agent", "SlidingRefreshAgent/1.0")
      .set("Cookie", loginCookie!.split(";")[0]!);
    expect(refreshed.status).toBe(200);

    const renewed = refreshCookieFrom(refreshed);
    expect(renewed, "обновление обязано перевыпустить refresh-cookie, иначе срок не сдвигается").toBeDefined();

    // Max-Age выставлен заново на полный срок — именно это и означает «отсчёт пошёл
    // от сейчас, а не от логина». Допуск в секунду: cookie округляет срок до секунд.
    const maxAge = Number(/max-age=(\d+)/i.exec(renewed!)?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(Math.floor(refreshTtlMs() / 1000) - 1);
  });

  it("деактивированному агенту обновление не продлевает cookie", async () => {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .set("User-Agent", "SlidingRefreshDisabled/1.0")
      .send({ phone, password });
    expect(login.status).toBe(200);
    const cookie = refreshCookieFrom(login)!.split(";")[0]!;

    await prisma.agent.update({ where: { id: agentId }, data: { isActive: false } });
    try {
      const refreshed = await request(app)
        .post("/api/v1/auth/refresh")
        .set("User-Agent", "SlidingRefreshDisabled/1.0")
        .set("Cookie", cookie);
      expect(refreshed.status).toBe(401);
      const renewed = refreshCookieFrom(refreshed);
      // Отказ обязан стирать cookie, а не продлевать её.
      expect(renewed === undefined || /max-age=0|expires=thu, 01 jan 1970/i.test(renewed)).toBe(true);
    } finally {
      await prisma.agent.update({ where: { id: agentId }, data: { isActive: true } });
    }
  });
});

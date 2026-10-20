import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * «Активность команды» разбирает строку запроса общей схемой, а не руками.
 *
 * Ручной разбор (`Number(req.query.page) || 1`, `new Date(req.query.from)`) пропускал
 * три вещи разом: у страницы не было потолка, хотя она доходит до skip/take;
 * «?from=вчера» превращалось в Invalid Date и фильтр по периоду молча пропадал
 * вместо понятного отказа; agentId принимался любой строкой. Раздел с отчётами и
 * календарём должен понимать период одинаково — иначе одни и те же даты дают в
 * разных экранах разные цифры (аудит 09.08.2026).
 */

const runId = Date.now();
let adminId = "";
let token = "";

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: {
      fullName: `Админ ленты ${runId}`,
      phone: `+99299${String(runId).slice(-7)}`,
      role: "ADMIN",
      passwordHash: "x",
    },
  });
  adminId = admin.id;
  token = signAccessToken({ sub: admin.id, role: "ADMIN" });
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: adminId } });
});

function feed(query: string) {
  return request(app).get(`/api/v1/interactions${query}`).set("Authorization", `Bearer ${token}`);
}

describe("Лента активности: строка запроса", () => {
  it("обычный запрос по-прежнему работает", async () => {
    const res = await feed("?page=1");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it("бессмысленно большой номер страницы отвергается", async () => {
    expect((await feed("?page=1000000")).status).toBe(400);
  });

  it("неразбираемая дата — понятный отказ, а не молча потерянный фильтр", async () => {
    expect((await feed("?from=вчера")).status).toBe(400);
  });

  it("agentId не из формата идентификатора отвергается", async () => {
    expect((await feed("?agentId=' OR 1=1--")).status).toBe(400);
  });

  it("нормальный период принимается", async () => {
    expect((await feed("?from=2026-08-01&to=2026-08-09")).status).toBe(200);
  });
});

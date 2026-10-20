import { afterAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Ночная проверка 24.09.2026, находка P1 («у половины офиса CRM не работает»,
 * подробный разбор в verify-1-ekrany-e2e.md): `brandingLimiter` (лимит на
 * GET /settings/branding) считал по `req.ip` без `keyGenerator` — на проде за
 * nginx (trust proxy + X-Forwarded-For) это ОДИН внешний адрес на весь офис.
 * Одна волна холодных загрузок (выкат, `UpdatePrompt` перегружает все вкладки
 * разом) набирала общий счётчик, и следующий 429 доставался уже не тому, кто
 * его вызвал, а любому коллеге за тем же адресом.
 *
 * Supertest шлёт все запросы с одного адреса (127.0.0.1) — ровно «весь офис за
 * одним IP», как и у соседних `login-limiter-key.test.ts`/`totp-limiter-key.test.ts`.
 * Проверяем по заголовку `RateLimit-Remaining` (express-rate-limit,
 * standardHeaders:true), не набирая реальные сотни/тысячи запросов до 429:
 * если ключ общий на всех (старое поведение), счётчик агента A "тратит" лимит
 * соседа B; если ключ по агенту (починка), первый же запрос B получает свежий
 * остаток независимо от того, сколько уже сходил A.
 */
const runId = Date.now();
const password = "testpass123";
const created: string[] = [];

async function makeAgent(tag: string): Promise<string> {
  const phone = `+9927${tag}${runId}`;
  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент лимитера бренда ${tag}`,
      phone,
      passwordHash: await bcrypt.hash(password, 10),
      role: "AGENT",
      isActive: true,
    },
  });
  created.push(agent.id);
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: created } } });
});

describe("brandingLimiter (GET /settings/branding) — ключ по агенту, а не по общему IP офиса", () => {
  it("несколько запросов агента A не трогают остаток лимита агента B", async () => {
    const tokenA = await makeAgent("1");
    const tokenB = await makeAgent("2");

    let remainingAfterA = -1;
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/api/v1/settings/branding").set("Authorization", `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      remainingAfterA = Number(res.headers["ratelimit-remaining"]);
    }

    const resB = await request(app).get("/api/v1/settings/branding").set("Authorization", `Bearer ${tokenB}`);
    expect(resB.status).toBe(200);
    const remainingB = Number(resB.headers["ratelimit-remaining"]);

    // Ключ по агенту: у B свежий счётчик — остаток ВЫШЕ, чем то, что осталось
    // у A после пяти запросов. По общему IP-ключу (старое поведение) счётчик
    // продолжал бы падать и у B, и remainingB был бы МЕНЬШЕ remainingAfterA.
    expect(remainingB).toBeGreaterThan(remainingAfterA);
  });

  it("анонимный запрос (без токена, экран входа) по-прежнему считается по адресу", async () => {
    const res = await request(app).get("/api/v1/settings/branding");
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-remaining"]).toBeDefined();
  });
});

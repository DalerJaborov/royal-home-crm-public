import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * НОЧНАЯ ПРОВЕРКА 24.09.2026, находка №1 («круг 3»): POST /api/v1/webhooks/google-budget
 * был единственным публичным секрет-роутом в проекте без своего rateLimit — секрет в
 * `?token=` можно было перебирать без предела (общий apiLimiter не считает: весь
 * префикс /api/v1/webhooks исключён из него, см. app.ts API_LIMIT_EXEMPT_PREFIXES).
 * Проверяем, что новый лимитер (budgetWebhookLimiter, 60/час) реально режет поток —
 * 61-й подряд запрос получает ответ лимитера (429), а не проходит до сравнения секрета.
 *
 * Модуль budgetWebhook.ts изолирован на файл (vitest isolate:true), поэтому счётчик
 * лимитера начинается с нуля именно в этом файле — не делит бюджет с
 * budget-webhook-idempotency.test.ts.
 */

const runId = Date.now();
let savedToken: string | null = null;

beforeAll(async () => {
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedToken = settings.googleBudgetToken;
  await prisma.settings.update({ where: { id: "singleton" }, data: { googleBudgetToken: `real-token-${runId}` } });
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { googleBudgetToken: savedToken } }).catch(() => {});
  await prisma.$disconnect();
});

describe("budgetWebhookLimiter — перебор ?token= на /google-budget упирается в предел", () => {
  it("60 промахов подряд отвечают как обычно, 61-й — ответом лимитера (429)", async () => {
    // Секрет заведомо неверный: каждый промах должен получать 200 {ignored:true}
    // (см. комментарий в самом роуте — Pub/Sub на 4xx повторял бы доставку часами),
    // лимитер считает эти запросы независимо от того, что ответил обработчик.
    for (let i = 0; i < 60; i++) {
      const res = await request(app)
        .post("/api/v1/webhooks/google-budget")
        .query({ token: `guess-${runId}-${i}` })
        .send({ message: { data: "" } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ignored: true });
    }

    const blocked = await request(app)
      .post("/api/v1/webhooks/google-budget")
      .query({ token: `guess-${runId}-60` })
      .send({ message: { data: "" } });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: expect.stringMatching(/Слишком много/) });
  });
});

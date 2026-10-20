import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { MAX_TRACKED_PHONES, recordLoginFailure, trackedLoginFailureCount } from "../src/lib/loginThrottle.js";

/**
 * Аудит 23.09.2026, круг 3, №73: поток попыток входа выедал память API.
 *
 * Лимит входа считал по номеру, общий лимит вход не трогает — и поток с новым
 * случайным номером на каждый запрос проходил целиком. Номер без потолка
 * длины (до мегабайта в теле) ложился в память дважды: ключом лимитера и
 * записью счётчика неудач, который рос без предела.
 */
afterAll(async () => {
  await prisma.$disconnect();
});

describe("поток попыток входа не съедает память сервера", () => {
  it("номер длиной в тысячу цифр отбивается проверкой, до базы и счётчиков", async () => {
    const res = await request(app).post("/api/v1/auth/login/code").send({ phone: "9".repeat(1000) });
    expect(res.status).toBe(400);
  });

  it("счётчик неудач помнит не больше потолка номеров", () => {
    for (let i = 0; i < MAX_TRACKED_PHONES + 1500; i++) recordLoginFailure(`+99290${String(i).padStart(7, "0")}`);
    expect(trackedLoginFailureCount()).toBeLessThanOrEqual(MAX_TRACKED_PHONES);
  });

  it("с одного адреса — не больше 200 входов за 15 минут, как бы ни менялся номер", async () => {
    let last = 0;
    for (let i = 0; i < 201; i++) {
      // Короткий «номер» не проходит проверку и не ходит в базу — тест быстрый.
      const res = await request(app).post("/api/v1/auth/login/code").send({ phone: `${i}` });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});

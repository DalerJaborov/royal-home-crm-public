import { describe, expect, it } from "vitest";
import { waitForSettled } from "./helpers/waitFor.js";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * БИТЫЙ JSON В ТЕЛЕ — ВИНА КЛИЕНТА, НЕ СЕРВЕРА (найдено 25.08.2026 по журналу
 * ошибок: «Bad escaped character in JSON at position 9» на /auth/login).
 *
 * До правки это падало в общий catch-all app.ts и отвечало 500 «Внутренняя
 * ошибка сервера» — неправда, сервер жив, тело просто нечитаемое — да ещё
 * писалось в ErrorLog, будя директора «новым видом ошибки» на каждый чужой
 * скан/кривой ручной запрос.
 */
describe("Некорректный JSON в теле запроса", () => {
  it("отвечает 400, а не 500 — это ошибка клиента, не сервера", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json")
      .send('{"phone": "12345, "password": "x"}'); // незакрытая строка — ровно тот случай из журнала

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it("не пишется в ErrorLog — это не системная поломка, будить директора не о чем", async () => {
    /**
     * Считаем не ВСЕ строки журнала, а только те, что могли бы появиться из-за
     * этого запроса. Общий счётчик мерил бы заодно всё, что пишут в журнал
     * соседние файлы (и фоновые записи, отвечающие уже после своего теста), —
     * тест падал бы от чужой ошибки, а не от появления своей.
     */
    // Регрессия писала бы строку общим обработчиком app.ts: source "api" и
    // url того самого маршрута (см. app.ts, ветка catch-all).
    const own = { source: "api", url: { contains: "/auth/login" } } as const;
    // ОБА замера через waitForSettled: app.ts пишет журнал через
    // `void logSystemError`, ждать в проверке «не записали» нечего.
    const before = await waitForSettled(() => prisma.errorLog.count({ where: own }));
    await request(app)
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json")
      .send('{"phone": "12345, "password": "x"}');
    const after = await waitForSettled(() => prisma.errorLog.count({ where: own }));
    expect(after).toBe(before);
  });
});

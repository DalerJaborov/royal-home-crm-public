import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { waitForSettled } from "./helpers/waitFor.js";

/**
 * Аудит 23.09.2026, круг 3, №82: тело больше лимита (1 МБ JSON) отвечало 500
 * «Внутренняя ошибка» и писало в журнал ошибок строку на КАЖДЫЙ такой запрос,
 * без дедупа. Поток больших тел превращался в поток записей в базу.
 */
afterAll(async () => {
  await prisma.$disconnect();
});

describe("отказы разбора тела — код входа, а не 500", () => {
  it("тело больше лимита — 413 и ни строки в журнале", async () => {
    const where = { message: { contains: "request entity too large" } };
    const before = await waitForSettled(() => prisma.errorLog.count({ where }));
    const huge = JSON.stringify({ phone: "1".repeat(2 * 1024 * 1024), password: "x" });
    const res = await request(app).post("/api/v1/auth/login").set("Content-Type", "application/json").send(huge);
    expect(res.status).toBe(413);
    const after = await waitForSettled(() => prisma.errorLog.count({ where }));
    expect(after).toBe(before);
  });
});

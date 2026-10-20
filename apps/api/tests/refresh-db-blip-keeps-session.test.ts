import { afterAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Аудит 23.09.2026, круг 3, №71: короткий сбой базы выкидывал агента из CRM.
 *
 * После перехода на Prisma 7 (драйвер pg) исчерпанный пул бросает голую ошибку
 * pg-pool «timeout exceeded when trying to connect», а лежащая база — P1001 с
 * kind "DatabaseNotReachable" (оба вида сняты живым прогоном). Детектор знал
 * только старый P2024, и POST /auth/refresh на любой такой ошибке стирал
 * cookie входа и отвечал 401 — сайт на 401 делает выход. Каждый перезапуск
 * Postgres = все, кто в эту секунду обновлял токен, снова вводят пароль и код.
 */
const touchSession = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/sessions.js")>()),
  touchSession,
}));

const { app } = await import("../src/app.js");
const { signRefreshToken } = await import("../src/auth/jwt.js");
const { isTransientDbError, isPoolExhaustionError } = await import("../src/lib/concurrency.js");
const { prisma } = await import("../src/db.js");

afterAll(async () => {
  await prisma.$disconnect();
});

function clearsCookie(res: request.Response): boolean {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.some((c) => c.startsWith("refreshToken=;"));
}

const poolTimeout = () => new Error("timeout exceeded when trying to connect");
const dbDown = () =>
  Object.assign(new Error("Invalid `prisma.session.findUnique()` invocation"), {
    code: "P1001",
    meta: { driverAdapterError: { name: "DriverAdapterError", cause: { kind: "DatabaseNotReachable" } } },
  });

describe("сбой базы при обновлении токена не выкидывает из CRM", () => {
  const cookie = `refreshToken=${signRefreshToken({ sub: "agent-blip", sid: "session-blip" })}`;

  it.each([
    ["пул соединений занят", poolTimeout],
    ["база перезапускается", dbDown],
    ["неизвестный сбой базы", () => new Error("something odd")],
  ])("%s → 503 «повторите», вход не стирается", async (_label, make) => {
    touchSession.mockRejectedValueOnce(make());
    const res = await request(app).post("/api/v1/auth/refresh").set("Cookie", cookie);
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(clearsCookie(res)).toBe(false);
  });

  it("испорченный токен по-прежнему стирает вход и отвечает 401", async () => {
    const res = await request(app).post("/api/v1/auth/refresh").set("Cookie", "refreshToken=not-a-jwt");
    expect(res.status).toBe(401);
    expect(clearsCookie(res)).toBe(true);
  });

  it("детектор узнаёт ошибки нынешнего драйвера", () => {
    expect(isPoolExhaustionError(poolTimeout())).toBe(true);
    expect(isTransientDbError(poolTimeout())).toBe(true);
    expect(isTransientDbError(dbDown())).toBe(true);
    expect(isTransientDbError({ code: "P1017" })).toBe(true);
    expect(isTransientDbError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransientDbError({ code: "P2002" })).toBe(false);
    expect(isTransientDbError(new Error("Недействительный или истёкший токен"))).toBe(false);
  });
});

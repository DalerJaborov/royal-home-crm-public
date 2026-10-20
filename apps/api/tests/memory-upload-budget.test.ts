import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import request from "supertest";
import type { Request, Response } from "express";

/**
 * ОДИН ЗАПРОС С ФОТО НЕ РОНЯЕТ API (аудит 23.09.2026, круг 3).
 *
 * multer держит фото целиком в памяти: 30 файлов по 30 МБ = 900 МБ на один
 * запрос при контейнере в 768 МБ. Теперь размер проверяется по заголовку ДО
 * чтения тела, а сумма идущих загрузок ограничена.
 */

const { app } = await import("../src/app.js");
const { createMemoryUploadBudget } = await import("../src/lib/memoryUploadBudget.js");

const MB = 1024 * 1024;

function fakeRes() {
  const res = new EventEmitter() as EventEmitter & { statusCode: number; body: unknown; headers: Record<string, string> };
  res.statusCode = 200;
  res.headers = {};
  Object.assign(res, {
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    setHeader(k: string, v: string) {
      res.headers[k] = v;
    },
  });
  return res as unknown as Response & EventEmitter & { statusCode: number };
}
const reqOf = (len?: number) => ({ headers: len === undefined ? {} : { "content-length": String(len) } }) as Request;

describe("бюджет памяти на загрузки", () => {
  it("огромный запрос отклоняется до чтения тела", () => {
    const budget = createMemoryUploadBudget({ maxRequestBytes: 64 * MB, maxInFlightBytes: 192 * MB });
    const res = fakeRes();
    let passed = false;
    budget(reqOf(900 * MB), res, () => (passed = true));
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(413);
  });

  it("без размера — отказ", () => {
    const budget = createMemoryUploadBudget({ maxRequestBytes: 64 * MB, maxInFlightBytes: 192 * MB });
    const res = fakeRes();
    budget(reqOf(), res, () => {});
    expect(res.statusCode).toBe(411);
  });

  it("параллельные загрузки сверх бюджета ждут, после ответа место освобождается", () => {
    const budget = createMemoryUploadBudget({ maxRequestBytes: 64 * MB, maxInFlightBytes: 100 * MB });
    const first = fakeRes();
    const second = fakeRes();
    let ok = 0;
    budget(reqOf(60 * MB), first, () => ok++);
    budget(reqOf(60 * MB), second, () => ok++);
    expect(ok).toBe(1);
    expect(second.statusCode).toBe(503);
    first.emit("finish");
    first.emit("close");
    expect(budget.inFlightBytes()).toBe(0);
    const third = fakeRes();
    budget(reqOf(60 * MB), third, () => ok++);
    expect(ok).toBe(2);
  });

  it("маршрут фото объекта отклоняет запрос на 900 МБ по заголовку", async () => {
    const { signAccessToken } = await import("../src/auth/jwt.js");
    const { prisma } = await import("../src/db.js");
    const tail = String(Date.now()).slice(-7);
    const director = await prisma.agent.create({
      data: { fullName: `Директор загрузок ${tail}`, phone: `+99289${tail}`, role: "DIRECTOR", passwordHash: "x" },
    });
    const token = signAccessToken({ sub: director.id, role: "DIRECTOR" });
    const res = await request(app)
      .post("/api/v1/properties/00000000-0000-4000-8000-000000000000/photos")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "multipart/form-data; boundary=x")
      .set("Content-Length", String(900 * MB))
      .send("");
    await prisma.agent.delete({ where: { id: director.id } });
    expect(res.status).toBe(413);
  });
});

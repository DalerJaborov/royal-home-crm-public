import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * «N ОШИБОК ЗА СЕГОДНЯ · РАЗОБРАТЬ ВСЕ» ЗАКРЫВАЕТ ТОЛЬКО СЕГОДНЯШНИЕ (аудит 23.09.2026, №56).
 *
 * Пульт считал сегодняшние ошибки, а кнопка закрывала все неразобранные, в том
 * числе старые, которые директор ни разу не видел.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
let directorId = "";
let token = "";
let oldId = "";
let todayId = "";

beforeAll(async () => {
  directorId = (
    await prisma.agent.create({ data: { fullName: `Директор ошибок ${runId}`, phone: `+99293${tail}`, role: "DIRECTOR", passwordHash: "x" } })
  ).id;
  token = signAccessToken({ sub: directorId, role: "DIRECTOR" });
  oldId = (
    await prisma.errorLog.create({
      data: { source: "api", message: `Старая ошибка ${runId}`, createdAt: new Date(Date.now() - 3 * 86_400_000) },
    })
  ).id;
  todayId = (await prisma.errorLog.create({ data: { source: "api", message: `Сегодняшняя ошибка ${runId}` } })).id;
});

afterAll(async () => {
  await prisma.errorLog.deleteMany({ where: { id: { in: [oldId, todayId] } } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
});

describe("Разобрать сегодняшние ошибки", () => {
  it("старая ошибка остаётся неразобранной", async () => {
    const res = await request(app)
      .post("/api/v1/errors/resolve-all")
      .set("Authorization", `Bearer ${token}`)
      .send({ scope: "today" });
    expect(res.status).toBe(200);
    const [old, today] = await Promise.all([
      prisma.errorLog.findUniqueOrThrow({ where: { id: oldId } }),
      prisma.errorLog.findUniqueOrThrow({ where: { id: todayId } }),
    ]);
    expect(today.resolvedAt).not.toBeNull();
    expect(old.resolvedAt).toBeNull();
  });
});

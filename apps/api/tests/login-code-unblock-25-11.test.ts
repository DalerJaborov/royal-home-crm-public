import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * БЛОК ВХОДА ПО КОДУ (25.11.2026): сотрудница жала «ещё раз», упёрлась в 5 кодов за
 * час и не могла войти. Держим: (1) директор снимает блок кнопкой, остальные — 403,
 * аудит пишется; (2) 503 по лимиту отдаёт, когда блок снимется; (3) сторож отказов
 * пишет одну запись на 3-м отказе за 15 минут и не дублирует.
 */
vi.mock("../src/lib/sms/index.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/sms/index.js")>();
  return { ...orig, sendSms: async () => ({ ok: true, id: "t", parts: 1 }) };
});

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { grantElevation } = await import("../src/lib/stepUp.js");
const { LOGIN_SMS_PER_HOUR } = await import("../src/lib/loginSmsCode.js");
const { noteLoginCodeRefusal, resetLoginCodeWatch } = await import("../src/lib/loginCodeWatch.js");

type Role = "DIRECTOR" | "ADMIN" | "AGENT";
const tail = String(Date.now()).slice(-7);
const ids: string[] = [];
let directorId: string;
let adminId: string;
let targetId: string;
let targetPhone: string;

async function mk(fullName: string, phone: string, role: Role, extra: object = {}) {
  const a = await prisma.agent.create({ data: { fullName, phone, role, ...extra } });
  ids.push(a.id);
  return a;
}
const auth = (id: string, role: Role) => ({ Authorization: `Bearer ${signAccessToken({ sub: id, role })}` });
const reset = (actor: { id: string; role: Role }, target: string) =>
  request(app).post(`/api/v1/agents/${target}/login-code/reset`).set(auth(actor.id, actor.role));

/** Пять кодов за последний час: самый ранний — 50 минут назад. */
async function fillHour() {
  const now = Date.now();
  await prisma.loginSmsCode.createMany({
    data: Array.from({ length: LOGIN_SMS_PER_HOUR }, (_, i) => ({
      agentId: targetId,
      codeHash: `h${i}`,
      channel: "sms",
      expiresAt: new Date(now + 60_000),
      createdAt: new Date(now - (50 - i * 10) * 60_000),
    })),
  });
}

beforeAll(async () => {
  directorId = (await mk("Директор сброса", `+99291${tail}`, "DIRECTOR")).id;
  adminId = (await mk("Админ сброса", `+99292${tail}`, "ADMIN")).id;
  targetPhone = `+99293${tail}`;
  targetId = (await mk("Ноза сброса", targetPhone, "AGENT", { telegramChatId: `tg-${tail}` })).id;
  grantElevation(adminId);
  grantElevation(directorId);
});
beforeEach(async () => {
  resetLoginCodeWatch();
  await prisma.loginSmsCode.deleteMany({ where: { agentId: targetId } });
});
afterAll(async () => {
  await prisma.loginSmsCode.deleteMany({ where: { agentId: { in: ids } } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { entityId: targetId } }).catch(() => {});
  await prisma.errorLog.deleteMany({ where: { dedupKey: { startsWith: `login-code-refusals:${targetId}` } } }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  await prisma.$disconnect();
});

describe("сброс блока входа по коду", () => {
  it("директор обнуляет счётчик: после сброса код снова выдаётся, аудит записан", async () => {
    await fillHour();
    const blocked = await request(app).post("/api/v1/auth/login/code").send({ phone: targetPhone });
    expect(blocked.status).toBe(503);

    const res = await reset({ id: directorId, role: "DIRECTOR" }, targetId);
    expect(res.status).toBe(200);
    expect(res.body.removedCodes).toBe(LOGIN_SMS_PER_HOUR);
    expect(await prisma.loginSmsCode.count({ where: { agentId: targetId } })).toBe(0);

    process.env.LOGIN_CODE_DEV_ECHO = "1";
    try {
      const again = await request(app).post("/api/v1/auth/login/code").send({ phone: targetPhone });
      expect(again.status).toBe(200);
    } finally {
      delete process.env.LOGIN_CODE_DEV_ECHO;
    }
    // Аудит пишется в фоне.
    await vi.waitFor(async () => {
      const row = await prisma.auditLog.findFirst({ where: { action: "LOGIN_CODE_BLOCK_RESET", entityId: targetId } });
      expect(row?.agentId).toBe(directorId);
    });
  });

  it("админ и обычный сотрудник получают 403, счётчик не тронут", async () => {
    await fillHour();
    const asAdmin = await reset({ id: adminId, role: "ADMIN" }, targetId);
    expect(asAdmin.status).toBe(403);
    const asAgent = await reset({ id: targetId, role: "AGENT" }, targetId);
    expect(asAgent.status).toBe(403);
    expect(await prisma.loginSmsCode.count({ where: { agentId: targetId } })).toBe(LOGIN_SMS_PER_HOUR);
  });

  it("без входа — 401, неверный id — 400, нет такого сотрудника — 404", async () => {
    expect((await request(app).post(`/api/v1/agents/${targetId}/login-code/reset`)).status).toBe(401);
    expect((await reset({ id: directorId, role: "DIRECTOR" }, "not-a-uuid")).status).toBe(400);
    expect((await reset({ id: directorId, role: "DIRECTOR" }, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("не трогает коды других сотрудников", async () => {
    await prisma.loginSmsCode.create({
      data: { agentId: adminId, codeHash: "x", channel: "sms", expiresAt: new Date(Date.now() + 60_000) },
    });
    await fillHour();
    await reset({ id: directorId, role: "DIRECTOR" }, targetId);
    expect(await prisma.loginSmsCode.count({ where: { agentId: adminId } })).toBe(1);
  });
});

describe("ответ 503 по лимиту часа", () => {
  it("отдаёт retryAt = самый ранний из пяти кодов + 1 час и telegramAvailable", async () => {
    await fillHour();
    const earliest = (await prisma.loginSmsCode.findFirst({ where: { agentId: targetId }, orderBy: { createdAt: "asc" } }))!;
    const res = await request(app).post("/api/v1/auth/login/code").send({ phone: targetPhone });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("Слишком много кодов за час");
    expect(new Date(res.body.retryAt).getTime()).toBe(earliest.createdAt.getTime() + 60 * 60 * 1000);
    expect(res.body.telegramAvailable).toBe(true);
  });
});

describe("сторож отказов выдачи кода", () => {
  it("пишет одну запись на 3-м отказе за 15 минут и не дублирует на 4-м", async () => {
    const where = { dedupKey: { startsWith: `login-code-refusals:${targetId}` } };
    expect(noteLoginCodeRefusal(targetId, "hour-limit")).toBe(false);
    expect(noteLoginCodeRefusal(targetId, "send-failed")).toBe(false);
    expect(await prisma.errorLog.count({ where })).toBe(0);
    expect(noteLoginCodeRefusal(targetId, "wrong-code")).toBe(true);
    await vi.waitFor(async () => expect(await prisma.errorLog.count({ where })).toBe(1));
    noteLoginCodeRefusal(targetId, "hour-limit");
    await new Promise((r) => setTimeout(r, 300));
    expect(await prisma.errorLog.count({ where })).toBe(1);
    const row = await prisma.errorLog.findFirst({ where });
    expect(row?.message).toContain("Ноза сброса");
  });

  it("отказы старше 15 минут не считаются", () => {
    const old = Date.now() - 20 * 60 * 1000;
    noteLoginCodeRefusal(targetId, "hour-limit", old);
    noteLoginCodeRefusal(targetId, "hour-limit", old + 1000);
    expect(noteLoginCodeRefusal(targetId, "hour-limit")).toBe(false);
  });

  it("реальные отказы входа (лимит часа, три запроса) доходят до сторожа", async () => {
    await fillHour();
    const where = { dedupKey: { startsWith: `login-code-refusals:${targetId}` } };
    for (let i = 0; i < 3; i++) await request(app).post("/api/v1/auth/login/code").send({ phone: targetPhone });
    await vi.waitFor(async () => expect(await prisma.errorLog.count({ where })).toBe(1));
  });
});

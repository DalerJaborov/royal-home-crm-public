import bcrypt from "bcrypt";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * GET /errors — ДВЕ КАТЕГОРИИ (аудит 03.09.2026, раздел 4-5:
 * docs/audit-02-09-2026/20-deep-audit-03-09-night.md). Эксплуатационный шум
 * ИИ-конвейера («Gemini ответил на резервной модели») не должен считаться в
 * count24h/count7d и не должен всплывать в списке по умолчанию — но остаётся
 * доступным тому, у кого есть auditLog.view, через `?priority=operational`
 * (право не изобреталось — то же самое, каким гейтится весь роут).
 *
 * `resolve` при этом обязан продолжать работать одинаково для обеих
 * категорий — задача явно требовала не ломать существующий флоу.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = Date.now().toString(36);
const password = "testpass123";
let directorToken = "";
let directorId = "";
const errorIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const director = await prisma.agent.create({
    data: { fullName: "Тест Директор ErrorLog приоритет", phone: `+992965${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  directorToken = await login(director.phone);
});

afterAll(async () => {
  await prisma.errorLog.deleteMany({ where: { id: { in: errorIds } } });
  await prisma.auditLog.deleteMany({ where: { agentId: directorId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
  await prisma.$disconnect();
});

afterEach(async () => {
  await prisma.errorLog.deleteMany({ where: { id: { in: errorIds } } });
  errorIds.length = 0;
});

async function seed(source: string, message: string) {
  const row = await prisma.errorLog.create({ data: { source, message } });
  errorIds.push(row.id);
  return row;
}

describe("errorLog.ts: приоритет operational/actionable", () => {
  it("по умолчанию отдаёт обе категории, каждая строка размечена priority", async () => {
    const operational = await seed(
      "ai",
      `Gemini ответил на РЕЗЕРВНОЙ модели gemini-2.5-flash — основная недоступна (${runId})`
    );
    const actionable = await seed("telephony", `ARI-подписка на события звонков оборвалась (${runId})`);

    const res = await request(app).get("/api/v1/errors").set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    const byId = new Map(res.body.recent.map((r: { id: string; priority: string }) => [r.id, r.priority]));
    expect(byId.get(operational.id)).toBe("operational");
    expect(byId.get(actionable.id)).toBe("actionable");
  });

  it("?priority=actionable скрывает эксплуатационный шум из списка", async () => {
    const operational = await seed(
      "ai",
      `Gemini не ответил (chat), повтор тоже не помог (${runId}-b)`
    );
    const actionable = await seed("site-sync", `Сайт недоступен: таймаут (${runId}-b)`);

    const res = await request(app)
      .get("/api/v1/errors?priority=actionable")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.recent.map((r: { id: string }) => r.id);
    expect(ids).toContain(actionable.id);
    expect(ids).not.toContain(operational.id);
  });

  it("?priority=operational показывает только эксплуатационные — полный доступ auditLog.view сохранён", async () => {
    const operational = await seed("ai", `Ассистент ответил на РЕЗЕРВНОЙ модели gemini-2.5-flash (${runId}-c)`);
    const actionable = await seed("cron", `Крон не запустился (${runId}-c)`);

    const res = await request(app)
      .get("/api/v1/errors?priority=operational")
      .set("Authorization", `Bearer ${directorToken}`);
    const ids = res.body.recent.map((r: { id: string }) => r.id);
    expect(ids).toContain(operational.id);
    expect(ids).not.toContain(actionable.id);
  });

  it("resolve по-прежнему работает одинаково для обеих категорий", async () => {
    const operational = await seed("ai", `Gemini ответил на РЕЗЕРВНОЙ модели test-model (${runId}-d)`);

    const res = await request(app)
      .post(`/api/v1/errors/${operational.id}/resolve`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(204);

    const row = await prisma.errorLog.findUnique({ where: { id: operational.id } });
    expect(row?.resolvedAt).not.toBeNull();
  });
});

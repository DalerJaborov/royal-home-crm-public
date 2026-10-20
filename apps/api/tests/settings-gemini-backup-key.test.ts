import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { resolveGeminiKeys } from "../src/ai/geminiClient.js";

/**
 * Резервный ключ Gemini правится в Настройках, а не только в .env.
 *
 * ЗАЧЕМ ТЕСТ. 12.08.2026 выяснилось, что основной ключ в .env был удалён при ротации
 * ещё в начале августа: запросы молча вытягивал резервный, и понять это можно было
 * только зайдя на сервер — резерв в интерфейсе не показывался вообще. Здесь
 * закрепляются оба следствия: ключ хранится зашифрованным и наружу уходит только
 * маской, и порядок ключей именно такой, каким его ждёт перебор (сначала основной).
 */

const runId = Date.now();
const password = "testpass123";

let adminId: string;
let adminToken: string;
let saved: { geminiApiKey: string | null; geminiApiKey2: string | null };

const PRIMARY = "AQ.TestPrimaryKeyValue0001";
const BACKUP = "AQ.TestBackupKeyValue0002";

function patch(body: Record<string, unknown>) {
  return request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`).send(body);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ ключей ИИ", phone: `+992936${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = res.body.accessToken;
  grantElevation(adminId);

  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = { geminiApiKey: current.geminiApiKey, geminiApiKey2: current.geminiApiKey2 };
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.agent.delete({ where: { id: adminId } });
  await prisma.$disconnect();
});

describe("Резервный ключ Gemini в Настройках", () => {
  it("сохраняется зашифрованным и отдаётся только маской", async () => {
    const res = await patch({ geminiApiKey: PRIMARY, geminiApiKey2: BACKUP });
    expect(res.status).toBe(200);
    expect(res.body.geminiApiKey2Configured).toBe(true);
    expect(res.body.geminiApiKey2Masked).toBe(`••••${BACKUP.slice(-4)}`);
    expect(res.body.geminiApiKey2Source).toBe("settings");
    // Сам ключ наружу не уходит ни под каким именем — иначе маска бессмысленна.
    expect(JSON.stringify(res.body)).not.toContain(BACKUP);

    const row = await prisma.settings.findUnique({ where: { id: "singleton" } });
    expect(row?.geminiApiKey2).toBeTruthy();
    expect(row?.geminiApiKey2).not.toBe(BACKUP);
  });

  it("оба ключа читаются из Настроек в правильном порядке", async () => {
    await patch({ geminiApiKey: PRIMARY, geminiApiKey2: BACKUP });
    const keys = await resolveGeminiKeys();
    expect(keys[0]).toBe(PRIMARY);
    expect(keys[1]).toBe(BACKUP);
  });

  it("пустая строка очищает резерв — возвращаемся на .env", async () => {
    await patch({ geminiApiKey2: BACKUP });
    const res = await patch({ geminiApiKey2: "" });
    expect(res.status).toBe(200);
    // Без переменной окружения резерва нет вовсе — интерфейс обязан это показать,
    // иначе пустое поле выглядит так же, как заполненное ключом из .env.
    const expected = !!process.env.GEMINI_API_KEY_2;
    expect(res.body.geminiApiKey2Configured).toBe(expected);
    expect(res.body.geminiApiKey2Source).toBe(expected ? "env" : null);

    const row = await prisma.settings.findUnique({ where: { id: "singleton" } });
    expect(row?.geminiApiKey2).toBeNull();
  });
});

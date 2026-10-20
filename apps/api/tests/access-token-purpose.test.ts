import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken, signMediaToken, signVideoDownloadToken } from "../src/auth/jwt.js";
import { signPending2faToken } from "../src/lib/pending-2fa.js";

/**
 * ТОКЕН ДОСТУПА — ТОЛЬКО ТОКЕН ДОСТУПА (23.09.2026).
 *
 * Тем же секретом подписаны служебные короткие токены: промежуточный токен
 * входа до второго фактора, ссылки на видео и файлы. Проверялась только
 * подпись, и промежуточный токен входа (в нём есть `sub`) открывал любой
 * маршрут API — второй фактор у директорских учёток не защищал ничего:
 * достаточно было пароля, код из приложения можно было не вводить.
 */

const runId = Date.now();
let agentId = "";

beforeAll(async () => {
  const a = await prisma.agent.create({
    data: { fullName: `Токен ${runId}`, phone: `+99293${String(runId).slice(-7)}`, role: "DIRECTOR", passwordHash: "x" },
  });
  agentId = a.id;
});

afterAll(async () => {
  if (agentId) await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("Служебный токен не открывает API", () => {
  it("настоящий токен доступа работает", async () => {
    const token = signAccessToken({ sub: agentId, role: "DIRECTOR" });
    const res = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("промежуточный токен входа до второго фактора — 401", async () => {
    const pending = signPending2faToken(agentId);
    const res = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${pending}`);
    expect(res.status).toBe(401);
  });

  it("токен ссылки на файл и на скачивание видео — не токен доступа", async () => {
    for (const t of [signMediaToken("/uploads/video/x.mp4"), signVideoDownloadToken("video-1")]) {
      const res = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${t}`);
      expect(res.status).toBe(401);
    }
  });

  it("закрытые файлы: промежуточный токен входа в заголовке не пускает", async () => {
    const pending = signPending2faToken(agentId);
    const res = await request(app).get("/uploads/video/nope.mp4").set("Authorization", `Bearer ${pending}`);
    expect(res.status).toBe(403);
  });
});

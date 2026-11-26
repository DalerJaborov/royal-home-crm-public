import bcrypt from "bcrypt";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * СРОК ПАУЗЫ БОТА, ВЫБРАННЫЙ ПРИ ОТВЕТЕ (владелец 26.11.2026): текст, голосовое и фото/видео
 * входят одной дверью (lib/replyPauseInput.ts) — границы срока одинаковы на всех трёх путях.
 * Невалидное число отбивается 400 ДО любой отправки клиенту.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { replyPausedUntilField, pauseMinutesUntil, REPLY_PAUSE_MAX_AHEAD_MS } = await import("../src/lib/replyPauseInput.js");
const { z } = await import("zod");

const runId = `${Date.now()}`.slice(-7);
const password = "testpass123";
let token = "";
let agentId = "";
let conversationId = "";
const schema = z.object({ pausedUntil: replyPausedUntilField });
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

beforeAll(async () => {
  const phone = `+99297${runId}`.slice(0, 13);
  const agent = await prisma.agent.create({
    data: { fullName: `Срок паузы ${runId}`, phone, role: "ADMIN", passwordHash: await bcrypt.hash(password, 10) },
  });
  agentId = agent.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
  conversationId = (await prisma.botConversation.create({
    data: { channel: "INSTAGRAM", subscriberId: `pause-choice-${runId}`, messages: [] as object[] },
  })).id;
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: conversationId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("границы срока: одна проверка на все пути", () => {
  it("нет срока — можно (умолчание сервера)", () => {
    expect(schema.safeParse({}).success).toBe(true);
  });
  it("час, два часа и «бессрочно» (10 лет) проходят", () => {
    for (const ms of [60_000, 3_600_000, 7_200_000, 10 * 365 * 24 * 3_600_000]) {
      expect(schema.safeParse({ pausedUntil: iso(ms) }).success, String(ms)).toBe(true);
    }
  });
  it("прошлое, не дата и слишком далёкое — отказ", () => {
    for (const bad of [iso(-60_000), "завтра", "60", "2026-13-45T00:00:00Z", iso(REPLY_PAUSE_MAX_AHEAD_MS + 3_600_000)]) {
      expect(schema.safeParse({ pausedUntil: bad }).success, bad).toBe(false);
    }
  });
  it("минуты для задания очереди: от сейчас, не меньше одной", () => {
    const now = Date.now();
    expect(pauseMinutesUntil(new Date(now + 3_600_000), now)).toBe(60);
    expect(pauseMinutesUntil(new Date(now + 5_000), now)).toBe(1);
  });
});

describe("все маршруты ответа отвечают 400 на невалидный срок до отправки", () => {
  const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);
  const BAD = ["вчера", iso(-3_600_000), iso(REPLY_PAUSE_MAX_AHEAD_MS + 86_400_000)];

  it("текст /reply", async () => {
    for (const pausedUntil of BAD) {
      const res = await auth(request(app).post(`/api/v1/conversations/${conversationId}/reply`)).send({ text: "Здравствуйте", pausedUntil });
      expect(res.status, pausedUntil).toBe(400);
    }
  });

  it("голосовое /reply-voice", async () => {
    for (const pausedUntil of BAD) {
      const res = await auth(request(app).post(`/api/v1/conversations/${conversationId}/reply-voice`))
        .field("pausedUntil", pausedUntil)
        .attach("audio", Buffer.from("x"), { filename: "v.webm", contentType: "audio/webm" });
      expect(res.status, pausedUntil).toBe(400);
    }
  });

  it("фото/видео /reply-media", async () => {
    for (const pausedUntil of BAD) {
      const res = await auth(request(app).post(`/api/v1/conversations/${conversationId}/reply-media`))
        .field("pausedUntil", pausedUntil)
        .attach("media", Buffer.from("x"), { filename: "a.jpg", contentType: "image/jpeg" });
      expect(res.status, pausedUntil).toBe(400);
    }
  });

  it("фото/видео по частям /reply-media/upload-sessions/complete", async () => {
    for (const pausedUntil of BAD) {
      const res = await auth(request(app).post(`/api/v1/conversations/${conversationId}/reply-media/upload-sessions/complete`))
        .send({ sessionId: "00000000-0000-4000-8000-000000000001", pausedUntil });
      expect(res.status, pausedUntil).toBe(400);
    }
  });
});

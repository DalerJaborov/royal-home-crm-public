import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ТРЕНАЖЁР БОТА: КЛЮЧ РЕПЛИКИ — ПОЗИЦИЯ В ПОЛНОМ ДИАЛОГЕ, А НЕ В ОБРЕЗАННОМ ОКНЕ
 * (аудит Codex 04.10.2026, ACCESS-07).
 *
 * Так было: очередь режет диалог до последних 40 реплик и для ответа без mid
 * (сайт) отдавала `idx:<номер в окне>`, а applyReplyFeedback ищет `idx:N` в
 * ПОЛНОМ массиве. В диалоге из 60 реплик оценка уходила на реплику 39 вместо 59
 * (или падала «Это не ответ бота»), настоящая оставалась в очереди.
 */

const runId = Date.now().toString(36);
const password = "testpass123";
let adminToken = "";
let clientId = "";
let convId = "";
let lessonId = "";
const LAST_BOT_TEXT = `Последний ответ бота окна ${runId}`;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: `Админ окна ${runId}`, phone: `+992946${runId}`.slice(0, 13), role: "ADMIN", passwordHash },
  });
  const login = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  expect(login.status).toBe(200);
  adminToken = login.body.accessToken;
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент окна ${runId}`,
      phone: `+992947${runId}`.slice(0, 13),
      source: "WEBSITE",
      assignedAgentId: admin.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
  const now = new Date().toISOString();
  const messages = Array.from({ length: 60 }, (_, i) =>
    i % 2 === 0
      ? { role: "user", content: `Вопрос ${i} ${runId}`, at: now }
      : { role: "assistant", content: i === 59 ? LAST_BOT_TEXT : `Ответ ${i} ${runId}`, at: now }
  );
  const conv = await prisma.botConversation.create({
    data: { clientId, channel: "WEBSITE", subscriberId: `web-win-${runId}`, lastMessageAt: new Date(), messages },
  });
  convId = conv.id;
  const lesson = await prisma.botLesson.create({
    data: {
      kind: "client_confused",
      channel: "WEBSITE",
      conversationId: conv.id,
      botMessage: LAST_BOT_TEXT,
      humanMessage: `не поняла окно, ${runId}`,
      lesson: null,
    },
  });
  lessonId = lesson.id;
});

afterAll(async () => {
  await prisma.botLesson.deleteMany({ where: { id: lessonId } });
  await prisma.botConversation.deleteMany({ where: { id: convId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { fullName: `Админ окна ${runId}` } });
  await prisma.$disconnect();
});

describe("GET /bot-trainer/queue, диалог из 60 реплик без mid", () => {
  it("вопрос и образец несут позицию в полном диалоге (idx:59)", async () => {
    const res = await request(app).get("/api/v1/bot-trainer/queue?limit=30").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const mine = (res.body.items as Array<{ kind: string; conversationId: string | null; messageKey?: string; id: string }>).filter(
      (it) => it.conversationId === convId
    );
    const question = mine.find((it) => it.kind === "question");
    expect(question?.messageKey).toBe("idx:59");
    const sample = mine.find((it) => it.kind === "sample");
    expect(sample?.messageKey).toBe("idx:59");
    expect(sample?.id).toBe(`sample:${convId}:59`);
  });
});

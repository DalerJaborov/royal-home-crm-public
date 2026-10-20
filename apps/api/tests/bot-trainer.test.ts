import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * «Тренажёр бота» (17.09.2026) — одна переписка, одно решение, применяется
 * сразу. Очередь (`GET /bot-trainer/queue`) собирает элементы из трёх
 * источников (BotLesson без правила, BotAuditFinding без вердикта, свежие
 * ответы бота без оценки), решение (`POST /bot-trainer/decide`) применяется
 * через уже существующие механизмы обучения бота — см. routes/botTrainer.ts.
 *
 * Настройка базы — тот же приём, что у bot-reply-feedback.test.ts: реальная
 * база, ИИ не задействован там, где это не нужно (variants мокается через
 * заведомо несуществующий conversationId/messageKey — ветка «нет диалога»,
 * а не через реальный вызов Gemini).
 */

const runId = Date.now().toString(36);
const password = "testpass123";

let adminId: string;
let adminToken: string;
let clientId: string;

function authed(token: string) {
  return {
    get: (path: string) => request(app).get(path).set("Authorization", `Bearer ${token}`),
    post: (path: string, body: unknown) => request(app).post(path).set("Authorization", `Bearer ${token}`).send(body),
  };
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: `Админ тренажёра ${runId}`, phone: `+992936${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  expect(login.status).toBe(200);
  adminToken = login.body.accessToken;

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент тренажёра ${runId}`,
      phone: `+992937${runId}`,
      source: "WHATSAPP",
      assignedAgentId: adminId,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.botLesson.deleteMany({ where: { channel: "WHATSAPP", humanMessage: { contains: runId } } });
  await prisma.botAuditFinding.deleteMany({ where: { why: { contains: runId } } });
  await prisma.botConversation.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: adminId } });
  await prisma.$disconnect();
});

describe("Очередь тренажёра — дедуп и лимит", () => {
  it("одинаковые вопросы (та же пара бот/клиент) схлопываются в одну карточку с dupCount", async () => {
    const botMessage = `Могу предложить трёхкомнатную, ${runId}`;
    const humanMessage = `не поняла, ${runId}`;
    const conv1 = await prisma.botConversation.create({
      data: { clientId, channel: "WHATSAPP", subscriberId: `wa-tr-dup1-${runId}`, messages: [] },
    });
    const conv2 = await prisma.botConversation.create({
      data: { clientId, channel: "WHATSAPP", subscriberId: `wa-tr-dup2-${runId}`, messages: [] },
    });
    await prisma.botLesson.createMany({
      data: [
        { kind: "client_confused", channel: "WHATSAPP", conversationId: conv1.id, botMessage, humanMessage, lesson: null },
        { kind: "client_confused", channel: "WHATSAPP", conversationId: conv2.id, botMessage, humanMessage, lesson: null },
      ],
    });

    const res = await authed(adminToken).get("/api/v1/bot-trainer/queue?limit=30");
    expect(res.status).toBe(200);
    const item = res.body.items.find((it: { q: string }) => it.q === humanMessage);
    expect(item).toBeTruthy();
    expect(item.kind).toBe("question");
    expect(item.dupCount).toBe(2);
    expect(item.lessonGroupIds).toHaveLength(2);

    await prisma.botConversation.deleteMany({ where: { id: { in: [conv1.id, conv2.id] } } });
  });

  it("лимит соблюдается (?limit=1 отдаёт не больше одного элемента)", async () => {
    const res = await authed(adminToken).get("/api/v1/bot-trainer/queue?limit=1");
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(1);
  });

  it("без права settings.manage — 403", async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    const agent = await prisma.agent.create({
      data: { fullName: `Агент без прав тренажёра ${runId}`, phone: `+992938${runId}`, role: "AGENT", passwordHash },
    });
    try {
      const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
      const res = await authed(login.body.accessToken).get("/api/v1/bot-trainer/queue");
      expect(res.status).toBe(403);
    } finally {
      await prisma.agent.deleteMany({ where: { id: agent.id } });
    }
  });
});

describe("Источник «свежие ответы без оценки» — предел в сутки", () => {
  it("не больше 10 образцов даже когда подходящих ответов больше", async () => {
    const convs = [];
    for (let i = 0; i < 14; i++) {
      const conv = await prisma.botConversation.create({
        data: {
          clientId,
          channel: "WHATSAPP",
          subscriberId: `wa-tr-sample-${runId}-${i}`,
          lastMessageAt: new Date(),
          messages: [
            { role: "user", content: `Вопрос номер ${i}, ${runId}`, at: new Date().toISOString() },
            { role: "assistant", content: `Ответ бота номер ${i}, ${runId}`, at: new Date().toISOString() },
          ],
        },
      });
      convs.push(conv.id);
    }
    try {
      const res = await authed(adminToken).get("/api/v1/bot-trainer/queue?limit=30");
      expect(res.status).toBe(200);
      const samples = res.body.items.filter((it: { kind: string }) => it.kind === "sample");
      expect(samples.length).toBeLessThanOrEqual(10);
    } finally {
      await prisma.botConversation.deleteMany({ where: { id: { in: convs } } });
    }
  });
});

describe("Решение — «Верно» по вопросу закрывает группу", () => {
  it("lesson становится «—», active:false, item больше не в очереди", async () => {
    const conv = await prisma.botConversation.create({
      data: { clientId, channel: "WHATSAPP", subscriberId: `wa-tr-good-${runId}`, messages: [] },
    });
    const lesson = await prisma.botLesson.create({
      data: {
        kind: "client_confused",
        channel: "WHATSAPP",
        conversationId: conv.id,
        botMessage: `Бот сказал верно, ${runId}`,
        humanMessage: `не поняла верно, ${runId}`,
        lesson: null,
      },
    });

    const res = await authed(adminToken).post("/api/v1/bot-trainer/decide", {
      itemId: `question:${lesson.id}`,
      kind: "question",
      verdict: "good",
      channel: "WHATSAPP",
      lessonId: lesson.id,
      lessonGroupIds: [lesson.id],
      q: `не поняла верно, ${runId}`,
      a: `Бот сказал верно, ${runId}`,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const updated = await prisma.botLesson.findUnique({ where: { id: lesson.id } });
    expect(updated?.lesson).toBe("—");
    expect(updated?.active).toBe(false);

    const queue = await authed(adminToken).get("/api/v1/bot-trainer/queue?limit=30");
    expect(queue.body.items.some((it: { lessonId?: string }) => it.lessonId === lesson.id)).toBe(false);

    await prisma.botConversation.deleteMany({ where: { id: conv.id } });
  });
});

describe("Решение — «Неверно» с текстом создаёт активное правило и закрывает группу", () => {
  it("группа из двух записей получает один и тот же текст правила, active:true", async () => {
    const conv1 = await prisma.botConversation.create({
      data: { clientId, channel: "WHATSAPP", subscriberId: `wa-tr-bad1-${runId}`, messages: [] },
    });
    const conv2 = await prisma.botConversation.create({
      data: { clientId, channel: "WHATSAPP", subscriberId: `wa-tr-bad2-${runId}`, messages: [] },
    });
    const botMessage = `Бот ошибся дважды, ${runId}`;
    const humanMessage = `не поняла дважды, ${runId}`;
    const lesson1 = await prisma.botLesson.create({
      data: { kind: "client_confused", channel: "WHATSAPP", conversationId: conv1.id, botMessage, humanMessage, lesson: null },
    });
    const lesson2 = await prisma.botLesson.create({
      data: { kind: "client_confused", channel: "WHATSAPP", conversationId: conv2.id, botMessage, humanMessage, lesson: null },
    });

    const noteText = `Отвечай точной ценой, ${runId}`;
    const res = await authed(adminToken).post("/api/v1/bot-trainer/decide", {
      itemId: `question:${lesson1.id}`,
      kind: "question",
      verdict: "bad",
      note: noteText,
      channel: "WHATSAPP",
      lessonId: lesson1.id,
      lessonGroupIds: [lesson1.id, lesson2.id],
      q: humanMessage,
      a: botMessage,
    });
    expect(res.status).toBe(200);
    expect(res.body.lessonCreated).toBe(true);

    const updated1 = await prisma.botLesson.findUnique({ where: { id: lesson1.id } });
    const updated2 = await prisma.botLesson.findUnique({ where: { id: lesson2.id } });
    expect(updated1?.lesson).toBe(noteText);
    expect(updated1?.active).toBe(true);
    expect(updated2?.lesson).toBe(noteText);
    expect(updated2?.active).toBe(true);

    await prisma.botConversation.deleteMany({ where: { id: { in: [conv1.id, conv2.id] } } });
  });
});

describe("Решение — «Не отвечать» заводит owner_mute", () => {
  it("создаёт активное правило kind=owner_mute с описанием случая", async () => {
    const before = await prisma.botLesson.count({ where: { kind: "owner_mute", channel: "WHATSAPP" } });
    const res = await authed(adminToken).post("/api/v1/bot-trainer/decide", {
      itemId: `sample:mute-${runId}`,
      kind: "finding",
      verdict: "mute",
      channel: "WHATSAPP",
      findingType: "other",
      findingWhy: `случай для не отвечать ${runId}, которого точно не существует в базе`,
      note: `спам-рассылка про крипту, ${runId}`,
      q: `реклама крипты, ${runId}`,
      a: `бот вежливо ответил на спам, ${runId}`,
    });
    expect(res.status).toBe(200);
    expect(res.body.lessonCreated).toBe(true);

    const after = await prisma.botLesson.count({ where: { kind: "owner_mute", channel: "WHATSAPP" } });
    expect(after).toBe(before + 1);
    const created = await prisma.botLesson.findFirst({
      where: { kind: "owner_mute", humanMessage: `реклама крипты, ${runId}` },
      orderBy: { createdAt: "desc" },
    });
    expect(created?.active).toBe(true);
    expect(created?.lesson).toContain("не отвечать");
  });
});

describe("Варианты ответа", () => {
  it("диалог не найден → пустой массив вариантов, 200 (не ошибка)", async () => {
    const res = await authed(adminToken).post("/api/v1/bot-trainer/variants", {
      conversationId: `no-such-conversation-${runId}`,
      messageKey: "idx:0",
    });
    expect(res.status).toBe(200);
    expect(res.body.variants).toEqual([]);
  });

  it("реплика не найдена в существующем диалоге → пустой массив, 200", async () => {
    const conv = await prisma.botConversation.create({
      data: {
        clientId,
        channel: "WHATSAPP",
        subscriberId: `wa-tr-variants-${runId}`,
        messages: [{ role: "user", content: `Привет, ${runId}` }],
      },
    });
    try {
      const res = await authed(adminToken).post("/api/v1/bot-trainer/variants", {
        conversationId: conv.id,
        messageKey: "idx:99",
      });
      expect(res.status).toBe(200);
      expect(res.body.variants).toEqual([]);
    } finally {
      await prisma.botConversation.deleteMany({ where: { id: conv.id } });
    }
  });
});

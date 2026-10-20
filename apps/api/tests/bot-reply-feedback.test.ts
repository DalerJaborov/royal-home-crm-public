import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Оценка ответа бота прямо в чате (17.09.2026) — «Верно»/«Неверно» под пузырём
 * ответа, POST /conversations/:id/reply-feedback. Правило владельца, размеченное
 * на отдельных страницах, теперь есть и здесь: без заметки — в очередь ночного
 * разбора, с заметкой — сразу в промт (BotLesson), «Верно» — в образцы стиля
 * (StyleExample, source=APPROVED).
 *
 * Настройка базы — тот же приём, что и client-message.test.ts/bot-training.test.ts:
 * реальная база, ИИ не задействован (сама оценка ни разу не зовёт модель).
 */

const runId = Date.now().toString(36);
const password = "testpass123";

let adminId: string;
let adminToken: string;
let conversationId: string;
let clientId: string;

const RAW_PHONE = "930001001";

function authed(token: string) {
  return {
    post: (path: string, body: unknown) =>
      request(app).post(path).set("Authorization", `Bearer ${token}`).send(body),
  };
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: `Админ оценки ${runId}`, phone: `+992935${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  expect(login.status).toBe(200);
  adminToken = login.body.accessToken;

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент оценки ${runId}`,
      phone: `+992934${runId}`,
      source: "WHATSAPP",
      assignedAgentId: adminId,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;

  const conversation = await prisma.botConversation.create({
    data: {
      clientId,
      channel: "WHATSAPP",
      subscriberId: `wa-feedback-${runId}`,
      messages: [
        // idx 0-1: пара для «Неверно» (с mid — реальный случай Meta)
        { role: "user", content: `Дар кучост ин ҳавли, ${runId}?` },
        { role: "assistant", content: `Ин дар минтақаи наздик аст, ${runId}.`, mid: `mid-bad-${runId}` },
        // idx 2-3: пара для «Верно» (без mid — старая запись без Meta-идентификатора).
        // Цена — 6 цифр НАРОЧНО: маска sanitizeStyleText трогает только 7+ цифр
        // подряд (см. её комментарий), а тест ниже сверяет agentText побайтово.
        { role: "user", content: `Нархаш чанд сомонӣ, ${runId}?` },
        { role: "assistant", content: `Нархаш 450000 сомонӣ, ${runId}.` },
        // idx 4: ответ ЖИВОГО агента — оценке не подлежит
        {
          role: "assistant",
          content: "Здравствуйте, это агент Далер, звоните.",
          by: { kind: "agent", agentId: adminId, agentName: "Далер" },
        },
      ],
    },
  });
  conversationId = conversation.id;
});

afterAll(async () => {
  await prisma.botLesson.deleteMany({ where: { conversationId } });
  await prisma.styleExample.deleteMany({ where: { channel: "WHATSAPP", agentText: { contains: "450000" } } });
  await prisma.botConversation.deleteMany({ where: { id: conversationId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: adminId } });
  await prisma.$disconnect();
});

describe("Оценка ответа бота в чате", () => {
  it("«Неверно» с заметкой создаёт активное правило и чистит телефон из текста", async () => {
    const res = await authed(adminToken).post(`/api/v1/conversations/${conversationId}/reply-feedback`, {
      messageKey: `mid-bad-${runId}`,
      verdict: "bad",
      note: `Называй точный район, а не «где-то рядом». Наш номер ${RAW_PHONE} тут ни при чём.`,
    });
    expect(res.status).toBe(200);
    expect(res.body.feedback.verdict).toBe("bad");
    const lessonId = res.body.feedback.lessonId as string;
    expect(lessonId).toBeTruthy();

    const lesson = await prisma.botLesson.findUnique({ where: { id: lessonId } });
    expect(lesson?.kind).toBe("owner_bad");
    expect(lesson?.active).toBe(true);
    expect(lesson?.lesson).toBeTruthy();
    expect(lesson?.lesson).not.toContain(RAW_PHONE);
    expect(lesson?.botMessage).not.toContain(RAW_PHONE);

    // Реплика в самой переписке несёт feedback — состояние переживает перезагрузку.
    const stored = (await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { messages: true } }))
      ?.messages as { feedback?: { verdict: string; lessonId?: string } }[];
    expect(stored[1].feedback?.verdict).toBe("bad");
    expect(stored[1].feedback?.lessonId).toBe(lessonId);
  });

  it("повторный клик «Неверно» с другой заметкой правит ТУ ЖЕ запись, а не плодит новую", async () => {
    const before = await prisma.botLesson.count({ where: { conversationId } });
    const res = await authed(adminToken).post(`/api/v1/conversations/${conversationId}/reply-feedback`, {
      messageKey: `mid-bad-${runId}`,
      verdict: "bad",
      note: "Второй вариант правила, без телефона",
    });
    expect(res.status).toBe(200);
    const after = await prisma.botLesson.count({ where: { conversationId } });
    expect(after).toBe(before); // не задвоилось
    const lesson = await prisma.botLesson.findUnique({ where: { id: res.body.feedback.lessonId } });
    expect(lesson?.lesson).toContain("Второй вариант правила");
  });

  it("«Неверно» без заметки уходит в очередь ночного разбора (lesson=null, active=false)", async () => {
    const res = await authed(adminToken).post(`/api/v1/conversations/${conversationId}/reply-feedback`, {
      messageKey: "idx:3",
      verdict: "bad",
    });
    expect(res.status).toBe(200);
    const lesson = await prisma.botLesson.findUnique({ where: { id: res.body.feedback.lessonId } });
    expect(lesson?.lesson).toBeNull();
    expect(lesson?.active).toBe(false);
  });

  it("«Верно» сохраняет образец стиля с источником APPROVED", async () => {
    const res = await authed(adminToken).post(`/api/v1/conversations/${conversationId}/reply-feedback`, {
      messageKey: "idx:3",
      verdict: "good",
    });
    expect(res.status).toBe(200);
    expect(res.body.feedback.verdict).toBe("good");
    // Прежнее «Неверно» на ЭТОЙ ЖЕ реплике обязано выключиться, а не просто повиснуть.
    const prevLesson = await prisma.botLesson.findFirst({
      where: { conversationId, botMessage: `Нархаш 450000 сомонӣ, ${runId}.` },
    });
    expect(prevLesson?.active).toBe(false);

    const styleExampleId = res.body.feedback.styleExampleId as string;
    expect(styleExampleId).toBeTruthy();
    const example = await prisma.styleExample.findUnique({ where: { id: styleExampleId } });
    expect(example?.source).toBe("APPROVED");
    expect(example?.enabled).toBe(true);
    expect(example?.agentText).toBe(`Нархаш 450000 сомонӣ, ${runId}.`);
  });

  it("смена вердикта (good → bad) выключает прежний StyleExample, а не удаляет его", async () => {
    const good = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { messages: true } });
    const styleExampleId = ((good?.messages as { feedback?: { styleExampleId?: string } }[])[3]).feedback?.styleExampleId;
    expect(styleExampleId).toBeTruthy();

    const res = await authed(adminToken).post(`/api/v1/conversations/${conversationId}/reply-feedback`, {
      messageKey: "idx:3",
      verdict: "bad",
      note: "Снова неверно, назад",
    });
    expect(res.status).toBe(200);

    const example = await prisma.styleExample.findUnique({ where: { id: styleExampleId! } });
    expect(example?.enabled).toBe(false); // выключен, не удалён

    const stored = (await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { messages: true } }))
      ?.messages as { feedback?: unknown }[];
    // В реплике ровно ОДНО поле feedback — актуальное состояние, а не история
    // всех кликов (сравнение с предыдущим тестом: там были good+styleExampleId,
    // здесь bad+note+lessonId, и старых полей не осталось).
    expect(Object.keys(stored[3].feedback as object).sort()).toEqual(["at", "by", "lessonId", "note", "verdict"].sort());
  });

  it("реплика живого агента — не ответ бота, 400", async () => {
    const res = await authed(adminToken).post(`/api/v1/conversations/${conversationId}/reply-feedback`, {
      messageKey: "idx:4",
      verdict: "good",
    });
    expect(res.status).toBe(400);
  });

  it("без права settings.manage — 403 (не 404: диалог свой, права не хватает)", async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    const agent = await prisma.agent.create({
      data: { fullName: `Агент без прав ${runId}`, phone: `+992933${runId}`, role: "AGENT", passwordHash },
    });
    try {
      // Рядовой AGENT по умолчанию видит чаты СВОИХ клиентов (messages.viewOwn) —
      // иначе сработал бы более ранний заслон роутера («Диалог не найден», 404) и
      // тест проверял бы не то право. Последний тест файла — переназначение
      // клиента дальше не аукнется.
      await prisma.client.update({ where: { id: clientId }, data: { assignedAgentId: agent.id } });
      const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
      const res = await authed(login.body.accessToken).post(`/api/v1/conversations/${conversationId}/reply-feedback`, {
        messageKey: "idx:3",
        verdict: "good",
      });
      expect(res.status).toBe(403);
    } finally {
      // Сначала возвращаем клиента админу — иначе внешний ключ Client.assignedAgentId
      // не даст удалить временного агента (Restrict по умолчанию у Prisma).
      await prisma.client.update({ where: { id: clientId }, data: { assignedAgentId: adminId } });
      await prisma.agent.deleteMany({ where: { id: agent.id } });
    }
  });
});

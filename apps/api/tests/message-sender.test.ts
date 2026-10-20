import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * Кто на самом деле написал реплику — бот, конкретный сотрудник или сама CRM.
 *
 * НАЙДЕНО ВЛАДЕЛЬЦЕМ 12.08.2026: под каждым ответом со стороны компании стояла
 * одна и та же подпись — интерфейс не различал ИИ и живого человека. Проверяем,
 * что новое поле `by` реально записывается на каждой из точек, где реплика
 * появляется (ручной ответ агента, служебная рассылка CRM), и доходит наружу
 * через presentMessages в обоих маршрутах, откуда переписку читает фронт.
 */

vi.mock("../src/messengers/meta.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/messengers/meta.js")>();
  return {
    ...actual,
    isMetaChannelEnabled: async () => true,
    sendMessage: vi.fn(async () => {}),
  };
});

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { deliverToConversation, agentSender } = await import("../src/lib/conversationDelivery.js");

let fixture: CustomerMessengerFixture;
beforeAll(async () => { fixture = await createCustomerMessengerFixture("WHATSAPP"); });

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let agentToken: string;
let clientId: string;
let conversationId: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: {
      fullName: `Далер отправитель ${runId}`,
      phone: `+992941${runId}`,
      role: "AGENT",
      passwordHash,
      // AGENT по умолчанию без messages.view (см. permissions.ts) — инбокс закрыт,
      // а этот тест как раз проверяет ответ ИЗ инбокса (POST /conversations/:id/reply).
      permissions: { granted: ["messages.view"], revoked: [] },
    },
  });
  agentId = agent.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  agentToken = res.body.accessToken;

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент отправителя ${runId}`,
      phone: `+992942${runId}`,
      source: "WHATSAPP",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;

  const conversation = await prisma.botConversation.create({
    data: {
      clientId,
      channel: "WHATSAPP",
      accountId: fixture.id,
      endpointScopeId: fixture.transport.endpointScopeId,
      subscriberId: `sub-sender-${runId}`,
      messages: [
        { role: "user", content: "Здравствуйте, интересует квартира" },
        { role: "assistant", content: "Добрый день! Что ищете?", by: { kind: "bot" } },
      ],
    },
  });
  conversationId = conversation.id;
});

afterAll(async () => {
  await fixture?.dispose();
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("agentSender", () => {
  it("отдаёт имя агента по id", async () => {
    const sender = await agentSender(agentId);
    expect(sender).toEqual({ kind: "agent", agentId, agentName: `Далер отправитель ${runId}` });
  });

  it("несуществующий агент не роняет вызов — запасное имя", async () => {
    const sender = await agentSender("00000000-0000-0000-0000-000000000000");
    expect(sender).toEqual({
      kind: "agent",
      agentId: "00000000-0000-0000-0000-000000000000",
      agentName: "Сотрудник",
    });
  });
});

describe("deliverToConversation записывает, кто отправил", () => {
  it("без sender — «system»: служебная рассылка, а не бот и не человек", async () => {
    const target = { kind: "bot" as const, id: conversationId, channel: "WHATSAPP", subscriberId: `sub-sender-${runId}`, accountId: fixture.id, transport: fixture.transport };
    const result = await deliverToConversation(target, "Напоминаем о показе");
    expect(result.ok).toBe(true);

    const conv = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { messages: true } });
    const last = (conv!.messages as any[]).at(-1);
    expect(last.by).toEqual({ kind: "system" });
  });

  it("с sender — записывается конкретный агент", async () => {
    const target = { kind: "bot" as const, id: conversationId, channel: "WHATSAPP", subscriberId: `sub-sender-${runId}`, accountId: fixture.id, transport: fixture.transport };
    const result = await deliverToConversation(target, "Отвечаю сам, один момент", undefined, {
      sender: { kind: "agent", agentId, agentName: `Далер отправитель ${runId}` },
    });
    expect(result.ok).toBe(true);

    const conv = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { messages: true } });
    const last = (conv!.messages as any[]).at(-1);
    expect(last.by).toEqual({ kind: "agent", agentId, agentName: `Далер отправитель ${runId}` });
  });
});

describe("Наружу — через оба маршрута, откуда фронт читает переписку", () => {
  it("GET /conversations/:id отдаёт by у каждой реплики ассистента", async () => {
    const res = await request(app)
      .get(`/api/v1/conversations/${conversationId}`)
      .set("Authorization", `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    const assistantMessages = res.body.messages.filter((m: { role: string }) => m.role === "assistant");
    expect(assistantMessages.length).toBeGreaterThanOrEqual(3);
    // Первая реплика бота из seed-данных.
    expect(assistantMessages[0].by).toEqual({ kind: "bot" });
    // Пользовательская реплика никогда не несёт by — это поле только для ответов компании.
    const userMessages = res.body.messages.filter((m: { role: string }) => m.role === "user");
    expect(userMessages.every((m: { by?: unknown }) => m.by === undefined)).toBe(true);
  });

  it("ответ через POST /conversations/:id/reply подписывается тем, кто нажал «Отправить»", async () => {
    const res = await request(app)
      .post(`/api/v1/conversations/${conversationId}/reply`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ text: "Отвечаю из инбокса" });

    expect(res.status).toBe(200);

    const view = await request(app)
      .get(`/api/v1/conversations/${conversationId}`)
      .set("Authorization", `Bearer ${agentToken}`);
    const last = view.body.messages.at(-1);
    expect(last.content).toBe("Отвечаю из инбокса");
    expect(last.by).toEqual({ kind: "agent", agentId, agentName: `Далер отправитель ${runId}` });
  });

  it("GET /clients/:id (карточка) отдаёт ту же подпись — единый источник правды", async () => {
    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { shortId: true } });
    const res = await request(app)
      .get(`/api/v1/clients/${client!.shortId}`)
      .set("Authorization", `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    // botConversation — массив (19.08.2026, поддержка нескольких диалогов на карточку).
    const last = res.body.botConversation[0].messages.at(-1);
    expect(last.by).toEqual({ kind: "agent", agentId, agentName: `Далер отправитель ${runId}` });
  });

  /**
   * ОТВЕТ РУКАМИ ИЗ САМОГО МЕССЕНДЖЕРА (`kind: "manual"`, появился 17.08.2026).
   *
   * Проверок на него тут не было — и белый список presentSender о нём так и не
   * узнал: наружу уходило `undefined`, а `undefined` интерфейс рисует как «Бот».
   * Три недели переписка, которую агент вёл из приложения Instagram, выглядела в
   * CRM работой бота (найдено владельцем 07.09.2026 на карточке продавца).
   */
  it("«вручную» доходит наружу отдельным видом, а не превращается в «бота»", async () => {
    await prisma.botConversation.update({
      where: { id: conversationId },
      data: { messages: [{ role: "assistant", content: "Я вам на вацап напишу", by: { kind: "manual" } }] as any },
    });

    const inbox = await request(app)
      .get(`/api/v1/conversations/${conversationId}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(inbox.status).toBe(200);
    expect(inbox.body.messages.at(-1).by).toEqual({ kind: "manual" });

    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { shortId: true } });
    const card = await request(app)
      .get(`/api/v1/clients/${client!.shortId}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(card.status).toBe(200);
    expect(card.body.botConversation[0].messages.at(-1).by).toEqual({ kind: "manual" });
  });

  /**
   * Превью в списке диалогов подписывается тем же senderPrefix, что и лента, но
   * `by` в нём сервер не отдавал вовсе — «Бот:» стояло перед КАЖДОЙ последней
   * репликой, чья бы она ни была. Тип на фронте это поле ждал с самого начала.
   */
  it("GET /conversations — превью последней реплики несёт подпись отправителя", async () => {
    await prisma.botConversation.update({
      where: { id: conversationId },
      data: { messages: [{ role: "assistant", content: "Последняя реплика живого агента", by: { kind: "manual" } }] as any },
    });

    const res = await request(app)
      .get(`/api/v1/conversations?q=${encodeURIComponent(`Клиент отправителя ${runId}`)}`)
      .set("Authorization", `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    const row = res.body.items.find((i: { id: string }) => i.id === conversationId);
    expect(row).toBeDefined();
    expect(row.lastMessage.by).toEqual({ kind: "manual" });
  });

  it("сломанное или чужеродное значение by не роняет маршрут — трактуется как бот", async () => {
    await prisma.botConversation.update({
      where: { id: conversationId },
      data: { messages: [{ role: "assistant", content: "мусор в by", by: "не объект" }] as any },
    });

    const res = await request(app)
      .get(`/api/v1/conversations/${conversationId}`)
      .set("Authorization", `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.messages[0].by).toBeUndefined();
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Красный индикатор «непрочитано» в СВОЁМ списке клиентов (владелец 31.08.2026:
 * «в чатах на телефоне красное должно быть, как в вотсапе»).
 *
 * Общий инбокс `/messages` для этого не годится — закрыт правом `messages.view`,
 * которого у роли AGENT нет по умолчанию. Список `GET /clients`, который агент и
 * так видит только по своим клиентам, переиспользует тот же признак «последняя
 * реплика от клиента, диалог не открывали после неё» (readAt/lastMessageAt на
 * BotConversation), что и общий инбокс — закреплено здесь.
 */

const runId = Date.now();
const password = "testpass123";

let agentId = "";
let clientId = "";
let clientShortId = 0;
let botConversationId = "";
let token = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Непрочит Агент ${runId}`, phone: `+992955${String(runId).slice(-7)}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;

  const client = await prisma.client.create({
    data: {
      fullName: `Непрочит Клиент ${runId}`,
      phone: `+992956${String(runId).slice(-7)}`,
      source: "INSTAGRAM",
      kind: "BUYER",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
  clientShortId = client.shortId;

  const conversation = await prisma.botConversation.create({
    data: {
      clientId,
      channel: "whatsapp",
      subscriberId: `wa-${runId}`,
      messages: [{ role: "user", content: "Здравствуйте, ещё актуально?" }],
      lastMessageAt: new Date(),
      readAt: null,
    },
  });
  botConversationId = conversation.id;

  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: botConversationId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Непрочитанные сообщения в списке своих клиентов", () => {
  it("клиент с непрочитанной репликой помечен unread: true", async () => {
    const res = await request(app)
      .get(`/api/v1/clients?q=${encodeURIComponent(`Непрочит Клиент ${runId}`)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const row = (res.body.items as { id: string; unread: boolean }[]).find((c) => c.id === clientId);
    expect(row?.unread).toBe(true);
  });

  it("открытие карточки гасит индикатор", async () => {
    const cardRes = await request(app).get(`/api/v1/clients/${clientShortId}`).set("Authorization", `Bearer ${token}`);
    expect(cardRes.status).toBe(200);

    const listRes = await request(app)
      .get(`/api/v1/clients?q=${encodeURIComponent(`Непрочит Клиент ${runId}`)}`)
      .set("Authorization", `Bearer ${token}`);
    const row = (listRes.body.items as { id: string; unread: boolean }[]).find((c) => c.id === clientId);
    expect(row?.unread).toBe(false);
  });
});

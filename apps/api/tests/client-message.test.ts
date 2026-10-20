import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/** Переписка с клиентом прямо из карточки (решение владельца 30.07, п. 4).
 *  Транспорт в тестах выключен — проверяем всё до момента доставки. */

let fixture: CustomerMessengerFixture;
beforeAll(async () => { fixture = await createCustomerMessengerFixture("WHATSAPP"); });

const runId = Date.now();
const password = "testpass123";

let ownAgentId: string;
let otherAgentId: string;
let ownToken: string;
let otherToken: string;
let clientWithChatId: string;
let clientNoChatId: string;
let clientPendingId: string;
let conversationId: string;

async function send(token: string, clientId: string, text: string) {
  return request(app)
    .post(`/api/v1/clients/${clientId}/message`)
    .set("Authorization", `Bearer ${token}`)
    .send({ text });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const own = await prisma.agent.create({
    data: { fullName: "Агент переписки", phone: `+992932${runId}`, role: "AGENT", passwordHash },
  });
  ownAgentId = own.id;
  const other = await prisma.agent.create({
    data: { fullName: "Агент чужой", phone: `+992931${runId}`, role: "AGENT", passwordHash },
  });
  otherAgentId = other.id;

  const withChat = await prisma.client.create({
    data: {
      fullName: `Клиент с чатом ${runId}`,
      phone: `+992930${runId}`,
      source: "WHATSAPP",
      assignedAgentId: ownAgentId,
      acceptedAt: new Date(),
    },
  });
  clientWithChatId = withChat.id;
  conversationId = (
    await prisma.botConversation.create({
      data: { channel: "WHATSAPP", accountId: fixture.id, endpointScopeId: fixture.transport.endpointScopeId, subscriberId: `msg-${runId}`, clientId: withChat.id },
    })
  ).id;

  clientNoChatId = (
    await prisma.client.create({
      data: {
        fullName: `Без чата ${runId}`,
        phone: `+992929${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: ownAgentId,
        acceptedAt: new Date(),
      },
    })
  ).id;

  clientPendingId = (
    await prisma.client.create({
      data: { fullName: `Непринятый ${runId}`, phone: `+992928${runId}`, source: "WHATSAPP", assignedAgentId: ownAgentId },
    })
  ).id;

  for (const phone of [own.phone, other.phone]) {
    const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
    expect(res.status).toBe(200);
    if (phone === own.phone) ownToken = res.body.accessToken;
    else otherToken = res.body.accessToken;
  }
});

afterAll(async () => {
  await fixture?.dispose();
  await prisma.client.deleteMany({ where: { id: { in: [clientWithChatId, clientNoChatId, clientPendingId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [ownAgentId, otherAgentId] } } });
  await prisma.$disconnect();
});

describe("Сообщение клиенту из карточки", () => {
  it("чужому клиенту написать нельзя", async () => {
    const res = await send(otherToken, clientWithChatId, "Привет");
    expect(res.status).toBe(403);
  });

  it("непринятому лиду — нельзя, карточка до принятия закрыта", async () => {
    const res = await send(ownToken, clientPendingId, "Привет");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/примите лид/i);
  });

  it("клиенту без переписки — понятный отказ", async () => {
    const res = await send(ownToken, clientNoChatId, "Привет");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/не писал в мессенджер/i);
  });

  it("пустое сообщение не принимается", async () => {
    const res = await send(ownToken, clientWithChatId, "   ");
    expect(res.status).toBe(400);
  });

  it("своему клиенту доходит до отправки — дальше упирается в выключенный транспорт", async () => {
    const res = await send(ownToken, clientWithChatId, "Здравствуйте! Подобрал для вас варианты.");
    expect(res.status).toBe(503);
  });
});

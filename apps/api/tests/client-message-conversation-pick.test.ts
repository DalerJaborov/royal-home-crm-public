import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import type { DeliveryTarget } from "../src/lib/conversationState.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * Аудит 04.10.2026, WEB-PAGES01: вкладка канала на карточке клиента не управляла
 * адресатом. Текст и голосовое уходили в «самый живой» диалог (Instagram), хотя
 * агент выбрал вкладку Telegram. Теперь выбранный диалог приходит как
 * `conversationId` (`<uuid>` бота или `tg_<uuid>`), сервер проверяет, что он
 * принадлежит этому клиенту, и шлёт именно туда. Транспорт подменён: проверяем
 * адресата, а не доставку.
 */
const delivered: { kind: "text" | "voice"; target: DeliveryTarget }[] = [];

vi.mock("../src/lib/conversationDelivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/conversationDelivery.js")>();
  return {
    ...actual,
    deliverToConversation: vi.fn(async (target: DeliveryTarget) => {
      delivered.push({ kind: "text", target });
      return { ok: true as const, masked: false, pausedUntil: null };
    }),
    deliverVoiceToConversation: vi.fn(async (target: DeliveryTarget) => {
      delivered.push({ kind: "voice", target });
      return { ok: true as const, pausedUntil: null };
    }),
  };
});

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let token: string;
let clientId: string;
let otherClientId: string;
let igConvId: string;
let tgConvId: string;
let foreignBotConvId: string;
let instagram: CustomerMessengerFixture;

async function sendText(body: Record<string, unknown>) {
  const { app } = await import("../src/app.js");
  return request(app)
    .post(`/api/v1/clients/${clientId}/message`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

async function sendVoice(conversationId?: string) {
  const { app } = await import("../src/app.js");
  const req = request(app)
    .post(`/api/v1/clients/${clientId}/message-voice`)
    .set("Authorization", `Bearer ${token}`)
    .attach("audio", Buffer.from("fake-audio"), { filename: "voice.webm", contentType: "audio/webm" });
  return conversationId ? req.field("conversationId", conversationId) : req;
}

beforeAll(async () => {
  const { app } = await import("../src/app.js");
  const { prisma } = await import("../src/db.js");
  instagram = await createCustomerMessengerFixture("INSTAGRAM");
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: "Агент вкладок", phone: `+992960${String(runId).slice(-9)}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент вкладок ${runId}`,
      phone: `+992961${String(runId).slice(-9)}`,
      source: "INSTAGRAM",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
  const other = await prisma.client.create({
    data: {
      fullName: `Чужой клиент ${runId}`,
      phone: `+992962${String(runId).slice(-9)}`,
      source: "INSTAGRAM",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  otherClientId = other.id;
  // Instagram свежее, Telegram старее: без выбора адресатом всегда был бы Instagram.
  igConvId = (await instagram.ensureConversation(`ig-${runId}`)).id;
  await prisma.botConversation.update({ where: { id: igConvId }, data: { clientId, lastMessageAt: new Date() } });
  tgConvId = (
    await prisma.telegramConversation.create({
      data: { chatId: `tg-${runId}`, clientId, lastMessageAt: new Date(Date.now() - 86_400_000) },
    })
  ).id;
  foreignBotConvId = (await instagram.ensureConversation(`ig-other-${runId}`)).id;
  await prisma.botConversation.update({ where: { id: foreignBotConvId }, data: { clientId: otherClientId, lastMessageAt: new Date() } });
  const res = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken;
});

beforeEach(() => {
  delivered.length = 0;
});

afterAll(async () => {
  const { prisma } = await import("../src/db.js");
  await instagram?.dispose();
  await prisma.telegramConversation.deleteMany({ where: { id: tgConvId } });
  await prisma.client.deleteMany({ where: { id: { in: [clientId, otherClientId] } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("текст из карточки клиента: адресат по выбранной вкладке", () => {
  it("без conversationId прежнее поведение: самый живой диалог", async () => {
    const res = await sendText({ text: "Здравствуйте" });
    expect(res.status).toBe(200);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].target).toMatchObject({ kind: "bot", id: igConvId, channel: "INSTAGRAM" });
    expect(delivered[0].target).toMatchObject({ accountId: instagram.id, transport: instagram.transport });
  });

  it("вкладка Telegram (tg_<id>): уходит в Telegram, хотя Instagram свежее", async () => {
    const res = await sendText({ text: "Здравствуйте", conversationId: `tg_${tgConvId}` });
    expect(res.status).toBe(200);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].target).toMatchObject({ kind: "telegram", id: tgConvId });
  });

  it("явный id диалога бота уходит в него", async () => {
    const res = await sendText({ text: "Здравствуйте", conversationId: igConvId });
    expect(res.status).toBe(200);
    expect(delivered[0].target).toMatchObject({ kind: "bot", id: igConvId });
    expect(delivered[0].target).toMatchObject({ accountId: instagram.id, transport: instagram.transport });
  });

  it("диалог другого клиента отклоняется и никуда не отправляется", async () => {
    const res = await sendText({ text: "Здравствуйте", conversationId: foreignBotConvId });
    expect(res.status).toBe(404);
    expect(delivered).toHaveLength(0);
  });

  it("несуществующий tg_-диалог отклоняется", async () => {
    const res = await sendText({ text: "Здравствуйте", conversationId: "tg_00000000-0000-4000-8000-000000000000" });
    expect(res.status).toBe(404);
    expect(delivered).toHaveLength(0);
  });
});

describe("голосовое из карточки клиента: адресат по выбранной вкладке", () => {
  it("вкладка Telegram: голосовое уходит в Telegram", async () => {
    const res = await sendVoice(`tg_${tgConvId}`);
    expect(res.status).toBe(200);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ kind: "voice", target: { kind: "telegram", id: tgConvId } });
  });

  it("без conversationId прежнее поведение", async () => {
    const res = await sendVoice();
    expect(res.status).toBe(200);
    expect(delivered[0].target).toMatchObject({ kind: "bot", id: igConvId });
    expect(delivered[0].target).toMatchObject({ accountId: instagram.id, transport: instagram.transport });
  });

  it("чужой диалог отклоняется", async () => {
    const res = await sendVoice(foreignBotConvId);
    expect(res.status).toBe(404);
    expect(delivered).toHaveLength(0);
  });
});

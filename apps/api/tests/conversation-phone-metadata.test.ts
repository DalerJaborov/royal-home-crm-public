import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { invalidateAgentAccess } from "../src/auth/middleware.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

const stamp = Date.now();
const phone = `+992931${String(stamp).slice(-6)}`;
const subscriberId = phone.slice(1);
const name = `Фарход ${phone}`;
let agentId = "", token = "", districtId = "", propertyId = "", conversationId = "", clientId = "";
const get = (path: string) => request(app).get(`/api/v1${path}`).set("Authorization", `Bearer ${token}`);

async function rights(origin: boolean, fullPhone: boolean) {
  const granted = [origin && "clients.viewOrigin", fullPhone && "clients.viewPhone"].filter(Boolean);
  const revoked = [!origin && "clients.viewOrigin", !fullPhone && "clients.viewPhone"].filter(Boolean);
  await prisma.agent.update({ where: { id: agentId }, data: { permissions: { granted, revoked } } });
  invalidateAgentAccess(agentId);
}

beforeAll(async () => {
  const agent = await prisma.agent.create({ data: {
    fullName: `Phone privacy ${stamp}`, phone: `+992932${String(stamp).slice(-6)}`, role: "AGENT",
    passwordHash: await bcrypt.hash("testpass123", 10),
  } });
  agentId = agent.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password: "testpass123" });
  expect(login.status).toBe(200);
  token = login.body.accessToken;
  districtId = (await prisma.district.create({ data: { name: `Phone privacy ${stamp}` } })).id;
  propertyId = (await prisma.property.create({ data: {
    title: `Phone privacy ${stamp}`, type: "APARTMENT", districtId, areaSqm: 70, price: 500000,
    address: "Тестовая", currency: "TJS", condition: "GOOD", status: "AVAILABLE", intakeAgentId: agentId,
  } })).id;
  conversationId = (await prisma.botConversation.create({ data: {
    channel: "WHATSAPP", subscriberId, name, lastMessageAt: new Date(Date.now() - 60_000),
    pausedUntil: new Date(Date.now() + 86_400_000), botPausedAt: new Date(Date.now() - 2 * 86_400_000),
    messages: [{ role: "user", content: `Мой номер ${phone}`, at: new Date().toISOString() }],
    propertyLinks: { create: { propertyId, source: "AD_REFERRAL" } },
  } })).id;
});

afterAll(async () => {
  if (conversationId) await prisma.botConversation.delete({ where: { id: conversationId } });
  if (clientId) await prisma.client.delete({ where: { id: clientId } });
  if (propertyId) await prisma.property.delete({ where: { id: propertyId } });
  if (districtId) await prisma.district.delete({ where: { id: districtId } });
  if (agentId) await deleteAgentsWithTraces([agentId]);
});

describe("Источник WhatsApp не раскрывает телефон без отдельного права", () => {
  it("до заявки маскирует ID отправителя, имя профиля и реплику при доступном источнике", async () => {
    await rights(true, false);
    const res = await get(`/conversations/${conversationId}`);
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe("WHATSAPP");
    for (const key of ["subscriberId", "profileName", "name"]) {
      expect(res.body[key]).toContain("•");
      expect(res.body[key]).not.toContain(subscriberId);
      expect(res.body[key]).not.toContain(phone);
    }
    expect(JSON.stringify(res.body.messages)).not.toContain(phone);
  });

  it("анонимное имя с номером закрыто в списке и предупреждениях ожидания", async () => {
    await rights(true, false);
    const res = await get("/conversations");
    expect(res.status).toBe(200);
    const item = res.body.items.find((row: { id: string }) => row.id === conversationId);
    expect(item.name).toContain("•");
    expect(item.name).not.toContain(phone);
    expect(res.body.alerts.longestWaitingHuman.name).not.toContain(phone);
    expect(res.body.alerts.pausedOverDay.names).not.toContain(name);
  });

  it("числовая метка диалога не превращается в маску телефона", async () => {
    await rights(true, false);
    const label = `Показ квартиры ${stamp}`;
    await prisma.botConversation.update({ where: { id: conversationId }, data: { name: label } });
    try {
      const res = await get(`/conversations/${conversationId}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe(label);
      expect(res.body.profileName).toBe(label);
      const list = await get("/conversations");
      expect(list.body.items.find((row: { id: string }) => row.id === conversationId).name).toBe(label);
    } finally {
      await prisma.botConversation.update({ where: { id: conversationId }, data: { name } });
    }
  });

  it("полное право на номер сохраняет исходные метаданные и сообщение", async () => {
    await rights(true, true);
    const res = await get(`/conversations/${conversationId}`);
    expect(res.status).toBe(200);
    expect(res.body.subscriberId).toBe(subscriberId);
    expect(res.body.profileName).toBe(name);
    expect(res.body.name).toBe(name);
    expect(JSON.stringify(res.body.messages)).toContain(phone);
  });

  it("право на телефон не открывает закрытый источник", async () => {
    await rights(false, true);
    const res = await get(`/conversations/${conversationId}`);
    expect(res.status).toBe(200);
    expect(res.body.channel).toBeNull();
    expect(res.body.subscriberId).toBeNull();
    expect(res.body.profileName).toBeNull();
  });

  it("после создания заявки маска остаётся, полный номер сохраняется только на сервере", async () => {
    await rights(true, false);
    clientId = (await prisma.client.create({ data: {
      fullName: "Фарход", phone, source: "WHATSAPP", assignedAgentId: agentId, acceptedAt: new Date(),
    } })).id;
    await prisma.botConversation.update({ where: { id: conversationId }, data: { clientId } });
    const res = await get(`/conversations/${conversationId}`);
    expect(res.status).toBe(200);
    expect(res.body.clientId).toBe(clientId);
    expect(res.body.clientPhone).toContain("•");
    expect(res.body.subscriberId).not.toContain(subscriberId);
    expect((await prisma.client.findUnique({ where: { id: clientId } }))?.phone).toBe(phone);
    expect((await prisma.botConversation.findUnique({ where: { id: conversationId } }))?.subscriberId).toBe(subscriberId);
  });
});

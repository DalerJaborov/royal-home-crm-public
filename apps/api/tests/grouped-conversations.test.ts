import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { invalidateAgentAccess } from "../src/auth/middleware.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

const runId = Date.now();
const iso = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
let adminId = "";
let agentId = "";
let foreignAgentId = "";
let adminToken = "";
let agentToken = "";
const clientIds: string[] = [];
const botIds: string[] = [];
const telegramIds: string[] = [];
const directIds: string[] = [];
let districtId = "";
let propertyId = "";
let propertyClientId = "";

const get = (token: string, path: string) => request(app).get(`/api/v1${path}`).set("Authorization", `Bearer ${token}`);

beforeAll(async () => {
  const [admin, agent, foreignAgent] = await Promise.all([
    prisma.agent.create({ data: { fullName: `Grouped inbox admin ${runId}`, phone: `+99290${String(runId).slice(-8)}1`, role: "ADMIN", passwordHash: "x" } }),
    prisma.agent.create({ data: { fullName: `Grouped inbox agent ${runId}`, phone: `+99290${String(runId).slice(-8)}2`, role: "AGENT", passwordHash: "x" } }),
    prisma.agent.create({ data: { fullName: `Grouped inbox foreign ${runId}`, phone: `+99290${String(runId).slice(-8)}3`, role: "AGENT", passwordHash: "x" } }),
  ]);
  adminId = admin.id;
  agentId = agent.id;
  foreignAgentId = foreignAgent.id;
  adminToken = signAccessToken({ sub: adminId, role: "ADMIN" });
  agentToken = signAccessToken({ sub: agentId, role: "AGENT" });

  const clients = await Promise.all(Array.from({ length: 25 }, (_, index) => prisma.client.create({
    data: {
      fullName: `Grouped test client ${runId}-${index}`,
      // Synthetic number is used only for the viewPhone masking assertion below.
      phone: index === 0 ? "+992900000000" : `fixture-phone-${runId}-${index}`,
      source: "PHONE_CALL", acceptedAt: new Date(),
      assignedAgentId: index === 24 ? foreignAgentId : agentId,
    },
  })));
  clientIds.push(...clients.map(({ id }) => id));

  // One linked client has three histories. Search must match the source row
  // first, then still return one group; all three real source IDs remain intact.
  const linked = clients[0]!;
  const [bot, telegram, direct] = await Promise.all([
    prisma.botConversation.create({ data: {
      clientId: linked.id, channel: "WHATSAPP", subscriberId: `grouped-${runId}-bot`, name: "SearchTarget",
      createdAt: new Date(Date.now() - 300_000), updatedAt: new Date(Date.now() - 2_000), lastMessageAt: new Date(Date.now() - 2_000),
      messages: [
        { role: "assistant", content: "Earlier reply", at: iso(3) },
        { role: "user", content: `SearchTarget ${runId}`, at: iso(2) },
        { role: "user", content: "One more", at: iso(1) },
      ],
    } }),
    prisma.telegramConversation.create({ data: {
      clientId: linked.id, chatId: `grouped-${runId}-telegram`, username: "test_user",
      createdAt: new Date(Date.now() - 250_000), updatedAt: new Date(Date.now() - 4_000), lastMessageAt: new Date(Date.now() - 4_000),
      messages: [{ role: "user", content: "unrelated source history", at: iso(4) }],
    } }),
    prisma.telegramDirectConversation.create({ data: {
      clientId: linked.id, chatId: `grouped-${runId}-direct`, topicId: `topic-${runId}`, username: "direct_user",
      createdAt: new Date(Date.now() - 200_000), updatedAt: new Date(Date.now() - 6_000), lastMessageAt: new Date(Date.now() - 6_000),
      messages: [{ role: "user", content: "Direct history", at: iso(6) }],
    } }),
  ]);
  botIds.push(bot.id);
  telegramIds.push(telegram.id);
  directIds.push(direct.id);

  // More than one page of distinct persisted clients exercises group pagination
  // and totals without loading an unbounded fixture set.
  const others = clients.slice(1, 24);
  const rows = await Promise.all(others.map((client, index) => prisma.botConversation.create({
    data: {
      clientId: client.id, channel: "INSTAGRAM", subscriberId: `grouped-${runId}-${index}`,
      createdAt: new Date(Date.now() - (10 + index) * 60_000), updatedAt: new Date(Date.now() - (10 + index) * 60_000),
      lastMessageAt: new Date(Date.now() - (10 + index) * 60_000),
      messages: [{ role: "assistant", content: `history ${index}`, at: iso(10 + index) }],
    },
  })));
  botIds.push(...rows.map(({ id }) => id));
  const foreign = await prisma.botConversation.create({ data: {
    clientId: clients[24]!.id, channel: "FACEBOOK", subscriberId: `grouped-${runId}-foreign`,
    messages: [{ role: "user", content: "foreign client" }],
  } });
  botIds.push(foreign.id);

  const district = await prisma.district.create({ data: { name: `Grouped property district ${runId}` } });
  districtId = district.id;
  const property = await prisma.property.create({ data: {
    title: `Grouped property ${runId}`, type: "APARTMENT", districtId,
    areaSqm: 70, price: 500000, address: "Тестовая", currency: "TJS", condition: "GOOD",
    status: "AVAILABLE", intakeAgentId: agentId,
  } });
  propertyId = property.id;
  const propertyClient = await prisma.client.create({ data: {
    fullName: `Grouped property-interest client ${runId}`, phone: `fixture-property-phone-${runId}`, source: "PHONE_CALL",
  } });
  propertyClientId = propertyClient.id;
  clientIds.push(propertyClient.id);
  const propertyConversation = await prisma.botConversation.create({ data: {
    clientId: propertyClient.id, propertyChatAgentId: agentId, channel: "INSTAGRAM",
    subscriberId: `grouped-${runId}-property`, messages: [{ role: "user", content: "Property interest" }],
    propertyLinks: { create: { propertyId, source: "AD_REFERRAL" } },
  } });
  botIds.push(propertyConversation.id);
  const [propertyTelegram, propertyDirect] = await Promise.all([
    prisma.telegramConversation.create({ data: {
      clientId: propertyClient.id, chatId: `grouped-${runId}-property-tg`, messages: [{ role: "user", content: "Restricted Telegram source" }],
    } }),
    prisma.telegramDirectConversation.create({ data: {
      clientId: propertyClient.id, chatId: `grouped-${runId}-property-direct`, topicId: `property-topic-${runId}`,
      messages: [{ role: "user", content: "Restricted Direct source" }],
    } }),
  ]);
  telegramIds.push(propertyTelegram.id);
  directIds.push(propertyDirect.id);
});

afterAll(async () => {
  if (botIds.length) await prisma.botConversation.deleteMany({ where: { id: { in: botIds } } });
  if (telegramIds.length) await prisma.telegramConversation.deleteMany({ where: { id: { in: telegramIds } } });
  if (directIds.length) await prisma.telegramDirectConversation.deleteMany({ where: { id: { in: directIds } } });
  if (clientIds.length) await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  if (propertyId) await prisma.property.delete({ where: { id: propertyId } });
  if (districtId) await prisma.district.delete({ where: { id: districtId } });
  const agents = [adminId, agentId, foreignAgentId].filter(Boolean);
  if (agents.length) await deleteAgentsWithTraces(agents);
});

describe("grouped conversation inbox", () => {
  it("keeps newly included Direct history closed until the assigned agent accepts the card", async () => {
    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientIds[0] } });
    await prisma.client.update({ where: { id: client.id }, data: { acceptedAt: null } });
    try {
      const response = await get(agentToken, `/clients/${client.shortId}`);
      expect(response.status).toBe(200);
      expect(response.body.botConversation).toEqual([]);
      expect(response.body.telegramConversation).toBeNull();
      expect(response.body.telegramDirectConversations).toEqual([]);
      expect(JSON.stringify(response.body)).not.toContain("Direct history");
      expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: botIds[0] } })).readAt).toBeNull();
      expect((await prisma.telegramConversation.findUniqueOrThrow({ where: { id: telegramIds[0] } })).readAt).toBeNull();
      expect((await prisma.telegramDirectConversation.findUniqueOrThrow({ where: { id: directIds[0] } })).readAt).toBeNull();
    } finally {
      await prisma.client.update({ where: { id: client.id }, data: { acceptedAt: client.acceptedAt } });
    }
  });
  it("filters sources before exact-client grouping and returns the persisted source IDs", async () => {
    const response = await get(adminToken, `/conversations?grouped=1&q=SearchTarget`);
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].id).toBe(`client:${clientIds[0]}`);
    expect(response.body.items[0].sourceConversationIds).toEqual([botIds[0]]);
  });

  it("pages grouped clients before pagination and returns exact full-set totals", async () => {
    const first = await get(adminToken, "/conversations?grouped=1&page=1");
    const second = await get(adminToken, "/conversations?grouped=1&page=2");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.total).toBe(26);
    expect(second.body.total).toBe(26);
    expect(first.body.items).toHaveLength(20);
    expect(second.body.items).toHaveLength(6);
    const firstIds = first.body.items.map((item: { id: string }) => item.id);
    const secondIds = second.body.items.map((item: { id: string }) => item.id);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(26);
    expect(first.body.items.find((item: { id: string }) => item.id === `client:${clientIds[0]}`).sourceConversationIds)
      .toEqual([botIds[0], `tg_${telegramIds[0]}`, `td_${directIds[0]}`]);
  });

  it("keeps the All segment count unfiltered while selected segments change the page total", async () => {
    const needsHuman = await get(adminToken, "/conversations?grouped=1&needsHuman=1");
    expect(needsHuman.status).toBe(200);
    expect(needsHuman.body.total).toBe(3);
    expect(needsHuman.body.counts.all).toBe(26);
    expect(needsHuman.body.counts.needsHuman).toBe(3);
    const mine = await get(adminToken, "/conversations?grouped=1&mine=1");
    expect(mine.status).toBe(200);
    expect(mine.body.total).toBe(0);
    expect(mine.body.counts.all).toBe(26);
  });

  it("sums unread tails across sources and marks Telegram Direct as read-only", async () => {
    const beforeRead = await get(adminToken, "/conversations?grouped=1&q=SearchTarget");
    expect(beforeRead.body.items[0].unreadCount).toBe(2);
    const response = await get(adminToken, `/conversations/groups/client:${clientIds[0]}`);
    expect(response.status).toBe(200);
    expect(response.body.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: botIds[0], channel: "WHATSAPP", canReply: true }),
      expect.objectContaining({ id: `tg_${telegramIds[0]}`, channel: "TELEGRAM", canReply: true }),
      expect.objectContaining({ id: `td_${directIds[0]}`, channel: "TELEGRAM_DIRECT", canReply: false }),
    ]));
    expect(response.body.messages.filter((message: { sourceConversationId: string }) => message.sourceConversationId === botIds[0])
      .map((message: { sourceMessageIndex: number }) => message.sourceMessageIndex)).toEqual([0, 1, 2]);
    const afterRead = await get(adminToken, "/conversations?grouped=1&q=SearchTarget");
    expect(afterRead.body.items[0].unreadCount).toBe(0);
    expect(afterRead.body.items[0].unread).toBe(false);
  });

  it("hides channel and phone details without their independent permissions", async () => {
    await prisma.agent.update({
      where: { id: adminId },
      data: { permissions: { granted: [], revoked: ["clients.viewOrigin", "clients.viewPhone"] } },
    });
    invalidateAgentAccess(adminId);
    try {
      const response = await get(adminToken, `/conversations/groups/client:${clientIds[0]}`);
      expect(response.status).toBe(200);
      expect(response.body.channel).toBeNull();
      expect(response.body.sources.every((source: { channel: string | null }) => source.channel === null)).toBe(true);
      expect(response.body.messages.every((message: { sourceChannel: string | null }) => message.sourceChannel === null)).toBe(true);
      expect(response.body.clientPhone).toContain("•");
    } finally {
      await prisma.agent.update({ where: { id: adminId }, data: { permissions: { granted: [], revoked: [] } } });
      invalidateAgentAccess(adminId);
    }
  });

  it("does not expose another agent's linked group or sources", async () => {
    const own = await get(agentToken, `/conversations/groups/client:${clientIds[0]}`);
    expect(own.status).toBe(200);
    expect(own.body.sources.some((source: { id: string }) => source.id === `td_${directIds[0]}`)).toBe(true);
    const propertyInterest = await get(agentToken, `/conversations/groups/client:${propertyClientId}`);
    expect(propertyInterest.status).toBe(200);
    expect(propertyInterest.body.sources).toHaveLength(1);
    expect(propertyInterest.body.sources[0].canReply).toBe(true);
    const response = await get(agentToken, "/conversations?grouped=1");
    expect(response.status).toBe(200);
    expect(response.body.items.some((item: { id: string }) => item.id === `client:${clientIds[24]}`)).toBe(false);
    const foreign = await get(agentToken, `/conversations/groups/client:${clientIds[24]}`);
    expect(foreign.status).toBe(404);
  });
});

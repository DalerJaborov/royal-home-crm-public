import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { invalidateAgentAccess } from "../src/auth/middleware.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { linkConversationClient } from "../src/lib/conversationClientLink.js";

const stamp = Date.now();
let agentId = "", token = "", clientId = "", otherId = "";
const conversations: string[] = [], profiles: string[] = [], calls: string[] = [];
const telegramIds: string[] = [];
const post = (id: string, body: unknown) => request(app).post(`/api/v1/conversations/${id}/link-client`)
  .set("Authorization", `Bearer ${token}`).send(body);
async function fixture(channel = "WHATSAPP") {
  const profile = await prisma.contactProfile.create({ data: { displayName: "Тест собеседника", messagesIn: 16 } });
  profiles.push(profile.id);
  const conversation = await prisma.botConversation.create({ data: {
    channel, subscriberId: `99255${String(stamp).slice(-6)}${conversations.length}`,
    contactProfileId: profile.id, messages: [{ role: "user", content: "Это тоже мой номер" }],
  } });
  conversations.push(conversation.id);
  return { profile, conversation };
}
beforeAll(async () => {
  const agent = await prisma.agent.create({ data: { fullName: `Chat link ${stamp}`, role: "ADMIN",
    phone: `+99291${String(stamp).slice(-7)}`, passwordHash: await bcrypt.hash("testpass123", 4) } });
  agentId = agent.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password: "testpass123" });
  token = login.body.accessToken;
  clientId = (await prisma.client.create({ data: { fullName: "После звонка", phone: `+99292${String(stamp).slice(-7)}`,
    source: "PHONE_CALL", assignedAgentId: agentId } })).id;
  otherId = (await prisma.client.create({ data: { fullName: "Другой клиент", phone: `+99293${String(stamp).slice(-7)}`, source: "PHONE_CALL" } })).id;
});
afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { action: "CONVERSATION_CLIENT_LINK", entityId: { in: [clientId, otherId] } } });
  await prisma.telegramConversation.deleteMany({ where: { id: { in: telegramIds } } });
  await prisma.incomingCall.deleteMany({ where: { id: { in: calls } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversations } } });
  await prisma.contactProfileMerge.deleteMany({ where: { OR: [{ targetId: { in: profiles } }, { sourceId: { in: profiles } }] } });
  await prisma.contactProfile.deleteMany({ where: { id: { in: profiles } } });
  await prisma.client.deleteMany({ where: { id: { in: [clientId, otherId] } } });
  await deleteAgentsWithTraces([agentId]);
});
describe("Ручная связь чата без лида с существующим клиентом", () => {
  it("связывает чат и досье звонка, сохраняет оба номера и не создаёт лид", async () => {
    const { profile, conversation } = await fixture();
    const callProfile = await prisma.contactProfile.create({ data: { messagesIn: 0 } });
    profiles.push(callProfile.id);
    const before = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    calls.push((await prisma.incomingCall.create({ data: { channelId: `link-${stamp}`, phone: before.phone,
      clientId, contactProfileId: callProfile.id } })).id);
    const res = await post(conversation.id, { clientId, confirmSamePerson: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const linked = await prisma.botConversation.findUniqueOrThrow({ where: { id: conversation.id } });
    const call = await prisma.incomingCall.findUniqueOrThrow({ where: { id: calls[0] } });
    expect(linked.clientId).toBe(clientId);
    expect(linked.contactProfileId).toBe(call.contactProfileId);
    const dossier = await prisma.contactProfile.findUniqueOrThrow({ where: { id: linked.contactProfileId! } });
    expect(dossier.clientId).toBe(clientId);
    expect(dossier.messagesIn).toBe(16);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(after.phone).toBe(before.phone);
    expect(after.whatsappPhone).toBe(`+${conversation.subscriberId}`);
    expect(after.assignedAgentId).toBe(before.assignedAgentId);
    expect(await prisma.contactProfileMerge.count({ where: { OR: [{ sourceId: profile.id }, { sourceId: callProfile.id }] } })).toBe(1);
    const retry = await post(conversation.id, { clientId, confirmSamePerson: true });
    expect(retry.status).toBe(200);
    expect((await prisma.contactProfile.findUniqueOrThrow({ where: { id: dossier.id } })).messagesIn).toBe(16);
  });
  it("требует явного подтверждения личности", async () => {
    const { conversation } = await fixture();
    expect((await post(conversation.id, { clientId })).status).toBe(400);
    expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: conversation.id } })).clientId).toBeNull();
  });
  it("не перепривязывает уже связанный чат к другому клиенту", async () => {
    expect((await post(conversations[0], { clientId: otherId, confirmSamePerson: true })).status).toBe(409);
  });
  it("не связывает досье с уже закреплёнными чужими переписками", async () => {
    const { profile, conversation } = await fixture("INSTAGRAM");
    const sibling = await prisma.botConversation.create({ data: { channel: "FACEBOOK", subscriberId: `sibling-${stamp}`,
      clientId: otherId, contactProfileId: profile.id } });
    conversations.push(sibling.id);
    expect((await post(conversation.id, { clientId, confirmSamePerson: true })).status).toBe(409);
    expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: conversation.id } })).clientId).toBeNull();
  });
  it("не отдаёт чат пользователю без прав на объединение", async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { permissions: { revoked: ["clients.merge"] } } });
    invalidateAgentAccess(agentId);
    try { expect((await post(conversations[0], { clientId, confirmSamePerson: true })).status).toBe(403); }
    finally {
      await prisma.agent.update({ where: { id: agentId }, data: { permissions: {} } });
      invalidateAgentAccess(agentId);
    }
  });
  it("отклоняет удалённого клиента", async () => {
    const { conversation } = await fixture("INSTAGRAM");
    await prisma.client.update({ where: { id: otherId }, data: { deletedAt: new Date() } });
    try { expect((await post(conversation.id, { clientId: otherId, confirmSamePerson: true })).status).toBe(404); }
    finally { await prisma.client.update({ where: { id: otherId }, data: { deletedAt: null } }); }
  });
  it("при конфликте номера откатывает даже уже выполненное слияние досье", async () => {
    const { profile, conversation } = await fixture();
    await prisma.client.update({ where: { id: otherId }, data: { extraPhones: [`+${conversation.subscriberId}`] } });
    const mergesBefore = await prisma.contactProfileMerge.count({ where: { sourceId: { in: profiles } } });
    try {
      expect((await post(conversation.id, { clientId, confirmSamePerson: true })).status).toBe(409);
      expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: conversation.id } })).clientId).toBeNull();
      const unchanged = await prisma.contactProfile.findUniqueOrThrow({ where: { id: profile.id } });
      expect(unchanged.mergedIntoId).toBeNull();
      expect(unchanged.messagesIn).toBe(16);
      expect(await prisma.contactProfileMerge.count({ where: { sourceId: { in: profiles } } })).toBe(mergesBefore);
    } finally { await prisma.client.update({ where: { id: otherId }, data: { extraPhones: [] } }); }
  });
  it("следующий WhatsApp сохраняет запасным, не затирая первый", async () => {
    const { conversation } = await fixture();
    const before = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect((await post(conversation.id, { clientId, confirmSamePerson: true })).status).toBe(200);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(after.phone).toBe(before.phone);
    expect(after.whatsappPhone).toBe(before.whatsappPhone);
    expect(after.extraPhones).toContain(`+${conversation.subscriberId}`);
  });
  it("работает для Telegram без досье и не превращает chatId в номер", async () => {
    const c = await prisma.telegramConversation.create({ data: { chatId: `telegram-link-${stamp}` } });
    telegramIds.push(c.id);
    const before = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const res = await post(`tg_${c.id}`, { clientId, confirmSamePerson: true });
    expect(res.status).toBe(200);
    expect((await prisma.telegramConversation.findUniqueOrThrow({ where: { id: c.id } })).clientId).toBe(clientId);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(after.phone).toBe(before.phone);
    expect(after.extraPhones).toEqual(before.extraPhones);
    expect(JSON.stringify(res.body)).not.toContain(after.phone);
  });
  it("служебная связь записывает поручение владельца, не выдавая себя за сотрудника", async () => {
    const { conversation } = await fixture("INSTAGRAM");
    await linkConversationClient(conversation.id, { clientId, confirmSamePerson: true }, null);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "CONVERSATION_CLIENT_LINK", entityId: clientId,
      meta: { path: ["conversationId"], equals: conversation.id } } });
    expect(audit.agentId).toBeNull();
    expect(audit.agentName).toBe("Система (по поручению владельца)");
    expect(audit.meta).toMatchObject({ source: "owner-authorized-maintenance" });
  });
  it("два одновременных решения не прикрепляют одно досье к разным людям", async () => {
    const { conversation } = await fixture("INSTAGRAM");
    const results = await Promise.all([
      post(conversation.id, { clientId, confirmSamePerson: true }),
      post(conversation.id, { clientId: otherId, confirmSamePerson: true }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const saved = await prisma.botConversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect((await prisma.contactProfile.findUniqueOrThrow({ where: { id: saved.contactProfileId! } })).clientId).toBe(saved.clientId);
  });
});

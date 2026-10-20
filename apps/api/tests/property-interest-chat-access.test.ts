import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  isMetaChannelEnabled: async () => true,
  sendMessage: vi.fn(async () => {}),
}));

// Exercise the actual notification writer with a delayed background commit.
// A stable zero is not evidence that a future notification has been persisted.
vi.mock("../src/lib/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/notifications.js")>();
  const delayForOwnNotice = async (tag: string | null | undefined) => {
    if (tag?.startsWith("property-chat-message-") || tag?.startsWith("interest-conv-")) {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  };
  return { ...actual,
    createNotification: async (...args: Parameters<typeof actual.createNotification>) => {
      await delayForOwnNotice(args[0].tag);
      return actual.createNotification(...args);
    },
    createNotifications: async (...args: Parameters<typeof actual.createNotifications>) => {
      await delayForOwnNotice(args[1].tag);
      return actual.createNotifications(...args);
    },
  };
});

const { prisma } = await import("../src/db.js");
const { encryptSecret } = await import("../src/crypto.js");
const { ensureScopedBotConversation, resolveCustomerEndpoint } = await import("../src/lib/customerConversationScope.js");
import type { CustomerTransportReference } from "../src/lib/customerConversationScope.js";
const { app } = await import("../src/app.js");
const { linkConversationProperty } = await import("../src/lib/propertyVoice/linkConversation.js");
const { defaultPauseForSender, OPERATOR_REPLY_PAUSE_MS, OPERATOR_REPLY_PAUSE_MS_SHORT } = await import("../src/lib/conversationDelivery.js");
const { propertyInterestChatAgentIds } = await import("../src/lib/ownBotConversationScope.js");
const { claimPropertyChatReply, rollbackPropertyChatReply } = await import("../src/lib/propertyChatReply.js");
const { notifyPropertyChatMessage } = await import("../src/lib/propertyChatMessageAlert.js");
const { noticeOwnerOfConversationInterest } = await import("../src/lib/propertyInterestNotice.js");
const { processMessengerTurn: actualProcessMessengerTurn } = await import("../src/messengers/conversation.js");
const { sendMessage } = await import("../src/messengers/meta.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { waitFor, waitForCount, waitForSettled } = await import("./helpers/waitFor.js");

const stamp = Date.now();
const label = `property-chat-${stamp}`;
const agents: string[] = [];
const clients: string[] = [];
const conversations: string[] = [];
const properties: string[] = [];
const profiles: string[] = [];
const peers = new Map<string, string>();
const transports = new Map<string, CustomerTransportReference>();
const inquiryIds: string[] = [];
let settingsBefore: { metaWaPhoneId: string | null; metaWaToken: string | null; metaAppSecret: string | null };
let policyBefore: { contractVersion: string; rolloutMode: string };
const installedResource = `synthetic-property-chat-wa-${stamp}`;
let ownerId: string;
let otherId: string;
let ownerToken: string;
let otherToken: string;
let districtId: string;
let propertyId: string;
let anonymousId: string;
let shownId: string;
let foreignId: string;
let unacceptedId: string;
let unassignedId: string;
let orphanId: string;
let profileId: string;

async function conversation(suffix: string, clientId?: string, contactProfileId?: string) {
  // WhatsApp identity is the normalized phone: distinct labels with the same
  // timestamp would normalize to one peer and accidentally reuse its client.
  const subscriberId = `992977${String(stamp).slice(-3)}${String(conversations.length).padStart(3, "0")}`;
  const scoped = await prisma.$transaction(tx => ensureScopedBotConversation(tx, {
    channel: "WHATSAPP", subscriberId, accountExternalId: installedResource,
  }));
  const row = await prisma.botConversation.update({ where: { id: scoped.id }, data: {
    name: `${label}-${suffix}`,
    clientId, contactProfileId, lastMessageAt: new Date(),
    messages: [{ role: "user", content: "Можно подробнее о квартире?", at: new Date().toISOString() }],
  } });
  conversations.push(row.id);
  peers.set(row.id, subscriberId);
  transports.set(subscriberId, scoped.transport);
  inquiryIds.push((await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: row.id } })).id);
  return row.id;
}

function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  return actualProcessMessengerTurn({ ...input, customerTransport: transports.get(input.subscriberId), accountExternalId: installedResource });
}

async function client(assignedAgentId: string | null, accepted: boolean) {
  const row = await prisma.client.create({ data: {
    fullName: label, phone: `+99288${stamp}${clients.length}`, source: "WHATSAPP",
    assignedAgentId, acceptedAt: accepted ? new Date() : null,
  } });
  clients.push(row.id);
  return row.id;
}

const authGet = (path: string, token = ownerToken) => request(app).get(`/api/v1${path}`).set("Authorization", `Bearer ${token}`);
const authPost = (path: string) => request(app).post(`/api/v1${path}`).set("Authorization", `Bearer ${ownerToken}`);

beforeAll(async () => {
  // This suite exercises the legacy staff/silent-intake workflow. A previous
  // scoped ACTIVE gate must not turn its deliberately unbranded direct inputs
  // into a different customer-authority scenario.
  policyBefore = await prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" },
    select: { contractVersion: true, rolloutMode: true } });
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "compat", rolloutMode: "OFF" } });
  settingsBefore = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { metaWaPhoneId: true, metaWaToken: true, metaAppSecret: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: {
    metaWaPhoneId: installedResource, metaWaToken: encryptSecret("synthetic-property-chat-token"), metaAppSecret: encryptSecret("synthetic-property-chat-signing-secret"),
  } });
  const passwordHash = await bcrypt.hash("testpass123", 10);
  for (let i = 0; i < 2; i++) {
    const a = await prisma.agent.create({ data: {
      fullName: `${label}-${i}`, phone: `+99289${stamp}${i}`, role: "AGENT", passwordHash,
    } });
    agents.push(a.id);
    const login = await request(app).post("/api/v1/auth/login").send({ phone: a.phone, password: "testpass123" });
    expect(login.status, JSON.stringify({ error: login.body.error, code: login.body.code, message: login.body.message })).toBe(200);
    if (i === 0) { ownerId = a.id; ownerToken = login.body.accessToken; }
    else { otherId = a.id; otherToken = login.body.accessToken; }
  }
  districtId = (await prisma.district.create({ data: { name: label } })).id;
  propertyId = (await prisma.property.create({ data: {
    title: label, type: "APARTMENT", districtId, areaSqm: 70, price: 500000,
    address: "Тестовая", currency: "TJS", condition: "GOOD", status: "AVAILABLE", intakeAgentId: ownerId,
  } })).id;
  properties.push(propertyId);
  profileId = (await prisma.contactProfile.create({ data: { displayName: label, category: "BUYER" } })).id;
  profiles.push(profileId);
  anonymousId = await conversation("anonymous", undefined, profileId);
  shownId = await conversation("shown");
  foreignId = await conversation("foreign", await client(otherId, true));
  unacceptedId = await conversation("unaccepted", await client(ownerId, false));
  unassignedId = await conversation("unassigned", await client(null, false));
  orphanId = await conversation("orphan");
  for (const id of [anonymousId, foreignId, unacceptedId, unassignedId]) {
    await prisma.conversationProperty.create({ data: { conversationId: id, propertyId, source: "AD_REFERRAL" } });
  }
  await prisma.conversationProperty.create({ data: { conversationId: shownId, propertyId, source: "EXPOSURE" } });
});

afterAll(async () => {
  try {
    await waitForSettled(() => prisma.notification.count({ where: { agentId: { in: agents } } }));
    await prisma.jobApplication.deleteMany({ where: { conversationId: { in: conversations } } });
    await prisma.botConversation.deleteMany({ where: { id: { in: conversations } } });
    await prisma.customerPropertyIngressTicket.deleteMany({ where: { originalConversationId: { in: conversations } } });
    await prisma.customerInquiry.deleteMany({ where: { id: { in: inquiryIds } } });
    const scopeIds = [...new Set([...transports.values()].map(ref => ref.endpointScopeId))];
    await prisma.outboundShieldState.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
    await prisma.customerEndpointScope.deleteMany({ where: { id: { in: scopeIds } } });
    await prisma.contactProfile.deleteMany({ where: { id: { in: profiles } } });
    await prisma.client.deleteMany({ where: { id: { in: clients } } });
    await prisma.property.deleteMany({ where: { id: { in: properties } } });
    await deleteAgentsWithTraces(agents);
    // A failed beforeAll can leave the ID unset. Prisma omits undefined filters;
    // never turn partial-fixture cleanup into a delete of all districts.
    if (districtId) await prisma.district.deleteMany({ where: { id: districtId } });
  } finally {
    // Configuration restoration is independent of owned-row cleanup failures.
    // Capabilities are deliberately unchanged by this legacy fixture.
    try {
      if (policyBefore) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: policyBefore });
    } finally {
      try {
        if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
      } finally { await prisma.$disconnect(); }
    }
  }
});

describe("Переписка по своему объекту до оформления заявки", () => {
  it("владелец открывает диалог и досье; другой агент не может", async () => {
    expect((await authGet(`/conversations/${anonymousId}`)).status).toBe(200);
    expect((await authGet(`/contacts/${profileId}`)).status).toBe(200);
    expect((await authGet(`/conversations/${anonymousId}`, otherToken)).status).toBe(404);
    expect((await authGet(`/contacts/${profileId}`, otherToken)).status).toBe(404);
  });

  it("список, total и срез Мои используют ту же область доступа", async () => {
    for (const query of ["", "&mine=1", "&needsHuman=1"]) {
      const res = await authGet(`/conversations?q=${label}${query}`);
      expect(res.status).toBe(200);
      expect(res.body.items.map((c: { id: string }) => c.id).sort()).toEqual([anonymousId, unassignedId].sort());
      expect(res.body.total).toBe(2);
      expect(res.body.counts).toMatchObject({ all: 2, mine: 2, needsHuman: 2 });
    }
  });

  it("сам показ ботом, обычный чат, чужой клиент и непринятый лид не дают доступ", async () => {
    for (const id of [shownId, orphanId, foreignId, unacceptedId]) {
      expect((await authGet(`/conversations/${id}`)).status).toBe(404);
      expect((await authPost(`/conversations/${id}/reply`).send({ text: "Недопустимый ответ" })).status).toBe(404);
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("непринятый клиент в досье не открывается через чат без заявки", async () => {
    const pending = await prisma.botConversation.findUniqueOrThrow({ where: { id: unacceptedId } });
    const p = await prisma.contactProfile.create({ data: { displayName: label, clientId: pending.clientId } });
    profiles.push(p.id);
    await prisma.botConversation.update({ where: { id: unassignedId }, data: { contactProfileId: p.id } });
    expect((await authGet(`/conversations/${unassignedId}`)).status).toBe(404);
    const list = await authGet(`/conversations?q=${label}`);
    expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain(unassignedId);
    expect(await propertyInterestChatAgentIds(unassignedId)).toEqual([]);
    await prisma.botConversation.update({ where: { id: unassignedId }, data: { contactProfileId: null } });
  });

  it("ручной ответ владельца отправляется и надолго ставит бота на паузу", async () => {
    const target = { kind: "bot" as const, id: anonymousId, channel: "WHATSAPP", subscriberId: peers.get(anonymousId)! };
    const sender = { kind: "agent" as const, agentId: ownerId, agentName: label };
    expect(await defaultPauseForSender(target, sender)).toBe(OPERATOR_REPLY_PAUSE_MS);
    expect(await defaultPauseForSender(target, { ...sender, agentId: otherId })).toBe(OPERATOR_REPLY_PAUSE_MS_SHORT);
    const res = await authPost(`/conversations/${anonymousId}/reply`).send({ text: "Здравствуйте, я агент этой квартиры. Отвечу на ваши вопросы." });
    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: anonymousId } });
    expect(row.pausedUntil!.getTime()).toBeGreaterThan(Date.now() + 365 * 24 * 60 * 60 * 1000);
    expect(row.clientId).toBeNull();
    expect(row.propertyChatAgentId).toBe(ownerId);
    expect((row.messages as { by?: { agentId?: string } }[]).at(-1)?.by?.agentId).toBe(ownerId);
    expect((await authPost(`/conversations/${anonymousId}/resume`).send({})).status).toBe(403);
  });

  it("закрытое окно отправки откатывает и паузу, и перехват", async () => {
    const id = await conversation("failed");
    await prisma.conversationProperty.create({ data: { conversationId: id, propertyId, source: "AD_REFERRAL" } });
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error("Graph API (#131047) 24 hour window passed"));
    const res = await authPost(`/conversations/${id}/reply`).send({ text: "Добрый день" });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("window_closed");
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id } });
    expect(row.propertyChatAgentId).toBeNull();
    expect(row.propertyChatAgentAt).toBeNull();
    expect(row.pausedUntil).toBeNull();
    expect((row.messages as unknown[]).length).toBe(1);
  });

  it("следующие сообщения без заявки записываются в ленту, даже без push-подписки", async () => {
    const tag = `property-chat-message-${anonymousId}`;
    await notifyPropertyChatMessage(anonymousId);
    await waitForCount(() => prisma.notification.count({ where: { tag } }), 1);
    const note = await prisma.notification.findFirstOrThrow({ where: { tag, agentId: ownerId } });
    expect(note.kind).toBe("message");
    expect(note.url).toBe(`/messages?open=${anonymousId}`);
    await notifyPropertyChatMessage(anonymousId);
    await waitFor(() => prisma.notification.findFirst({ where: { id: note.id } }).then(n => n?.count === 2));
    expect(await prisma.notification.count({ where: { tag } })).toBe(1);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: note.id } })).count).toBe(2);
    await notifyPropertyChatMessage(foreignId);
    expect(await prisma.notification.count({ where: { tag: `property-chat-message-${foreignId}` } })).toBe(0);
  });

  it("отказ отправки не откатывает чужую паузу после A→B→A с теми же датами", async () => {
    const id = await conversation("pause-aba");
    await prisma.conversationProperty.create({ data: { conversationId: id, propertyId, source: "AD_REFERRAL" } });
    let finalPause: Date | null = null;
    vi.mocked(sendMessage).mockImplementationOnce(async () => {
      const placed = await prisma.botConversation.findUniqueOrThrow({ where: { id } });
      finalPause = placed.pausedUntil;
      // A separate owner intervention returns all old timestamp values. A
      // timestamp-only rollback would mistakenly erase this newer ownership.
      await prisma.botConversation.update({ where: { id }, data: { pausedUntil: null, botPausedAt: null,
        propertyChatAgentId: null, propertyChatAgentAt: null } });
      await prisma.botConversation.update({ where: { id }, data: { pausedUntil: placed.pausedUntil, botPausedAt: placed.botPausedAt,
        propertyChatAgentId: placed.propertyChatAgentId, propertyChatAgentAt: placed.propertyChatAgentAt } });
      throw new Error("Graph API (#131047) 24 hour window passed");
    });
    const res = await authPost(`/conversations/${id}/reply`).send({ text: "Добрый день" });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("window_closed");
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id } });
    expect(finalPause).not.toBeNull();
    expect(row.pausedUntil).toEqual(finalPause);
    expect(row.propertyChatAgentId).toBe(ownerId);
    expect((row.messages as unknown[]).length).toBe(1);
  });

  it("два владельца в одном чате не перехватывают разговор одновременно", async () => {
    const second = await prisma.property.create({ data: {
      title: label, type: "APARTMENT", districtId, areaSqm: 60, price: 400000,
      address: "Тестовая 2", currency: "TJS", condition: "GOOD", status: "AVAILABLE", intakeAgentId: otherId,
    } });
    properties.push(second.id);
    const id = await conversation("race");
    await prisma.conversationProperty.createMany({ data: [
      { conversationId: id, propertyId, source: "AD_REFERRAL" },
      { conversationId: id, propertyId: second.id, source: "SHARED_MEDIA" },
    ] });
    const results = await Promise.all([ownerId, otherId].map(agentId => claimPropertyChatReply(id, { kind: "agent", agentId, agentName: label })));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toHaveLength(1);
    const claimed = await prisma.botConversation.findUniqueOrThrow({ where: { id } });
    const token = claimed.propertyChatAgentId === ownerId ? otherToken : ownerToken;
    expect((await authGet(`/conversations/${id}`, token)).status).toBe(404);
    const otherPropertyId = claimed.propertyChatAgentId === ownerId ? second.id : propertyId;
    const otherOwnerId = claimed.propertyChatAgentId === ownerId ? otherId : ownerId;
    await noticeOwnerOfConversationInterest({ conversationId: id, propertyId: otherPropertyId });
    const tag = `interest-conv-${id}-${otherPropertyId}`;
    await waitForCount(() => prisma.notification.count({ where: { tag } }), 1);
    const note = await prisma.notification.findFirstOrThrow({ where: { tag, agentId: otherOwnerId } });
    expect(note.url).toBe(`/properties/${claimed.propertyChatAgentId === ownerId ? second.shortId : (await prisma.property.findUniqueOrThrow({ where: { id: propertyId } })).shortId}`);
    expect(note.body).toContain("Переписку уже ведёт");
    expect(note.body).not.toContain("Переписка — в «Чатах»");
  });

  it("поздний отказ первого ответа не снимает перехват после нового ответа", async () => {
    const id = await conversation("rollback-race");
    await prisma.conversationProperty.create({ data: { conversationId: id, propertyId, source: "AD_REFERRAL" } });
    const sender = { kind: "agent" as const, agentId: ownerId, agentName: label };
    const first = await claimPropertyChatReply(id, sender);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    expect((await claimPropertyChatReply(id, sender)).ok).toBe(true);
    await rollbackPropertyChatReply(first.undo);
    expect((await prisma.botConversation.findUniqueOrThrow({ where: { id } })).propertyChatAgentId).toBe(ownerId);
  });

  it("старый claim undo не оживает после изменения и восстановления привязки", async () => {
    const id = await conversation("binding-aba");
    await prisma.conversationProperty.create({ data: { conversationId: id, propertyId, source: "AD_REFERRAL" } });
    const result = await claimPropertyChatReply(id, { kind: "agent", agentId: ownerId, agentName: label });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.undo) throw new Error("Expected actual claim undo");
    await prisma.botConversation.update({ where: { id }, data: { contactProfileId: profileId } });
    await prisma.botConversation.update({ where: { id }, data: { contactProfileId: null } });
    await rollbackPropertyChatReply(result.undo);
    expect((await prisma.botConversation.findUniqueOrThrow({ where: { id } })).propertyChatAgentId).toBe(ownerId);
  });

  it("номер в чате при молчащем боте создаёт заявку владельцу и не закрывает переписку", async () => {
    const id = await conversation("capture");
    await prisma.conversationProperty.create({ data: { conversationId: id, propertyId, source: "SHARED_MEDIA" } });
    // A real affected dialog can still have UNKNOWN after a generic greeting.
    await prisma.botConversation.update({ where: { id }, data: { leadDraft: { intent: "other", whoIsThis: "UNKNOWN", confident: false, stage: "chatting" } } });
    expect((await authPost(`/conversations/${id}/reply`).send({ text: "Подскажите ваш номер для звонка" })).status).toBe(200);
    const result = await processMessengerTurn({ channel: "WHATSAPP", subscriberId: peers.get(id)!, text: `Мой номер +992934${String(stamp).slice(-6)}` });
    expect(result.shouldReply).toBe(false);
    const conv = await prisma.botConversation.findUniqueOrThrow({ where: { id }, include: { client: true } });
    let captureDiagnostic: string | undefined;
    if (!conv.clientId) {
      const policy = await prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" },
        select: { contractVersion: true, rolloutMode: true } });
      const accounts = await prisma.messengerAccount.findMany({ where: { channel: "WHATSAPP" },
        select: { externalId: true, messagingId: true, extraExternalIds: true, enabled: true } });
      const ref = transports.get(peers.get(id)!)!;
      let namespace: "current" | "denied" = "denied";
      try {
        await resolveCustomerEndpoint({ channel: "WHATSAPP", subscriberId: peers.get(id)!, accountExternalId: installedResource, transport: ref });
        namespace = "current";
      } catch { /* Only the outcome is diagnostic; never print routing/contact data. */ }
      const lastMessage = Array.isArray(conv.messages) ? conv.messages.at(-1) : null;
      captureDiagnostic = JSON.stringify({ policy, result: { shouldReply: result.shouldReply, accepted: result.accepted,
        ready: result.ready, silenced: result.silenced ?? null }, namespace,
        accountCandidates: accounts.length, enabledAccountCandidates: accounts.filter(a => a.enabled).length,
        exactAccountCandidates: accounts.filter(a => [a.externalId, a.messagingId, ...a.extraExternalIds].includes(installedResource)).length,
        storedScopeMatches: conv.endpointScopeId === ref.endpointScopeId, storedAccountMatches: conv.accountId === ref.accountId,
        hasOwner: !!conv.propertyChatAgentId, isPaused: !!conv.pausedUntil && conv.pausedUntil > new Date(),
        hasCurrentUserMessage: !!lastMessage && typeof lastMessage === "object" && !Array.isArray(lastMessage) && lastMessage.role === "user" });
    }
    expect(conv.clientId, captureDiagnostic).not.toBeNull();
    clients.push(conv.clientId!);
    expect(conv.client?.assignedAgentId).toBe(ownerId);
    expect(conv.client?.kind).toBe("BUYER");
    expect(conv.client?.acceptedAt).toBeNull();
    expect(conv.client?.matchedPropertyId).toBe(propertyId);
    expect((await authGet(`/conversations/${id}`)).status).toBe(200);
    expect(conv.pausedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it.each([
    ["rent", "Нужна квартира в аренду", "930"],
    ["job", "Я ищу работу по вакансии", "932"],
  ])("явный запрос %s не становится покупателем после ответа владельца", async (tag, text, prefix) => {
    const id = await conversation(`guard-${tag}`);
    await prisma.conversationProperty.create({ data: { conversationId: id, propertyId, source: "AD_REFERRAL" } });
    await prisma.botConversation.update({ where: { id }, data: { leadDraft: { intent: "other", whoIsThis: "UNKNOWN", confident: false, stage: "chatting" } } });
    expect((await authPost(`/conversations/${id}/reply`).send({ text: "Уточните, чем помочь" })).status).toBe(200);
    await processMessengerTurn({ channel: "WHATSAPP", subscriberId: peers.get(id)!, text: `${text}. Мой номер +992${prefix}${String(stamp).slice(-6)}` });
    const conv = await prisma.botConversation.findUniqueOrThrow({ where: { id }, include: { client: true } });
    if (conv.clientId) clients.push(conv.clientId);
    expect(conv.client?.kind).not.toBe("BUYER");
    expect(conv.client?.assignedAgentId ?? null).toBeNull();
  });

  it("живые обновления адресованы только владельцу интересующего объекта", async () => {
    expect(await propertyInterestChatAgentIds(anonymousId)).toEqual([ownerId]);
    expect(await propertyInterestChatAgentIds(shownId)).toEqual([]);
    expect(await propertyInterestChatAgentIds(foreignId)).toEqual([]);
    expect(await propertyInterestChatAgentIds(orphanId)).toEqual([]);
  });

  it("связь с досье чужого клиента не открывает его через анонимный чат", async () => {
    const foreign = await prisma.botConversation.findUniqueOrThrow({ where: { id: foreignId } });
    await prisma.contactProfile.update({ where: { id: profileId }, data: { clientId: foreign.clientId } });
    expect((await authGet(`/conversations/${anonymousId}`)).status).toBe(404);
    expect((await authGet(`/contacts/${profileId}`)).status).toBe(404);
    expect(await propertyInterestChatAgentIds(anonymousId)).toEqual([]);
    const list = await authGet(`/conversations?q=${label}`);
    expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain(anonymousId);
    await prisma.contactProfile.update({ where: { id: profileId }, data: { clientId: null } });
  });

  it("старый id слитого досье не обходит владельца живого досье", async () => {
    const foreign = await prisma.botConversation.findUniqueOrThrow({ where: { id: foreignId } });
    const merged = await prisma.contactProfile.create({ data: { displayName: label, clientId: foreign.clientId } });
    profiles.push(merged.id);
    await prisma.contactProfile.update({ where: { id: profileId }, data: { mergedIntoId: merged.id } });
    expect((await authGet(`/conversations/${anonymousId}`)).status).toBe(404);
    expect((await authGet(`/contacts/${profileId}`)).status).toBe(404);
    expect(await propertyInterestChatAgentIds(anonymousId)).toEqual([]);
    const list = await authGet(`/conversations?q=${label}`);
    expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain(anonymousId);
    await prisma.contactProfile.update({ where: { id: profileId }, data: { mergedIntoId: null } });
  });

  it("реальный интерес после показа даёт доступ, ensureOnly не меняет число узнаваний", async () => {
    await linkConversationProperty({ conversationId: shownId, propertyId, source: "NUMBER_IN_TEXT", ensureOnly: true });
    expect((await authGet(`/conversations/${shownId}`)).status).toBe(200);
    const link = await prisma.conversationProperty.findUniqueOrThrow({ where: { conversationId_propertyId: { conversationId: shownId, propertyId } } });
    expect(link.source).toBe("NUMBER_IN_TEXT");
    expect(link.hits).toBe(1);
  });

  it("назначение клиента другому агенту сразу закрывает доступ, объект не переезжает", async () => {
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: unassignedId } });
    await prisma.client.update({ where: { id: row.clientId! }, data: { assignedAgentId: otherId } });
    expect((await authGet(`/conversations/${unassignedId}`)).status).toBe(404);
    await prisma.client.update({ where: { id: row.clientId! }, data: { assignedAgentId: null } });
  });

  it("закрытый, удалённый объект и смена владельца отзывают доступ", async () => {
    for (const data of [{ status: "SOLD" as const }, { deletedAt: new Date() }, { intakeAgentId: otherId }]) {
      await prisma.property.update({ where: { id: propertyId }, data });
      expect((await authGet(`/conversations/${anonymousId}`)).status).toBe(404);
      const list = await authGet(`/conversations?q=${label}`);
      expect(list.body.items).toHaveLength(0);
      await prisma.property.update({ where: { id: propertyId }, data: { status: "AVAILABLE", deletedAt: null, intakeAgentId: ownerId } });
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import {
  findClientByPhoneDigits,
  linkWhatsAppConversationToClient,
  rememberWhatsAppPhone,
  resolveWhatsAppLeadIdentity,
  whatsAppPhoneFromSubscriberId,
} from "../src/lib/whatsappPhone.js";
import { createLeadFromChannel } from "../src/leads.js";

/**
 * Номер клиента из WhatsApp подставляется в карточку автоматически (требование
 * владельца 31.07.2026, п. 4). Проверяем три вещи, на которых это ломается:
 * канал (в Instagram subscriberId — НЕ телефон), уже существующая карточка
 * (второй дубль вместо связи) и уникальность Client.phone (падение приёма).
 */

const runId = Date.now();
// Хвост номера уникален для прогона: база общая, и тест не должен зацепить
// ни сидовые данные, ни записи параллельного прогона.
const tail = String(runId).slice(-7);
const waId = `992${tail}88`; // 12 цифр, как настоящий wa_id
const waPhone = `+${waId}`;

const clientIds: string[] = [];
const conversationIds: string[] = [];
let agentId: string;
/** Карточка, существовавшая ДО обращения в WhatsApp, — к ней и должен привязаться диалог. */
let existingClientId: string;
/** Карточка, заведённая по wa_id уже в этом прогоне. */
let freshClientId: string;

async function makeConversation(channel: string, subscriberId: string): Promise<string> {
  const c = await prisma.botConversation.create({
    data: { channel, subscriberId, messages: [], leadDraft: { stage: "chatting" } },
  });
  conversationIds.push(c.id);
  return c.id;
}

const password = "testpass123";
let adminId: string;
let agentToken: string;
let adminToken: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Агент WA ${runId}`, phone: `+992900${tail}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const admin = await prisma.agent.create({
    data: { fullName: `Админ WA ${runId}`, phone: `+992901${tail}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  agentToken = await login(agent.phone);
  adminToken = await login(admin.phone);
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, adminId] } } });
  await prisma.$disconnect();
});

describe("wa_id → телефон", () => {
  it("в WhatsApp subscriberId — это номер", () => {
    expect(whatsAppPhoneFromSubscriberId("WHATSAPP", "992900000001")).toBe("+992900000001");
  });

  it("девятизначный местный номер получает код страны — как везде в CRM", () => {
    expect(whatsAppPhoneFromSubscriberId("WHATSAPP", "900000001")).toBe("+992900000001");
  });

  it("в Instagram и Facebook subscriberId телефоном НЕ считается", () => {
    expect(whatsAppPhoneFromSubscriberId("INSTAGRAM", "17841400000000000")).toBeNull();
    expect(whatsAppPhoneFromSubscriberId("FACEBOOK", "992900000001")).toBeNull();
  });

  it("мусор и слишком короткое/длинное значение отбрасываются", () => {
    expect(whatsAppPhoneFromSubscriberId("WHATSAPP", "")).toBeNull();
    expect(whatsAppPhoneFromSubscriberId("WHATSAPP", "12345")).toBeNull();
    expect(whatsAppPhoneFromSubscriberId("WHATSAPP", "9929000000019929000000")).toBeNull();
  });
});

describe("поиск карточки по номеру терпим к записи", () => {
  it("находит клиента, у которого номер записан с пробелами и без «+»", async () => {
    const messy = `992 ${tail} 77`;
    const client = await prisma.client.create({
      data: { fullName: `Клиент с пробелами ${runId}`, phone: messy, source: "WALK_IN", assignedAgentId: agentId },
    });
    clientIds.push(client.id);

    const found = await findClientByPhoneDigits(`+992${tail}77`);
    expect(found?.id).toBe(client.id);
    // Отдаёт телефон КАК ЗАПИСАН — иначе createLeadFromChannel промахнётся findUnique.
    expect(found?.phone).toBe(messy);
  });

  it("на незнакомом номере молчит", async () => {
    expect(await findClientByPhoneDigits("+99299900000")).toBeNull();
  });
});

describe("клиент уже существует — связываем, а не дублируем", () => {
  it("createLeadFromChannel по найденному телефону не создаёт вторую карточку", async () => {
    const existing = await prisma.client.create({
      data: {
        fullName: `Старый клиент ${runId}`,
        phone: waPhone,
        source: "WEBSITE",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    });
    clientIds.push(existing.id);
    existingClientId = existing.id;

    const identity = await resolveWhatsAppLeadIdentity("WHATSAPP", waId);
    expect(identity).not.toBeNull();
    expect(identity!.waPhone).toBe(waPhone);
    expect(identity!.existingClientId).toBe(existing.id);

    const { clientId, created } = await createLeadFromChannel({
      fullName: `Кто-то из WhatsApp ${runId}`,
      phone: identity!.leadPhone,
      source: "WHATSAPP",
      whatsappPhone: identity!.waPhone,
    });
    expect(created).toBe(false);
    expect(clientId).toBe(existing.id);

    // Номер WhatsApp дозаполнен в существующей карточке, phone не тронут.
    const after = await prisma.client.findUnique({ where: { id: existing.id } });
    expect(after?.whatsappPhone).toBe(waPhone);
    expect(after?.phone).toBe(waPhone);
    expect(after?.fullName).toBe(`Старый клиент ${runId}`);
  });

  it("диалог WhatsApp привязывается к существующей карточке", async () => {
    const conversationId = await makeConversation("WHATSAPP", waId);
    const outcome = await linkWhatsAppConversationToClient(conversationId, "WHATSAPP", waId);
    expect(outcome.linked).toBe(true);

    const conv = await prisma.botConversation.findUnique({ where: { id: conversationId } });
    expect(conv?.clientId).toBe(existingClientId);

    // Повторная доставка вебхука ничего не портит.
    const again = await linkWhatsAppConversationToClient(conversationId, "WHATSAPP", waId);
    expect(again).toMatchObject({ linked: false, reason: "already_linked" });
  });

  it("у карточки уже есть диалог другого канала — WhatsApp привязывается тоже, оба видны на карточке", async () => {
    const busyTail = `${tail}66`;
    const client = await prisma.client.create({
      data: { fullName: `Клиент из Instagram ${runId}`, phone: `+992${busyTail}`, source: "INSTAGRAM", assignedAgentId: agentId },
    });
    clientIds.push(client.id);
    const igConversation = await makeConversation("INSTAGRAM", `ig-${runId}`);
    await prisma.botConversation.update({ where: { id: igConversation }, data: { clientId: client.id } });

    const waConversation = await makeConversation("WHATSAPP", `992${busyTail}`);
    const outcome = await linkWhatsAppConversationToClient(waConversation, "WHATSAPP", `992${busyTail}`);
    expect(outcome).toMatchObject({ linked: true, clientId: client.id });

    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.whatsappPhone).toBe(`+992${busyTail}`);

    const linkedConversations = await prisma.botConversation.findMany({
      where: { clientId: client.id },
      select: { id: true },
    });
    expect(linkedConversations.map((c) => c.id).sort()).toEqual([igConversation, waConversation].sort());
  });

  it("карточка в Корзине сама не подцепляется — её воскрешение решается отдельно", async () => {
    const trashedTail = `${tail}55`;
    const client = await prisma.client.create({
      data: {
        fullName: `Удалённый клиент ${runId}`,
        phone: `+992${trashedTail}`,
        source: "WALK_IN",
        assignedAgentId: agentId,
        deletedAt: new Date(),
      },
    });
    clientIds.push(client.id);

    const conversationId = await makeConversation("WHATSAPP", `992${trashedTail}`);
    const outcome = await linkWhatsAppConversationToClient(conversationId, "WHATSAPP", `992${trashedTail}`);
    expect(outcome).toMatchObject({ linked: false, reason: "no_client" });

    const conv = await prisma.botConversation.findUnique({ where: { id: conversationId } });
    expect(conv?.clientId).toBeNull();
  });
});

describe("новая карточка из WhatsApp", () => {
  it("заводится с номером из wa_id — без диктовки словами", async () => {
    const freshTail = `${tail}44`;
    const identity = await resolveWhatsAppLeadIdentity("WHATSAPP", `992${freshTail}`);
    expect(identity).toMatchObject({ waPhone: `+992${freshTail}`, leadPhone: `+992${freshTail}`, existingClientId: null });

    const { clientId, created } = await createLeadFromChannel({
      fullName: `Новый из WhatsApp ${runId}`,
      phone: identity!.leadPhone,
      source: "WHATSAPP",
      whatsappPhone: identity!.waPhone,
    });
    clientIds.push(clientId);
    freshClientId = clientId;
    expect(created).toBe(true);

    const client = await prisma.client.findUnique({ where: { id: clientId } });
    expect(client?.phone).toBe(`+992${freshTail}`);
    expect(client?.whatsappPhone).toBe(`+992${freshTail}`);
  });

  it("уже записанный номер WhatsApp не перетирается новым", async () => {
    await rememberWhatsAppPhone(freshClientId, "+992000000000");
    const client = await prisma.client.findUnique({ where: { id: freshClientId } });
    expect(client?.whatsappPhone).not.toBe("+992000000000");
  });
});

/**
 * Видимость номера. Отдельного механизма не заводили: whatsappPhone идёт через ту же
 * маскировку, что и phone (presentClient), а «руководитель» определяется правом
 * clients.viewAll — оно есть у админа и директора и нет у агента.
 */
describe("номер целиком видит только руководство", () => {
  const visTail = `${tail}33`;
  let shortId: number;
  let visClientId: string;

  beforeAll(async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Клиент видимости ${runId}`,
        phone: `+992${visTail}`,
        whatsappPhone: `+992${visTail}`,
        source: "WHATSAPP",
        assignedAgentId: agentId,
      },
    });
    clientIds.push(client.id);
    visClientId = client.id;
    shortId = client.shortId;
  });

  it("агенту до принятия лида номер WhatsApp приходит замаскированным", async () => {
    const res = await request(app).get(`/api/v1/clients/${shortId}`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.pendingAcceptance).toBe(true);
    expect(res.body.whatsappPhone).toContain("•");
    expect(res.body.whatsappPhone).not.toBe(`+992${visTail}`);
    // Прежнее ограничение на обычный телефон осталось прежним — его не трогали.
    expect(res.body.phone).toContain("•");
  });

  it("админ видит номер WhatsApp целиком", async () => {
    const res = await request(app).get(`/api/v1/clients/${shortId}`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.whatsappPhone).toBe(`+992${visTail}`);
  });

  it("после принятия лида номер WhatsApp агенту по-прежнему закрыт — как и обычный телефон", async () => {
    const res = await request(app)
      .post(`/api/v1/clients/${visClientId}/accept`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    // Оба номера клиента живут по одному правилу (см. presentClient): агенту закрыты
    // всегда, руководителю открыты всегда. Если бы WhatsApp-номер открывался после
    // принятия, скрытие обычного телефона не значило бы ничего — увести переписку в
    // личный мессенджер можно было бы ровно так же.
    expect(res.body.whatsappPhone).not.toBe(`+992${visTail}`);
    expect(res.body.whatsappPhone).toContain("•");
  });
});

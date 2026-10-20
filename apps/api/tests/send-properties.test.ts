import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { findClientDeliveryTarget } from "../src/lib/conversationDelivery.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

// Real configured routing exists, but transport availability is intentionally
// off: these tests exercise preparation/fallback and never call the provider.
vi.mock("../src/messengers/meta.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  isMetaChannelEnabled: vi.fn(async () => false),
  sendMessage: vi.fn(async () => { throw new Error("Provider send forbidden in disabled-transport fixtures"); }),
}));

/** Отправка подобранных объектов клиенту в его канал (POST /clients/:id/send-properties).
 *  Транспорт в тестах выключен, поэтому проверяется всё до момента доставки: права,
 *  наличие переписки и наличие публичной ссылки у объекта. */

const runId = Date.now();
const password = "testpass123";

/**
 * ЖЁСТКО ЗАДАННЫЙ НОМЕР ЛОМАЛ ТЕСТ У ВСЕХ НАВСЕГДА (найдено 23.08.2026).
 *
 * Раньше здесь стоял просто `4242` — уникальная колонка Property.siteListingId,
 * общая на всех, кто гоняет тесты по одной dev-базе. Первый же прогон, оборвавшийся
 * между созданием записи и очисткой (упавший процесс, Ctrl+C, параллельная сессия),
 * оставлял её в базе навсегда — и КАЖДЫЙ следующий прогон падал на
 * `Unique constraint failed on the fields: (siteListingId)`, даже у другого
 * человека и даже недели спустя, потому что причина была не в коде, а в мусоре.
 * Тот же приём, что уже стоит в tests/website-webhook.test.ts (newListingId):
 * число выводится из runId, поэтому у разных прогонов оно разное, а старый мусор
 * никогда не совпадёт с новым запуском и не помешает ему.
 */
const siteListingId = 900_000_000 + (runId % 90_000_000);

let districtId: string;
let ownAgentId: string;
let otherAgentId: string;
let ownToken: string;
let otherToken: string;
let clientWithChatId: string;
let clientNoChatId: string;
let clientPendingId: string;
let conversationId: string;
let unpublishedId: string;
let publishedFromCrmId: string;
let publishedSiteBornId: string;
let offSiteId: string;
let soldId: string;
let clientTwoChatsId: string;
let liveInstagramId: string;
let emptyWhatsappId: string;
let foreignClientId: string;
let foreignConversationId: string;
let whatsapp: CustomerMessengerFixture;
let instagram: CustomerMessengerFixture;

async function send(token: string, clientId: string, propertyIds: string[]) {
  return request(app)
    .post(`/api/v1/clients/${clientId}/send-properties`)
    .set("Authorization", `Bearer ${token}`)
    .send({ propertyIds });
}

async function makeProperty(
  title: string,
  data: Partial<{ publishedOnSite: boolean; siteListingId: number; offSite: boolean; status: "SOLD" }>
) {
  const p = await prisma.property.create({
    data: {
      title,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      assignedAgentId: ownAgentId,
      ...data,
    },
  });
  return p.id;
}

beforeAll(async () => {
  whatsapp = await createCustomerMessengerFixture("WHATSAPP");
  instagram = await createCustomerMessengerFixture("INSTAGRAM");
  const passwordHash = await bcrypt.hash(password, 10);
  // Имя района уникально ПО ФАЙЛУ, не только по времени: файлы стартуют параллельно,
  // и два runId = Date.now() в одну миллисекунду роняли второй файл на unique(name).
  districtId = (await prisma.district.create({ data: { name: `Тест-район-отправка-${runId}` } })).id;

  const own = await prisma.agent.create({
    data: { fullName: "Агент свой", phone: `+992996${runId}`, role: "AGENT", passwordHash },
  });
  ownAgentId = own.id;
  const other = await prisma.agent.create({
    data: { fullName: "Агент чужой", phone: `+992997${runId}`, role: "AGENT", passwordHash },
  });
  otherAgentId = other.id;

  // acceptedAt: лид принят — до принятия карточка для агента закрыта, и отправка
  // (как и любая работа с клиентом) отвечает 403; на это есть отдельный тест ниже.
  const withChat = await prisma.client.create({
    data: { fullName: "Клиент с перепиской", phone: `+992998${runId}`, source: "WHATSAPP", assignedAgentId: ownAgentId, acceptedAt: new Date() },
  });
  clientWithChatId = withChat.id;
  conversationId = (
    await prisma.botConversation.update({
      where: { id: (await whatsapp.ensureConversation(`sub-${runId}`)).id },
      data: { clientId: withChat.id },
    })
  ).id;

  clientNoChatId = (
    await prisma.client.create({
      data: { fullName: "Клиент без переписки", phone: `+992999${runId}`, source: "PHONE_CALL", assignedAgentId: ownAgentId, acceptedAt: new Date() },
    })
  ).id;

  clientPendingId = (
    await prisma.client.create({
      data: { fullName: "Клиент непринятый", phone: `+992979${runId}`, source: "WHATSAPP", assignedAgentId: ownAgentId },
    })
  ).id;

  unpublishedId = await makeProperty(`Не на сайте ${runId}`, {});
  // Опубликован из CRM: id объявления на сайте неизвестен и не нужен — ссылка идёт
  // через редирект by-crm. Раньше на таком объекте отправка отказывала.
  publishedFromCrmId = await makeProperty(`На сайте из CRM ${runId}`, { publishedOnSite: true });
  // Объект, родившийся на сайте: by-crm его не найдёт, ссылка собирается по siteListingId.
  publishedSiteBornId = await makeProperty(`Родился на сайте ${runId}`, { publishedOnSite: true, siteListingId });
  // Несайтовый объект (docs/plan-18-08-private-listings-and-video.md §1) не публикуется
  // на сайте никогда, поэтому у него нет siteListingUrl вовсе — «Отправить клиенту»
  // обязана уйти персональной ссылкой /l/:token тем же путём, что у обычного объекта
  // (владелец 19.08.2026: «максимально просто, как и с обычным объектом»).
  offSiteId = await makeProperty(`Несайтовый ${runId}`, { offSite: true });

  soldId = await makeProperty(`Продан ${runId}`, { publishedOnSite: true, status: "SOLD" });

  // Клиент с двумя диалогами: живой Instagram (писал только что) и пустой
  // WhatsApp, заведённый «Написать первыми» — без lastMessageAt и без реплик клиента.
  clientTwoChatsId = (
    await prisma.client.create({
      data: { fullName: "Клиент два чата", phone: `+992977${runId}`, source: "INSTAGRAM", assignedAgentId: ownAgentId, acceptedAt: new Date() },
    })
  ).id;
  liveInstagramId = (
    await prisma.botConversation.update({
      where: { id: (await instagram.ensureConversation(`ig-${runId}`)).id },
      data: {
        clientId: clientTwoChatsId,
        lastMessageAt: new Date(),
        messages: [{ role: "user", content: "салом", at: new Date().toISOString() }],
      },
    })
  ).id;
  emptyWhatsappId = (
    await prisma.botConversation.update({
      where: { id: (await whatsapp.ensureConversation(`wa-${runId}`)).id },
      data: { clientId: clientTwoChatsId },
    })
  ).id;

  foreignClientId = (
    await prisma.client.create({
      data: { fullName: "Чужой клиент", phone: `+992976${runId}`, source: "WHATSAPP", assignedAgentId: otherAgentId, acceptedAt: new Date() },
    })
  ).id;
  foreignConversationId = (
    await prisma.botConversation.update({
      where: { id: (await whatsapp.ensureConversation(`wa-foreign-${runId}`)).id },
      data: { clientId: foreignClientId },
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
  const clientIds = [clientWithChatId, clientNoChatId, clientPendingId, clientTwoChatsId, foreignClientId];
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await whatsapp.dispose();
  await instagram.dispose();
  const propertyIds = [unpublishedId, publishedFromCrmId, publishedSiteBornId, offSiteId, soldId];
  await prisma.propertyShareLink.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [ownAgentId, otherAgentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Отправка объектов клиенту", () => {
  it("чужому клиенту отправить нельзя", async () => {
    const res = await send(otherToken, clientWithChatId, [publishedFromCrmId]);
    expect(res.status).toBe(403);
  });

  it("непринятому лиду агент отправить не может — карточка до принятия закрыта", async () => {
    const res = await send(ownToken, clientPendingId, [publishedFromCrmId]);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/примите лид/i);
  });

  it("клиенту без переписки — понятный отказ, а не молчание", async () => {
    const res = await send(ownToken, clientNoChatId, [publishedFromCrmId]);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/не писал в мессенджер/i);
  });

  /**
   * ПОВЕДЕНИЕ ИЗМЕНЕНО НАМЕРЕННО (28.09.2026, владелец: «агенты не могут
   * отправлять объекты»). Раньше здесь был отказ 409 «Не опубликованы на
   * сайте» — а свежий объект днями ждёт фото и ролик до сайта, и все эти дни
   * его нельзя было отправить клиенту. Теперь он уходит личной ссылкой, тем
   * же путём, что несайтовый (тест ниже).
   */
  it("ещё не выложенный на сайт объект уходит личной ссылкой, а не отказом", async () => {
    const res = await send(ownToken, clientWithChatId, [unpublishedId]);
    expect(res.status).toBe(503);
    const link = await prisma.propertyShareLink.findFirst({ where: { propertyId: unpublishedId, clientId: clientWithChatId } });
    expect(link).not.toBeNull();
    expect(res.body.fallback.links[0].url).toContain(`/l/${link!.token}`);
  });

  it("проданный объект не отправляется — ссылка обещала бы то, чего нет", async () => {
    const res = await send(ownToken, clientWithChatId, [soldId]);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Продан или снят/);
  });

  it("отказ канала отдаёт готовый текст и ссылки — агент не начинает заново", async () => {
    const res = await send(ownToken, clientWithChatId, [publishedFromCrmId]);
    expect(res.status).toBe(503);
    expect(res.body.fallback.text).toContain("На сайте из CRM");
    expect(res.body.fallback.links).toHaveLength(1);
  });

  it("клиенту без переписки отказ тоже несёт ссылки для СМС или копирования", async () => {
    const res = await send(ownToken, clientNoChatId, [publishedFromCrmId]);
    expect(res.status).toBe(409);
    expect(res.body.fallback.links).toHaveLength(1);
  });

  it("подготовка без отправки отдаёт текст и ссылки и ничего не пишет клиенту", async () => {
    const before = await prisma.interaction.count({ where: { clientId: clientTwoChatsId } });
    const res = await request(app)
      .post(`/api/v1/clients/${clientTwoChatsId}/send-properties`)
      .set("Authorization", `Bearer ${ownToken}`)
      .send({ propertyIds: [publishedFromCrmId], prepareOnly: true });
    expect(res.status).toBe(200);
    expect(res.body.prepared).toBe(true);
    expect(res.body.sent).toBe(0);
    expect(res.body.fallback.links).toHaveLength(1);
    const conv = await prisma.botConversation.findUnique({ where: { id: liveInstagramId }, select: { messages: true, pausedUntil: true } });
    expect((conv!.messages as unknown[]).length).toBe(1);
    expect(conv!.pausedUntil).toBeNull();
    expect(await prisma.interaction.count({ where: { clientId: clientTwoChatsId } })).toBe(before);
  });

  it("подготовка чужому агенту тоже закрыта", async () => {
    const res = await request(app)
      .post(`/api/v1/clients/${clientTwoChatsId}/send-properties`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ propertyIds: [publishedFromCrmId], prepareOnly: true });
    expect(res.status).toBe(403);
  });

  it("чужой диалог в conversationId не подменяет адресата — 404, а не отправка не туда", async () => {
    const res = await request(app)
      .post(`/api/v1/clients/${clientWithChatId}/send-properties`)
      .set("Authorization", `Bearer ${ownToken}`)
      .send({ propertyIds: [publishedFromCrmId], conversationId: foreignConversationId });
    expect(res.status).toBe(404);
  });

  it("пустой диалог «Написать первыми» не перехватывает отправку у живого чата", async () => {
    // Живой Instagram-диалог с отметкой и пустой WhatsApp без lastMessageAt:
    // у Postgres DESC ставит NULL первым, и раньше побеждал пустой.
    const target = await findClientDeliveryTarget(clientTwoChatsId);
    expect(target?.kind).toBe("bot");
    expect(target && target.kind === "bot" ? target.channel : null).toBe("INSTAGRAM");
  });

  it("«куда уйдёт» видно до нажатия: закрытое окно Meta называется словами", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientTwoChatsId}/send-target`)
      .set("Authorization", `Bearer ${ownToken}`);
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe("INSTAGRAM");
    expect(res.body.windowOpen).toBe(true);

    const wa = await request(app)
      .get(`/api/v1/clients/${clientTwoChatsId}/send-target?conversationId=${emptyWhatsappId}`)
      .set("Authorization", `Bearer ${ownToken}`);
    expect(wa.status).toBe(200);
    expect(wa.body.channel).toBe("WHATSAPP");
    expect(wa.body.windowOpen).toBe(false);
  });

  it("«куда уйдёт» чужому агенту не отвечает", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientTwoChatsId}/send-target`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
  });

  it("объект, опубликованный из CRM, доходит до отправки — id объявления знать не нужно", async () => {
    const res = await send(ownToken, clientWithChatId, [publishedFromCrmId]);
    expect(res.status).toBe(503);
  });

  it("объект, родившийся на сайте, тоже доходит до отправки", async () => {
    const res = await send(ownToken, clientWithChatId, [publishedSiteBornId]);
    expect(res.status).toBe(503);
  });

  it("несайтовый объект тоже доходит до отправки — персональной ссылкой вместо сайта", async () => {
    const before = await prisma.propertyShareLink.count({ where: { propertyId: offSiteId, clientId: clientWithChatId } });
    expect(before).toBe(0);
    const res = await send(ownToken, clientWithChatId, [offSiteId]);
    expect(res.status).toBe(503);
    const link = await prisma.propertyShareLink.findFirst({ where: { propertyId: offSiteId, clientId: clientWithChatId } });
    expect(link).not.toBeNull();
  });

  it("повторная отправка того же несайтового объекта тому же клиенту переиспользует ссылку", async () => {
    await send(ownToken, clientWithChatId, [offSiteId]);
    const links = await prisma.propertyShareLink.findMany({ where: { propertyId: offSiteId, clientId: clientWithChatId } });
    expect(links.length).toBe(1);
  });

  it("больше пяти объектов за раз не принимается", async () => {
    const res = await send(ownToken, clientWithChatId, Array(6).fill(publishedFromCrmId));
    expect(res.status).toBe(400);
  });
});

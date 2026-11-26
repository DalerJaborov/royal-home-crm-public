import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import * as conversationDelivery from "../src/lib/conversationDelivery.js";
import * as outgoingMediaJobs from "../src/lib/outgoingMediaJobs.js";
import * as push from "../src/push.js";
import { uploadsDir } from "../src/upload.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * Объекты из переписки без карточки клиента (POST /conversations/:id/send-properties,
 * lib/conversationPropertySend.ts, 26.11.2026). Канал и очередь фото — заглушки:
 * клиенту и в Meta ничего не уходит, проверяется всё вокруг доставки.
 */

vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  isMetaChannelEnabled: vi.fn(async () => true),
  sendMessage: vi.fn(async () => { throw new Error("Provider send forbidden in this test"); }),
}));

const runId = Date.now();
const password = "testpass123";
const OWNER_CONTACT = "+992900777123 Рустам";
const SECRET_ADDRESS = "Секретная улица 77";
const SECRET_TITLE = `Секретное название ${runId} +992900555111`;

let districtId: string;
let adminId: string;
let adminToken: string;
let agentAId: string;
let agentAToken: string;
let agentBId: string;
let agentBToken: string;
let ownProperty: string;
let foreignProperty: string;
let soldProperty: string;
let withdrawnProperty: string;
let photoPropertyId: string;
let photoFile: string;
let cardClientId: string;
let whatsapp: CustomerMessengerFixture;
let noCardConvId: string;
let noCardSubscriber: string;
let cardConvId: string;
let cardSubscriber: string;
const propertyIds: string[] = [];
const createdClientIds: string[] = [];

async function makeProperty(extra: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: SECRET_TITLE,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 64,
      floor: 4,
      totalFloors: 9,
      price: 650000,
      currency: "TJS",
      districtId,
      address: SECRET_ADDRESS,
      ownerContact: OWNER_CONTACT,
      condition: "GOOD",
      assignedAgentId: agentAId,
      intakeAgentId: agentAId,
      ...extra,
    },
  });
  propertyIds.push(p.id);
  return p.id;
}

async function setSwitch(on: boolean) {
  await prisma.settings.upsert({ where: { id: "singleton" }, update: { sendPropertiesWithoutCardEnabled: on }, create: { id: "singleton", sendPropertiesWithoutCardEnabled: on } });
}

function post(token: string, convId: string, body: Record<string, unknown>, key?: string) {
  const r = request(app).post(`/api/v1/conversations/${convId}/send-properties`).set("Authorization", `Bearer ${token}`);
  if (key) r.set("Idempotency-Key", key);
  return r.send(body);
}

let deliver: ReturnType<typeof vi.spyOn>;
let enqueue: ReturnType<typeof vi.spyOn>;
let pushSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  whatsapp = await createCustomerMessengerFixture("WHATSAPP");
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-из-чата-${runId}` } })).id;
  const mk = async (fullName: string, phone: string, role: "ADMIN" | "AGENT") =>
    prisma.agent.create({ data: { fullName, phone, role, passwordHash } });
  const admin = await mk("Админ из чата", `+992960${runId}`, "ADMIN");
  const agentA = await mk("Агент А из чата", `+992961${runId}`, "AGENT");
  const agentB = await mk("Агент Б из чата", `+992962${runId}`, "AGENT");
  adminId = admin.id; agentAId = agentA.id; agentBId = agentB.id;
  for (const [a, set] of [[admin, (t: string) => (adminToken = t)], [agentA, (t: string) => (agentAToken = t)], [agentB, (t: string) => (agentBToken = t)]] as const) {
    const res = await request(app).post("/api/v1/auth/login").send({ phone: a.phone, password });
    expect(res.status).toBe(200);
    set(res.body.accessToken);
  }

  ownProperty = await makeProperty({ assignedAgentId: adminId, intakeAgentId: adminId });
  foreignProperty = await makeProperty();
  soldProperty = await makeProperty({ status: "SOLD" });
  withdrawnProperty = await makeProperty({ status: "WITHDRAWN" });
  photoPropertyId = await makeProperty({ assignedAgentId: adminId, intakeAgentId: adminId });
  photoFile = `test-send-${runId}.webp`;
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, photoFile), Buffer.from("RIFF0000WEBPVP8 "));
  await prisma.propertyPhoto.create({ data: { propertyId: photoPropertyId, url: `/uploads/${photoFile}`, thumbUrl: `/uploads/${photoFile}`, order: 0 } });

  noCardSubscriber = `nocard-${runId}`;
  const noCard = await whatsapp.ensureConversation(noCardSubscriber);
  noCardConvId = noCard.id;
  await prisma.botConversation.update({
    where: { id: noCardConvId },
    data: {
      lastMessageAt: new Date(),
      messages: [{ role: "user", content: "салом, хона даркор", at: new Date().toISOString() }],
      leadDraft: { stage: "chatting", rooms: 2, districtName: "Шохмансур", budgetMax: 700000 },
    },
  });

  const card = await prisma.client.create({
    data: { fullName: "Клиент с карточкой из чата", phone: `+992963${runId}`, source: "WHATSAPP", assignedAgentId: agentAId, acceptedAt: new Date() },
  });
  cardClientId = card.id;
  createdClientIds.push(card.id);
  cardSubscriber = `card-${runId}`;
  cardConvId = (await whatsapp.ensureConversation(cardSubscriber)).id;
  await prisma.botConversation.update({
    where: { id: cardConvId },
    data: { clientId: card.id, lastMessageAt: new Date(), messages: [{ role: "user", content: "привет", at: new Date().toISOString() }] },
  });
  await setSwitch(true);
});

afterEach(() => {
  deliver?.mockRestore();
  enqueue?.mockRestore();
  pushSpy?.mockRestore();
});

afterAll(async () => {
  await setSwitch(true);
  await prisma.propertyExposure.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: createdClientIds } } });
  await prisma.propertyShareLink.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.idempotencyKey.deleteMany({ where: { agentId: { in: [adminId, agentAId, agentBId] } } }).catch(() => {});
  await prisma.botConversation.updateMany({ where: { id: cardConvId }, data: { clientId: null } });
  await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: photoPropertyId } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, agentAId, agentBId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  fs.rmSync(path.join(uploadsDir, photoFile), { force: true });
  await whatsapp.cleanupConversations();
  await whatsapp.dispose();
  await prisma.$disconnect();
});

function stubDelivery() {
  deliver = vi.spyOn(conversationDelivery, "deliverToConversation").mockResolvedValue({ ok: true, masked: false, pausedUntil: new Date(Date.now() + 3600_000) });
  enqueue = vi.spyOn(outgoingMediaJobs, "enqueueOutgoingMedia").mockResolvedValue({ status: 202, body: { ok: true, queued: true, jobId: randomUUID(), status: "QUEUED" } });
  pushSpy = vi.spyOn(push, "sendPushToAgent").mockResolvedValue(1 as never);
}

describe("объект в переписку без карточки клиента", () => {
  it("уходит собеседнику без карточки: клиент не создаётся, показ привязан к паре канал+собеседник", async () => {
    stubDelivery();
    const clientsBefore = await prisma.client.count();
    const res = await post(adminToken, noCardConvId, { propertyIds: [ownProperty] });
    expect(res.status).toBe(200);
    expect(res.body.hasCard).toBe(false);
    expect(deliver).toHaveBeenCalledTimes(1);
    const text = deliver.mock.calls[0][1] as string;
    expect(text).toMatch(/№\d+/);
    expect(text).toContain("/l/");
    expect(text).toContain("650");
    expect(await prisma.client.count()).toBe(clientsBefore);
    const exposure = await prisma.propertyExposure.findFirst({ where: { propertyId: ownProperty, recipientId: noCardSubscriber } });
    expect(exposure).not.toBeNull();
    expect(exposure!.clientId).toBeNull();
    expect(exposure!.channel).toBe("WHATSAPP");
    const conv = await prisma.botConversation.findUniqueOrThrow({ where: { id: noCardConvId }, select: { clientId: true } });
    expect(conv.clientId).toBeNull();
  });

  it("с карточкой: показ и хронология пишутся на клиента", async () => {
    stubDelivery();
    const res = await post(agentAToken, cardConvId, { propertyIds: [foreignProperty] });
    expect(res.status).toBe(200);
    expect(res.body.hasCard).toBe(true);
    const exposure = await prisma.propertyExposure.findFirst({ where: { propertyId: foreignProperty, recipientId: cardSubscriber } });
    expect(exposure?.clientId).toBe(cardClientId);
    expect(await prisma.interaction.count({ where: { clientId: cardClientId, propertyId: foreignProperty } })).toBe(1);
  });

  it("контакты, адрес и название собственника не попадают ни в текст, ни в ответ", async () => {
    stubDelivery();
    const res = await post(adminToken, noCardConvId, { propertyIds: [foreignProperty], caption: "Добрый день" });
    expect(res.status).toBe(200);
    const text = deliver.mock.calls[0][1] as string;
    expect(text).toContain("Добрый день");
    for (const secret of ["900777123", "Рустам", "Секретная", "900555111", SECRET_ADDRESS]) {
      expect(text).not.toContain(secret);
      expect(JSON.stringify(res.body)).not.toContain(secret);
    }
    const prepared = await post(adminToken, noCardConvId, { propertyIds: [foreignProperty], prepareOnly: true });
    expect(prepared.status).toBe(200);
    expect(JSON.stringify(prepared.body)).not.toContain("900777123");
    expect(JSON.stringify(prepared.body)).not.toContain("Секретная");
  });

  it("закрытое окно 24 ч: честная причина, ничего не записано", async () => {
    deliver = vi.spyOn(conversationDelivery, "deliverToConversation").mockResolvedValue({ ok: false, status: 409, code: "window_closed", error: "Окно закрыто" });
    const before = await prisma.propertyExposure.count({ where: { propertyId: ownProperty, recipientId: noCardSubscriber } });
    const res = await post(adminToken, noCardConvId, { propertyIds: [ownProperty] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("window_closed");
    expect(res.body.fallback.links).toHaveLength(1);
    expect(await prisma.propertyExposure.count({ where: { propertyId: ownProperty, recipientId: noCardSubscriber } })).toBe(before);
  });

  it("проданный и снятый объект не отправляются, доставка не вызывается", async () => {
    stubDelivery();
    for (const id of [soldProperty, withdrawnProperty]) {
      const res = await post(adminToken, noCardConvId, { propertyIds: [id] });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/Продан или снят/);
    }
    expect(deliver).not.toHaveBeenCalled();
  });

  it("чужой объект: хозяину уходит пуш, свой объект пуша не даёт", async () => {
    stubDelivery();
    await post(adminToken, noCardConvId, { propertyIds: [ownProperty] });
    expect(pushSpy).not.toHaveBeenCalled();
    await post(adminToken, noCardConvId, { propertyIds: [foreignProperty] });
    await vi.waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    expect(pushSpy.mock.calls[0][0]).toBe(agentAId);
    expect(JSON.stringify(pushSpy.mock.calls[0][1])).not.toContain("900777123");
  });

  it("повтор с тем же Idempotency-Key не шлёт второй раз", async () => {
    stubDelivery();
    const key = `conv-send-${runId}-a`;
    const first = await post(adminToken, noCardConvId, { propertyIds: [ownProperty] }, key);
    const second = await post(adminToken, noCardConvId, { propertyIds: [ownProperty] }, key);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("фото уходят в очередь после карточки, а у объекта без фото клиент всё равно получает текст", async () => {
    stubDelivery();
    const withPhoto = await post(adminToken, noCardConvId, { propertyIds: [photoPropertyId] });
    expect(withPhoto.status).toBe(200);
    expect(withPhoto.body.photos.queued).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const noPhoto = await post(adminToken, noCardConvId, { propertyIds: [ownProperty] });
    expect(noPhoto.status).toBe(200);
    expect(noPhoto.body.photos.queued).toBe(0);
    expect(noPhoto.body.photos.note).toMatch(/нет фото/i);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("шторка: без карточки видно куда уйдёт, что уже отправляли и что бот собрал о запросе", async () => {
    stubDelivery();
    await post(adminToken, noCardConvId, { propertyIds: [ownProperty] });
    const res = await request(app).get(`/api/v1/conversations/${noCardConvId}/send-context`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.hasCard).toBe(false);
    expect(res.body.allowed).toBe(true);
    expect(res.body.channel).toBe("WHATSAPP");
    expect(res.body.sentPropertyIds).toContain(ownProperty);
    expect(res.body.draft).toMatchObject({ rooms: 2, districtName: "Шохмансур", budgetMax: 700000 });
  });

  it("чужая переписка агенту недоступна, пустая переписка без карточки — ему же", async () => {
    stubDelivery();
    const foreign = await post(agentBToken, cardConvId, { propertyIds: [ownProperty] });
    expect(foreign.status).toBe(404);
    const noCard = await post(agentAToken, noCardConvId, { propertyIds: [ownProperty] });
    expect(noCard.status).toBe(404);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("рубильник выключен: прежний отказ «сначала примите заявку» для диалога без карточки, с карточкой работает", async () => {
    stubDelivery();
    await setSwitch(false);
    try {
      const refused = await post(adminToken, noCardConvId, { propertyIds: [ownProperty] });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatch(/примите заявку/i);
      const ctx = await request(app).get(`/api/v1/conversations/${noCardConvId}/send-context`).set("Authorization", `Bearer ${adminToken}`);
      expect(ctx.body.allowed).toBe(false);
      expect(deliver).not.toHaveBeenCalled();
      const withCard = await post(agentAToken, cardConvId, { propertyIds: [ownProperty] });
      expect(withCard.status).toBe(200);
    } finally {
      await setSwitch(true);
    }
  });

  it("неверные данные: пустой список и больше десяти объектов", async () => {
    stubDelivery();
    expect((await post(adminToken, noCardConvId, { propertyIds: [] })).status).toBe(400);
    expect((await post(adminToken, noCardConvId, { propertyIds: Array.from({ length: 11 }, () => randomUUID()) })).status).toBe(400);
    expect((await post(adminToken, noCardConvId, { propertyIds: [randomUUID()] })).status).toBe(404);
  });
});

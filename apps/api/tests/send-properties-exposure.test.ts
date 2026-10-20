import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * Ручная отправка объекта (POST /clients/:id/send-properties) должна защищать
 * правило «own_property_shown» (services/leads/assignment.ts) точно так же, как
 * показ ботом — до этой правки маршрут писал только обычную хронологию
 * (Interaction), PropertyExposure не создавался, и агент, вручную отправивший
 * клиенту СВОЙ объект, не получал вне-очередного лида, на который был вправе
 * рассчитывать (см. tests/lead-own-property-priority.test.ts и
 * tests/property-exposure.test.ts — образцы для журнала показов).
 *
 * Meta мокаем целиком (как в message-sender.test.ts): без этого deliverToConversation
 * отвечает 503 (канал недоступен) ещё до того, как код доходит до записи в журнал.
 */

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn(async () => "synthetic-manual-property-mid") }));
vi.mock("../src/messengers/meta.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isMetaChannelEnabled: vi.fn(async () => true),
    sendMessage,
    showReadAndTyping: vi.fn(async () => undefined),
  };
});

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { assignAgentForLead } = await import("../src/leads.js");

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let ownAgentId: string;
let ownToken: string;
let outsiders: string[] = [];
let clientId: string;
let clientShortId: number;
let conversationId: string;
let propertyId: string;
let propertyShortId: number;
let savedSettings: Record<string, unknown> = {};
let whatsapp: CustomerMessengerFixture;
const TOUCHED_SETTINGS = ["ownPropertyPriorityEnabled", "ownPropertyShownExceptionEnabled", "leadDistributionStrategy"] as const;

async function send(propertyIds: string[]) {
  return request(app)
    .post(`/api/v1/clients/${clientId}/send-properties`)
    .set("Authorization", `Bearer ${ownToken}`)
    .send({ propertyIds });
}

beforeAll(async () => {
  whatsapp = await createCustomerMessengerFixture("WHATSAPP");
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-журнал-ручной-${runId}` } })).id;

  const own = await prisma.agent.create({
    data: { fullName: "Агент-хозяин объекта", phone: `+992971${runId}`, role: "AGENT", passwordHash },
  });
  ownAgentId = own.id;

  outsiders = (
    await prisma.agent.findMany({ where: { role: "AGENT", id: { not: ownAgentId } }, select: { id: true } })
  ).map((a) => a.id);

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент ручной отправки ${runId}`,
      phone: `+992972${runId}`,
      source: "WHATSAPP",
      assignedAgentId: ownAgentId,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
  clientShortId = client.shortId;
  conversationId = (
    await prisma.botConversation.update({
      where: { id: (await whatsapp.ensureConversation(`sub-manual-${runId}`)).id },
      data: { clientId: client.id },
    })
  ).id;

  const property = await prisma.property.create({
    data: {
      title: `Объект ручной отправки ${runId}`,
      type: "APARTMENT",
      areaSqm: 55,
      rooms: 2,
      price: 250_000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 5",
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
      // Хозяин объекта — тот же агент, что отправляет его вручную: только тогда
      // правило own_property_shown вообще может кого-то выбрать вне очереди.
      intakeAgentId: ownAgentId,
    },
  });
  propertyId = property.id;
  propertyShortId = property.shortId;
  // Фото объекта — проверить ниже, что мини-карточка в хронологии клиента несёт
  // thumbUrl, а не только id/shortId/title (17.09.2026, план раздел 6).
  await prisma.propertyPhoto.create({
    data: { propertyId, url: "https://example.com/o.jpg", thumbUrl: "https://example.com/t.jpg", order: 0 },
  });

  const res = await request(app).post("/api/v1/auth/login").send({ phone: own.phone, password });
  expect(res.status).toBe(200);
  ownToken = res.body.accessToken;

  // Правило проверяется явно включённым — тот же приём, что в
  // lead-own-property-priority.test.ts: значения по умолчанию тоже "true", но
  // соседний тест мог оставить настройки в другом состоянии между прогонами.
  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSettings = Object.fromEntries(TOUCHED_SETTINGS.map((k) => [k, (current as Record<string, unknown>)[k]]));
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { ownPropertyPriorityEnabled: true, ownPropertyShownExceptionEnabled: true, leadDistributionStrategy: "fair" },
  });
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.propertyExposure.deleteMany({ where: { clientId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await whatsapp.dispose();
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: ownAgentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Ручная отправка объекта пишет в журнал показов (PropertyExposure)", () => {
  it("успешная отправка создаёт запись PropertyExposure тем же путём, что и бот", async () => {
    const res = await send([propertyId]);
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(1);
    expect(sendMessage).toHaveBeenCalled();

    const exposures = await prisma.propertyExposure.findMany({ where: { clientId } });
    expect(exposures).toHaveLength(1);
    expect(exposures[0].propertyId).toBe(propertyId);
    expect(exposures[0].shortId).toBe(propertyShortId);
    expect(exposures[0].kind).toBe("LINK");
    expect(exposures[0].channel).toBe("WHATSAPP");
    expect(exposures[0].recipientId).toBe(`sub-manual-${runId}`);

    // И обычная хронология по-прежнему пишется — эта правка её не заменяет, а дополняет.
    const interaction = await prisma.interaction.findFirst({
      where: { clientId, type: "SYSTEM", propertyId },
    });
    expect(interaction).not.toBeNull();
    expect(interaction?.notes).toMatch(/отправлена клиенту/);

    /**
     * Мини-карточка объекта в хронологии (17.09.2026, план раздел 6): карточка
     * клиента отдаёт эту же запись через interactionPropertySelect — цена и
     * превью фото, а не голый id/shortId/title.
     */
    const card = await request(app).get(`/api/v1/clients/${clientShortId}`).set("Authorization", `Bearer ${ownToken}`);
    expect(card.status).toBe(200);
    const cardInteraction = card.body.interactions.find(
      (i: { propertyId: string | null }) => i.propertyId === propertyId
    );
    expect(cardInteraction).toBeDefined();
    expect(Number(cardInteraction.property.price)).toBe(250_000);
    expect(cardInteraction.property.currency).toBe("TJS");
    expect(cardInteraction.property.photos).toHaveLength(1);
    expect(cardInteraction.property.photos[0].thumbUrl).toBe("https://example.com/t.jpg");
  });

  it("после ручной отправки клиент уходит хозяину объекта вне очереди — own_property_shown", async () => {
    const assignment = await assignAgentForLead({ clientId }, outsiders);
    expect(assignment.agentId).toBe(ownAgentId);
    expect(assignment.reason).toBe("own_property_shown");
    expect(assignment.propertyShortId).toBe(propertyShortId);
  });
});

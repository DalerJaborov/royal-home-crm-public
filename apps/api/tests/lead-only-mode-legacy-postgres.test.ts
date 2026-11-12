import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ» — СТАРЫЙ ПУТЬ БОТА (messengers/conversation.ts).
 * Владелец 12–13.11.2026: бот берёт заявку и передаёт агенту, без подборок, фото и
 * ссылок; WhatsApp-номер и есть номер для звонка; горячие слова — агенту сразу.
 * Модель подменена: тест про решения кода, и в этих сценариях модель не должна
 * зваться вовсе.
 */
const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { prisma } = await import("../src/db.js");
const { processMessengerTurn } = await import("../src/messengers/conversation.js");
const { leadOnlyMarketSummary } = await import("../src/lib/leadOnlySettings.js");

const runId = Date.now().toString(36);
// Номера WhatsApp — цифрами (wa_id), у каждого сценария свой, чтобы заявки не склеились по телефону.
const digits = () => `9929${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
let whatsapp: CustomerMessengerFixture, instagram: CustomerMessengerFixture;
let ownerId: string, propertyId: string, propertyShortId: number, cheapId: string, districtId: string, districtName: string;
const peers: string[] = [];
type SettingsSnapshot = {
  botReplyDelaySec: number; botReplyMaxWaitSec: number; workHoursStart: string; workHoursEnd: string;
  botLeadOnlyMode: boolean; botUseWhatsappNumber: boolean; botMaxPhoneAsks: number; botHotIntentHandover: boolean;
};
let before: SettingsSnapshot | null = null;

beforeAll(async () => {
  whatsapp = await createCustomerMessengerFixture("WHATSAPP");
  instagram = await createCustomerMessengerFixture("INSTAGRAM");
  before = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" }, select: {
    botReplyDelaySec: true, botReplyMaxWaitSec: true, workHoursStart: true, workHoursEnd: true,
    botLeadOnlyMode: true, botUseWhatsappNumber: true, botMaxPhoneAsks: true, botHotIntentHandover: true,
  } });
  districtName = `Лидтест${runId}`;
  districtId = (await prisma.district.create({ data: { name: districtName } })).id;
  ownerId = (await prisma.agent.create({ data: { fullName: `Хозяин ${runId}`, phone: `+992907${runId}`, role: "AGENT", passwordHash: "x" } })).id;
  const property = await prisma.property.create({ data: { title: `Объект ${runId}`, type: "APARTMENT", areaSqm: 60, rooms: 2,
    price: 450_000, currency: "TJS", districtId, address: "Тестовая, 1", condition: "GOOD", status: "AVAILABLE", assignedAgentId: ownerId, publishedOnSite: true } });
  propertyId = property.id; propertyShortId = property.shortId;
  cheapId = (await prisma.property.create({ data: { title: `Дешёвый ${runId}`, type: "APARTMENT", areaSqm: 50, rooms: 2,
    price: 300_000, currency: "TJS", districtId, address: "Тестовая, 2", condition: "GOOD", status: "AVAILABLE", assignedAgentId: ownerId, publishedOnSite: true } })).id;
});

beforeEach(async () => {
  callAi.mockReset();
  callAi.mockResolvedValue({ reply: ["Здравствуйте! Чем помочь?"], intent: "other", confident: false, ready: false, topic: "other",
    openQuestion: "", clientAnsweredOpenQuestion: false });
  // Круглые сутки — "00:00"–"24:00" (см. property-mention-routes-to-agent.test.ts).
  await prisma.settings.update({ where: { id: "singleton" }, data: { botReplyDelaySec: 1, botReplyMaxWaitSec: 3,
    workHoursStart: "00:00", workHoursEnd: "24:00", botLeadOnlyMode: true, botUseWhatsappNumber: true, botMaxPhoneAsks: 2,
    botHotIntentHandover: true } });
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  if (before) await prisma.settings.update({ where: { id: "singleton" }, data: before });
  const convs = await prisma.botConversation.findMany({ where: { subscriberId: { in: peers } }, select: { clientId: true } });
  const clientIds = convs.flatMap((c) => (c.clientId ? [c.clientId] : []));
  await whatsapp.dispose();
  await instagram.dispose();
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, cheapId] } } });
  await prisma.agent.deleteMany({ where: { id: ownerId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

async function turn(fixture: CustomerMessengerFixture, peer: string, text: string, extra: Record<string, unknown> = {}) {
  if (!peers.includes(peer)) peers.push(peer);
  return processMessengerTurn({ ...fixture.turnInput(peer), text, ...extra });
}
/** Ходы модели-ответчика. Фоновые разбор и оценка карточки после заявки (card-fill, score-client) — не ответ клиенту. */
function replyModelCalls(): string[] {
  return callAi.mock.calls.map((call) => String((call[0] as { endpoint?: string })?.endpoint ?? "?")).filter((e) => !["card-fill", "score-client"].includes(e));
}
async function clientOf(peer: string) {
  const conv = await prisma.botConversation.findFirst({ where: { subscriberId: peer }, select: { clientId: true } });
  return conv?.clientId ? prisma.client.findUniqueOrThrow({ where: { id: conv.clientId } }) : null;
}

describe("режим «только заявки», старый путь", () => {
  it("WhatsApp, продавец: номер не спрашиваем, заявка на номер отправителя, без модели", async () => {
    const peer = digits();
    const result = await turn(whatsapp, peer, "Здравствуйте, хочу продать свою квартиру");
    expect(result.reply).toContain("на этот номер");
    expect(result.reply).not.toMatch(/номер телефона|оставьте/i);
    expect(replyModelCalls()).toEqual([]);
    const client = await clientOf(peer);
    expect(client).not.toBeNull();
    expect(client!.phone.replace(/\D/g, "")).toBe(peer);
    expect(client!.kind).toBe("SELLER");
  });

  it("WhatsApp, понравился объект: заявка с объектом уходит его агенту", async () => {
    const peer = digits();
    const result = await turn(whatsapp, peer, "Интересует эта квартира", { sharedPropertyId: propertyId });
    expect(result.reply).toContain(`№${propertyShortId}`);
    expect(result.reply).toContain("450 000");
    const client = await clientOf(peer);
    expect(client?.assignedAgentId).toBe(ownerId);
    expect(client?.assignReason).toBe("own_property_explicit");
  });

  it("WhatsApp, горячие слова по-таджикски: заявка сразу", async () => {
    const peer = digits();
    const result = await turn(whatsapp, peer, "Салом, дидан мехоҳем, куҷо биёем?");
    expect(result.reply).toContain("Хуб, ба агент мерасонам.");
    expect(replyModelCalls()).toEqual([]);
    expect(await clientOf(peer)).not.toBeNull();
  });

  it("Instagram, «нужна квартира»: без подборки и ссылок, номер просим не больше двух раз, потом номер офиса", async () => {
    const peer = `lead-only-ig-${runId}`;
    const first = await turn(instagram, peer, "Нужна двухкомнатная квартира");
    expect(first.reply).toContain("Оставьте, пожалуйста, номер телефона");
    expect(first.reply).not.toMatch(/https?:|№/);
    expect(replyModelCalls()).toEqual([]);
    const second = await turn(instagram, peer, "Хочу купить квартиру");
    expect(second.reply).toContain("Если удобно, напишите номер");
    const third = await turn(instagram, peer, "Ищу квартиру");
    expect(third.reply).toContain("777 070 100");
    const fourth = await turn(instagram, peer, "Ищу квартиру");
    expect(fourth.reply).not.toMatch(/777 070 100|номер/i);
    expect(await clientOf(peer)).toBeNull();
  });

  it("Instagram: номер в сообщении — заявка и короткое «номер получил», без модели", async () => {
    const peer = `lead-only-ig-phone-${runId}`;
    const result = await turn(instagram, peer, "Хочу продать дом, мой номер 918 22 33 44");
    expect(result.reply).toBe("Спасибо, номер получил. Агент скоро позвонит.");
    expect(replyModelCalls()).toEqual([]);
    expect(await clientOf(peer)).not.toBeNull();
  });

  it("Instagram: номер в ответ на просьбу — заявка покупателя агенту, а не «прочее обращение»", async () => {
    const peer = `lead-only-ig-follow-${runId}`;
    expect((await turn(instagram, peer, "Хочу купить двухкомнатную квартиру")).reply).toContain("Оставьте, пожалуйста, номер");
    const result = await turn(instagram, peer, "918 33 44 56");
    expect(result.reply).toBe("Спасибо, номер получил. Агент скоро позвонит.");
    const client = await clientOf(peer);
    expect(client?.kind).toBe("BUYER");
  });

  it("вне рабочих часов: честное время звонка, а не «сейчас»", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "23:58", workHoursEnd: "23:59" } });
    const peer = digits();
    const result = await turn(whatsapp, peer, "Хочу продать квартиру");
    expect(result.reply).toMatch(/с 23:58/);
  });

  it("цена «от» для сценария 3 берётся из базы: самый дешёвый доступный объект района", async () => {
    expect(await leadOnlyMarketSummary({ districtName })).toEqual({ districtName, minPrice: "300000", currency: "TJS" });
    expect(await leadOnlyMarketSummary({ districtName: `Нетакого${runId}` })).toBeNull();
  });

  it("режим выключен — прежнее поведение: номер WhatsApp не становится заявкой, отвечает модель", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botLeadOnlyMode: false } });
    const peer = digits();
    await turn(whatsapp, peer, "Здравствуйте, хочу продать свою квартиру");
    expect(callAi).toHaveBeenCalled();
    expect(await clientOf(peer)).toBeNull();
  });
});

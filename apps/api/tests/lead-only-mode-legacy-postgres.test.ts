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
/** Ходы модели-ответчика. Фоновые разбор и оценка карточки после заявки (card-fill, score-client) — не ответ клиенту.
 *  Сюда же определение актуальных ролей (client-current-intents): это ПЕРВЫЙ вызов того же фонового автопилота
 *  карточки (lib/clientAutopilot.ts, «lead_created», без ожидания) — на быстрой машине он успевал до проверки и
 *  ронял тест через раз (13.11.2026: облачный ship #163 и чистый main 6851f10a локально, 1 из 3). */
function replyModelCalls(): string[] {
  return callAi.mock.calls.map((call) => String((call[0] as { endpoint?: string })?.endpoint ?? "?"))
    .filter((e) => !["card-fill", "score-client", "client-current-intents"].includes(e));
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
    await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "23:58", workHoursEnd: "23:58" } });
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
  // ── Ревью 13.11.2026: каждый тест падает на коде до правки ──
  it("ревью №2: объект рекламы не «залипает» — «где офис?» вторым ходом не получает «Это объект №N»", async () => {
    const peer = `lead-only-ig-sticky-${runId}`;
    const first = await turn(instagram, peer, "Здравствуйте", { adPropertyId: propertyId, adExternalId: `ad-${runId}` });
    expect(first.reply).toContain(`№${propertyShortId}`);
    const second = await turn(instagram, peer, "Где ваш офис?");
    expect(second.reply).not.toContain(`№${propertyShortId}`);
  });

  it("ревью №3: Instagram без номера, горячие слова — человек правда позван", async () => {
    const peer = `lead-only-ig-hot-${runId}`;
    const result = await turn(instagram, peer, "Хотим посмотреть, куда ехать?");
    expect(result.reply).toContain("передаю агенту");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const conv = await prisma.botConversation.findFirstOrThrow({ where: { subscriberId: peer }, select: { id: true } });
    expect(await prisma.notification.count({ where: { tag: `lead-only-handover-${conv.id}` } })).toBeGreaterThan(0);
  });

  it("ревью №3: вырезанная подборка — короткое «передаю агенту», и человек позван", async () => {
    callAi.mockResolvedValue({ reply: ["Вот ссылка на варианты: https://royalhome.tj/listing/12"], intent: "other", confident: false, ready: false,
      topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const peer = `lead-only-ig-filter-${runId}`;
    const result = await turn(instagram, peer, "Где ваш офис?");
    expect(result.reply).toBe("Передаю ваш вопрос агенту, он ответит вам здесь.");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const conv = await prisma.botConversation.findFirstOrThrow({ where: { subscriberId: peer }, select: { id: true } });
    expect(await prisma.notification.count({ where: { tag: `lead-only-handover-${conv.id}` } })).toBeGreaterThan(0);
  });

  it("ревью №5: «другой город» с номером — без обещания звонка", async () => {
    const peer = `lead-only-ig-city-${runId}`;
    const direct = await turn(instagram, peer, "Хочу купить дом в Худжанде, мой номер 918 44 55 66");
    expect(direct.reply).not.toMatch(/позвонит/);
    const peer2 = `lead-only-ig-city2-${runId}`;
    await turn(instagram, peer2, "Ищу квартиру в Худжанде");
    const byPhone = await turn(instagram, peer2, "918 55 66 78");
    expect(byPhone.reply).not.toMatch(/позвонит/);
  });

  it("ревью №6: карточка уже есть, горячие слова без номера — без «номер получил», агенту метка", async () => {
    const peer = `lead-only-ig-card-${runId}`;
    await turn(instagram, peer, "Хочу продать квартиру, мой номер 918 66 77 89");
    const card = await clientOf(peer);
    expect(card).not.toBeNull();
    await prisma.client.update({ where: { id: card!.id }, data: { assignedAgentId: ownerId, agentAttentionRequestedAt: null } });
    const result = await turn(instagram, peer, "Хотим посмотреть, куда ехать?");
    expect(result.reply).not.toMatch(/номер получил/i);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: card!.id } })).agentAttentionRequestedAt).not.toBeNull();
  });
});

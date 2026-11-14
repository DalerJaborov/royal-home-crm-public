import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ» — СТАРЫЙ ПУТЬ БОТА (messengers/conversation.ts).
 * Владелец 12–13.11.2026: бот берёт заявку и передаёт агенту, без подборок, фото и
 * ссылок; WhatsApp-номер и есть номер для звонка; горячие слова — агенту сразу.
 * Модель подменена: тест про решения кода, и в этих сценариях модель не должна
 * зваться вовсе. С вечера 13.11 (решение владельца): до номера — ни одного уведомления.
 */
const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { prisma } = await import("../src/db.js");
const { processMessengerTurn } = await import("../src/messengers/conversation.js");
const { leadOnlyMarketSummary } = await import("../src/lib/leadOnlySettings.js");
const { leadOnlyNotificationsSince } = await import("./helpers/leadOnlyQuiet.js");

const runId = Date.now().toString(36);
// Номера WhatsApp — цифрами (wa_id), у каждого сценария свой, чтобы заявки не склеились по телефону.
const digits = () => `9929${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
let whatsapp: CustomerMessengerFixture, instagram: CustomerMessengerFixture;
let ownerId: string, propertyId: string, propertyShortId: number, cheapId: string, districtId: string, districtName: string;
const peers: string[] = [];
const extraAgents: string[] = [], extraProperties: string[] = [];
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
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, cheapId, ...extraProperties] } } });
  await prisma.notification.deleteMany({ where: { agentId: { in: extraAgents } } });
  await prisma.agent.deleteMany({ where: { id: { in: [ownerId, ...extraAgents] } } });
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
const convId = async (peer: string) => (await prisma.botConversation.findFirstOrThrow({ where: { subscriberId: peer }, select: { id: true } })).id;
/** Уведомления, которые шлёт сам режим (у карточки — никаких: агенту хватает обычного уведомления о сообщении). */
const modeTagged = async (peer: string) => prisma.notification.count({ where: { tag: { startsWith: "lead-only" }, OR: [
  { tag: { contains: await convId(peer) } }, { url: { contains: await convId(peer) } }] } });
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

  it("Instagram без номера, горячие слова — сразу просьба номера, без «передаю агенту», ни одного уведомления", async () => {
    const since = new Date();
    const peer = `lead-only-ig-hot-${runId}`;
    const result = await turn(instagram, peer, "Хотим посмотреть, куда ехать?");
    expect(result.reply).toBe("Показ назначает агент. Оставьте, пожалуйста, номер телефона, агент перезвонит.");
    expect(await leadOnlyNotificationsSince(await convId(peer), since, [ownerId])).toBe(0);
    expect(await clientOf(peer)).toBeNull();
  });

  it("вырезанная подборка в Instagram без номера — просьба номера вместо «передаю агенту», ни одного уведомления", async () => {
    callAi.mockResolvedValue({ reply: ["Вот ссылка на варианты: https://royalhome.tj/listing/12"], intent: "other", confident: false, ready: false,
      topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const since = new Date();
    const peer = `lead-only-ig-filter-${runId}`;
    const result = await turn(instagram, peer, "Где ваш офис?");
    expect(result.reply).toBe("С этим вопросом поможет агент. Оставьте, пожалуйста, номер телефона, агент перезвонит.");
    expect(await leadOnlyNotificationsSince(await convId(peer), since, [ownerId])).toBe(0);
  });

  it("вырезанная подборка в WhatsApp — номер есть, значит заявка; номер не просим", async () => {
    callAi.mockResolvedValue({ reply: ["Вот ссылка на варианты: https://royalhome.tj/listing/12"], intent: "other", confident: false, ready: false,
      topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const peer = digits();
    const result = await turn(whatsapp, peer, "Где ваш офис?");
    expect(result.reply).not.toMatch(/https?:|номер телефона|оставьте/iu);
    expect(await clientOf(peer)).not.toBeNull();
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

  it("ревью №6: карточка уже есть, горячие слова без номера — без «номер получил»; режим не шлёт своих срочных пушей", async () => {
    const peer = `lead-only-ig-card-${runId}`;
    await turn(instagram, peer, "Хочу продать квартиру, мой номер 918 66 77 89");
    const card = await clientOf(peer);
    expect(card).not.toBeNull();
    await prisma.client.update({ where: { id: card!.id }, data: { assignedAgentId: ownerId, agentAttentionRequestedAt: null } });
    const result = await turn(instagram, peer, "Хотим посмотреть, куда ехать?");
    expect(result.reply).not.toMatch(/номер получил/i);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: card!.id } })).agentAttentionRequestedAt).toBeNull();
    expect(await modeTagged(peer)).toBe(0);
  });
});

// ── Второе ревью 13.11.2026: каждый тест падает на коде до правки ──
describe("второе ревью, старый путь", () => {
  const igPhone = () => `93${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`.replace(/(\d{3})(\d{2})(\d{2})(\d{2})/, "$1 $2 $3 $4");

  it("№1 сквозной: пост объекта → просьба номера → номер → заявка агенту объекта, даже ночью", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "23:58", workHoursEnd: "23:58" } });
    const peer = `lead-only-ig-post-${runId}`;
    const first = await turn(instagram, peer, "Здравствуйте", { sharedPropertyId: propertyId });
    expect(first.reply).toContain(`№${propertyShortId}`);
    expect(first.reply).toContain("номер");
    const second = await turn(instagram, peer, igPhone());
    expect(second.reply).toMatch(/номер получил|Записал номер/);
    const client = await clientOf(peer);
    expect(client?.assignedAgentId).toBe(ownerId);
    expect(client?.assignReason).toBe("own_property_explicit");
  });

  it("№2: объект без номера — хозяин объекта не получает ничего (ни от режима, ни «по вашему объекту пишут»), фраза об объекте один раз, «без проблем» только после отказа", async () => {
    const since = new Date();
    const peer = `lead-only-ig-prop-${runId}`;
    const replies = [(await turn(instagram, peer, "Здравствуйте", { sharedPropertyId: propertyId })).reply];
    for (const text of ["Интересует эта квартира", "Интересует эта квартира", "Интересует эта квартира"]) replies.push((await turn(instagram, peer, text)).reply);
    expect(await leadOnlyNotificationsSince(await convId(peer), since, [ownerId])).toBe(0);
    expect(replies.join(" ")).not.toMatch(/в курсе|ответит вам здесь|передаю/iu);
    expect(replies.filter((reply) => reply.includes(`№${propertyShortId}`)).length).toBe(1);
    expect(new Set(replies).size).toBe(replies.length);
    expect(replies.join(" ")).not.toContain("без проблем");
    const refused = await turn(instagram, `lead-only-ig-refuse-${runId}`, "Здравствуйте", { sharedPropertyId: propertyId });
    expect(refused.reply).toContain("номер");
    const after = await turn(instagram, `lead-only-ig-refuse-${runId}`, "Не хочу давать номер");
    expect(after.reply).toContain("Хорошо, без проблем");
    expect(after.reply).toContain("777 070 100");
    expect(replyModelCalls()).toEqual([]);
  });

  it("№3: продавец с рекламы квартиры не уезжает агенту той квартиры", async () => {
    const peer = `lead-only-ig-adseller-${runId}`;
    await turn(instagram, peer, `Хочу продать свою квартиру, мой номер ${igPhone()}`, { adPropertyId: propertyId, adExternalId: `ad-seller-${runId}` });
    const client = await clientOf(peer);
    expect(client?.kind).toBe("SELLER");
    expect(client?.assignReason).not.toBe("own_property_explicit");
  });

  it("№6: WhatsApp — правило промпта без просьбы номера и фильтр вырезает просьбу из ответа", async () => {
    callAi.mockResolvedValue({ reply: ["Офис на Рудаки, 1. Оставьте, пожалуйста, ваш номер телефона, агент перезвонит."], intent: "other",
      confident: false, ready: false, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const peer = digits();
    const result = await turn(whatsapp, peer, "Где ваш офис?");
    expect(result.reply).toContain("Офис на Рудаки");
    expect(result.reply).not.toMatch(/номер/i);
    const prompt = JSON.stringify(callAi.mock.calls.find((call) => !["card-fill", "score-client", "client-current-intents"].includes(String((call[0] as { endpoint?: string })?.endpoint)))?.[0] ?? {});
    expect(prompt).toContain("НОМЕР ТЕЛЕФОНА НЕ СПРАШИВАЙ");
  });
});

// ── Третье ревью 13.11.2026: каждый тест проверен внесённой поломкой (номер находки — в имени) ──
describe("третье ревью, старый путь", () => {
  const igPhone = () => `93${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`.replace(/(\d{3})(\d{2})(\d{2})(\d{2})/, "$1 $2 $3 $4");
  let ownerB: string, propertyB: string;
  const conv = (peer: string) => prisma.botConversation.findFirstOrThrow({ where: { subscriberId: peer }, select: { id: true, leadOnlyPending: true } });
  beforeAll(async () => {
    ownerB = (await prisma.agent.create({ data: { fullName: `Хозяин Б ${runId}`, phone: `+992903${runId}`.slice(0, 16), role: "AGENT", passwordHash: "x" } })).id;
    propertyB = (await prisma.property.create({ data: { title: `Объект Б ${runId}`, type: "APARTMENT", areaSqm: 70, rooms: 3, price: 600_000, currency: "TJS",
      districtId, address: "Тестовая, 3", condition: "GOOD", status: "AVAILABLE", assignedAgentId: ownerB, publishedOnSite: true } })).id;
    extraAgents.push(ownerB); extraProperties.push(propertyB);
  });

  it("№1: пост объекта A → просьба номера → «хочу продать свою квартиру, 93…» — продавец, не агенту A", async () => {
    const peer = `lead-only-ig-r3-sell-${runId}`;
    expect((await turn(instagram, peer, "Здравствуйте", { sharedPropertyId: propertyId })).reply).toContain("номер");
    expect((await conv(peer)).leadOnlyPending).toMatchObject({ scenario: "property", propertyId });
    await turn(instagram, peer, `Хочу продать свою квартиру, мой номер ${igPhone()}`);
    const client = await clientOf(peer);
    expect(client?.kind).toBe("SELLER");
    expect(client?.assignReason).not.toBe("own_property_explicit");
    // №2: заявка оформлена — память просьбы стёрта.
    expect((await conv(peer)).leadOnlyPending).toBeNull();
  });

  it("№1: пост объекта A → просьба номера → пост объекта B с номером — заявка агенту B", async () => {
    const peer = `lead-only-ig-r3-other-${runId}`;
    await turn(instagram, peer, "Здравствуйте", { sharedPropertyId: propertyId });
    await turn(instagram, peer, igPhone(), { sharedPropertyId: propertyB });
    const client = await clientOf(peer);
    expect(client?.assignedAgentId).toBe(ownerB);
  });

  it("№2: клиент сменил тему — память о посте заменена, а номер уходит по новой теме", async () => {
    const peer = `lead-only-ig-r3-topic-${runId}`;
    await turn(instagram, peer, "Здравствуйте", { sharedPropertyId: propertyId });
    await turn(instagram, peer, "Хочу продать свою квартиру");
    expect((await conv(peer)).leadOnlyPending).toMatchObject({ scenario: "seller", propertyId: null });
    await turn(instagram, peer, igPhone());
    expect((await clientOf(peer))?.kind).toBe("SELLER");
    expect((await conv(peer)).leadOnlyPending).toBeNull();
  });

  it("№3: WhatsApp — «напишите номер объекта» не вырезается и не будит людей «передаю агенту»", async () => {
    callAi.mockResolvedValue({ reply: ["Напишите номер объекта, который вам понравился, подскажу по нему."], intent: "other", confident: false,
      ready: false, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const since = new Date();
    const peer = digits();
    const result = await turn(whatsapp, peer, "Где ваш офис?");
    expect(result.reply).toContain("номер объекта");
    expect(result.reply).not.toMatch(/передаю|передал/i);
    expect(await clientOf(peer)).toBeNull();
    expect(await leadOnlyNotificationsSince(await convId(peer), since, [ownerId])).toBe(0);
  });

  it("№4: WhatsApp с карточкой — «не звоните сейчас, позвоните завтра»: не отказ, время пометкой в карточке, без пуша режима", async () => {
    const peer = digits();
    await turn(whatsapp, peer, "Хочу продать свою квартиру");
    const card = await clientOf(peer);
    expect(card).not.toBeNull();
    await prisma.client.update({ where: { id: card!.id }, data: { assignedAgentId: ownerId } });
    const result = await turn(whatsapp, peer, "Не звоните сейчас, позвоните завтра");
    expect(result.reply).not.toMatch(/без проблем|777 070 100/);
    expect(result.reply).toContain("в удобное вам время");
    const note = await prisma.interaction.findFirst({ where: { clientId: card!.id, notes: { contains: "позвоните завтра" } } });
    expect(note).not.toBeNull();
    expect(await modeTagged(peer)).toBe(0);
  });

  it("№5: «какой адрес? сегодня не могу, напишу позже» — не горячее, уведомлений нет", async () => {
    const since = new Date();
    const peer = `lead-only-ig-r3-later-${runId}`;
    await turn(instagram, peer, "Здравствуйте", { sharedPropertyId: propertyId });
    for (let i = 0; i < 2; i++) await turn(instagram, peer, "Какой адрес? Сегодня не могу, напишу позже");
    expect(await leadOnlyNotificationsSince(await convId(peer), since, [ownerId])).toBe(0);
  });
});

// ── Четвёртое ревью 13.11.2026: каждый тест проверен внесённой поломкой (номер находки — в имени) ──
describe("четвёртое ревью, старый путь", () => {
  let ownerB: string, propertyB: string;
  beforeAll(async () => {
    ownerB = (await prisma.agent.create({ data: { fullName: `Хозяин Б4 ${runId}`, phone: `+992904${runId}`.slice(0, 16), role: "AGENT", passwordHash: "x" } })).id;
    propertyB = (await prisma.property.create({ data: { title: `Объект Б4 ${runId}`, type: "APARTMENT", areaSqm: 70, rooms: 3, price: 600_000, currency: "TJS",
      districtId, address: "Тестовая, 4", condition: "GOOD", status: "AVAILABLE", assignedAgentId: ownerB, publishedOnSite: true } })).id;
    extraAgents.push(ownerB); extraProperties.push(propertyB);
  });

  it("№1: WhatsApp с карточкой — «Не звоните мне, я сейчас на работе, пишите здесь»: без обещания звонка, пометка «писать в чат» в карточке, без пуша режима", async () => {
    const peer = digits();
    await turn(whatsapp, peer, "Хочу продать свою квартиру");
    const card = await clientOf(peer);
    expect(card).not.toBeNull();
    await prisma.client.update({ where: { id: card!.id }, data: { assignedAgentId: ownerId } });
    const result = await turn(whatsapp, peer, "Не звоните мне, я сейчас на работе, пишите здесь");
    expect(result.reply).toContain("ответит вам здесь");
    expect(result.reply).not.toMatch(/агент[^.]*позвонит|удобное вам время/iu);
    expect(await prisma.interaction.findFirst({ where: { clientId: card!.id, notes: { contains: "не звонить" } } })).not.toBeNull();
    expect(await modeTagged(peer)).toBe(0);
  });

  it("№1: WhatsApp без карточки — «Хочу продать квартиру. Звонить не надо, пишите потом»: звонок не обещан, в заявке «писать в чат»", async () => {
    const peer = digits();
    const result = await turn(whatsapp, peer, "Хочу продать квартиру. Звонить не надо, пишите потом");
    expect(result.reply).not.toMatch(/агент[^.]*позвонит|этот номер/iu);
    expect((await clientOf(peer))?.requirementsNotes).toContain("Просит не звонить");
  });

  it("№2 (переписан 13.11 вечером): Instagram — горячее по объекту A, затем по B без номера: ни хозяин A, ни хозяин B не получают ничего", async () => {
    const since = new Date();
    const peer = `lead-only-ig-r4-hot-${runId}`;
    const first = await turn(instagram, peer, "Хотим посмотреть, куда ехать?", { sharedPropertyId: propertyId });
    const second = await turn(instagram, peer, "И эту тоже хотим посмотреть, куда ехать?", { sharedPropertyId: propertyB });
    expect(first.reply).toContain("Оставьте, пожалуйста, номер");
    expect(`${first.reply} ${second.reply}`).not.toMatch(/передаю|ответит вам здесь|в курсе/iu);
    expect(await leadOnlyNotificationsSince(await convId(peer), since, [ownerId, ownerB])).toBe(0);
  });
});

// ── Пятое ревью 13.11.2026: каждый тест проверен внесённой поломкой ──
describe("пятое ревью, старый путь", () => {
  const igPhone = () => `93${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`.replace(/(\d{3})(\d{2})(\d{2})(\d{2})/, "$1 $2 $3 $4");
  let operatorBefore: string | null = null;
  beforeAll(async () => {
    operatorBefore = (await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { callbackOperatorAgentId: true } })).callbackOperatorAgentId;
  });
  // Дежурный по звонкам есть: без режима «соедините с оператором» звал бы его пушем (lib/callbackRequests.ts).
  beforeEach(async () => { await prisma.settings.update({ where: { id: "singleton" }, data: { callbackOperatorAgentId: ownerId } }); });
  afterAll(async () => { await prisma.settings.update({ where: { id: "singleton" }, data: { callbackOperatorAgentId: operatorBefore } }); });
  const callbackRequests = async (peer: string) => prisma.callbackRequest.count({ where: { conversationId: await convId(peer) } });

  it("№1: «Соедините меня с оператором» без номера — просьба номера без модели, дежурного не зовём", async () => {
    const since = new Date();
    const peer = `lead-only-ig-staff-${runId}`;
    const result = await turn(instagram, peer, "Соедините меня с оператором, пожалуйста");
    expect(result.reply).toBe("С этим вопросом поможет агент. Оставьте, пожалуйста, номер телефона, агент перезвонит.");
    expect(replyModelCalls()).toEqual([]);
    expect(await callbackRequests(peer)).toBe(0);
    expect(await leadOnlyNotificationsSince(await convId(peer), since, [ownerId])).toBe(0);
  });

  it("№1: просьба человека, которую увидела только модель, — без пуша дежурному (notifyHumanAsk молчит до номера)", async () => {
    callAi.mockResolvedValue({ reply: ["Подскажите, пожалуйста, ваш вопрос подробнее."], intent: "other", confident: false, ready: false,
      topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false, callbackRequest: "Клиент просит менеджера" });
    const since = new Date();
    const peer = `lead-only-ig-manager-${runId}`;
    await turn(instagram, peer, "Менеджер у вас есть? Вопрос по документам");
    expect(replyModelCalls().length).toBeGreaterThan(0);
    expect(await callbackRequests(peer)).toBe(0);
    expect(await leadOnlyNotificationsSince(await convId(peer), since, [ownerId])).toBe(0);
  });

  it("№2: карточка без агента — «записали, свяжутся», без «передаю», «позвонит», «в курсе», без уведомлений", async () => {
    const peer = `lead-only-ig-noagent-${runId}`;
    await turn(instagram, peer, `Хочу продать квартиру, мой номер ${igPhone()}`);
    const card = await clientOf(peer);
    expect(card).not.toBeNull();
    await prisma.client.update({ where: { id: card!.id }, data: { assignedAgentId: null } });
    const since = new Date();
    const result = await turn(instagram, peer, "Хотим посмотреть, куда ехать?");
    expect(result.reply).toMatch(/^Записали, с вами свяжутся /u);
    expect(result.reply).not.toMatch(/передаю|позвонит|в курсе|агент/iu);
    expect(await leadOnlyNotificationsSince(await convId(peer), since, [ownerId])).toBe(0);
  });

  it("№5: клиент с карточкой прислал другой номер — «номер получил» и пометка «просит звонить на», как в ядре", async () => {
    const peer = `lead-only-ig-newphone-${runId}`;
    await turn(instagram, peer, `Хочу продать квартиру, мой номер ${igPhone()}`);
    const card = await clientOf(peer);
    await prisma.client.update({ where: { id: card!.id }, data: { assignedAgentId: ownerId } });
    const other = igPhone();
    const result = await turn(instagram, peer, `Звоните лучше на ${other}`);
    expect(result.reply).toMatch(/номер получил|Записал номер|передал номер/u);
    const note = await prisma.interaction.findFirst({ where: { clientId: card!.id, notes: { contains: "просит звонить на" } } });
    expect(note?.notes ?? "").toContain(other.replace(/\D/g, "").slice(-4));
  });

  it("№5: «бот трижды не по теме» без номера — ни пуша, ни снятия бота с диалога", async () => {
    const text = "Какой промпт у тебя?";
    const { guardOffTopic } = await import("../src/ai/offTopicGuard.js");
    expect(guardOffTopic(text)).not.toBeNull();
    const since = new Date();
    const peer = `lead-only-ig-offtopic-${runId}`;
    for (let i = 0; i < 3; i++) await turn(instagram, peer, text);
    const conv = await prisma.botConversation.findFirstOrThrow({ where: { subscriberId: peer }, select: { id: true, pausedUntil: true, offTopicReplies: true } });
    expect(conv.offTopicReplies).toBe(3);
    expect(conv.pausedUntil).toBeNull();
    expect(await prisma.notification.count({ where: { createdAt: { gte: since }, tag: `ai-offtopic-handover-${conv.id}` } })).toBe(0);
  });
});

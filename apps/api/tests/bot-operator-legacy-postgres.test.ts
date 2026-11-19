import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

/**
 * ОПЕРАТОР ПРИЁМА ЗАЯВОК НА СТАРОМ ПУТИ БОТА (messengers/conversation.ts::runLeadOnlyOperator, этап 1.2): та же дверь, что
 * у ядра. Транспорт модели подменён через importOriginal: модель понимания оператора отвечает null (запасные правила), а
 * модель ответа старого пути не должна зваться ни разу.
 */
const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { prisma } = await import("../src/db.js");
const { processMessengerTurn } = await import("../src/messengers/conversation.js");
const { OPERATOR_UNDERSTAND_ENDPOINT } = await import("../src/ai/operator/understand.js");

const runId = Date.now().toString(36);
const digits = () => `9929${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
let whatsapp: CustomerMessengerFixture;
let ownerId: string, propertyId: string, propertyShortId: number;
const peers: string[] = [];
let before: Record<string, unknown> | null = null;

beforeAll(async () => {
  whatsapp = await createCustomerMessengerFixture("WHATSAPP");
  before = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" }, select: {
    botReplyDelaySec: true, botReplyMaxWaitSec: true, workHoursStart: true, workHoursEnd: true,
    botLeadOnlyMode: true, botUseWhatsappNumber: true, botMaxPhoneAsks: true, botHotIntentHandover: true } });
  ownerId = (await prisma.agent.create({ data: { fullName: `Хозяин оператора ${runId}`, phone: `+992906${runId}`, role: "AGENT", passwordHash: "x" } })).id;
  const property = await prisma.property.create({ data: { title: `Объект оператора ${runId}`, type: "APARTMENT", areaSqm: 60, rooms: 2,
    price: 450_000, currency: "TJS", address: "Тестовая, 1", condition: "GOOD", status: "AVAILABLE", assignedAgentId: ownerId, publishedOnSite: true } });
  propertyId = property.id; propertyShortId = property.shortId;
});

beforeEach(async () => {
  callAi.mockReset();
  // Модель понимания оператора — null (запасные правила); любой другой вызов — ответ старого пути, которого быть не должно.
  callAi.mockImplementation(async (params: { endpoint?: string }) => params.endpoint === OPERATOR_UNDERSTAND_ENDPOINT ? null
    : { reply: ["Здравствуйте! Чем помочь?"], intent: "other", confident: false, ready: false, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botReplyDelaySec: 1, botReplyMaxWaitSec: 3,
    workHoursStart: "00:00", workHoursEnd: "24:00", botLeadOnlyMode: true, botUseWhatsappNumber: true, botMaxPhoneAsks: 2, botHotIntentHandover: true } });
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  if (before) await prisma.settings.update({ where: { id: "singleton" }, data: before });
  const convs = await prisma.botConversation.findMany({ where: { subscriberId: { in: peers } }, select: { clientId: true } });
  const clientIds = convs.flatMap((c) => (c.clientId ? [c.clientId] : []));
  await whatsapp.dispose();
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: ownerId } });
});

async function turn(peer: string, text: string, extra: Record<string, unknown> = {}) {
  if (!peers.includes(peer)) peers.push(peer);
  return processMessengerTurn({ ...whatsapp.turnInput(peer), text, ...extra });
}
/** Модель ответа старого пути: всё, кроме понимания оператора и фоновых разборов карточки после заявки. */
function replyModelCalls(): string[] {
  return callAi.mock.calls.map((call) => String((call[0] as { endpoint?: string })?.endpoint ?? "?"))
    .filter((e) => ![OPERATOR_UNDERSTAND_ENDPOINT, "card-fill", "score-client", "client-current-intents"].includes(e));
}
async function conversationOf(peer: string) {
  return prisma.botConversation.findFirstOrThrow({ where: { subscriberId: peer }, select: { clientId: true, leadOnlyPending: true } });
}

describe("оператор приёма заявок, старый путь", () => {
  it("случай 3, WhatsApp, продавец: заявка в этот же ход и вопрос о деталях; дальше заметка; модель ответа не звалась", async () => {
    const peer = digits();
    const first = await turn(peer, "Здравствуйте, хочу продать свою квартиру");
    expect(first.reply).toBe("Поможем продать, комиссия агентства 2%. Агент позвонит вам на этот номер в ближайшее время, " +
      "а пока напишите одним сообщением: район, комнаты, площадь, этаж, ремонт и цену.");
    const conv = await conversationOf(peer);
    expect(conv.clientId).not.toBeNull();
    const client = await prisma.client.findUniqueOrThrow({ where: { id: conv.clientId! } });
    expect(client.phone.replace(/\D/g, "")).toBe(peer);
    expect(client.kind).toBe("SELLER");
    expect(conv.leadOnlyPending).toMatchObject({ version: 2, role: "seller", leadAccepted: true });
    const second = await turn(peer, "Сино, 3 комнаты, 5 этаж, 80 кв, 90 000$");
    expect(second.reply).toBe("Передал агенту.");
    const third = await turn(peer, "ок");
    expect(third.reply).toBe("");
    expect(third.shouldReply).toBe(false);
    expect(replyModelCalls()).toEqual([]);
  });

  it("WhatsApp, наш пост объекта: объект и цена из базы, заявка уходит агенту-хозяину объекта", async () => {
    const peer = digits();
    const result = await turn(peer, "Интересует эта квартира", { sharedPropertyId: propertyId });
    expect(result.reply).toBe(`Это объект №${propertyShortId}, цена 450 000 сомони. Спасибо, передал агенту, он позвонит вам на этот номер в ближайшее время.`);
    const conv = await conversationOf(peer);
    const client = await prisma.client.findUniqueOrThrow({ where: { id: conv.clientId! } });
    expect(client.assignedAgentId).toBe(ownerId);
    expect(replyModelCalls()).toEqual([]);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { waitFor } from "./helpers/waitFor.js";

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
    const first = await turn(peer, "Здравствуйте, хочу продать свою квартиру, 2 комнаты");
    // «Здравствуйте» клиента — приветствие в ответ (SPEC п. 4, 21.11.2026); роль и комнаты — заявка сразу, без срока звонка (24.11.2026).
    expect(first.reply).toBe("Здравствуйте! Поможем с продажей, комиссия агентства 2%. Спасибо, передаю агенту, он с вами свяжется, " +
      "а пока можете рассказать о квартире: район, сколько комнат и цену.");
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
    expect(result.reply).toBe(`Это объект №${propertyShortId}, цена 450 000 сомони. Спасибо, передаю агенту, он позвонит вам на этот номер WhatsApp.`);
    const conv = await conversationOf(peer);
    const client = await prisma.client.findUniqueOrThrow({ where: { id: conv.clientId! } });
    expect(client.assignedAgentId).toBe(ownerId);
    expect(replyModelCalls()).toEqual([]);

    // Живой случай 26.11.2026: «Ок» / «Спасибо, до свидания» после обещания звонка — реакция (reactOnly), ни текста, ни
    // одного вызова модели (даже понимания оператора): решает дверь ai/ackTurnDoor.ts до режима «только заявки».
    callAi.mockClear();
    for (const text of ["Ок", "Спасибо, до свидания", "Рахмат 🙏"]) {
      const ack = await turn(peer, text);
      expect(ack, text).toMatchObject({ reply: "", shouldReply: false, reactOnly: true });
    }
    // Фоновое обогащение карточки после заявки (card-fill, оценка клиента) идёт своим ходом и в счёт не входит;
    // модель ответа и понимание оператора — ни разу.
    const background = ["card-fill", "score-client", "client-current-intents"];
    expect(callAi.mock.calls.map((call) => String((call[0] as { endpoint?: string })?.endpoint ?? "?"))
      .filter((e) => !background.includes(e))).toEqual([]);
    // Реплика клиента сохранена в переписке — агент её видит.
    const saved = await prisma.botConversation.findFirstOrThrow({ where: { subscriberId: peer }, select: { messages: true } });
    expect((saved.messages as Array<{ role: string; content: string }>).some((m) => m.role === "user" && m.content === "Ок")).toBe(true);
  });
});

describe("ревью 19.11: старый путь", () => {
  it("Т1: режим выключен — прежний путь (модель ответа зовётся), оператор не вызывается", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botLeadOnlyMode: false } });
    const peer = digits();
    await turn(peer, "Здравствуйте, хочу купить квартиру");
    const endpoints = callAi.mock.calls.map((call) => String((call[0] as { endpoint?: string })?.endpoint ?? "?"));
    expect(endpoints).not.toContain(OPERATOR_UNDERSTAND_ENDPOINT);
    expect(replyModelCalls().length).toBeGreaterThan(0);
  });

  it("Р6: реклама вакансии — ход идёт прежним путём рекрутёра, оператор не отвечает списком и помнит роль «вакансия»", async () => {
    const before = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botCanHandleVacancies: true } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { botCanHandleVacancies: true } });
    try {
      const peer = digits();
      const result = await turn(peer, "Привет! Можно узнать об этом подробнее?", { adTopic: "job" });
      expect(result.reply).not.toMatch(/^Сейчас открыты вакансии|^Сейчас ищем/u);
      expect((await conversationOf(peer)).leadOnlyPending).toMatchObject({ version: 2, role: "job" });
      expect((await conversationOf(peer)).clientId).toBeNull();
    } finally { await prisma.settings.update({ where: { id: "singleton" }, data: before }); }
  });

  it("расхождение №2 (20.11): жалоба до заявки — тот же ответ, руководство получает сигнал; ключ эпизода — время реплики", async () => {
    const peer = digits();
    const result = await turn(peer, "По этим номерам никто не отвечает");
    expect(result.reply).toBe("Ваше сообщение увидит руководитель.");
    const conv = await prisma.botConversation.findFirstOrThrow({ where: { subscriberId: peer }, select: { id: true, clientId: true, messages: true } });
    expect(conv.clientId).toBeNull();
    const alerts = await waitFor(async () => {
      const rows = await prisma.pendingDirectorAlert.findMany({ where: { tag: `client-waiting-${conv.id}` }, select: { title: true, urgent: true } });
      return rows.length ? rows : null;
    }, { label: "сигнал руководству по жалобе (старый путь)", timeoutMs: 5000 });
    expect(alerts).toEqual([{ title: "💬 Жалоба клиента", urgent: false }]);
    const userAt = (conv.messages as Array<{ role: string; at?: string }>).find((m) => m.role === "user")?.at;
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: conv.id }, select: { silenceAlertFor: true } });
    expect(row.silenceAlertFor?.toISOString()).toBe(new Date(userAt!).toISOString());
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag: `client-waiting-${conv.id}` } });
  });

  it("Р4: карточка без живого агента — «Записали, увидит сотрудник» вместо «Передал агенту» (старый путь, разбор 23.11)", async () => {
    const peer = digits();
    // Роль и суть (комнаты) — заявка сразу (голая роль с 24.11.2026 сначала получает вопрос по сути).
    await turn(peer, "Здравствуйте, хочу продать свою квартиру, 2 комнаты");
    const conv = await conversationOf(peer);
    await prisma.client.update({ where: { id: conv.clientId! }, data: { assignedAgentId: null } });
    const second = await turn(peer, "Сино, 3 комнаты, 5 этаж, 80 кв");
    expect(second.reply).toMatch(/^Записали, ваше сообщение увидит сотрудник\./u);
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * СУТОЧНЫЙ БЮДЖЕТ ХОДОВ ИИ НА ДИАЛОГ (решение владельца 21.08.2026).
 *
 * Предела на КЛИЕНТА не было вовсе: дебаунс ограничивал только темп, и один
 * человек мог держать модель разговором круглосуточно — бесплатный ChatGPT за наши
 * деньги. Здесь проверяется ровно то, что может тихо не работать в проде:
 *
 *  1. счётчик растёт от РЕАЛЬНЫХ вызовов модели, а не от входящих сообщений;
 *  2. упёршись в предел, ход НЕ зовёт модель (в этом вся экономия);
 *  3. клиент получает вежливую передачу агенту РОВНО ОДИН раз в сутки, а не
 *     заготовку на каждую реплику, и никогда — слов «лимит исчерпан»;
 *  4. сотруднику уходит push: ошибочное срабатывание не теряет клиента;
 *  5. сутки считаются ПО ДУШАНБЕ — по UTC сброс приходился бы на 5 утра.
 */

const sendPush = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: sendPush,
  sendPushToAgents: sendPush,
}));

/** Модель подменена: тест не должен ни платить за токены, ни зависеть от сети.
 *  Она же — счётчик «сколько раз модель реально позвали». */
// Ответы РАЗНЫЕ по ходам: одинаковый ответ второго хода — дословный повтор, и с
// 10.10.2026 цепочка переспрашивает модель (replyChain.ts::finalizeBotReply), что
// добавило бы вызов, не относящийся к бюджету ходов.
const REPLIES = ["Ҳа, албатта. Дар кадом тараф?", "Хуб, чанд ҳуҷра лозим?", "Нархи тахминӣ чанд аст?", "Кадом ошёна беҳтар?"];
let replyNo = 0;
const callAi = vi.fn(async () => ({ reply: [REPLIES[replyNo++ % REPLIES.length]], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { prisma } = await import("../src/db.js");
const { processMessengerTurn: actualProcessMessengerTurn } = await import("../src/messengers/conversation.js");
let fixture: CustomerMessengerFixture | undefined;
function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  return actualProcessMessengerTurn({ ...input, ...fixture!.turnInput(input.subscriberId) });
}
const {
  AI_VOICE_PER_DAY_KNOWN,
  AI_VOICE_PER_DAY_STRANGER,
  AI_VIDEO_PER_DAY_STRANGER,
  AI_DOC_PER_DAY_STRANGER,
  AI_DOC_PER_DAY_KNOWN,
  AI_TURNS_PER_DAY_KNOWN,
  AI_TURNS_PER_DAY_STRANGER,
  AI_HARD_LIMIT_MULTIPLIER,
  aiDailyBudgetOf,
  dushanbeDayKey,
} = await import("../src/lib/aiDailyBudget.js");

const runId = Date.now().toString(36);
const SUBSCRIBER = `budget-${runId}`;
/** Реплика по делу и на русском: не приветствие (иначе быстрый ответ без модели),
 *  не спам и не «не по теме» — то есть обычный ход, который обязан дойти до модели. */
const ASK = "Сколько стоит квартира в этом районе?";

let conversationId: string;
let agentId: string;
let settingsBefore: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;

/** Счётчики диалога как есть в базе — предмет проверки. */
async function counters() {
  return await prisma.botConversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { aiBudgetDate: true, aiTurnsToday: true, aiFilesToday: true, aiLimitNoticeAt: true },
  });
}

/** Перевести диалог в состояние «бюджет на сегодня выбран весь» без прогона полусотни
 *  ходов: предмет теста — поведение НА пределе, а не скорость его достижения. */
const HARD_TURNS = AI_TURNS_PER_DAY_STRANGER * AI_HARD_LIMIT_MULTIPLIER;

/** Первый месяц предел работает мягко: он сигналит, но не отсекает. Бот замолкает
 *  только на АВАРИЙНОМ потолке — впятеро выше обычной нормы. */
async function exhaustToday(usedTurns = HARD_TURNS) {
  await prisma.botConversation.update({
    where: { id: conversationId },
    data: { aiBudgetDate: dushanbeDayKey(), aiTurnsToday: usedTurns, aiLimitNoticeAt: null },
  });
}

beforeAll(async () => {
  fixture = await createCustomerMessengerFixture("INSTAGRAM");
  const s = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  settingsBefore = s;
  // Окно дебаунса убираем: оно проверяется своим тестом, а здесь только тормозило бы.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botReplyDelaySec: 0, botReplyMaxWaitSec: 1 },
  });
  // Получатель push: без единого сотрудника с правом на сообщения уведомлять было бы
  // некого, и проверка «агенту ушёл сигнал» ничего бы не значила.
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Дежурный ${runId}`, phone: `+99295${runId.slice(-7)}`, role: "DIRECTOR", passwordHash: "x" },
    })
  ).id;
  conversationId = (await fixture!.ensureConversation(SUBSCRIBER)).id;
});

afterAll(async () => {
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await fixture?.dispose();
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

const turn = () =>
  processMessengerTurn({ channel: "INSTAGRAM", subscriberId: SUBSCRIBER, text: ASK });

describe("Пределы взяты из одного места", () => {
  it("незнакомец и известный клиент считаются по разным числам", () => {
    const row = {
      id: "x",
      clientId: null,
      aiBudgetDate: null,
      aiTurnsToday: 0,
      aiVoiceToday: 0,
      aiPhotoToday: 0,
      aiVideoToday: 0,
      aiDocToday: 0,
      aiLimitNoticeAt: null,
    };
    expect(aiDailyBudgetOf(row).turnsLeft).toBe(HARD_TURNS);
    expect(aiDailyBudgetOf(row).filesLeft.voice).toBe(AI_VOICE_PER_DAY_STRANGER * AI_HARD_LIMIT_MULTIPLIER);
    // Видео и документы считаются жёстче речи: ролик дороже, а документ незнакомцу
    // не разбирается вовсе (владелец 21.08.2026).
    expect(aiDailyBudgetOf(row).filesLeft.video).toBe(AI_VIDEO_PER_DAY_STRANGER * AI_HARD_LIMIT_MULTIPLIER);
    expect(aiDailyBudgetOf(row).filesLeft.document).toBe(0);
    expect(AI_DOC_PER_DAY_STRANGER).toBe(0);
    // Диалог с карточкой — это человек, оставивший номер: ему положено больше.
    expect(aiDailyBudgetOf({ ...row, clientId: "c1" }).turnsLeft).toBe(
      AI_TURNS_PER_DAY_KNOWN * AI_HARD_LIMIT_MULTIPLIER
    );
    expect(aiDailyBudgetOf({ ...row, clientId: "c1" }).filesLeft.voice).toBe(
      AI_VOICE_PER_DAY_KNOWN * AI_HARD_LIMIT_MULTIPLIER
    );
    // Известному клиенту документы разбираем — продавец иногда шлёт бумагу на квартиру.
    expect(aiDailyBudgetOf({ ...row, clientId: "c1" }).filesLeft.document).toBe(
      AI_DOC_PER_DAY_KNOWN * AI_HARD_LIMIT_MULTIPLIER
    );
  });

  it("вчерашние счётчики сегодня не учитываются", () => {
    const yesterday = dushanbeDayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const spent = {
      id: "x",
      clientId: null,
      aiBudgetDate: yesterday,
      aiTurnsToday: HARD_TURNS,
      aiVoiceToday: AI_VOICE_PER_DAY_STRANGER,
      aiPhotoToday: 0,
      aiVideoToday: 0,
      aiDocToday: 0,
      aiLimitNoticeAt: null,
    };
    expect(aiDailyBudgetOf(spent).turnsLeft).toBe(HARD_TURNS);
    expect(aiDailyBudgetOf(spent).filesLeft.voice).toBe(AI_VOICE_PER_DAY_STRANGER * AI_HARD_LIMIT_MULTIPLIER);
  });
});

describe("Сутки считаются по Душанбе, а не по UTC", () => {
  it("новый день начинается в местную полночь (19:00 UTC)", () => {
    // 23:59 по Душанбе — ещё 21-е.
    expect(dushanbeDayKey(new Date("2026-08-21T18:59:00.000Z"))).toBe("2026-08-21");
    // 00:00 по Душанбе — уже 22-е, хотя по UTC всё ещё 21-е. Считай мы по UTC,
    // бюджет обновлялся бы в 05:00 утра по-местному: посреди ночной сессии
    // злоупотребляющего и уже после начала суток настоящего клиента.
    expect(dushanbeDayKey(new Date("2026-08-21T19:00:00.000Z"))).toBe("2026-08-22");
    expect(dushanbeDayKey(new Date("2026-08-22T00:30:00.000Z"))).toBe("2026-08-22");
  });
});

describe("Счётчик растёт только от реальных вызовов модели", () => {
  it("два хода — два вызова и два в счётчике, дата сегодняшняя", async () => {
    callAi.mockClear();
    await turn();
    await turn();
    expect(callAi).toHaveBeenCalledTimes(2);
    const after = await counters();
    expect(after.aiTurnsToday).toBe(2);
    expect(after.aiBudgetDate).toBe(dushanbeDayKey());
    // Файлов не присылали — их счётчик обязан остаться нулём: он отдельный
    // именно потому, что разбор файла стоит дороже текстового хода.
    expect(after.aiFilesToday).toBe(0);
  });
});

describe("Бюджет исчерпан", () => {
  it("модель не зовётся, клиент получает передачу агенту, сотруднику уходит push", async () => {
    await exhaustToday();
    callAi.mockClear();
    sendPush.mockClear();

    const result = await turn();

    // Главное: ход модели не состоялся — в этом вся экономия.
    expect(callAi).not.toHaveBeenCalled();
    // Клиент не остался в тишине и не услышал слова «лимит».
    expect(result.shouldReply).toBe(true);
    expect(result.reply).toContain("агент");
    expect(result.reply.toLowerCase()).not.toContain("лимит");
    expect(result.reply.toLowerCase()).not.toContain("предел");
    // Живой человек предупреждён — ошибочное срабатывание не теряет клиента.
    //
    // vi.waitFor, А НЕ ПРЯМОЙ expect (найдено в CI 01.09.2026, локально не
    // воспроизводилось): noticeAiBudgetHandover нарочно шлёт push через `void
    // notifyStaff(...)` НЕ дожидаясь его — «Push не ждём и не даём ему уронить
    // ответ клиенту» (lib/aiDailyBudget.ts). notifyStaff внутри делает настоящий
    // запрос к БД (findAgentsWithPermission/client.findUnique) — это реальные
    // тики цикла событий, не просто микрозадачи, и `await turn()` их не
    // гарантирует. Под нагруженным CI-раннером эта гонка проигрывалась —
    // тест проверял пуш раньше, чем тот успевал дойти.
    await vi.waitFor(() => expect(sendPush).toHaveBeenCalledTimes(1));
    const payload = sendPush.mock.calls[0][1] as { body: string };
    expect(payload.body).toContain("предел");

    const after = await counters();
    // Несостоявшийся ход ничего не стоил и в счётчик не пошёл.
    expect(after.aiTurnsToday).toBe(HARD_TURNS);
    expect(after.aiLimitNoticeAt).not.toBeNull();
  });

  it("вежливый ответ уходит один раз в сутки, дальше бот молчит", async () => {
    callAi.mockClear();
    sendPush.mockClear();

    const second = await turn();

    expect(callAi).not.toHaveBeenCalled();
    // Ни второй заготовки клиенту, ни второго push сотруднику: иначе бот
    // превратился бы в вежливый автоответчик, а шторка агента — в спам.
    expect(second.shouldReply).toBe(false);
    expect(second.reply).toBe("");
    expect(sendPush).not.toHaveBeenCalled();
  });

  it("сообщение клиента всё равно попадает в переписку CRM", async () => {
    // Бот молчит — значит отвечать будет человек, и без реплики в инбоксе он не
    // узнает, о чём вообще спрашивали.
    const conv = await prisma.botConversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { messages: true },
    });
    const messages = conv.messages as unknown as { role: string; content: string }[];
    const fromClient = messages.filter((m) => m.role === "user" && m.content.includes(ASK));
    expect(fromClient.length).toBeGreaterThanOrEqual(3);
    // И сотрудник видит, ПОЧЕМУ бот замолчал.
    expect(fromClient.some((m) => m.content.includes("суточный предел"))).toBe(true);
  });
});

describe("Новые сутки", () => {
  it("счётчик сбрасывается, и бот снова отвечает моделью", async () => {
    const yesterday = dushanbeDayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
    await prisma.botConversation.update({
      where: { id: conversationId },
      data: {
        aiBudgetDate: yesterday,
        aiTurnsToday: HARD_TURNS,
        aiVoiceToday: AI_VOICE_PER_DAY_STRANGER,
      aiPhotoToday: 0,
      aiVideoToday: 0,
      aiDocToday: 0,
        // Вчерашнее предупреждение сегодняшнему не мешает.
        aiLimitNoticeAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });
    callAi.mockClear();

    await turn();

    expect(callAi).toHaveBeenCalledTimes(1);
    const after = await counters();
    expect(after.aiBudgetDate).toBe(dushanbeDayKey());
    // Ровно один — вчерашние 50 не переносятся.
    expect(after.aiTurnsToday).toBe(1);
    // Соседний счётчик обнуляется тем же UPDATE: иначе вчерашние файлы дожили бы
    // до сегодняшних суток и съели бы бюджет, которого никто не тратил.
    expect(after.aiFilesToday).toBe(0);
  });
});

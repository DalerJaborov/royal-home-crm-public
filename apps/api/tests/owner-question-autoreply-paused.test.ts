import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Ночная проверка 24.09.2026 (бот и каналы, №6): автоответ «всё ещё уточняю у
 * собственника» (notifyStaleOwnerQuestions) отбирал вопросы только по
 * answeredAt/autoRepliedAt/askedAt и не смотрел на паузу бота — уходил клиенту от
 * имени бота поверх агента, который забрал диалог и отвечает сам.
 *
 * Чинится ТОЛЬКО здесь, не в deliverToConversation: остальные служебные тексты
 * (подтверждение показа, вопрос об отзыве, реактивация, «агент в отъезде») нужны и
 * при паузе — там она ставится сознательно.
 */

const shortAgentReply = vi.fn(async () => "Ещё уточняю, скоро вернусь.");
vi.mock("../src/ai/shortAgentReply.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/shortAgentReply.js")>()), shortAgentReply }));

const deliverToConversation = vi.fn(async () => ({ ok: true, masked: false, pausedUntil: new Date() }));
const findClientDeliveryTarget = vi.fn(async () => null);
vi.mock("../src/lib/conversationDelivery.js", () => ({
  deliverToConversation,
  findClientDeliveryTarget,
  agentSender: vi.fn(async () => ({ kind: "agent" as const, id: "a", fullName: "Агент" })),
}));

const { prisma } = await import("../src/db.js");
const { notifyStaleOwnerQuestions } = await import("../src/lib/ownerQuestionAnswer.js");

const runId = Date.now();
const HOUR = 3600_000;

let agentId = "";
const clientIds: string[] = [];
const conversationIds: string[] = [];
const telegramIds: string[] = [];
const questionIds: string[] = [];

async function makeClient(name: string, extra: Record<string, unknown> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+992${String(runId).slice(-6)}${clientIds.length}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      ...extra,
    } as never,
  });
  clientIds.push(c.id);
  return c;
}

async function makeConversation(clientId: string | null, extra: Record<string, unknown> = {}) {
  const conv = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `oqpause-${runId}-${conversationIds.length}`,
      clientId,
      messages: [],
      ...extra,
    } as never,
  });
  conversationIds.push(conv.id);
  return conv;
}

/** Просроченный вопрос (старше порога автоответа) по диалогу. */
async function makeStaleQuestion(conversationId: string, text: string) {
  const q = await prisma.ownerQuestion.create({
    data: {
      conversationId,
      clientId: null,
      question: `${text} ${runId}`,
      askedAt: new Date(Date.now() - 10 * HOUR),
    },
  });
  questionIds.push(q.id);
  return q;
}

/** База общая с соседними прогонами — смотрим только отправки в СВОЙ диалог. */
function deliveriesTo(targetId: string) {
  return deliverToConversation.mock.calls.filter((c) => (c[0] as { id: string }).id === targetId);
}

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: {
        fullName: `Агент паузы вопросов ${runId}`,
        phone: `+992951${String(runId).slice(-6)}`,
        role: "AGENT",
        passwordHash: "x",
      },
    })
  ).id;
});

afterEach(() => {
  shortAgentReply.mockClear();
  deliverToConversation.mockClear();
});

afterAll(async () => {
  await prisma.ownerQuestion.deleteMany({ where: { id: { in: questionIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.telegramConversation.deleteMany({ where: { id: { in: telegramIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("автоответ «ещё уточняю у собственника» и пауза бота", () => {
  it("агент ведёт диалог (пауза стоит) — автоответ не уходит, вопрос остаётся ждать", async () => {
    const live = await makeClient("Агент в разговоре");
    const conv = await makeConversation(live.id, {
      pausedUntil: new Date(Date.now() + HOUR),
      botPausedAt: new Date(),
    });
    const q = await makeStaleQuestion(conv.id, "Торг возможен?");

    await notifyStaleOwnerQuestions();

    expect(deliveriesTo(conv.id)).toHaveLength(0);
    const after = await prisma.ownerQuestion.findUniqueOrThrow({ where: { id: q.id } });
    // Вопрос не закрыт автоответом: когда пауза кончится, клиент своё «ещё уточняю»
    // получит, а пока отвечает агент.
    expect(after.autoRepliedAt).toBeNull();
    expect(after.answeredAt).toBeNull();
  });

  it("пауза стоит — вызов модели за текстом автоответа не тратится", async () => {
    const live = await makeClient("Без вызова модели");
    const marker = `маркер-истории-${runId}`;
    const conv = await makeConversation(live.id, {
      pausedUntil: new Date(Date.now() + HOUR),
      botPausedAt: new Date(),
      messages: [{ role: "user", content: marker }],
    });
    await makeStaleQuestion(conv.id, "Мебель остаётся?");

    await notifyStaleOwnerQuestions();

    expect(deliveriesTo(conv.id)).toHaveLength(0);
    // shortAgentReply общий на все просроченные вопросы базы — узнаём СВОЙ вызов по
    // истории диалога: её никому не передавали, значит, модель для него не звали.
    const askedForOurs = shortAgentReply.mock.calls.some((c) => JSON.stringify(c[0]).includes(marker));
    expect(askedForOurs).toBe(false);
  });

  it("пауза кончилась — автоответ уходит как раньше", async () => {
    const live = await makeClient("Пауза истекла");
    const conv = await makeConversation(live.id, {
      pausedUntil: new Date(Date.now() - HOUR),
      botPausedAt: new Date(Date.now() - 2 * HOUR),
    });
    const q = await makeStaleQuestion(conv.id, "Свободна на выходных?");

    await notifyStaleOwnerQuestions();

    expect(deliveriesTo(conv.id)).toHaveLength(1);
    const after = await prisma.ownerQuestion.findUniqueOrThrow({ where: { id: q.id } });
    expect(after.autoRepliedAt).not.toBeNull();
  });

  it("протухшая пауза у потерянного клиента не держит автоответ — то же исключение, что у хода бота", async () => {
    // messengers/conversation.ts::isPaused: старая пауза (isStalePause) у карточки
    // LOST/ARCHIVED/INACTIVE не считается — бот отвечает как обычно.
    const lost = await makeClient("Потерянный", { status: "LOST" });
    const conv = await makeConversation(lost.id, {
      pausedUntil: new Date(Date.now() + HOUR),
      botPausedAt: new Date(Date.now() - 30 * 24 * HOUR),
    });
    const q = await makeStaleQuestion(conv.id, "Есть ли парковка?");

    await notifyStaleOwnerQuestions();

    expect(deliveriesTo(conv.id)).toHaveLength(1);
    const after = await prisma.ownerQuestion.findUniqueOrThrow({ where: { id: q.id } });
    expect(after.autoRepliedAt).not.toBeNull();
  });

  it("Telegram: пауза на диалоге тоже держит автоответ", async () => {
    const live = await makeClient("Telegram на паузе");
    const tg = await prisma.telegramConversation.create({
      data: {
        chatId: `oqpause-tg-${runId}`,
        clientId: live.id,
        messages: [],
        pausedUntil: new Date(Date.now() + HOUR),
        botPausedAt: new Date(),
      } as never,
    });
    telegramIds.push(tg.id);
    // Карточка есть — цель берётся через findClientDeliveryTarget (замокан).
    findClientDeliveryTarget.mockResolvedValueOnce({ kind: "telegram", id: tg.id, subscriberId: tg.chatId } as never);
    const q = await prisma.ownerQuestion.create({
      data: {
        conversationId: (await makeConversation(live.id)).id,
        clientId: live.id,
        question: `Когда можно посмотреть? ${runId}`,
        askedAt: new Date(Date.now() - 10 * HOUR),
      },
    });
    questionIds.push(q.id);

    await notifyStaleOwnerQuestions();

    expect(deliveriesTo(tg.id)).toHaveLength(0);
    const after = await prisma.ownerQuestion.findUniqueOrThrow({ where: { id: q.id } });
    expect(after.autoRepliedAt).toBeNull();
  });
});

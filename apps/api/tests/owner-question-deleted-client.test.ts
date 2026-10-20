import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Разведка 07.09.2026 (класс «осиротевшие спутники»): OwnerQuestion — единственный
 * спутник вообще без фильтра при выдаче. Карточка клиента уходила в Корзину, а
 * вопрос «уточню у собственника» продолжал висеть в панели с пустым именем (ответить
 * уже некому), и крон автоответа мог писать в диалог удалённого клиента напрямую —
 * в обход фильтра `deletedAt`, который уже стоял в findClientDeliveryTarget.
 */

const shortAgentReply = vi.fn(async () => "Ещё уточняю, скоро вернусь.");
vi.mock("../src/ai/leadQualifier.js", () => ({ shortAgentReply }));

const deliverToConversation = vi.fn(async () => ({ ok: true, masked: false, pausedUntil: new Date() }));
const findClientDeliveryTarget = vi.fn(async () => null);
vi.mock("../src/lib/conversationDelivery.js", () => ({
  deliverToConversation,
  findClientDeliveryTarget,
  agentSender: vi.fn(async () => ({ kind: "agent" as const, id: "a", fullName: "Агент" })),
}));

const { prisma } = await import("../src/db.js");
const { loadPendingOwnerQuestions } = await import("../src/lib/ownerQuestions.js");
const { answerOwnerQuestion, notifyStaleOwnerQuestions } = await import("../src/lib/ownerQuestionAnswer.js");

const runId = Date.now();
const HOUR = 3600_000;

let agentId = "";
const clientIds: string[] = [];
const conversationIds: string[] = [];
const questionIds: string[] = [];

async function makeClient(name: string, trashed = false) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+992${String(runId).slice(-6)}${clientIds.length}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      ...(trashed ? { deletedAt: new Date() } : {}),
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeConversation(clientId: string | null, channel = "INSTAGRAM") {
  const conv = await prisma.botConversation.create({
    data: { channel, subscriberId: `sub-${runId}-${conversationIds.length}`, clientId, messages: [] },
  });
  conversationIds.push(conv.id);
  return conv;
}

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: {
        fullName: `Агент вопросов собственнику ${runId}`,
        phone: `+992950${String(runId).slice(-6)}`,
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
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("OwnerQuestion и удалённый клиент", () => {
  it("панель не показывает вопрос по карточке, ушедшей в Корзину", async () => {
    const trashed = await makeClient("Ушёл в Корзину", true);
    const conv = await makeConversation(trashed.id);
    const q = await prisma.ownerQuestion.create({
      data: { conversationId: conv.id, clientId: trashed.id, question: `Торг возможен? ${runId}` },
    });
    questionIds.push(q.id);

    const items = await loadPendingOwnerQuestions(100);
    expect(items.find((i) => i.id === q.id)).toBeUndefined();
  });

  it("панель показывает вопрос по живой карточке как обычно", async () => {
    const live = await makeClient("Живая карточка");
    const conv = await makeConversation(live.id);
    const q = await prisma.ownerQuestion.create({
      data: { conversationId: conv.id, clientId: live.id, question: `Свободна на выходных? ${runId}` },
    });
    questionIds.push(q.id);

    const items = await loadPendingOwnerQuestions(100);
    const found = items.find((i) => i.id === q.id);
    expect(found).toBeDefined();
    expect(found?.clientName).toBe(live.fullName);
  });

  it("крон автоответа НЕ пишет в диалог, чья карточка ушла в Корзину", async () => {
    const trashed = await makeClient("Автоответ мимо Корзины", true);
    const conv = await makeConversation(trashed.id);
    const q = await prisma.ownerQuestion.create({
      data: {
        conversationId: conv.id,
        clientId: null, // как и было в момент вопроса — карточка появилась у диалога позже
        question: `Остаётся ли мебель? ${runId}`,
        askedAt: new Date(Date.now() - 10 * HOUR),
      },
    });
    questionIds.push(q.id);

    await notifyStaleOwnerQuestions();

    expect(deliverToConversation).not.toHaveBeenCalled();
    const after = await prisma.ownerQuestion.findUniqueOrThrow({ where: { id: q.id } });
    expect(after.autoRepliedAt).toBeNull();
  });

  it("крон автоответа пишет в диалог, чья карточка жива", async () => {
    const live = await makeClient("Автоответ проходит");
    const conv = await makeConversation(live.id);
    const q = await prisma.ownerQuestion.create({
      data: {
        conversationId: conv.id,
        clientId: null,
        question: `Готовы ли к переезду через месяц? ${runId}`,
        askedAt: new Date(Date.now() - 10 * HOUR),
      },
    });
    questionIds.push(q.id);

    await notifyStaleOwnerQuestions();

    expect(deliverToConversation).toHaveBeenCalledTimes(1);
    const after = await prisma.ownerQuestion.findUniqueOrThrow({ where: { id: q.id } });
    expect(after.autoRepliedAt).not.toBeNull();
  });
});

/**
 * 11.09.2026: ответ собственника на вопрос БЕЗ карточки уходил своей отправкой
 * через Graph API, знавшей только каналы Meta. Клиент из чата на сайте не получал
 * ответа никогда — и молча, без строки в журнале. Теперь путь один и общий.
 */
describe("ответ собственника уходит в любой канал, а не только в Meta", () => {
  it("диалог с сайта без карточки — ответ доставляется общей доставкой", async () => {
    const conv = await makeConversation(null, "WEBSITE");
    const q = await prisma.ownerQuestion.create({
      data: { conversationId: conv.id, clientId: null, question: `Есть ли парковка? ${runId}` },
    });
    questionIds.push(q.id);

    const result = await answerOwnerQuestion(q.id, "Да, парковка своя.", agentId);

    expect(result).toEqual({ ok: true, delivered: true });
    expect(deliverToConversation).toHaveBeenCalledTimes(1);
    const target = deliverToConversation.mock.calls[0][0] as { kind: string; channel: string };
    expect(target).toMatchObject({ kind: "bot", channel: "WEBSITE" });
    const after = await prisma.ownerQuestion.findUniqueOrThrow({ where: { id: q.id } });
    expect(after.deliveredAt).not.toBeNull();
  });
});

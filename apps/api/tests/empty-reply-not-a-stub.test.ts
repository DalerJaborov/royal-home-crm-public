import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomInt } from "node:crypto";
import { waitFor } from "./helpers/waitFor.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ПУСТОЙ ОТВЕТ НЕ ПРЕВРАЩАЕТСЯ В ЗАГЛУШКУ ПРО СБОЙ (20.09.2026, выгрузка 775
 * живых переписок, docs/bot-razbor-20-09.md).
 *
 * Заглушку «ба ҷавоб додан ҳозир бештар вақт лозим аст» в выгрузке за месяц
 * получили 47 раз, и почти всегда без всякого сбоя ИИ: модель отвечала, а её
 * единственный пузырь вычищал dropPhoneAsks после исчерпанного предела просьб о
 * номере (MAX_PHONE_ASKS = 3). То есть человеку сообщали о поломке ровно там, где
 * код нарочно решил промолчать, — худшее из двух возможных сообщений.
 *
 * Здесь стережём оба случая: невалидный пустой результат модели попадает в
 * очередь восстановления; вычищенный фильтрами валидный ответ — в reply chain.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { prisma } = await import("../src/db.js");
const { processMessengerTurn } = await import("../src/messengers/conversation.js");
const { MAX_PHONE_ASKS, countPhoneAsks } = await import("../src/ai/replyRepeatGuard.js");
const { NEUTRAL_REPLIES } = await import("../src/messengers/replyChain.js");

const runId = Date.now().toString(36);
const prefix = `emptyreply-${runId}`;

/** Просьба дать номер — ровно та, что считает countPhoneAsks. */
const PHONE_ASK = "Рақами телефонатонро нависед, то агент тамос гирад.";
const TOPIC = { topic: "price", openQuestion: "", clientAnsweredOpenQuestion: false };

const SETTINGS_SELECT = {
  botReplyDelaySec: true, botReplyMaxWaitSec: true,
  botEnabled: true, botInstagramEnabled: true, botTopicLockEnabled: true,
  botCanBookShowings: true, botCanAskOwner: true, botCanRequestCallback: true,
  botCanHandleVacancies: true, botPromptIntentEconomy: true,
} as const;
let settingsBefore: { [K in keyof typeof SETTINGS_SELECT]: K extends "botReplyDelaySec" | "botReplyMaxWaitSec" ? number : boolean } | null = null;
let fixture: CustomerMessengerFixture;

beforeAll(async () => {
  fixture = await createCustomerMessengerFixture("INSTAGRAM");
  const s = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: SETTINGS_SELECT,
  });
  settingsBefore = s;
  await prisma.settings.update({ where: { id: "singleton" }, data: {
    botReplyDelaySec: 1, botReplyMaxWaitSec: 3,
    botEnabled: true, botInstagramEnabled: true, botTopicLockEnabled: true,
    botCanBookShowings: true, botCanAskOwner: true, botCanRequestCallback: true,
    botCanHandleVacancies: true, botPromptIntentEconomy: false,
  } });
  // Проверка самой заготовки: если формулировка просьбы перестанет считаться
  // просьбой о номере, тест ниже позеленеет по неверной причине.
  expect(countPhoneAsks([PHONE_ASK])).toBe(1);
});

afterAll(async () => {
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  const convs = await prisma.botConversation.findMany({
    where: { endpointScopeId: fixture.transport.endpointScopeId },
    select: { id: true, clientId: true },
  });
  for (const conv of convs) {
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: `ai-reply-retry:${conv.id}` } });
    if (conv.clientId) {
      await prisma.interaction.deleteMany({ where: { clientId: conv.clientId } });
      await prisma.client.deleteMany({ where: { id: conv.clientId } });
    }
  }
  await fixture?.dispose();
});

/** Разговор, в котором бот уже исчерпал предел просьб о номере. */
async function conversationWithSpentPhoneAsks(subscriberId: string): Promise<void> {
  const messages: { role: string; content: string }[] = [];
  for (let i = 0; i < MAX_PHONE_ASKS; i += 1) {
    messages.push({ role: "user", content: `Ищу двухкомнатную в центре, вариант ${i + 1}` });
    messages.push({ role: "assistant", content: PHONE_ASK });
  }
  const conv = await fixture.ensureConversation(subscriberId);
  await prisma.botConversation.update({ where: { id: conv.id }, data: { messages: messages as any } });
}

describe("пустой ответ не превращается в заглушку про сбой", () => {
  /**
   * С 10.10.2026 (аудит ботов, P0-1) «вычистили — молчим» заменено на «не молчим»:
   * модель отвечает второй раз с поправкой, а если и это съедено — короткая
   * нейтральная реплика. Заглушки про сбой ИИ здесь по-прежнему нет.
   */
  const qualifyCalls = () =>
    callAi.mock.calls.filter((c) => (c[0] as { endpoint: string }).endpoint === "lead-qualify") as unknown as [
      { system: string },
    ][];

  it("наши проверки вычистили ответ целиком, второй ход тоже — нейтральная реплика, а не тишина и не «поломка»", async () => {
    const subscriberId = `${prefix}-eaten`;
    await conversationWithSpentPhoneAsks(subscriberId);
    callAi.mockClear();
    // Модель ОТВЕТИЛА — но ровно тем, что dropPhoneAsks обязан вырезать, и дважды.
    callAi.mockResolvedValue({ ...TOPIC, reply: [PHONE_ASK], ready: false, confident: true });

    const result = await processMessengerTurn({
      ...fixture.turnInput(subscriberId),
      text: "А сколько стоит?",
    });

    // Ход модели повторён ровно один раз, с поправкой последним словом промта.
    expect(qualifyCalls()).toHaveLength(2);
    expect(qualifyCalls()[1][0].system).toMatch(/ПОВТОРНАЯ ПОПЫТКА/);
    expect(qualifyCalls()[0][0].system).not.toMatch(/ПОВТОРНАЯ ПОПЫТКА/);
    // Golden Д005: retain established RU; Д111/Д870: neutral wording must not
    // invent a recording. This is a synthetic filtered-empty path, not replay.
    expect(result.reply).toBe(NEUTRAL_REPLIES.question.ru);
    expect(result.reply).not.toMatch(/записал|қайд кардам|позвон|рақам/i);
    expect(result.reply).not.toContain("больше времени");
    expect(result.shouldReply ?? true).toBe(true);
    // Сбоя ИИ не было — маркер очереди повторов не выставляется.
    expect(result.aiUnavailable ?? false).toBe(false);
  });

  it("наши проверки вычистили ответ, второй ход модели ответил по делу — уходит он", async () => {
    const subscriberId = `${prefix}-eaten-retry`;
    await conversationWithSpentPhoneAsks(subscriberId);
    callAi.mockClear();
    const answer = "Цену по этому варианту уточню у агента, торг обсуждается при просмотре.";
    callAi.mockImplementation(async (params: { endpoint: string; system: string }) =>
      params.endpoint === "lead-qualify" && params.system.includes("ПОВТОРНАЯ ПОПЫТКА")
        ? { ...TOPIC, reply: [answer], ready: false, confident: true }
        : { ...TOPIC, reply: [PHONE_ASK], ready: false, confident: true }
    );

    const result = await processMessengerTurn({
      ...fixture.turnInput(subscriberId),
      text: "А сколько стоит?",
    });

    expect(qualifyCalls()).toHaveLength(2);
    expect(result.reply).toMatch(/^Цену по этому варианту уточню у агента/);
  });

  it("модель не дала текста — невалидный результат идёт в очередь восстановления без действий", async () => {
    const subscriberId = `${prefix}-silent-model`;
    callAi.mockClear();
    callAi.mockResolvedValue({ ...TOPIC, reply: [], ready: false, confident: true });

    const result = await processMessengerTurn({
      ...fixture.turnInput(subscriberId),
      text: "Здравствуйте, ищу двухкомнатную квартиру в центре, какой у вас выбор?",
    });

    expect(result.reply).toBe("");
    expect(result.shouldReply).toBe(false);
    expect(result.aiUnavailable).toBe(true);
    const conv = await prisma.botConversation.findUniqueOrThrow({
      where: { endpointScopeId_subscriberId: { endpointScopeId: fixture.transport.endpointScopeId, subscriberId } },
    });
    const job = await waitFor(() => prisma.backgroundJob.findUnique({
      where: { dedupeKey: `ai-reply-retry:${conv.id}` },
    }));
    expect(job).toMatchObject({ type: "ai-reply-retry", payload: { conversationId: conv.id } });
  });

  it("невалидный результат с действиями: ни изменений карточки/показа, ни новых просьб; вход и durable retry сохранены", async () => {
    // There is no historical raw submit_reply in golden200: malformed wire data
    // is synthetic. Д167 supplies only the known-contact preservation obligation.
    const subscriberId = `${prefix}-invalid-actions`;
    const marker = `${prefix}-must-not-be-applied`;
    const agent = await prisma.agent.create({
      data: { fullName: `${prefix}-boundary-agent`, phone: `+99298${randomInt(1_000_000, 10_000_000)}`, role: "AGENT", passwordHash: "unused-test-hash" },
    });
    const client = await prisma.client.create({
      data: { fullName: `${prefix}-boundary-client`, phone: `+99299${randomInt(1_000_000, 10_000_000)}`, source: "INSTAGRAM", acceptedAt: new Date(), desiredRooms: 2, assignedAgentId: agent.id },
    });
    let conversationId: string | null = null;
    try {
      const showing = await prisma.interaction.create({
        data: { clientId: client.id, agentId: agent.id, type: "SHOWING", notes: marker, nextAction: "Показ объекта", nextActionDate: new Date(Date.now() + 2 * 86_400_000) },
      });
      const draft = { stage: "done", intent: "buy", rooms: 2 };
      const native = await fixture.ensureConversation(subscriberId);
      const conv = await prisma.botConversation.update({
        where: { id: native.id },
        data: {
          clientId: client.id, leadDraft: draft,
          messages: [{ role: "user", content: "Ищу двухкомнатную квартиру" }, { role: "assistant", content: "Что хотите уточнить по квартире?" }],
        },
      });
      conversationId = conv.id;
      callAi.mockClear();
      callAi.mockResolvedValue({
        ...TOPIC, reply: ["Уточнение принято"], ready: "false", confident: true, intent: "buy",
        lead: { rooms: 3, notes: marker }, showing: { action: "cancel" },
        askOwner: marker, callbackRequest: marker, jobApplication: { summary: marker },
      });
      const clientText = "Пожалуйста, уточните детали по моему запросу.";
      const result = await processMessengerTurn({ ...fixture.turnInput(subscriberId), text: clientText });
      expect(qualifyCalls()).toHaveLength(1);
      expect(result).toMatchObject({ reply: "", shouldReply: false, aiUnavailable: true, accepted: true });
      expect(result.reply2).toBeUndefined();

      const job = await waitFor(() => prisma.backgroundJob.findUnique({
        where: { dedupeKey: `ai-reply-retry:${conv.id}` },
      }), { label: "invalid action-bearing reply recovery" });
      expect(job).toMatchObject({ type: "ai-reply-retry", status: "PENDING", payload: { conversationId: conv.id } });
      const saved = await prisma.botConversation.findUniqueOrThrow({ where: { id: conv.id } });
      expect(saved.clientId).toBe(client.id);
      expect(saved.leadDraft).toEqual(draft);
      expect(saved.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", content: clientText })]));
      expect((saved.messages as Array<{ role: string; content: string }>).filter((m) => m.role === "assistant").map((m) => m.content))
        .toEqual(["Что хотите уточнить по квартире?"]);
      expect(await prisma.client.findUniqueOrThrow({ where: { id: client.id }, select: { desiredRooms: true, requirementsNotes: true } }))
        .toEqual({ desiredRooms: 2, requirementsNotes: null });
      expect(await prisma.interaction.findUniqueOrThrow({ where: { id: showing.id }, select: { nextAction: true, nextActionDate: true } }))
        .toEqual({ nextAction: showing.nextAction, nextActionDate: showing.nextActionDate });
      expect(await prisma.interaction.count({ where: { clientId: client.id, type: "SHOWING" } })).toBe(1);
      expect(await prisma.ownerQuestion.count({ where: { conversationId: conv.id } })).toBe(0);
      expect(await prisma.callbackRequest.count({ where: { OR: [{ conversationId: conv.id }, { clientId: client.id }] } })).toBe(0);
      expect(await prisma.jobApplication.count({ where: { conversationId: conv.id } })).toBe(0);
    } finally {
      if (conversationId) {
        await prisma.backgroundJob.deleteMany({ where: { dedupeKey: `ai-reply-retry:${conversationId}` } });
        await prisma.ownerQuestion.deleteMany({ where: { conversationId } });
        await prisma.jobApplication.deleteMany({ where: { conversationId } });
        await prisma.callbackRequest.deleteMany({ where: { OR: [{ conversationId }, { clientId: client.id }] } });
        await fixture.cleanupConversations();
      }
      await prisma.interaction.deleteMany({ where: { clientId: client.id } });
      await prisma.client.deleteMany({ where: { id: client.id } });
      await prisma.agent.deleteMany({ where: { id: agent.id } });
    }
  });
});

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * Задания telegram-reply-retry / telegram-dm-reply-retry (13.09.2026, тот же
 * чертёж Б2, что и ai-reply-retry для каналов Meta): проверяем гварды
 * «повторять нечего» и то, что успешный ход зовёт finishTelegram*QualifyTurn
 * ровно тем же кодом, что и обычный (не повторный) ход. Модель и доставка
 * замоканы — их контракт покрывают telegram-repeat-and-question-guards.test.ts
 * и voice-delivery.test.ts.
 *
 * telegram/bot.ts и messengers/telegramDirectMessages.ts подменяются ЦЕЛИКОМ
 * (без importOriginal), тем же приёмом, что ai-reply-retry-job.test.ts делает
 * для stuckConversations.js: настоящие модули тянут за собой webhook-приём,
 * альбомы, весь messengers/* — лишнее для теста одной ветки задания.
 */
const finishTelegramQualifyTurn = vi.hoisted(() => vi.fn(async () => {}));
const runQualifyTurn = vi.hoisted(() => vi.fn(async () => null as null | { reply: string; ready: boolean }));
const sendPushToAgent = vi.hoisted(() => vi.fn(async () => 1));

vi.mock("../src/telegram/bot.js", () => ({ finishTelegramQualifyTurn }));
vi.mock("../src/ai/customerChannelTurn.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/customerChannelTurn.js")>()), runCustomerChannelTurn: runQualifyTurn }));
vi.mock("../src/messengers/botCapabilities.js", () => ({
  loadBotCapabilities: async () => ({ callback: false }),
  botAbilitiesOf: () => ({}),
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent }));
vi.mock("../src/lib/recipients.js", () => ({ findAgentsWithPermission: async () => ["agent-1"] }));

import { prisma } from "../src/db.js";
import { telegramReplyRetryJob } from "../src/jobs/telegramReplyRetry.js";

beforeEach(() => {
  finishTelegramQualifyTurn.mockClear();
  runQualifyTurn.mockReset();
  sendPushToAgent.mockClear();
});

describe("задание telegram-reply-retry (личка с ботом)", () => {
  const chatId = `retry-tg-${Date.now()}`;
  let conversationId = "";

  afterAll(async () => {
    if (conversationId) await prisma.telegramConversation.deleteMany({ where: { id: conversationId } });
  });

  it("последняя реплика клиентская → проигрывает ход по свежей истории, зовёт finishTelegramQualifyTurn", async () => {
    const c = await prisma.telegramConversation.create({
      data: { chatId, messages: [{ role: "user", content: "нархаш чанд?" }], leadDraft: { stage: "chatting" } },
    });
    conversationId = c.id;
    runQualifyTurn.mockResolvedValueOnce({ reply: "Норм", ready: false });

    await expect(telegramReplyRetryJob.run({ conversationId: c.id })).resolves.toBeUndefined();

    expect(runQualifyTurn).toHaveBeenCalledOnce();
    expect(finishTelegramQualifyTurn).toHaveBeenCalledOnce();
    expect(finishTelegramQualifyTurn.mock.calls[0][0]).toMatchObject({ text: "нархаш чанд?" });
  });

  it("уже отвечено (последняя реплика — бот) → повтора нет", async () => {
    const c = await prisma.telegramConversation.create({
      data: {
        chatId: `${chatId}-answered`,
        messages: [
          { role: "user", content: "вопрос" },
          { role: "assistant", content: "ответ более свежего хода" },
        ],
      },
    });
    await expect(telegramReplyRetryJob.run({ conversationId: c.id })).resolves.toBeUndefined();
    expect(runQualifyTurn).not.toHaveBeenCalled();
    await prisma.telegramConversation.delete({ where: { id: c.id } });
  });

  it("оператор ведёт диалог (pausedUntil в будущем) → бот не лезет", async () => {
    const c = await prisma.telegramConversation.create({
      data: {
        chatId: `${chatId}-paused`,
        messages: [{ role: "user", content: "вопрос" }],
        pausedUntil: new Date(Date.now() + 60 * 60_000),
      },
    });
    await expect(telegramReplyRetryJob.run({ conversationId: c.id })).resolves.toBeUndefined();
    expect(runQualifyTurn).not.toHaveBeenCalled();
    await prisma.telegramConversation.delete({ where: { id: c.id } });
  });

  it("модель всё ещё лежит → задание падает (лесенка повторов подхватит)", async () => {
    const c = await prisma.telegramConversation.create({
      data: { chatId: `${chatId}-down`, messages: [{ role: "user", content: "вопрос" }] },
    });
    runQualifyTurn.mockResolvedValueOnce(null);
    await expect(telegramReplyRetryJob.run({ conversationId: c.id })).rejects.toThrow();
    expect(finishTelegramQualifyTurn).not.toHaveBeenCalled();
    await prisma.telegramConversation.delete({ where: { id: c.id } });
  });

  it("сдача (onGiveUp) ставит диалог на паузу и зовёт персонал пушем", async () => {
    const c = await prisma.telegramConversation.create({
      data: { chatId: `${chatId}-giveup`, messages: [{ role: "user", content: "вопрос" }] },
    });
    await telegramReplyRetryJob.onGiveUp({ conversationId: c.id });
    const after = await prisma.telegramConversation.findUnique({ where: { id: c.id } });
    expect(after?.pausedUntil).toBeTruthy();
    expect(sendPushToAgent).toHaveBeenCalledOnce();
    // «Сообщения» узнают Telegram-диалог по префиксу tg_ — без него пуш вёл в
    // пустоту (23.09.2026, аудит №17).
    const push = (sendPushToAgent.mock.calls[0] as unknown as [unknown, { url: string }])[1];
    expect(push.url).toBe(`/messages?open=tg_${c.id}`);
    await prisma.telegramConversation.delete({ where: { id: c.id } });
  });
});

// Direct Messages retry: the model reply of that channel was retired (one brain, step 3, 16.11.2026);
// see tests/telegram-direct-auto-reply-retired.test.ts.

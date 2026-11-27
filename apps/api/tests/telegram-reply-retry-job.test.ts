import { useTelegramClientBot } from "./helpers/telegramClientBot.js";
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";

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
const finishTelegramDirectQualifyTurn = vi.hoisted(() => vi.fn(async () => {}));
const runQualifyTurn = vi.hoisted(() => vi.fn(async () => null as null | { reply: string; ready: boolean }));
const sendPushToAgent = vi.hoisted(() => vi.fn(async () => 1));

vi.mock("../src/telegram/bot.js", () => ({ finishTelegramQualifyTurn }));
// Рубильник Direct Messages повтор теперь спрашивает, как живой ход (03.10.2026,
// аудит audit-1, находка 14); здесь он включён — проверяется сам повтор. Подмена
// узкая намеренно (см. .vi-mock-baseline.json): настоящий модуль тянет
// подменённый выше leadQualifier целиком.
vi.mock("../src/messengers/telegramDirectMessages.js", () => ({
  finishTelegramDirectQualifyTurn,
  isTelegramDirectMessagesEnabled: async () => true,
}));
vi.mock("../src/ai/leadQualifier.js", () => ({ runQualifyTurn }));
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
import { telegramDirectReplyRetryJob } from "../src/jobs/telegramDirectReplyRetry.js";
import { customerAgentHandoverLine } from "../src/ai/customerAgentRenderer.js";
import { claimChannelCoreRun } from "../src/lib/customerChannelCore.js";
// Клиентский путь Telegram — при выключенном «боте только для сотрудников» (27.11.2026).
useTelegramClientBot();

beforeEach(() => {
  finishTelegramQualifyTurn.mockClear();
  finishTelegramDirectQualifyTurn.mockClear();
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

describe("задание telegram-dm-reply-retry (Direct Messages)", () => {
  it("последняя реплика клиентская → проигрывает ход, зовёт finishTelegramDirectQualifyTurn", async () => {
    const c = await prisma.telegramDirectConversation.create({
      data: { chatId: `retry-dm-${Date.now()}`, topicId: "42", messages: [{ role: "user", content: "салом" }] },
    });
    runQualifyTurn.mockResolvedValueOnce({ reply: "Ассалому алейкум", ready: false });

    await expect(telegramDirectReplyRetryJob.run({ conversationId: c.id })).resolves.toBeUndefined();

    expect(finishTelegramDirectQualifyTurn).toHaveBeenCalledOnce();
    expect(finishTelegramDirectQualifyTurn.mock.calls[0][0]).toMatchObject({ text: "салом", topicId: 42 });
    await prisma.telegramDirectConversation.delete({ where: { id: c.id } });
  });

  it("уже отвечено → повтора нет", async () => {
    const c = await prisma.telegramDirectConversation.create({
      data: {
        chatId: `retry-dm-answered-${Date.now()}`,
        topicId: "43",
        messages: [
          { role: "user", content: "вопрос" },
          { role: "assistant", content: "ответ" },
        ],
      },
    });
    await expect(telegramDirectReplyRetryJob.run({ conversationId: c.id })).resolves.toBeUndefined();
    expect(runQualifyTurn).not.toHaveBeenCalled();
    await prisma.telegramDirectConversation.delete({ where: { id: c.id } });
  });

  it("сдача не снимает бота и не зовёт пушем в диалог, которого нет в «Сообщениях» (аудит 23.09.2026, №37)", async () => {
    // Ответить руками из CRM в личных сообщениях канала нельзя: снятый бот значил,
    // что клиенту не ответит никто, а пуш вёл на «Диалог не найден».
    const c = await prisma.telegramDirectConversation.create({
      data: { chatId: `retry-dm-giveup-${Date.now()}`, topicId: "44", messages: [{ role: "user", content: "салом" }] },
    });
    sendPushToAgent.mockClear();
    await telegramDirectReplyRetryJob.onGiveUp?.({ conversationId: c.id });

    const after = await prisma.telegramDirectConversation.findUnique({ where: { id: c.id } });
    expect(after?.pausedUntil ?? null).toBeNull();
    expect(sendPushToAgent).not.toHaveBeenCalled();
    await prisma.telegramDirectConversation.delete({ where: { id: c.id } });
  });
});

/**
 * Ревью #223 R1 (17.11.2026): в режиме ядра повтор хода — не больше трёх прогонов. Задание передаёт номер своей попытки
 * (раннер: context.attempt), дверь считает прогон = попытка + 1 (живой ход был первым). После третьего — сотрудник и строка
 * «передал сотруднику», модель больше не зовётся. Пустой env — старый бот и его лесенка, как раньше.
 * С ревью 0e463b02 N2 решает счёт САМОГО сообщения в базе (номер задания — только запасной): поэтому три прошлых прогона
 * этого сообщения (живой ход и две попытки задания) занимаются здесь той же дверью, что у настоящих прогонов.
 */
const spendThreeRuns = async (channel: "TELEGRAM" | "TELEGRAM_DIRECT", conversationId: string) => {
  for (let run = 1; run <= 3; run++) expect(await claimChannelCoreRun({ channel, conversationId })).toBe(run);
};
const dropRuns = (channel: string, id: string) =>
  prisma.processedMessage.deleteMany({ where: { channel: "channel-core-run", messageId: { startsWith: `${channel}:${id}:` } } });
describe("ревью #223 R1: потолок повторов ядра в заданиях Telegram", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("ядро, попытка задания 3 (прогон 4) → без вызова модели: строка передачи уходит тем же finishTelegramQualifyTurn, пуш сотруднику", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "telegram");
    const c = await prisma.telegramConversation.create({
      data: { chatId: `retry-tg-cap-${Date.now()}`, messages: [{ role: "user", content: "Нархаш чанд?" }], leadDraft: { stage: "chatting" } },
    });
    await spendThreeRuns("TELEGRAM", c.id);
    await expect(telegramReplyRetryJob.run({ conversationId: c.id }, { attempt: 3 })).resolves.toBeUndefined();
    expect(runQualifyTurn).not.toHaveBeenCalled();
    expect(finishTelegramQualifyTurn).toHaveBeenCalledOnce();
    const turn = (finishTelegramQualifyTurn.mock.calls[0] as unknown as [{ turn: { reply: string[]; verified?: boolean } }])[0].turn;
    expect(turn).toMatchObject({ reply: [customerAgentHandoverLine("tg")], verified: true });
    expect(sendPushToAgent).toHaveBeenCalledOnce();
    await prisma.processedMessage.deleteMany({ where: { channel: "channel-staff-alert", messageId: { startsWith: `tg:${c.id}:` } } });
    await dropRuns("TELEGRAM", c.id);
    await prisma.telegramConversation.delete({ where: { id: c.id } });
  });

  it("личка канала (ядро telegram_direct), попытка 3 → строка передачи через finishTelegramDirectQualifyTurn", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "telegram_direct");
    const c = await prisma.telegramDirectConversation.create({
      data: { chatId: `retry-dm-cap-${Date.now()}`, topicId: "45", messages: [{ role: "user", content: "Сколько стоит?" }] },
    });
    await spendThreeRuns("TELEGRAM_DIRECT", c.id);
    await expect(telegramDirectReplyRetryJob.run({ conversationId: c.id }, { attempt: 3 })).resolves.toBeUndefined();
    expect(runQualifyTurn).not.toHaveBeenCalled();
    const turn = (finishTelegramDirectQualifyTurn.mock.calls[0] as unknown as [{ turn: { reply: string[] } }])[0].turn;
    expect(turn.reply).toEqual([customerAgentHandoverLine("ru")]);
    await prisma.processedMessage.deleteMany({ where: { channel: "channel-staff-alert", messageId: { startsWith: `td:${c.id}:` } } });
    await dropRuns("TELEGRAM_DIRECT", c.id);
    await prisma.telegramDirectConversation.delete({ where: { id: c.id } });
  });

  it("пустой env: попытка задания 9 → старый бот, как раньше (лесенка 46 ступеней не тронута)", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "");
    const c = await prisma.telegramConversation.create({
      data: { chatId: `retry-tg-legacy-${Date.now()}`, messages: [{ role: "user", content: "вопрос" }] },
    });
    runQualifyTurn.mockResolvedValueOnce(null);
    await expect(telegramReplyRetryJob.run({ conversationId: c.id }, { attempt: 9 })).rejects.toThrow(/недоступен/);
    expect(runQualifyTurn).toHaveBeenCalledOnce();
    expect(finishTelegramQualifyTurn).not.toHaveBeenCalled();
    await prisma.telegramConversation.delete({ where: { id: c.id } });
  });
});

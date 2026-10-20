import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ВОПРОС КАНДИДАТА О ЗАРПЛАТЕ В TELEGRAM НЕ ГЛУШИТСЯ (AI-GUARD01, аудит 04.10.2026).
 *
 * Исключение для соискателей («какая зарплата?» это первый вопрос любого кандидата)
 * жило в guardOffTopic, но ранний фильтр screenIncomingText не пробрасывал туда
 * признак «разговор о работе», и в Telegram (бот и Direct Messages) вопрос
 * получал полное молчание ещё до модели. Транспорт и модель подменены.
 */
const { sendMessage, callAiText } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string, _replyTo?: number, _topicId?: number) => {}),
  callAiText: vi.fn(),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
}));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));
delete process.env.TELEGRAM_BOT_TOKEN;

const { prisma } = await import("../src/db.js");
const { screenIncomingText } = await import("../src/ai/inboundScreen.js");
const { handleTelegramDirectMessage } = await import("../src/messengers/telegramDirectMessages.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");
const { instantBotReplyWindow } = await import("./helpers/botReplyWindow.js");

const runId = Date.now();
const DM_CHAT_ID = -(3_300_000_000_000 + (runId % 1_000_000_000));
const BOT_CHAT_ID = 760000000 + (runId % 1_000_000);
const TOPIC = 730000000 + (runId % 1000);
const SALARY = "Какая зарплата?";
const aiReply = { reply: ["Зарплата зависит от продаж."], ready: false, intent: "job", confident: true };

const SELECT = {
  botEnabled: true,
  botTelegramEnabled: true,
  telegramOwnerChatId: true,
  telegramDirectMessagesEnabled: true,
} as const;
let saved: Record<string, unknown>;
let restoreWindow: (() => Promise<void>) | undefined;

beforeAll(async () => {
  saved = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" }, select: SELECT });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botEnabled: true, botTelegramEnabled: true, telegramOwnerChatId: null, telegramDirectMessagesEnabled: true },
  });
  restoreWindow = await instantBotReplyWindow();
});

afterAll(async () => {
  await prisma.telegramDirectConversation.deleteMany({ where: { chatId: String(DM_CHAT_ID) } });
  await prisma.telegramConversation.deleteMany({ where: { chatId: String(BOT_CHAT_ID) } });
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await restoreWindow?.();
});

beforeEach(() => {
  sendMessage.mockClear();
  callAiText.mockReset();
  callAiText.mockResolvedValue(aiReply);
});

describe("ранний фильтр: зарплата соискателя", () => {
  it("в разговоре о работе вопрос о зарплате проходит, вне него глушится", () => {
    expect(screenIncomingText(SALARY, { jobConversation: true }).action).toBe("pass");
    expect(screenIncomingText(SALARY).action).toBe("silent");
  });
});

describe("Telegram: кандидат спрашивает про зарплату", () => {
  it("Direct Messages: диалог с intent=job доходит до модели", async () => {
    await prisma.telegramDirectConversation.create({
      data: {
        chatId: String(DM_CHAT_ID),
        topicId: String(TOPIC),
        fromUserId: String(TOPIC),
        username: "cand_salary",
        messages: [{ role: "user", content: "Салом, кор ҳаст?" }] as object[],
        leadDraft: { stage: "chatting", intent: "job" } as object,
        lastMessageAt: new Date(),
      },
    });

    await handleTelegramDirectMessage({
      chat: { id: DM_CHAT_ID, type: "supergroup", is_direct_messages: true },
      from: { id: TOPIC, username: "cand_salary" },
      text: SALARY,
      direct_messages_topic: { topic_id: TOPIC, user: { id: TOPIC, is_bot: false, username: "cand_salary" } },
    } as never);

    expect(callAiText).toHaveBeenCalled();
  }, 20_000);

  it("личка бота: диалог с intent=job доходит до модели", async () => {
    await prisma.telegramConversation.create({
      data: {
        chatId: String(BOT_CHAT_ID),
        username: "cand_salary_bot",
        messages: [{ role: "user", content: "Салом, кор ҳаст?" }] as object[],
        leadDraft: { stage: "chatting", intent: "job" } as object,
        lastMessageAt: new Date(),
      },
    });

    await handleTelegramUpdate({
      update_id: runId % 1_000_000_000,
      message: { chat: { id: BOT_CHAT_ID }, from: { username: "cand_salary_bot" }, text: SALARY },
    });

    expect(callAiText).toHaveBeenCalled();
  }, 20_000);
});

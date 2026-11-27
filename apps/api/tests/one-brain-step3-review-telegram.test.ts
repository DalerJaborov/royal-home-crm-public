import { useTelegramClientBot } from "./helpers/telegramClientBot.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// Клиентский путь Telegram — при выключенном «боте только для сотрудников» (27.11.2026).
useTelegramClientBot();

/**
 * Re-review of #223 (17.11.2026), end to end on the real Telegram bodies and the real database:
 *  N2 — direct messages of the Telegram channel have their own switch key: `CHANNEL_CORE=telegram` leaves them on the old
 *       bot; `telegram_direct` moves them, and the core's staff alert finds the chat in TelegramDirectConversation (a push
 *       goes out and the customer hears the handover line — before the fix: `skipped`, no push, no line);
 *  N4 — after the core's verified text neither the bot nor the direct-message body sends a second «write your number».
 * Telegram transport, the push and the core run are faked; the legacy door, the channel bodies and the alert are real.
 */
const f = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string, _replyTo?: number, _topicId?: number) => {}),
  requestContact: vi.fn(async (_chatId: string, _text: string) => {}),
  callAiText: vi.fn(),
  channelCore: vi.fn(),
  push: vi.fn(async () => {}),
}));
vi.mock("../src/telegram/api.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage: f.sendMessage, requestContact: f.requestContact }));
vi.mock("../src/ai/client.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: f.callAiText }));
vi.mock("../src/lib/customerChannelCore.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerChannelCore.js")>()),
  runChannelCoreTurn: f.channelCore }));
vi.mock("../src/push.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents: f.push }));
vi.mock("../src/lib/recipients.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/recipients.js")>()),
  findAgentsWithPermission: async () => ["agent-on-duty"] }));

delete process.env.TELEGRAM_BOT_TOKEN;

const { prisma } = await import("../src/db.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");
const { handleTelegramDirectMessage } = await import("../src/messengers/telegramDirectMessages.js");
const { customerAgentHandoverLine } = await import("../src/ai/customerAgentRenderer.js");
const { instantBotReplyWindow } = await import("./helpers/botReplyWindow.js");

const runId = Date.now();
const DM_CHAT_ID = -(2_300_000_000_000 + (runId % 1_000_000_000));
const BOT_CHAT_ID = String(784000000 + (runId % 100000));
let nextUpdateId = runId % 1_000_000_000;
let nextMessageId = 5000;
const SELECT = { botEnabled: true, botTelegramEnabled: true, telegramOwnerChatId: true, telegramDirectMessagesEnabled: true,
  workHoursStart: true, workHoursEnd: true } as const;
let saved: Record<string, unknown> = {};
let restoreReplyWindow: (() => Promise<void>) | undefined;

const CORE_TEXT = "Ташаккур, дархости шумо қабул шуд.";
const verifiedReply = { status: "reply", text: CORE_TEXT, askedPhone: false, intake: { role: "buyer" } };

function dmUpdate(topicId: number, text: string) {
  return { message_id: nextMessageId++, chat: { id: DM_CHAT_ID, type: "supergroup", is_direct_messages: true },
    from: { id: topicId, username: `dm_${topicId}` }, text,
    direct_messages_topic: { topic_id: topicId, user: { id: topicId, is_bot: false, username: `dm_user_${topicId}` } } };
}
const allSent = () => [...f.sendMessage.mock.calls.map(call => call[1]), ...f.requestContact.mock.calls.map(call => call[1])];

beforeAll(async () => {
  saved = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" }, select: SELECT });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, botTelegramEnabled: true, telegramOwnerChatId: null,
    telegramDirectMessagesEnabled: true, workHoursStart: "00:00", workHoursEnd: "24:00" } });
  restoreReplyWindow = await instantBotReplyWindow();
});
afterAll(async () => {
  await restoreReplyWindow?.();
  await prisma.settings.update({ where: { id: "singleton" }, data: saved as never });
  const direct = await prisma.telegramDirectConversation.findMany({ where: { chatId: String(DM_CHAT_ID) }, select: { id: true } });
  const bot = await prisma.telegramConversation.findMany({ where: { chatId: BOT_CHAT_ID }, select: { id: true } });
  await prisma.processedMessage.deleteMany({ where: { channel: "channel-staff-alert",
    OR: [...direct.map(row => ({ messageId: { startsWith: `td:${row.id}:` } })), ...bot.map(row => ({ messageId: { startsWith: `tg:${row.id}:` } }))] } });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: [...direct.map(row => `telegram-dm-reply-retry:${row.id}`),
    ...bot.map(row => `telegram-reply-retry:${row.id}`)] } } });
  await prisma.telegramDirectConversation.deleteMany({ where: { chatId: String(DM_CHAT_ID) } });
  await prisma.telegramConversation.deleteMany({ where: { chatId: BOT_CHAT_ID } });
});
beforeEach(() => {
  f.sendMessage.mockClear(); f.requestContact.mockClear(); f.callAiText.mockReset(); f.channelCore.mockReset(); f.push.mockClear();
  vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", ""); vi.stubEnv("CUSTOMER_AGENT_CHANNEL_SHADOW", "");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("N2: Telegram channel direct messages", () => {
  it("`CHANNEL_CORE=telegram` does not take them: the old bot answers there, the core is not called", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "telegram");
    f.callAiText.mockResolvedValue({ reply: ["Здравствуйте! Чем можем помочь?"], ready: false, intent: "buy", confident: true });
    await handleTelegramDirectMessage(dmUpdate(731000000 + (runId % 1000), "Здравствуйте, ищу квартиру") as never);
    expect(f.channelCore).not.toHaveBeenCalled();
    expect(f.callAiText).toHaveBeenCalled();
    expect(allSent()).toEqual(["Здравствуйте! Чем можем помочь?"]);
  }, 30_000);

  it("`telegram_direct` + the core calls a person: a push from the RIGHT table, and the customer hears the handover line", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "telegram_direct");
    f.channelCore.mockResolvedValue({ status: "staff", reason: "escalate", intake: { role: "unknown" }, language: "ru" });
    await handleTelegramDirectMessage(dmUpdate(732000000 + (runId % 1000), "Позовите, пожалуйста, человека") as never);
    expect(f.channelCore.mock.calls[0][0]).toMatchObject({ channel: "TELEGRAM_DIRECT", channelKey: "telegram_direct" });
    expect(f.callAiText).not.toHaveBeenCalled();
    expect(f.push).toHaveBeenCalledTimes(1);
    expect(f.push.mock.calls[0]).toEqual([["agent-on-duty"], expect.objectContaining({
      body: expect.stringContaining("Ответить можно только в самом Telegram") })]);
    expect(allSent()).toEqual([customerAgentHandoverLine("ru")]);
  }, 30_000);

  it("N4 here too: the core's verified text goes out as is, no second phone ask while «waiting for the number»", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "telegram_direct");
    const topicId = 733000000 + (runId % 1000);
    await prisma.telegramDirectConversation.create({ data: { chatId: String(DM_CHAT_ID), topicId: String(topicId), username: `dm_user_${topicId}`,
      leadDraft: { stage: "awaiting_phone", intent: "buy", confident: true } as never,
      messages: [{ role: "user", content: "Ищу двушку в Сино" }, { role: "assistant", content: "Какой у вас бюджет?" }] as never,
      lastMessageAt: new Date() } });
    f.channelCore.mockResolvedValue(verifiedReply);
    await handleTelegramDirectMessage(dmUpdate(topicId, "До 600 тысяч сомони") as never);
    expect(allSent()).toEqual([CORE_TEXT]);
  }, 30_000);
});

describe("N4: Telegram bot after the core's verified text", () => {
  it("«waiting for the number» left from an earlier turn does not add «write your number» after the core's reply", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "telegram");
    await prisma.telegramConversation.create({ data: { chatId: BOT_CHAT_ID, username: `n4_${runId}`,
      leadDraft: { stage: "awaiting_phone", intent: "buy", confident: true } as never,
      messages: [{ role: "user", content: "Ищу двушку в Сино" }, { role: "assistant", content: "Какой у вас бюджет?" }] as never,
      lastMessageAt: new Date() } });
    f.channelCore.mockResolvedValue(verifiedReply);
    await handleTelegramUpdate({ update_id: nextUpdateId++, message: { message_id: nextMessageId++,
      chat: { id: Number(BOT_CHAT_ID), type: "private" }, from: { id: Number(BOT_CHAT_ID), username: `n4_${runId}`, first_name: "Фарход" },
      text: "До 600 тысяч сомони" } } as never);
    expect(f.channelCore).toHaveBeenCalledTimes(1);
    expect(allSent()).toEqual([CORE_TEXT]);
  }, 30_000);
});

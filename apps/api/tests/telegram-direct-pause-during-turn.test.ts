import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ПАУЗА, ПОСТАВЛЕННАЯ ПОКА БОТ ДУМАЛ — Direct Messages канала (аудит Codex
 * 04.10.2026, находка №11). `isPaused` считался один раз по строке диалога,
 * прочитанной в начале хода; если сотрудник ответил из самого Telegram, пока
 * модель думала, ветка fromStaff записывала его реплику и ставила `pausedUntil`,
 * а ход бота этого не замечал и отправлял свою реплику поверх. В каналах Meta
 * (messengers/conversation.ts) и личке бота (telegram/bot.ts) пауза перечитывается
 * после модели; здесь — в `finishTelegramDirectQualifyTurn`, которую зовут и живой
 * ход, и фоновый повтор jobs/telegramDirectReplyRetry.ts.
 *
 * Транспорт и модель подменены; окно «пока бот думал» — управляемый deferred на
 * вызове модели.
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
const { handleTelegramDirectMessage } = await import("../src/messengers/telegramDirectMessages.js");
const { telegramDirectReplyRetryJob } = await import("../src/jobs/telegramDirectReplyRetry.js");

const runId = Date.now();
const DM_CHAT_ID = -(3_000_000_000_000 + (runId % 1_000_000_000));
const STAFF_USER_ID = 5_550_000;

type SettingsSnapshot = {
  botEnabled: boolean;
  botTelegramEnabled: boolean;
  telegramOwnerChatId: string | null;
  telegramDirectMessagesEnabled: boolean;
};
const SELECT = {
  botEnabled: true,
  botTelegramEnabled: true,
  telegramOwnerChatId: true,
  telegramDirectMessagesEnabled: true,
} as const;
let savedSettings: SettingsSnapshot;
let nextUpdateId = runId % 1_000_000_000;

function dmUpdate(topicId: number, text: string, fromId = topicId) {
  return {
    update_id: nextUpdateId++,
    message: {
      chat: { id: DM_CHAT_ID, type: "supergroup", is_direct_messages: true },
      from: { id: fromId, username: fromId === topicId ? "client_pause" : "channel_admin" },
      text,
      direct_messages_topic: { topic_id: topicId, user: { id: topicId, is_bot: false, username: "client_pause" } },
    },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function waitFor(cond: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`не дождались: ${label}`);
}

const aiReply = { reply: ["Здравствуйте! Чем можем помочь?"], ready: false, intent: "buy", confident: true };

beforeAll(async () => {
  savedSettings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: SELECT,
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botEnabled: true, botTelegramEnabled: true, telegramOwnerChatId: null, telegramDirectMessagesEnabled: true },
  });
});

afterAll(async () => {
  await prisma.telegramDirectConversation.deleteMany({ where: { chatId: String(DM_CHAT_ID) } });
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
});

beforeEach(() => {
  sendMessage.mockClear();
  callAiText.mockReset();
});

describe("Direct Messages: сотрудник ответил, пока бот думал", () => {
  it("живой ход: ответ бота не уходит и не пишется в переписку, реплика сотрудника остаётся", async () => {
    const topic = 710000000 + (runId % 1000);
    const gate = deferred<typeof aiReply>();
    callAiText.mockImplementation(() => gate.promise);

    // Прямо handleTelegramDirectMessage, мимо цепочки чата (chatChains в telegram/bot.ts):
    // там апдейты одного chat.id идут строго по очереди, и реплика сотрудника встала бы
    // ЗА ходом бота. Гонка живёт там, где очереди нет: фоновый повтор, второй процесс.
    const turn = handleTelegramDirectMessage(dmUpdate(topic, "Здравствуйте, ищу квартиру").message);
    await waitFor(() => callAiText.mock.calls.length > 0, "вызов модели");

    // Сотрудник отвечает из Telegram, пока модель «думает».
    await handleTelegramDirectMessage(dmUpdate(topic, "Добрый день, это менеджер, сейчас подключусь", STAFF_USER_ID).message);
    gate.resolve(aiReply);
    await turn;

    expect(sendMessage).not.toHaveBeenCalled();
    const row = await prisma.telegramDirectConversation.findUnique({
      where: { chatId_topicId: { chatId: String(DM_CHAT_ID), topicId: String(topic) } },
    });
    const messages = (row?.messages ?? []) as Array<{ role: string; content: string; by?: { kind: string } }>;
    expect(messages.some((m) => m.by?.kind === "bot")).toBe(false);
    expect(messages.some((m) => m.by?.kind === "manual" && m.content.includes("менеджер"))).toBe(true);
    expect(row?.pausedUntil && row.pausedUntil.getTime() > Date.now()).toBe(true);
  });

  it("повтор фоновым заданием: тот же результат", async () => {
    const topic = 720000000 + (runId % 1000);
    const conversation = await prisma.telegramDirectConversation.create({
      data: {
        chatId: String(DM_CHAT_ID),
        topicId: String(topic),
        messages: [{ role: "user", content: "Здравствуйте, ищу квартиру" }],
      },
    });
    const gate = deferred<typeof aiReply>();
    callAiText.mockImplementation(() => gate.promise);

    const retry = telegramDirectReplyRetryJob.run({ conversationId: conversation.id });
    await waitFor(() => callAiText.mock.calls.length > 0, "вызов модели в повторе");
    await prisma.telegramDirectConversation.update({
      where: { id: conversation.id },
      data: { pausedUntil: new Date(Date.now() + 10 * 60_000) },
    });
    gate.resolve(aiReply);
    await retry;

    expect(sendMessage).not.toHaveBeenCalled();
    const row = await prisma.telegramDirectConversation.findUnique({ where: { id: conversation.id } });
    const messages = (row?.messages ?? []) as Array<{ by?: { kind: string } }>;
    expect(messages.some((m) => m.by?.kind === "bot")).toBe(false);
  });

  it("без вмешательства сотрудника бот отвечает как прежде", async () => {
    const topic = 730000000 + (runId % 1000);
    callAiText.mockResolvedValue(aiReply);
    await handleTelegramDirectMessage(dmUpdate(topic, "Здравствуйте, ищу квартиру").message);
    expect(sendMessage).toHaveBeenCalled();
  });
});

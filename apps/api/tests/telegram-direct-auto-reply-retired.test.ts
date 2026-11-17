import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ЛИЧНЫЕ СООБЩЕНИЯ TELEGRAM-КАНАЛА: АВТООТВЕТ МОДЕЛИ СНЯТ (один мозг, шаг 3, 16.11.2026).
 *
 * Режим рубильника TELEGRAM_DIRECT_BOT_REPLY=off (по умолчанию автоответ включён, как раньше — ревью #223 M1; тест
 * сам ставит `off`, иначе он проверял бы умолчание, которого больше нет).
 * ФАКТ (прод, 16.11): TelegramDirectConversation — 0 диалогов за всё время. Старый бот здесь больше не отвечает и на
 * ядро не переносится; слова клиента остаются в переписке, а человеку уходит «ответьте вручную» (lib/channelStaffAlert.ts).
 * Повтор jobs/telegramDirectReplyRetry.ts — тоже без модели: уже стоящие задания закрываются уведомлением.
 * (Прежний тест этого файла — пауза сотрудника во время хода модели — проверял ход, которого больше нет.)
 */
const { sendMessage, callAiText } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string, _replyTo?: number, _topicId?: number) => {}),
  callAiText: vi.fn(),
}));
const { alertChannelStaff } = vi.hoisted(() => ({ alertChannelStaff: vi.fn(async () => "sent" as const) }));
vi.mock("../src/lib/channelStaffAlert.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/channelStaffAlert.js")>()),
  alertChannelStaff,
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
  vi.stubEnv("TELEGRAM_DIRECT_BOT_REPLY", "off");
  sendMessage.mockClear();
  callAiText.mockReset();
  alertChannelStaff.mockClear();
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("Direct Messages: модель не отвечает, человек узнаёт", () => {
  it("живой ход: ни модели, ни ответа бота; реплика клиента в переписке; сотруднику — «ответьте вручную»", async () => {
    const topic = 710000000 + (runId % 1000);
    await handleTelegramDirectMessage(dmUpdate(topic, "Здравствуйте, ищу квартиру").message);
    expect(callAiText).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    const row = await prisma.telegramDirectConversation.findUnique({
      where: { chatId_topicId: { chatId: String(DM_CHAT_ID), topicId: String(topic) } },
    });
    const messages = (row?.messages ?? []) as Array<{ role: string; content: string; by?: { kind: string } }>;
    expect(messages.some((m) => m.role === "user" && m.content.includes("ищу квартиру"))).toBe(true);
    expect(messages.some((m) => m.by?.kind === "bot")).toBe(false);
    expect(alertChannelStaff).toHaveBeenCalledWith(expect.objectContaining({ channel: "TELEGRAM_DIRECT", conversationId: row?.id, why: "bot_retired" }));
  });

  it("задание повтора, оставшееся в очереди: без модели, только уведомление", async () => {
    const topic = 720000000 + (runId % 1000);
    const conversation = await prisma.telegramDirectConversation.create({
      data: { chatId: String(DM_CHAT_ID), topicId: String(topic), messages: [{ role: "user", content: "Здравствуйте, ищу квартиру" }] },
    });
    await telegramDirectReplyRetryJob.run({ conversationId: conversation.id });
    expect(callAiText).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(alertChannelStaff).toHaveBeenCalledWith({ channel: "TELEGRAM_DIRECT", conversationId: conversation.id,
      text: "Здравствуйте, ищу квартиру", why: "bot_retired" });
  });
});

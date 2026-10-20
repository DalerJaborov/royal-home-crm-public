import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * РАСШИФРОВКА ГОЛОСОВОГО В TELEGRAM — В ГРАНИЦАХ, КАК В META (ночная проверка
 * 24.09.2026, bot-kanaly №2).
 *
 * В каналах Meta расшифровка приклеивается к словам клиента через
 * wrapUntrusted("voice", …) (messengers/conversation.ts): модель видит, где
 * кончаются наши правила и начинается чужой текст, а ценовой щит (ai/priceGuard.ts)
 * выбрасывает цену, названную голосом, из белого списка «наших» цен. В клиентском
 * боте Telegram и в Direct Messages канала расшифровка шла голым join — тот же
 * голос был для модели обычными словами клиента, и цена из голосового считалась
 * нашей.
 *
 * Транспорт, скачивание и ИИ подменены — тест не ходит ни в Telegram, ни к модели.
 */

const { sendMessage, callAiText, fetchTelegramAlbumAttachments, transcribeAudio, isTranscriptionEnabled, storeFetchedAttachments } =
  vi.hoisted(() => ({
    sendMessage: vi.fn(async (_chatId: string, _text: string, _replyTo?: number, _topicId?: number) => {}),
    callAiText: vi.fn(),
    fetchTelegramAlbumAttachments: vi.fn(async () => ({
      images: [],
      audios: [{ kind: "audio" as const, mediaType: "audio/ogg", buffer: Buffer.from("voice"), filename: "voice.ogg" }],
      medias: [],
      hadUnsupported: false,
    })),
    transcribeAudio: vi.fn(async (_buf: Buffer, _name: string, _mime: string) => "у соседа такая же стоит 640 000 сомони"),
    isTranscriptionEnabled: vi.fn(async () => true),
    storeFetchedAttachments: vi.fn(() => []),
  }));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
}));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));
vi.mock("../src/telegram/attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/attachments.js")>()),
  fetchTelegramAlbumAttachments,
}));
vi.mock("../src/messengers/attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/attachments.js")>()),
  storeFetchedAttachments,
}));
vi.mock("../src/ai/transcribe.js", () => ({ transcribeAudio, isTranscriptionEnabled }));

delete process.env.TELEGRAM_BOT_TOKEN;

const { prisma } = await import("../src/db.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");
const { stripUntrusted } = await import("../src/ai/untrustedContent.js");

const runId = Date.now();
const DM_CHAT_ID = -(2_100_000_000_000 + (runId % 1_000_000_000));

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

const chatIds: string[] = [];
let nextUpdateId = runId % 1_000_000_000;

/** Реплика клиента в истории — с границей недоверенного содержимого и без неё. */
function expectVoiceFenced(messages: { role: string; content: string }[]) {
  const last = messages.filter((m) => m.role === "user").at(-1);
  expect(last).toBeDefined();
  expect(last!.content).toContain('<client_content kind="voice">');
  expect(last!.content).toContain("640 000");
  // Ценовой щит режет именно по этой границе: без неё цена из голосового
  // осталась бы в белом списке «наших» цен (ai/priceGuard.ts).
  expect(stripUntrusted(last!.content)).not.toContain("640 000");
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
  await prisma.telegramConversation.deleteMany({ where: { chatId: { in: chatIds } } });
  await prisma.telegramDirectConversation.deleteMany({ where: { chatId: String(DM_CHAT_ID) } });
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
});

beforeEach(() => {
  sendMessage.mockClear();
  transcribeAudio.mockClear();
  callAiText.mockReset();
  callAiText.mockResolvedValue({ reply: ["Здравствуйте! Чем можем помочь?"], ready: false, intent: "buy", confident: true });
});

describe("Голосовое в Telegram — расшифровка в границах недоверенного содержимого", () => {
  it("клиентский бот: расшифровка ложится в историю внутри client_content kind=voice", async () => {
    const chatId = String(782000001 + (runId % 100000));
    chatIds.push(chatId);

    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: { chat: { id: Number(chatId) }, from: { username: `voice_${runId}` }, voice: { file_id: "voice-1" } },
    });

    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    const row = await prisma.telegramConversation.findUnique({ where: { chatId }, select: { messages: true } });
    expectVoiceFenced(row!.messages as unknown as { role: string; content: string }[]);
  });

  it("Direct Messages канала: то же правило", async () => {
    const topicId = 900000000 + (runId % 1000);

    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: {
        chat: { id: DM_CHAT_ID, type: "supergroup", is_direct_messages: true },
        from: { id: topicId, username: `dm_voice_${runId}` },
        voice: { file_id: "voice-2" },
        direct_messages_topic: { topic_id: topicId, user: { id: topicId, is_bot: false, username: `dm_voice_${runId}` } },
      },
    });

    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    const row = await prisma.telegramDirectConversation.findFirst({
      where: { chatId: String(DM_CHAT_ID), topicId: String(topicId) },
      select: { messages: true },
    });
    expect(row).not.toBeNull();
    expectVoiceFenced(row!.messages as unknown as { role: string; content: string }[]);
  });
});

// Ответ бота в Telegram ждёт окно склейки быстрых сообщений (находка №132,
// 01.10.2026; по умолчанию 25 секунд). Здесь проверяется сам ответ, а не
// склейка, — окно на время файла нулевое (склейку проверяет telegram-debounce).
const { instantBotReplyWindow } = await import("./helpers/botReplyWindow.js");
let restoreReplyWindow: (() => Promise<void>) | undefined;
beforeAll(async () => {
  restoreReplyWindow = await instantBotReplyWindow();
});
afterAll(async () => {
  await restoreReplyWindow?.();
});

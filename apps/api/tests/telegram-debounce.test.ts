import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * СКЛЕЙКА БЫСТРЫХ СООБЩЕНИЙ В TELEGRAM (ночная проверка, находка №132, 01.10.2026).
 *
 * В каналах Meta несколько коротких сообщений подряд («Салом», «квартира»,
 * «3 хонагӣ») склеиваются окном ожидания в ОДИН ход модели (debounceAndMerge в
 * messengers/conversation.ts). В Telegram склейки не было: цепочка chatChains в
 * telegram/bot.ts лишь выстраивала сообщения в очередь, и каждое получало свой
 * ответ — три сообщения давали три ответа бота и тройной расход модели.
 *
 * Тест: три сообщения одного чата подряд — модель вызвана ОДИН раз, и в её истории
 * все три текста; клиенту ушёл один ответ. Одиночное сообщение отвечается сразу по
 * окончании окна — без лишней задержки.
 *
 * Транспорт и ИИ подменены — тест не ходит ни в Telegram, ни к модели.
 */

const { sendMessage, requestContact, removeKeyboard, callAiText } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string) => {}),
  requestContact: vi.fn(async (_chatId: string, _text: string) => {}),
  removeKeyboard: vi.fn(async (_chatId: string, _text: string) => {}),
  callAiText: vi.fn(),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  requestContact,
  removeKeyboard,
}));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));

delete process.env.TELEGRAM_BOT_TOKEN;

const { prisma } = await import("../src/db.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");
const { recoverStuckPendingMessages } = await import("../src/messengers/conversation.js");

const runId = Date.now();
const chatA = String(781000000 + (runId % 100000));
const chatB = String(782000000 + (runId % 100000));
const chatC = String(783000000 + (runId % 100000));
const chatD = String(784000000 + (runId % 100000));
const ALL_CHATS = [chatA, chatB, chatC, chatD];

type SettingsSnapshot = {
  botEnabled: boolean;
  botTelegramEnabled: boolean;
  telegramOwnerChatId: string | null;
  botReplyDelaySec: number;
  botReplyMaxWaitSec: number;
};
const SELECT = {
  botEnabled: true,
  botTelegramEnabled: true,
  telegramOwnerChatId: true,
  botReplyDelaySec: true,
  botReplyMaxWaitSec: true,
} as const;
let savedSettings: SettingsSnapshot;

/** Окно в тесте — 2 секунды (в проде по умолчанию 25 с, Настройки → Бот). */
const WINDOW_SEC = 2;

let nextUpdateId = runId % 1_000_000_000;
function textUpdate(chatId: string, text: string) {
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextUpdateId,
      chat: { id: Number(chatId), type: "private" },
      from: { id: Number(chatId), username: `deb_${chatId}` },
      text,
    },
  };
}

/** Только ходы квалификатора: сторожа и разборы тоже зовут модель, но отвечает клиенту один этот ход. */
function qualifyCalls() {
  return callAiText.mock.calls.filter((call) => (call[0] as { endpoint?: string }).endpoint === "lead-qualify");
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
    data: {
      botEnabled: true,
      botTelegramEnabled: true,
      telegramOwnerChatId: null,
      botReplyDelaySec: WINDOW_SEC,
      botReplyMaxWaitSec: 10,
    },
  });
  await prisma.telegramConversation.deleteMany({ where: { chatId: { in: ALL_CHATS } } });
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.telegramConversation.deleteMany({ where: { chatId: { in: ALL_CHATS } } });
});

beforeEach(() => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue(undefined);
  requestContact.mockReset();
  requestContact.mockResolvedValue(undefined);
  removeKeyboard.mockReset();
  removeKeyboard.mockResolvedValue(undefined);
  callAiText.mockReset();
  callAiText.mockImplementation(async (params: { endpoint?: string }) =>
    params.endpoint === "lead-qualify"
      ? { reply: ["Понял вас: трёхкомнатная в Сино. Какой бюджет?"], ready: false, intent: "buy", confident: true }
      : null
  );
});

describe("Telegram: быстрые сообщения подряд склеиваются в один ход", () => {
  it("три сообщения подряд — модель вызвана один раз, в её истории все три текста", async () => {
    await Promise.all([
      handleTelegramUpdate(textUpdate(chatA, "Салом")),
      handleTelegramUpdate(textUpdate(chatA, "квартира нужна")),
      handleTelegramUpdate(textUpdate(chatA, "3 комнаты в Сино")),
    ]);

    const calls = qualifyCalls();
    expect(calls).toHaveLength(1);
    const history = ((calls[0][0] as { messages?: Array<{ content: unknown }> }).messages ?? [])
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(history).toContain("Салом");
    expect(history).toContain("квартира нужна");
    expect(history).toContain("3 комнаты в Сино");

    // Клиенту — один ответ, а в переписке CRM все три его сообщения по отдельности.
    const replies = sendMessage.mock.calls.filter((call) => String(call[0]) === chatA);
    expect(replies).toHaveLength(1);
    const conv = await prisma.telegramConversation.findUnique({ where: { chatId: chatA } });
    const userTexts = ((conv?.messages as Array<{ role: string; content: string }>) ?? [])
      .filter((m) => m.role === "user")
      .map((m) => m.content);
    expect(userTexts).toEqual(["Салом", "квартира нужна", "3 комнаты в Сино"]);
    // Буфер после хода пуст — следующая пачка начнётся с нуля.
    expect(conv?.pendingSince ?? null).toBeNull();
    expect(conv?.pendingMessages).toEqual([]);
  }, 30_000);

  it("одиночное сообщение — ответ сразу по окончании окна, без лишней задержки", async () => {
    const startedAt = Date.now();
    await handleTelegramUpdate(textUpdate(chatB, "Есть двушки в Шохмансуре?"));
    const spent = Date.now() - startedAt;

    expect(qualifyCalls()).toHaveLength(1);
    expect(sendMessage.mock.calls.filter((call) => String(call[0]) === chatB)).toHaveLength(1);
    // Окно выдержано (склейка не выключена), но сверх него — только сам ход.
    expect(spent).toBeGreaterThanOrEqual(WINDOW_SEC * 1000 - 50);
    expect(spent).toBeLessThan(WINDOW_SEC * 1000 + 5_000);
  }, 30_000);

  it("сотрудник взял диалог, пока шло окно, — бот молчит, сообщение в переписке", async () => {
    const pending = handleTelegramUpdate(textUpdate(chatC, "Сколько стоит трёшка?"));
    // Сообщение уже легло в переписку (до окна) — сотрудник видит его и берёт диалог.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await prisma.telegramConversation.update({
      where: { chatId: chatC },
      data: { pausedUntil: new Date(Date.now() + 60 * 60 * 1000), botPausedAt: new Date() },
    });
    await pending;

    expect(qualifyCalls()).toHaveLength(0);
    expect(sendMessage.mock.calls.filter((call) => String(call[0]) === chatC)).toHaveLength(0);
    const conv = await prisma.telegramConversation.findUnique({ where: { chatId: chatC } });
    const messages = (conv?.messages as Array<{ role: string; content: string }>) ?? [];
    expect(messages.map((m) => m.content)).toEqual(["Сколько стоит трёшка?"]);
  }, 30_000);
});

describe("Telegram: пачка, зависшая после перезапуска", () => {
  it("буфер старше пяти минут очищается, переписка не трогается", async () => {
    const staleSince = new Date(Date.now() - 10 * 60 * 1000);
    await prisma.telegramConversation.create({
      data: {
        chatId: chatD,
        messages: [{ role: "user", content: "Есть дома в Вахдате?" }] as never,
        leadDraft: { stage: "chatting" } as never,
        pendingMessages: ["Есть дома в Вахдате?"],
        pendingAttachments: [{ voice: false }] as never,
        pendingSince: staleSince,
        lastMessageAt: staleSince,
      },
    });

    await recoverStuckPendingMessages();

    const conv = await prisma.telegramConversation.findUnique({ where: { chatId: chatD } });
    expect(conv?.pendingSince ?? null).toBeNull();
    expect(conv?.pendingMessages).toEqual([]);
    expect(conv?.pendingAttachments).toEqual([]);
    // Сообщение уже лежало в переписке — второй раз его туда не дописывают.
    expect(conv?.messages).toEqual([{ role: "user", content: "Есть дома в Вахдате?" }]);
  });
});

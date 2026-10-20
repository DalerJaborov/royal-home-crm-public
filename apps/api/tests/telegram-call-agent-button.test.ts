import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ночная проверка 01.10.2026, №135: кнопка «Позвать агента» под приветствием
 * Telegram живёт вечно и срабатывала при паузе оператора и в выключенном
 * канале — слала «агент свяжется» поверх агента и заводила лишнюю просьбу о
 * звонке. Транспорт подменён, к Telegram тест не ходит.
 */
const { sendMessage, answerCallbackQuery } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string) => {}),
  answerCallbackQuery: vi.fn(async (_id: string, _text?: string) => {}),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  answerCallbackQuery,
}));

delete process.env.TELEGRAM_BOT_TOKEN;

const { prisma } = await import("../src/db.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");

const runId = Date.now();
type SettingsSnapshot = { botEnabled: boolean; botTelegramEnabled: boolean };
let saved: SettingsSnapshot;
const chatIds: string[] = [];
const conversationIds: string[] = [];
let nextUpdateId = runId % 1_000_000_000;

beforeAll(async () => {
  saved = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botEnabled: true, botTelegramEnabled: true },
  });
});

afterAll(async () => {
  await prisma.callbackRequest.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.telegramConversation.deleteMany({ where: { chatId: { in: chatIds } } });
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
});

beforeEach(async () => {
  sendMessage.mockClear();
  answerCallbackQuery.mockClear();
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, botTelegramEnabled: true } });
});

async function makeConversation(extra: { pausedUntil?: Date; botPausedAt?: Date } = {}) {
  const chatId = String(7_000_000_000 + chatIds.length * 7 + (runId % 1000));
  chatIds.push(chatId);
  const conv = await prisma.telegramConversation.create({ data: { chatId, username: `callbtn${runId}${chatIds.length}`, ...extra } });
  conversationIds.push(conv.id);
  return conv;
}

function pressCallAgent(chatId: string) {
  return handleTelegramUpdate({
    update_id: nextUpdateId++,
    callback_query: { id: `cb-${nextUpdateId}`, from: { id: Number(chatId) }, data: "call_agent", message: { message_id: 1, chat: { id: Number(chatId) } } },
  } as never);
}

const requestsFor = (conversationId: string) => prisma.callbackRequest.count({ where: { conversationId } });

describe("кнопка «Позвать агента» (№135)", () => {
  it("диалог на паузе оператора — ничего не пишем и просьбу не заводим", async () => {
    const conv = await makeConversation({ pausedUntil: new Date(Date.now() + 60 * 60 * 1000) });
    await pressCallAgent(conv.chatId);
    expect(answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuery.mock.calls[0][1]).toBeUndefined(); // только погасили «часики»
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await requestsFor(conv.id)).toBe(0);
  });

  it("канал Telegram выключен рубильником — то же самое", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botTelegramEnabled: false } });
    const conv = await makeConversation();
    await pressCallAgent(conv.chatId);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await requestsFor(conv.id)).toBe(0);
  });

  it("обычный диалог — кнопка работает как раньше: подтверждение клиенту", async () => {
    const conv = await makeConversation();
    await pressCallAgent(conv.chatId);
    expect(answerCallbackQuery.mock.calls[0][1]).toBe("Передаю агенту 🙌");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0][1])).toContain("агент свяжется");
  });
});

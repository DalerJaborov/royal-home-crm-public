import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «TELEGRAM-БОТ ТОЛЬКО ДЛЯ СОТРУДНИКОВ» (27.11.2026, владелец; учредитель написал /start и
 * получил клиентское приветствие без пути к привязке). Оба положения рубильника:
 *  - ВКЛ: незнакомому чату памятка, ни переписки, ни заявки, ни кнопок клиента;
 *  - ВЫКЛ: прежнее клиентское приветствие с кнопками.
 * Транспорт подменён, к Telegram тест не ходит.
 */
const { sendMessage, sendMessageWithButtons, answerCallbackQuery } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string) => ({ message_id: 1 })),
  sendMessageWithButtons: vi.fn(async (_chatId: string, _text: string, _buttons: unknown) => ({ message_id: 1 })),
  answerCallbackQuery: vi.fn(async (_id: string, _text?: string) => {}),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  sendMessageWithButtons,
  answerCallbackQuery,
}));

delete process.env.TELEGRAM_BOT_TOKEN;

const { prisma } = await import("../src/db.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");
const { resetStaffOnlyNoticeCooldown } = await import("../src/telegram/staffOnlyNotice.js");
const { isAutomationSwitchOn } = await import("@royal-home/shared");
const { waitFor } = await import("./helpers/waitFor.js");

const runId = Date.now();
const chatIds: string[] = [];
const clientIds: string[] = [];
let nextUpdateId = (runId % 1_000_000_000) + 500;
let saved: { telegramStaffOnlyEnabled: boolean; botEnabled: boolean; botTelegramEnabled: boolean };

function newChat(): string {
  const chatId = String(7_300_000_000 + chatIds.length * 13 + (runId % 1000));
  chatIds.push(chatId);
  return chatId;
}

function sendText(chatId: string, text: string) {
  return handleTelegramUpdate({
    update_id: nextUpdateId++,
    message: { message_id: nextUpdateId, date: Math.floor(Date.now() / 1000), text, chat: { id: Number(chatId), type: "private" }, from: { id: Number(chatId), first_name: "Тест" } },
  } as never);
}

async function setStaffOnly(on: boolean) {
  await prisma.settings.update({ where: { id: "singleton" }, data: { telegramStaffOnlyEnabled: on } });
}

const allTexts = () => [...sendMessage.mock.calls.map((c) => c[1]), ...sendMessageWithButtons.mock.calls.map((c) => c[1])].map(String);
const allButtons = () => sendMessageWithButtons.mock.calls.flatMap((c) => (c[2] as Array<Array<{ text: string }>>).flat().map((b) => b.text));

beforeAll(async () => {
  saved = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { telegramStaffOnlyEnabled: true, botEnabled: true, botTelegramEnabled: true },
  });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, botTelegramEnabled: true } });
});

afterAll(async () => {
  const convs = await prisma.telegramConversation.findMany({ where: { chatId: { in: chatIds } }, select: { id: true } });
  await prisma.callbackRequest.deleteMany({ where: { conversationId: { in: convs.map((c) => c.id) } } });
  await prisma.telegramConversation.deleteMany({ where: { chatId: { in: chatIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
});

beforeEach(() => {
  sendMessage.mockClear();
  sendMessageWithButtons.mockClear();
  answerCallbackQuery.mockClear();
  resetStaffOnlyNoticeCooldown();
});

describe("рубильник по умолчанию", () => {
  it("ВКЛ, пока владелец не выключит", () => {
    expect(isAutomationSwitchOn(null, "telegramStaffOnlyEnabled")).toBe(true);
    expect(isAutomationSwitchOn(null, "shareholderReportsEnabled")).toBe(true);
  });
});

describe("ВКЛ: бот только для сотрудников", () => {
  beforeEach(() => setStaffOnly(true));

  it("/start незнакомца — памятка без клиентских кнопок, переписка не заводится", async () => {
    const chatId = newChat();
    await sendText(chatId, "/start");
    const texts = allTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("рабочий бот Royal Home для сотрудников");
    expect(texts[0]).toContain("Профиль");
    expect(texts[0]).not.toContain("—");
    expect(allButtons()).not.toContain("🏠 Смотреть объекты");
    expect(allButtons()).not.toContain("🙋 Позвать агента");
    expect(await prisma.telegramConversation.count({ where: { chatId } })).toBe(0);
  });

  it("сообщения подряд — одна памятка, не по одной на каждое", async () => {
    const chatId = newChat();
    await sendText(chatId, "Здравствуйте, нужна квартира");
    await sendText(chatId, "+992900000002");
    expect(allTexts()).toHaveLength(1);
    expect(await prisma.telegramConversation.count({ where: { chatId } })).toBe(0);
  });

  it("чат с карточкой клиента идёт прежним путём: сообщение не теряется, памятки нет", async () => {
    const chatId = newChat();
    const client = await prisma.client.create({
      data: { fullName: `Клиент ТГ памятка ${runId}`, phone: `+992503${String(runId).slice(-6)}`, source: "TELEGRAM" },
    });
    clientIds.push(client.id);
    await prisma.telegramConversation.create({ data: { chatId, clientId: client.id, username: `staffonly${runId}` } });
    await sendText(chatId, "Здравствуйте, я по квартире");
    expect(allTexts().join(" | ")).not.toContain("рабочий бот Royal Home");
    // Клиентский путь может копить сообщения коротким окном (debounce) — ждём запись.
    await waitFor(async () => {
      const conv = await prisma.telegramConversation.findUniqueOrThrow({ where: { chatId } });
      return JSON.stringify(conv.messages).includes("я по квартире") || null;
    }, { timeoutMs: 15_000 });
  });

  it("старая кнопка «Позвать агента» — памятка, заявки нет", async () => {
    const chatId = newChat();
    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      callback_query: { id: `cb-${nextUpdateId}`, from: { id: Number(chatId) }, data: "call_agent", message: { message_id: 1, chat: { id: Number(chatId) } } },
    } as never);
    expect(answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(allTexts()[0]).toContain("рабочий бот");
    expect(await prisma.telegramConversation.count({ where: { chatId } })).toBe(0);
  });
});

describe("ВЫКЛ: прежний клиентский путь", () => {
  beforeEach(() => setStaffOnly(false));

  it("/start — клиентское приветствие с кнопками, переписка заведена", async () => {
    const chatId = newChat();
    await sendText(chatId, "/start");
    expect(allButtons()).toEqual(expect.arrayContaining(["🏠 Смотреть объекты", "🙋 Позвать агента"]));
    expect(allTexts().join("\n")).not.toContain("рабочий бот Royal Home");
    expect(await prisma.telegramConversation.count({ where: { chatId } })).toBe(1);
  });
});

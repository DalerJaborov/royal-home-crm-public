import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Альбом фотографий в клиентском боте Telegram.
 *
 * Клиент отправляет три снимка одной пачкой — для него это ОДНО сообщение. Telegram
 * доставляет их тремя отдельными обновлениями с общим media_group_id, и бот разбирал
 * каждое само по себе: три вызова ИИ, три ответа подряд и три записи в переписке.
 * Со стороны клиента это выглядит как заикание.
 *
 * Здесь стерегутся оба конца склейки:
 *   1. На пачку уходит ОДИН ответ, а не по одному на снимок.
 *   2. Подпись не теряется: Telegram кладёт её лишь в одну часть альбома, и в какую
 *      именно — не обещает. Потерянная подпись превращает вопрос клиента в «[📷]».
 *
 * Транспорт и ИИ подменены: тест не ходит ни в Telegram, ни к Anthropic.
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

// Маркер бота убираем ДО импорта telegram/api.ts (он читает его при загрузке): без
// маркера getFile не вызывается вовсе, и тест гарантированно не ходит в сеть. Проверяем
// склейку сообщений, а не скачивание файлов — им занимается telegram-attachments.test.ts.
delete process.env.TELEGRAM_BOT_TOKEN;

const { prisma } = await import("../src/db.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");

const runId = Date.now();
const CHAT_ID = 780000000 + (runId % 1_000_000);
const chatId = String(CHAT_ID);
const GROUP = `album-${runId}`;

type SettingsSnapshot = { botEnabled: boolean; botTelegramEnabled: boolean; telegramOwnerChatId: string | null };
const SELECT = { botEnabled: true, botTelegramEnabled: true, telegramOwnerChatId: true } as const;
let savedSettings: SettingsSnapshot;

/** Одна часть альбома: у всех частей общий media_group_id, подпись — максимум у одной.
 *  update_id у каждой части СВОЙ, как в настоящем Telegram: с 26.08.2026 дедуп-отметка
 *  ставится при склейке по этому id, и части с одинаковым id склеились бы в одну. */
let nextUpdateId = runId % 1_000_000_000;
const albumPart = (fileId: string, caption?: string) => ({
  message: {
    chat: { id: CHAT_ID },
    from: { username: `client_${runId}` },
    media_group_id: GROUP,
    photo: [{ file_id: `${fileId}-small`, width: 90 }, { file_id: fileId, width: 1280 }],
    ...(caption ? { caption } : {}),
  },
  update_id: nextUpdateId++,
});

/** Окно склейки — 2 секунды тишины (ALBUM_WINDOW_MS в telegram/bot.ts) плюс запас на
 *  саму обработку: ждать больше незачем, меньше — тест ловил бы недособранную пачку. */
const waitForFlush = () => new Promise<void>((resolve) => setTimeout(resolve, 3500));

beforeAll(async () => {
  savedSettings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: SELECT,
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    // Чат владельца обнуляем: совпади он с нашим, бот принял бы тест за служебную
    // переписку директора и клиента не квалифицировал бы вовсе.
    data: { botEnabled: true, botTelegramEnabled: true, telegramOwnerChatId: null },
  });
});

afterAll(async () => {
  await prisma.telegramConversation.deleteMany({ where: { chatId } });
  // Дедуп-отметки склейки (ProcessedMessage) — свои, по диапазону runId.
  await prisma.processedMessage.deleteMany({
    where: { channel: "TELEGRAM", messageId: { in: Array.from({ length: 20 }, (_, k) => String((runId % 1_000_000_000) + k)) } },
  });
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.$disconnect();
});

beforeEach(async () => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue(undefined);
  requestContact.mockReset();
  requestContact.mockResolvedValue(undefined);
  removeKeyboard.mockReset();
  removeKeyboard.mockResolvedValue(undefined);
  callAiText.mockReset();
  // Ответ нарочно БЕЗ вводного «Хуб,»: с 02.08.2026 отчёт о приёме вычёркивается
  // на выходе (stripLeadingAck в ai/replyGuards.ts), и реплика с ним проверяла бы
  // не склейку альбома, ради которой написан этот файл, а работу того фильтра.
  callAiText.mockResolvedValue({ reply: ["Суратҳоро дидам"], ready: false, confident: true });
  await prisma.telegramConversation.deleteMany({ where: { chatId } });
});

describe("альбом из трёх фотографий — одно обращение", () => {
  it("бот отвечает один раз, а не на каждый снимок", async () => {
    await handleTelegramUpdate(albumPart("f1", "ана хонаи ман"));
    await handleTelegramUpdate(albumPart("f2"));
    await handleTelegramUpdate(albumPart("f3"));

    // До закрытия окна бот молчит: части ещё летят.
    expect(sendMessage).not.toHaveBeenCalled();

    await waitForFlush();

    expect(callAiText).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(chatId, "Суратҳоро дидам");
  }, 15_000);

  it("подпись из любой части альбома доходит до модели и в переписку", async () => {
    // Подпись у ПОСЛЕДНЕЙ части: разбирая сообщения поодиночке, бот увидел бы сперва
    // два безмолвных фото и ответил бы на пустоту.
    await handleTelegramUpdate(albumPart("g1"));
    await handleTelegramUpdate(albumPart("g2", "чанд пул мешавад?"));

    await waitForFlush();

    const conversation = await prisma.telegramConversation.findUnique({
      where: { chatId },
      select: { messages: true },
    });
    const messages = (conversation?.messages ?? []) as { role: string; content: string }[];
    // Одна реплика клиента на всю пачку, и слова клиента в ней сохранены.
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(messages[0].content).toContain("чанд пул мешавад?");
    expect(messages[1].content).toBe("Суратҳоро дидам");
  }, 15_000);

  it("обычное сообщение без альбома отвечается сразу, без ожидания окна", async () => {
    await handleTelegramUpdate({
      update_id: 2,
      message: { chat: { id: CHAT_ID }, from: { username: `client_${runId}` }, text: "салом" },
    });

    // Никакого буфера для одиночного сообщения: ждать нечего и незачем.
    expect(sendMessage).toHaveBeenCalledTimes(1);
  }, 15_000);
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

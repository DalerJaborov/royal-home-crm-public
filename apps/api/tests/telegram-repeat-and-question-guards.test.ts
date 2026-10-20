import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TELEGRAM ШЁЛ В ОБХОД ТРЁХ РУБЕЖЕЙ, КОТОРЫЕ УЖЕ ЕСТЬ У WHATSAPP/INSTAGRAM
 * (разбор находок судьи 30.08.2026, BotAuditFinding).
 *
 * У Telegram свой, отдельный от messengers/conversation.ts (processMessengerTurn)
 * путь сборки ответа — runQualifyTurn вызывается прямо в telegram/bot.ts. Предел
 * на просьбы номера (MAX_PHONE_ASKS/dropPhoneAsks), обрезка двух вопросов в одном
 * сообщении (ai/oneQuestionGuard.ts) и вычёркивание дословного повтора
 * (ai/replyRepeatGuard.ts) стояли только в этом отдельном пути — Telegram не знал
 * о них вовсе. BotAuditFinding судит TelegramConversation наравне с остальными
 * каналами (ai/botAudit.ts), поэтому и защита обязана быть одна на все.
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
const { NEUTRAL_REPLIES } = await import("../src/messengers/replyChain.js");

const runId = Date.now();

type SettingsSnapshot = { botEnabled: boolean; botTelegramEnabled: boolean; telegramOwnerChatId: string | null };
const SELECT = { botEnabled: true, botTelegramEnabled: true, telegramOwnerChatId: true } as const;
let savedSettings: SettingsSnapshot;

const chatIds: string[] = [];
let nextUpdateId = runId % 1_000_000_000;

function textUpdate(chatId: string, username: string, text: string) {
  return {
    update_id: nextUpdateId++,
    message: { chat: { id: Number(chatId) }, from: { username }, text },
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
    data: { botEnabled: true, botTelegramEnabled: true, telegramOwnerChatId: null },
  });
});

afterAll(async () => {
  await prisma.telegramConversation.deleteMany({ where: { chatId: { in: chatIds } } });
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.$disconnect();
});

beforeEach(() => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue(undefined);
  requestContact.mockReset();
  requestContact.mockResolvedValue(undefined);
  removeKeyboard.mockReset();
  removeKeyboard.mockResolvedValue(undefined);
  callAiText.mockReset();
});

/**
 * Ночная проверка 24.09.2026 (goryachie №3): pausedUntil читался ОДИН раз, до
 * вызова модели. Агент, взявший диалог из инбокса, пока бот думал, получал ответ
 * бота поверх своего. В каналах Meta пауза перечитывается после модели — здесь
 * должно быть так же.
 */
describe("Telegram: пауза, поставленная пока бот думал", () => {
  it("агент взял диалог во время вызова модели — ответ бота не уходит и в переписку не пишется", async () => {
    const chatId = String(781000009 + (runId % 100000));
    chatIds.push(chatId);
    const conversation = await prisma.telegramConversation.create({
      data: {
        chatId,
        username: `paused_${runId}`,
        leadDraft: { stage: "chatting" } as any,
        messages: [],
        lastMessageAt: new Date(),
      },
    });

    // Модель «думает», и в это время оператор ставит бессрочную паузу из инбокса.
    callAiText.mockImplementation(async () => {
      await prisma.telegramConversation.update({
        where: { id: conversation.id },
        data: { pausedUntil: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000) },
      });
      return { reply: ["Салом! Кадом ноҳия?"], ready: false, intent: "buy", confident: true };
    });
    await handleTelegramUpdate(textUpdate(chatId, `paused_${runId}`, "Хона мехоҳам"));

    expect(callAiText).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    const row = await prisma.telegramConversation.findUnique({ where: { id: conversation.id }, select: { messages: true } });
    const messages = row!.messages as unknown as { role: string; content: string }[];
    // Слова клиента сохранены, ответа бота нет — диалог ведёт человек.
    expect(messages.some((m) => m.role === "user" && m.content === "Хона мехоҳам")).toBe(true);
    expect(messages.some((m) => m.role === "assistant")).toBe(false);
  }, 15_000);
});

describe("Telegram: предел просьб о номере (MAX_PHONE_ASKS)", () => {
  it("после трёх просьб бот больше не просит номер в четвёртый раз", async () => {
    const chatId = String(781000001 + (runId % 100000));
    chatIds.push(chatId);
    await prisma.telegramConversation.create({
      data: {
        chatId,
        username: `phone_${runId}`,
        leadDraft: { stage: "awaiting_phone" } as any,
        messages: [
          { role: "user", content: "Хона мехоҳам дар Сино" },
          { role: "assistant", content: "Рақами телефонатонро нависед?" },
          { role: "user", content: "Хуб" },
          { role: "assistant", content: "Норасо шуд, рақами телефонатонро бори дигар нависед?" },
          { role: "user", content: "Ок" },
          { role: "assistant", content: "Рақамро нависед, лутфан, то агенти мо занг занад?" },
        ],
        lastMessageAt: new Date(),
      },
    });

    // Ход №4: клиент снова уклоняется, модель СНОВА формулирует пузырь только
    // про телефон — до правки этот пузырь ушёл бы клиенту как есть, восьмой
    // случай из ai/replyRepeatGuard.ts повторился бы и в Telegram.
    callAiText.mockResolvedValue({ reply: ["Рақами телефонатонро дигар бор нависед?"], ready: false, confident: true });
    await handleTelegramUpdate(textUpdate(chatId, `phone_${runId}`, "Майлаш"));

    expect(callAiText).toHaveBeenCalled();
    const sentTexts = sendMessage.mock.calls.map((c) => c[1] as string);
    expect(sentTexts.some((t) => /рақам/iu.test(t))).toBe(false);
    // Единственный пузырь модели вычистил предел просьб — это НАШЕ решение, а не
    // сбой ИИ, поэтому бот молчит, как в каналах Meta (03.10.2026, «один мозг»):
    // прежняя русская заглушка «Извините, не расслышал» здесь больше не уходит.
    expect(sentTexts.some((t) => /не расслышал/iu.test(t))).toBe(false);
  }, 15_000);

  it("пузырь с содержательным ответом остаётся, вырезается только пузырь про номер", async () => {
    const chatId = String(781000002 + (runId % 100000));
    chatIds.push(chatId);
    await prisma.telegramConversation.create({
      data: {
        chatId,
        username: `phone2_${runId}`,
        leadDraft: { stage: "awaiting_phone" } as any,
        messages: [
          { role: "user", content: "Хона мехоҳам" },
          { role: "assistant", content: "Рақами телефонатонро нависед?" },
          { role: "user", content: "Хуб" },
          { role: "assistant", content: "Рақамро нависед?" },
          { role: "user", content: "Майлаш" },
          { role: "assistant", content: "Лутфан рақами телефонатонро нависед?" },
        ],
        lastMessageAt: new Date(),
      },
    });

    callAiText.mockResolvedValue({
      reply: ["Дар ин минтақа якчанд вариант ҳаст", "Рақами телефонатонро бори дигар нависед?"],
      ready: false,
      confident: true,
    });
    await handleTelegramUpdate(textUpdate(chatId, `phone2_${runId}`, "Хуб"));

    const sentTexts = sendMessage.mock.calls.map((c) => c[1] as string);
    expect(sentTexts.some((t) => t.includes("якчанд вариант ҳаст"))).toBe(true);
    expect(sentTexts.some((t) => /рақам/iu.test(t))).toBe(false);
  }, 15_000);
});

describe("Telegram: строго один вопрос в одном сообщении", () => {
  it("два вопроса в одной реплике модели обрезаются до первого", async () => {
    const chatId = String(781000003 + (runId % 100000));
    chatIds.push(chatId);
    await prisma.telegramConversation.create({
      data: {
        chatId,
        username: `oneq_${runId}`,
        leadDraft: { stage: "chatting", intent: "buy" } as any,
        messages: [{ role: "user", content: "Ассалом" }, { role: "assistant", content: "Ваалейкум ассалом!" }],
        lastMessageAt: new Date(),
      },
    });

    callAiText.mockResolvedValue({
      reply: ["Ба Шумо чӣ гуна кӯмак карда метавонам? Хона мехаред ё мефурӯшед?"],
      ready: false,
      confident: true,
    });
    await handleTelegramUpdate(textUpdate(chatId, `oneq_${runId}`, "Хона лозим аст"));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0][1] as string;
    expect(sent).toBe("Ба Шумо чӣ гуна кӯмак карда метавонам?");
    expect(sent).not.toContain("Хона мехаред");
  }, 15_000);
});

describe("Telegram: дословный повтор одной из трёх последних реплик не уходит клиенту", () => {
  // С 10.10.2026 (аудит ботов, P0-1) вместо молчания уходит короткая нейтральная
  // реплика — но повтор по-прежнему не уходит никогда.
  it("повтор реплики ЧЕРЕЗ ОДНУ (не последней) — не второй раз и не молчание", async () => {
    // Нарочно НЕ последняя реплика бота: isRepeatOfLastReply (normalizeReplyBubbles)
    // ловит только дословный повтор ПОСЛЕДНЕЙ фразы — этот случай уже был бы поймал
    // и без правки. Здесь проверяется именно то, чего не было: dropRepeatedBubbles
    // смотрит на три последних реплики, а не только на одну (ai/replyRepeatGuard.ts).
    const chatId = String(781000004 + (runId % 100000));
    chatIds.push(chatId);
    const REPEATED = "Дар кадом минтақа хона мекобед, нависед";
    await prisma.telegramConversation.create({
      data: {
        chatId,
        username: `repeat_${runId}`,
        leadDraft: { stage: "chatting" } as any,
        messages: [
          { role: "user", content: "Дар Сино хона ҳаст?" },
          { role: "assistant", content: REPEATED },
          { role: "user", content: "чи?" },
          { role: "assistant", content: "Тавзеҳ диҳед, кадом хонаро дар назар доред" },
        ],
        lastMessageAt: new Date(),
      },
    });

    callAiText.mockResolvedValue({ reply: [REPEATED], ready: false, confident: true });
    await handleTelegramUpdate(textUpdate(chatId, `repeat_${runId}`, "хм"));

    // Дословный повтор вычеркнут целиком — вместо него нейтральная реплика.
    const sent = sendMessage.mock.calls.map((c) => c[1] as string);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("Дар кадом минтақа хона мекобед");
    expect(Object.values(NEUTRAL_REPLIES).map((v) => v.tg)).toContain(sent[0]);
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

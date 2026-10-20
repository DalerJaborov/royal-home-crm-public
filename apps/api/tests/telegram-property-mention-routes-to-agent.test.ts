import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * НОЧНАЯ ПРОВЕРКА 24.09.2026 (находка №2): «клиент называет номер объекта —
 * заявка уходит хозяину объекта» и «мне нужен Умед» работали только в каналах
 * Meta (messengers/conversation.ts) — в Telegram (telegram/bot.ts) оба сигнала
 * не читались вовсе, ни один тест этого не проверял. Здесь — тот же сценарий,
 * что уже есть для WhatsApp/Instagram (см. property-mention-routes-to-agent.test.ts),
 * но через Telegram-приёмник: объект называется на одном ходе, телефон — на
 * следующем, заявка обязана уйти хозяину объекта, а не в обычную очередь по KPI.
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

const runId = Date.now();

type SettingsSnapshot = {
  botEnabled: boolean;
  botTelegramEnabled: boolean;
  telegramOwnerChatId: string | null;
  workHoursStart: string;
  workHoursEnd: string;
};
const SELECT = {
  botEnabled: true,
  botTelegramEnabled: true,
  telegramOwnerChatId: true,
  workHoursStart: true,
  workHoursEnd: true,
} as const;
let savedSettings: SettingsSnapshot;

let nextUpdateId = runId % 1_000_000_000;
function textUpdate(chatId: string, username: string, text: string) {
  return {
    update_id: nextUpdateId++,
    message: { chat: { id: Number(chatId) }, from: { username }, text },
  };
}

const chatId = String(782000000 + (runId % 100000));
let ownerId: string;
let propertyId: string;
let propertyShortId: number;
let districtId: string;

beforeAll(async () => {
  savedSettings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: SELECT,
  });
  // Рабочие часы — на весь день (см. докстринг property-mention-routes-to-agent.test.ts):
  // вне окна деференс назначения гасит лесенку «объект назван явно» целиком,
  // и тест был бы зелёным днём и красным вечером при исправном коде.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      botEnabled: true,
      botTelegramEnabled: true,
      telegramOwnerChatId: null,
      // Круглые сутки — это "00:00"–"24:00", а НЕ "00:00"–"23:59": минута 23:59 у
      // второго остаётся закрытой, и тест падает одну минуту в сутки
      // (isWithinDushanbeWindow → false, заявка уходит в общую очередь без агента).
      // "00:00"–"00:00" тоже нельзя: у isWithinDushanbeWindow пустое окно значит
      // «никогда». Разбор — docs/journal/2026-09-24-krugolosutochnoe-okno-24-00.md.
      workHoursStart: "00:00",
      workHoursEnd: "24:00",
    },
  });

  districtId = (await prisma.district.create({ data: { name: `ТГ-объект-номер-${runId}` } })).id;
  ownerId = (
    await prisma.agent.create({
      data: { fullName: `Хозяин объекта ТГ ${runId}`, phone: `+992906${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  const property = await prisma.property.create({
    data: {
      title: `Объект по номеру ТГ ${runId}`,
      type: "APARTMENT",
      areaSqm: 55,
      rooms: 2,
      price: 450_000,
      currency: "TJS",
      districtId,
      address: "Тестовая ТГ, 7",
      condition: "GOOD",
      status: "AVAILABLE",
      assignedAgentId: ownerId,
    },
  });
  propertyId = property.id;
  propertyShortId = property.shortId;
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  const conv = await prisma.telegramConversation.findUnique({ where: { chatId }, select: { id: true, clientId: true } });
  if (conv?.clientId) {
    await prisma.interaction.deleteMany({ where: { clientId: conv.clientId } });
    await prisma.client.deleteMany({ where: { id: conv.clientId } });
  }
  if (conv) await prisma.telegramConversation.deleteMany({ where: { id: conv.id } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: ownerId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
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

describe("Telegram: клиент называет номер объекта в переписке — заявка уходит хозяину", () => {
  it("«объект №<N>», потом телефон — Client.assignedAgentId это хозяин объекта", async () => {
    callAiText.mockResolvedValue({
      reply: ["Да, объект ещё доступен. Как к вам обращаться и по какому телефону связаться?"],
      ready: false,
      intent: "buy",
      confident: true,
    });
    await handleTelegramUpdate(textUpdate(chatId, `propmention_${runId}`, `Здравствуйте, интересует объект №${propertyShortId}`));

    // Второй ход: телефон отдельным сообщением, посреди разговора (extractVolunteeredPhone) —
    // тот же пример номера, что и в тесте для каналов Meta.
    callAiText.mockResolvedValue({
      reply: ["Спасибо, наш агент свяжется с вами."],
      ready: false,
      intent: "buy",
      confident: true,
    });
    await handleTelegramUpdate(textUpdate(chatId, `propmention_${runId}`, "Фаридун, 910001044"));

    const conv = await prisma.telegramConversation.findUnique({ where: { chatId }, select: { clientId: true } });
    expect(conv?.clientId).toBeTruthy();
    const client = await prisma.client.findUniqueOrThrow({ where: { id: conv!.clientId! } });
    // Именно ПРАВИЛО «объект назван явно», а не случайное совпадение с обычной
    // очередью: assignReason различает эти два случая (services/leads/intake.ts).
    expect(client.assignReason).toBe("own_property_explicit");
    expect(client.assignedAgentId).toBe(ownerId);
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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * Отказ отправки сообщения клиенту (Meta/Telegram) обязан попасть в журнал ошибок
 * через logSystemError — не только в console.error. deliverToConversation зовут не
 * только синхронные роуты (там отказ виден агенту прямо в ответе 502), но и фоновые
 * джобы без единого зрителя: напоминание подтвердить показ (lib/meetingReminders.ts)
 * и ответ на «уточню у собственника» без карточки клиента (lib/ownerQuestionAnswer.ts).
 * До этой правки такой фоновый отказ не оставлял в системе никакого следа — экран
 * «Здоровье системы» оставался зелёным, пока бот неделю не мог достучаться до клиента.
 */

const { logSystemError, sendMetaMessage, sendTelegramMessage } = vi.hoisted(() => ({
  logSystemError: vi.fn(), sendMetaMessage: vi.fn(), sendTelegramMessage: vi.fn(),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError,
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  isMetaChannelEnabled: async () => true, sendMessage: sendMetaMessage,
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage: sendTelegramMessage, isTelegramEnabled: () => true,
}));
vi.mock("../src/messengers/appendMessages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/appendMessages.js")>()),
  appendConversationMessages: vi.fn(async () => undefined),
  appendTelegramConversationMessages: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/botLessons.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/botLessons.js")>()), recordLesson: vi.fn(async () => undefined),
}));

const { prisma } = await import("../src/db.js");
let fixture: CustomerMessengerFixture;
let botId: string;
let telegramId: string;
let telegramPeer: string;
beforeAll(async () => {
  // Real native/namespace reads replace the old incomplete Prisma mock. Only
  // provider I/O, logger and append are mocked; no customer grant is forged.
  fixture = await createCustomerMessengerFixture("WHATSAPP");
  botId = (await fixture.ensureConversation("992900000000")).id;
  telegramPeer = "delivery-log-" + fixture.id;
  telegramId = (await prisma.telegramConversation.create({ data: { chatId: telegramPeer } })).id;
});
afterAll(async () => {
  await fixture?.dispose();
  const anchors = await prisma.customerInquiry.findMany({ where: { telegramConversationId: telegramId }, select: { id: true } });
  await prisma.telegramConversation.deleteMany({ where: { id: telegramId } });
  await prisma.customerInquiry.deleteMany({ where: { id: { in: anchors.map(row => row.id) }, actions: { none: {} } } });
});

describe("deliverToConversation: отказ отправки доходит до журнала", () => {
  beforeEach(() => {
    logSystemError.mockClear();
    sendMetaMessage.mockReset();
    sendTelegramMessage.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it("отказ Meta пишет в журнал с источником meta и возвращает 502", async () => {
    const { deliverToConversation } = await import("../src/lib/conversationDelivery.js");
    sendMetaMessage.mockRejectedValue(new Error("Meta API sendMessage: rate limited"));

    const result = await deliverToConversation(
      { kind: "bot", id: botId, channel: "WHATSAPP", subscriberId: "992900000000", accountId: fixture.id, transport: fixture.transport },
      "Здравствуйте"
    );

    expect(result).toEqual({ ok: false, status: 502, error: "Не удалось отправить сообщение" });
    expect(sendMetaMessage).toHaveBeenCalledTimes(1);
    expect(logSystemError).toHaveBeenCalledTimes(1);
    const [source, message] = logSystemError.mock.calls[0] as [string, string];
    expect(source).toBe("meta");
    expect(message).toContain("rate limited");
  });

  it("отказ Telegram пишет в журнал с источником telegram", async () => {
    const { deliverToConversation } = await import("../src/lib/conversationDelivery.js");
    sendTelegramMessage.mockRejectedValue(new Error("Telegram API sendMessage: blocked"));

    const result = await deliverToConversation({ kind: "telegram", id: telegramId, subscriberId: telegramPeer }, "Здравствуйте");

    expect(result.ok).toBe(false);
    expect(logSystemError).toHaveBeenCalledTimes(1);
    const [source, message] = logSystemError.mock.calls[0] as [string, string];
    expect(source).toBe("telegram");
    expect(message).toContain("blocked");
  });

  it("закрытое 24-часовое окно Meta — отдельный код и понятный текст, а не общее «не удалось»", async () => {
    const { deliverToConversation } = await import("../src/lib/conversationDelivery.js");
    sendMetaMessage.mockRejectedValue(
      new Error(
        'Graph API HTTP 400: {"error":{"message":"(#131047) Message failed to send because more than 24 hours have passed since the customer last replied to this number.","type":"OAuthException","code":131047}}'
      )
    );

    const result = await deliverToConversation(
      { kind: "bot", id: botId, channel: "WHATSAPP", subscriberId: "992900000000", accountId: fixture.id, transport: fixture.transport },
      "Здравствуйте"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("window_closed");
      expect(result.error).toMatch(/24 час/);
      expect(result.error).not.toBe("Не удалось отправить сообщение");
    }
  });

  it("успешная отправка журнал не трогает", async () => {
    const { deliverToConversation } = await import("../src/lib/conversationDelivery.js");
    sendMetaMessage.mockResolvedValue(undefined);

    const result = await deliverToConversation(
      { kind: "bot", id: botId, channel: "WHATSAPP", subscriberId: "992900000000", accountId: fixture.id, transport: fixture.transport },
      "Здравствуйте"
    );

    expect(result.ok).toBe(true);
    expect(sendMetaMessage).toHaveBeenCalledTimes(1);
    expect(logSystemError).not.toHaveBeenCalled();
  });
});

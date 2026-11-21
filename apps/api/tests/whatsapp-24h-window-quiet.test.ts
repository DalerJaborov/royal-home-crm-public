import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * Окно 24 часа WhatsApp (21.11.2026): свободный текст вне окна не отправляется
 * заранее (WhatsApp принимает его с 200 и «не доставил» сообщает статусом 131047,
 * а в Журнал ошибок падала запись), сотруднику — понятный текст, автоматике —
 * тихий отказ без записи об ошибке; внутри окна всё как раньше.
 */
const { logSystemError, sendMetaMessage } = vi.hoisted(() => ({ logSystemError: vi.fn(), sendMetaMessage: vi.fn() }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError,
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  isMetaChannelEnabled: async () => true, sendMessage: sendMetaMessage,
}));
vi.mock("../src/messengers/appendMessages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/appendMessages.js")>()),
  appendConversationMessages: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/botLessons.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/botLessons.js")>()), recordLesson: vi.fn(async () => undefined),
}));

const { prisma } = await import("../src/db.js");
const { isWhatsAppWindowFailure, windowClosedStaffText } = await import("../src/lib/messagingWindow.js");
let fixture: CustomerMessengerFixture;
let botId: string;
const target = () => ({ kind: "bot" as const, id: botId, channel: "WHATSAPP", subscriberId: "992900000001", accountId: fixture.id, transport: fixture.transport });
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const setLastClient = (at: string | null) =>
  prisma.botConversation.update({
    where: { id: botId },
    data: { messages: at ? [{ role: "user", content: "здравствуйте", at }, { role: "assistant", content: "ок" }] : [] },
  });

beforeAll(async () => {
  fixture = await createCustomerMessengerFixture("WHATSAPP");
  botId = (await fixture.ensureConversation("992900000001")).id;
});
afterAll(async () => { await fixture?.dispose(); });
beforeEach(() => { logSystemError.mockClear(); sendMetaMessage.mockReset(); sendMetaMessage.mockResolvedValue("wamid.test"); });

describe("WhatsApp: вне окна 24 часов", () => {
  it("сотрудник: не отправляем, понятный текст, код window_closed", async () => {
    const { deliverToConversation } = await import("../src/lib/conversationDelivery.js");
    await setLastClient(hoursAgo(30));
    const r = await deliverToConversation(target(), "Добрый день", undefined, { sender: { kind: "agent", agentId: "a1", agentName: "Умед" } });
    expect(r).toMatchObject({ ok: false, code: "window_closed", error: "Прошло больше 24 часов, напишите клиенту шаблоном «Написать в WhatsApp»." });
    expect(sendMetaMessage).not.toHaveBeenCalled();
    expect(logSystemError).not.toHaveBeenCalled();
  });

  it("автоматика: не отправляем и не пишем ошибку", async () => {
    const { deliverToConversation } = await import("../src/lib/conversationDelivery.js");
    await setLastClient(hoursAgo(48));
    const r = await deliverToConversation(target(), "Напоминание");
    expect(r).toMatchObject({ ok: false, code: "window_closed" });
    expect(sendMetaMessage).not.toHaveBeenCalled();
    expect(logSystemError).not.toHaveBeenCalled();
  });

  it("внутри окна отправка идёт как раньше", async () => {
    const { deliverToConversation } = await import("../src/lib/conversationDelivery.js");
    await setLastClient(hoursAgo(2));
    const r = await deliverToConversation(target(), "Добрый день", undefined, { sender: { kind: "agent", agentId: "a1", agentName: "Умед" } });
    expect(r.ok).toBe(true);
    expect(sendMetaMessage).toHaveBeenCalledTimes(1);
  });

  it("время последней реплики клиента неизвестно — не блокируем", async () => {
    const { deliverToConversation } = await import("../src/lib/conversationDelivery.js");
    await setLastClient(null);
    const r = await deliverToConversation(target(), "Добрый день", undefined, { sender: { kind: "agent", agentId: "a1", agentName: "Умед" } });
    expect(r.ok).toBe(true);
  });
});

describe("статус failed из вебхука", () => {
  it("131047 и текст про 24 часа — штатное правило, не ошибка системы", () => {
    expect(isWhatsAppWindowFailure(131047, undefined)).toBe(true);
    expect(isWhatsAppWindowFailure(undefined, "Re-engagement message — more than 24 hours have passed since the customer last replied")).toBe(true);
  });
  it("настоящие причины остаются ошибками", () => {
    expect(isWhatsAppWindowFailure(131026, "Message undeliverable")).toBe(false);
    expect(isWhatsAppWindowFailure(131049, "healthy ecosystem engagement")).toBe(false);
    expect(isWhatsAppWindowFailure(undefined, undefined)).toBe(false);
  });
  it("текст для Instagram/Messenger без шаблона WhatsApp", () => {
    expect(windowClosedStaffText("INSTAGRAM")).not.toContain("Написать в WhatsApp");
  });
});

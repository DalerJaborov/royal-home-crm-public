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
const { isWhatsAppWindowFailure, windowClosedStaffText, isMessagingWindowOpen } = await import("../src/lib/messagingWindow.js");
const { lastInboundAt, messagingWindowState } = await import("@royal-home/shared");
const { lastInboundMessageAt, isMessagingWindowClosed } = await import("../../web/src/lib/messagingWindow.js");
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

describe("гонка: клиент ответил на шаблон, реплика ещё не легла в переписку", () => {
  it("в переписке старая реплика (9 дней), но входящий пришёл сейчас — ссылка уходит", async () => {
    const { deliverToConversation } = await import("../src/lib/conversationDelivery.js");
    await setLastClient(hoursAgo(9 * 24));
    const r = await deliverToConversation(target(), "Ссылка на объект", undefined, {
      sender: { kind: "agent", agentId: "a1", agentName: "Умед" }, inboundAt: new Date(),
    });
    expect(r.ok).toBe(true);
    expect(sendMetaMessage).toHaveBeenCalledTimes(1);
  });
  it("без времени входящего та же переписка блокируется", async () => {
    const { deliverToConversation } = await import("../src/lib/conversationDelivery.js");
    await setLastClient(hoursAgo(9 * 24));
    const r = await deliverToConversation(target(), "Ссылка на объект", undefined, { sender: { kind: "agent", agentId: "a1", agentName: "Умед" } });
    expect(r).toMatchObject({ ok: false, code: "window_closed" });
  });
});

describe("одно правило окна: сервер, экран и кнопка согласны", () => {
  const cases: { name: string; messages: { role: string; at?: string }[] }[] = [
    { name: "свежая реплика", messages: [{ role: "user", at: hoursAgo(1) }] },
    { name: "старая реплика", messages: [{ role: "user", at: hoursAgo(50) }] },
    { name: "порядок записей не совпадает со временем: позднее стоит раньше", messages: [{ role: "user", at: hoursAgo(1) }, { role: "assistant" }, { role: "user", at: hoursAgo(80) }] },
    { name: "реплики без времени", messages: [{ role: "user" }, { role: "assistant", at: hoursAgo(1) }] },
    { name: "клиент не писал", messages: [{ role: "assistant", at: hoursAgo(1) }] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const last = lastInboundAt(c.messages);
      const state = messagingWindowState("WHATSAPP", last);
      // сервер (проверка отправки и подсказка в карточке) и экран дают один ответ
      expect(isMessagingWindowOpen("WHATSAPP", last)).toBe(state !== "closed");
      expect(isMessagingWindowClosed("WHATSAPP", lastInboundMessageAt(c.messages as never))).toBe(state === "closed");
    });
  }
  it("максимум по времени, неизвестно не блокирует, Telegram без окна", () => {
    expect(lastInboundAt(cases[2].messages)?.getTime()).toBeGreaterThan(Date.now() - 2 * 3600_000);
    expect(messagingWindowState("WHATSAPP", null)).toBe("unknown");
    expect(messagingWindowState("TELEGRAM", hoursAgo(500))).toBe("open");
    expect(lastInboundAt([{ role: "user", at: hoursAgo(100) }], new Date())).not.toBeNull();
    expect(messagingWindowState("WHATSAPP", lastInboundAt([{ role: "user", at: hoursAgo(100) }], new Date()))).toBe("open");
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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { prisma } from "../src/db.js";
import { handleOutgoingEcho } from "../src/routes/webhooks.js";

/**
 * СОТРУДНИК ОТВЕТИЛ РУКАМИ ИЗ ПРИЛОЖЕНИЯ — БОТ ОБЯЗАН ЗАМОЛЧАТЬ (17.08.2026).
 *
 * Вопрос владельца: «когда кто-то вручную отвечает в инстаграме, а не в CRM,
 * бот остановится или нет?». Не останавливался: эхо исходящих отбрасывалось в
 * разборе целиком, CRM о таком ответе не узнавала, и бот продолжал вести диалог
 * параллельно с живым человеком.
 *
 * ГЛАВНАЯ ЛОВУШКА, которую и стережёт этот файл: эхо приходит и на реплики
 * САМОГО БОТА. Если не отличать своё от чужого, бот ставил бы себе паузу после
 * каждого собственного сообщения и замолчал бы навсегда.
 */

let fixture: CustomerMessengerFixture;
beforeAll(async () => { fixture = await createCustomerMessengerFixture("INSTAGRAM"); });

const runId = Date.now().toString(36);
const SUBSCRIBER = `echo-${runId}`;

async function makeConversation(messages: unknown[]): Promise<string> {
  const conv = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      accountId: fixture.id, endpointScopeId: fixture.transport.endpointScopeId,
      subscriberId: SUBSCRIBER,
      messages: messages as never,
      leadDraft: { stage: "chatting" } as never,
    },
  });
  return conv.id;
}

beforeEach(async () => {
  await fixture.cleanupConversations();
});

afterAll(async () => {
  await fixture?.dispose();
});

describe("Ручной ответ из мессенджера останавливает бота", () => {
  it("незнакомый mid — это человек: реплика в переписке, бот на паузе", async () => {
    const id = await makeConversation([{ role: "user", content: "Салом", at: new Date().toISOString() }]);

    await handleOutgoingEcho({
      channel: "INSTAGRAM",
      accountExternalId: fixture.externalId,
      senderId: SUBSCRIBER,
      text: "Здравствуйте, отвечаю вручную",
      messageId: "mid-from-phone",
    });

    const conv = await prisma.botConversation.findUnique({
      where: { id },
      select: { messages: true, pausedUntil: true },
    });
    const messages = (Array.isArray(conv?.messages) ? conv!.messages : []) as {
      role: string;
      content: string;
      by?: { kind: string };
    }[];
    const manual = messages.find((m) => m.content.includes("отвечаю вручную"));
    expect(manual).toBeDefined();
    expect(manual!.role).toBe("assistant");
    // Подписано «вручную», а не выдуманным сотрудником и не «CRM»: кто именно
    // писал, Meta не сообщает (см. MessageSender в @royal-home/shared).
    expect(manual!.by?.kind).toBe("manual");
    // Главное: бот замолчал.
    expect(conv?.pausedUntil).toBeTruthy();
    expect(conv!.pausedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("СВОЙ mid — это реплика бота: ни записи, ни паузы", async () => {
    // Ровно тот случай, из-за которого бот заглушил бы сам себя: своё же
    // отправленное сообщение возвращается эхом с mid, который у нас записан.
    const id = await makeConversation([
      { role: "assistant", content: "Ассалому алейкум!", by: { kind: "bot" }, mid: "mid-ours-1" },
    ]);

    await handleOutgoingEcho({
      channel: "INSTAGRAM",
      accountExternalId: fixture.externalId,
      senderId: SUBSCRIBER,
      text: "Ассалому алейкум!",
      messageId: "mid-ours-1",
    });

    const conv = await prisma.botConversation.findUnique({
      where: { id },
      select: { messages: true, pausedUntil: true },
    });
    const messages = (Array.isArray(conv?.messages) ? conv!.messages : []) as unknown[];
    expect(messages).toHaveLength(1);
    expect(conv?.pausedUntil).toBeNull();
  });

  it("второй пузырь ответа бота (mid2) тоже своим и остаётся", async () => {
    const id = await makeConversation([
      { role: "assistant", content: "Первое\nВторое", by: { kind: "bot" }, mid: "mid-a", mid2: "mid-b" },
    ]);

    await handleOutgoingEcho({ channel: "INSTAGRAM", accountExternalId: fixture.externalId, senderId: SUBSCRIBER, text: "Второе", messageId: "mid-b" });

    const conv = await prisma.botConversation.findUnique({
      where: { id },
      select: { messages: true, pausedUntil: true },
    });
    expect((conv?.messages as unknown[]) ?? []).toHaveLength(1);
    expect(conv?.pausedUntil).toBeNull();
  });

  it("диалога нет — ничего не заводим (сотрудник написал первым)", async () => {
    await handleOutgoingEcho({
      channel: "INSTAGRAM",
      accountExternalId: fixture.externalId,
      senderId: `${SUBSCRIBER}-nobody`,
      text: "Пишу первым",
      messageId: "mid-x",
    });

    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: `${SUBSCRIBER}-nobody` },
    });
    expect(conv).toBeNull();
  });

  it("вложение без текста тоже останавливает бота", async () => {
    const id = await makeConversation([{ role: "user", content: "Салом" }]);

    await handleOutgoingEcho({
      channel: "INSTAGRAM",
      accountExternalId: fixture.externalId,
      senderId: SUBSCRIBER,
      text: "",
      attachmentType: "image",
      messageId: "mid-photo",
    });

    const conv = await prisma.botConversation.findUnique({
      where: { id },
      select: { messages: true, pausedUntil: true },
    });
    const messages = (Array.isArray(conv?.messages) ? conv!.messages : []) as { content: string }[];
    expect(messages.some((m) => m.content.includes("вложение: image"))).toBe(true);
    expect(conv?.pausedUntil).toBeTruthy();
  });
});

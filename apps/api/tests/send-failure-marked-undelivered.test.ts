import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { prisma } from "../src/db.js";
import { appendConversationMessages, markLastReplyUndelivered, stampOutgoingMid } from "../src/messengers/conversation.js";

/**
 * ОТВЕТ, КОТОРЫЙ НЕ УШЁЛ, НЕ ДОЛЖЕН ВЫГЛЯДЕТЬ ОТПРАВЛЕННЫМ.
 *
 * Реплика бота пишется в переписку ДО отправки в Meta. Отправка упала (закрытое
 * окно 24 часов, отозванный маркер, 5xx Graph API) — и в CRM остаётся ответ,
 * которого клиент никогда не видел; вебхуку уже ответили 200, повтора не будет.
 * Сотрудник открывает переписку, видит «бот ответил» и не отвечает сам — человек
 * остаётся без ответа вообще (docs/bot-razbor-20-09.md, класс 7 п. 1).
 */
let fixture: CustomerMessengerFixture;
beforeAll(async () => { fixture = await createCustomerMessengerFixture("INSTAGRAM"); });

const runId = `${process.pid}`;
const subscribers: string[] = [];

async function seedWithReply(text: string): Promise<string> {
  const subscriberId = `send-fail-${runId}-${subscribers.length}`;
  subscribers.push(subscriberId);
  await prisma.botConversation.create({
    data: { channel: "INSTAGRAM", accountId: fixture.id, endpointScopeId: fixture.transport.endpointScopeId, subscriberId, leadDraft: { stage: "chatting" } as never },
  });
  await appendConversationMessages(
    (await prisma.botConversation.findUniqueOrThrow({
      where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId } },
      select: { id: true },
    })).id,
    [{ role: "assistant", content: text, by: { kind: "bot" } }]
  );
  return subscriberId;
}

async function lastMessage(subscriberId: string): Promise<Record<string, unknown>> {
  const row = await prisma.botConversation.findUniqueOrThrow({
    where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId } },
    select: { messages: true },
  });
  const messages = (row.messages ?? []) as Record<string, unknown>[];
  return messages[messages.length - 1] ?? {};
}

afterAll(async () => {
  await fixture?.dispose();
});

describe("Неудачная отправка видна в переписке", () => {
  it("ответ без идентификатора отправки помечается как не дошедший", async () => {
    const subscriberId = await seedWithReply("Салом! Чӣ гуна хона мекобед?");
    await markLastReplyUndelivered("INSTAGRAM", subscriberId, fixture.transport);
    expect((await lastMessage(subscriberId)).deliveryStatus).toBe("failed");
  });

  it("ушедший ответ пометкой не портится", async () => {
    // Обратная сторона: идентификатор есть — значит Meta приняла сообщение, и
    // помечать всю реплику неудачей было бы враньём в обратную сторону.
    const subscriberId = await seedWithReply("Ин хона фурӯхта шуд.");
    await stampOutgoingMid("INSTAGRAM", subscriberId, `mid-ok-${runId}`, fixture.transport);
    await markLastReplyUndelivered("INSTAGRAM", subscriberId, fixture.transport);
    const last = await lastMessage(subscriberId);
    expect(last.mid).toBe(`mid-ok-${runId}`);
    expect(last.deliveryStatus).toBeUndefined();
  });

  it("последним говорил клиент — метить нечего", async () => {
    const subscriberId = `send-fail-${runId}-user`;
    subscribers.push(subscriberId);
    const conv = await prisma.botConversation.create({
      data: { channel: "INSTAGRAM", accountId: fixture.id, endpointScopeId: fixture.transport.endpointScopeId, subscriberId, leadDraft: { stage: "chatting" } as never },
    });
    await appendConversationMessages(conv.id, [{ role: "user", content: "Салом" }]);
    await markLastReplyUndelivered("INSTAGRAM", subscriberId, fixture.transport);
    const last = await lastMessage(subscriberId);
    expect(last.role).toBe("user");
    expect(last.deliveryStatus).toBeUndefined();
  });

  it("повторный вызов ничего не меняет", async () => {
    const subscriberId = await seedWithReply("Рақами телефонатонро нависед.");
    await markLastReplyUndelivered("INSTAGRAM", subscriberId, fixture.transport);
    await markLastReplyUndelivered("INSTAGRAM", subscriberId, fixture.transport);
    expect((await lastMessage(subscriberId)).deliveryStatus).toBe("failed");
  });
});

import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * СЛУЖЕБНАЯ ОТПРАВКА («system») НЕ СТАВИТ ПАУЗУ ОПЕРАТОРА (24.09.2026, ночная проверка).
 *
 * `deliverToConversation` без `sender` (или с явным `{kind:"system"}`) — это
 * автоматический текст CRM без человека за штурвалом: просьба подтвердить показ,
 * напоминание. Правка #801 (23.09.2026) сделала так, что такая отправка не
 * УКОРАЧИВАЕТ действующую паузу «оператор взял разговор» — но она всё ещё
 * ставила/продлевала эту паузу, если её не было или срок истёк. Клиент получал
 * служебный вопрос, а бот потом молчал недели/годы, как будто разговор ведёт
 * человек. Пауза от «system» теперь не появляется вовсе; действующую паузу
 * (её поставил агент или бот) это по-прежнему не трогает — ни снять, ни продлить
 * (см. bot-pause-never-shortened.test.ts).
 */

const { sendMessage, isMetaChannelEnabled } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_c: string, _to: string, _text: string) => "wamid.sent-1"),
  isMetaChannelEnabled: vi.fn(async () => true),
}));

vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  sendMessage,
  isMetaChannelEnabled,
}));

const { prisma } = await import("../src/db.js");
const { deliverToConversation } = await import("../src/lib/conversationDelivery.js");

let fixture: CustomerMessengerFixture;
beforeAll(async () => { fixture = await createCustomerMessengerFixture("INSTAGRAM"); });

const runId = Date.now().toString(36);
const conversationIds: string[] = [];

afterEach(() => vi.clearAllMocks());
afterAll(async () => {
  await fixture?.dispose();
});

async function savedPause(id: string) {
  return prisma.botConversation.findUnique({ where: { id }, select: { pausedUntil: true, botPausedAt: true } });
}

describe("Служебная отправка (sender=system) не ставит паузу оператора", () => {
  it("паузы не было — служебная отправка без sender её не создаёт", async () => {
    const c = await prisma.botConversation.create({
      data: { channel: "INSTAGRAM", accountId: fixture.id, endpointScopeId: fixture.transport.endpointScopeId, subscriberId: `sys-no-pause-${runId}-1`, messages: [] },
    });
    conversationIds.push(c.id);

    const result = await deliverToConversation(
      { kind: "bot", id: c.id, channel: c.channel, subscriberId: c.subscriberId, accountId: fixture.id, transport: fixture.transport },
      "Напоминаем о показе завтра в 11:00"
    );

    expect(result.ok).toBe(true);
    const saved = await savedPause(c.id);
    expect(saved!.pausedUntil).toBeNull();
    expect(saved!.botPausedAt).toBeNull();
  });

  it("паузы не было — служебная отправка с явным sender:{kind:\"system\"} её тоже не создаёт", async () => {
    const c = await prisma.botConversation.create({
      data: { channel: "INSTAGRAM", accountId: fixture.id, endpointScopeId: fixture.transport.endpointScopeId, subscriberId: `sys-no-pause-${runId}-2`, messages: [] },
    });
    conversationIds.push(c.id);

    const result = await deliverToConversation(
      { kind: "bot", id: c.id, channel: c.channel, subscriberId: c.subscriberId, accountId: fixture.id, transport: fixture.transport },
      "Вопрос об отзыве",
      undefined,
      { sender: { kind: "system" } }
    );

    expect(result.ok).toBe(true);
    const saved = await savedPause(c.id);
    expect(saved!.pausedUntil).toBeNull();
  });

  it("пауза уже стоит (агент забрал диалог) — служебная отправка оставляет её как есть", async () => {
    const long = new Date(Date.now() + 60 * 24 * 365 * 10 * 60 * 1000);
    const startedAt = new Date(Date.now() - 60 * 60 * 1000);
    const c = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        accountId: fixture.id,
        endpointScopeId: fixture.transport.endpointScopeId,
        subscriberId: `sys-keep-pause-${runId}`,
        messages: [],
        pausedUntil: long,
        botPausedAt: startedAt,
      },
    });
    conversationIds.push(c.id);

    const result = await deliverToConversation(
      { kind: "bot", id: c.id, channel: c.channel, subscriberId: c.subscriberId, accountId: fixture.id, transport: fixture.transport },
      "Напоминаем о показе завтра в 11:00"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pausedUntil.getTime()).toBe(long.getTime());
    const saved = await savedPause(c.id);
    // Ни срок, ни отметка начала паузы не сдвинулись — этот вызов её вообще не писал.
    expect(saved!.pausedUntil!.getTime()).toBe(long.getTime());
    expect(saved!.botPausedAt!.getTime()).toBe(startedAt.getTime());
  });

  it("пауза истекла — служебная отправка её не переставляет заново", async () => {
    const expired = new Date(Date.now() - 60_000);
    const c = await prisma.botConversation.create({
      data: { channel: "INSTAGRAM", accountId: fixture.id, endpointScopeId: fixture.transport.endpointScopeId, subscriberId: `sys-expired-pause-${runId}`, messages: [], pausedUntil: expired },
    });
    conversationIds.push(c.id);

    const result = await deliverToConversation(
      { kind: "bot", id: c.id, channel: c.channel, subscriberId: c.subscriberId, accountId: fixture.id, transport: fixture.transport },
      "Служебное сообщение"
    );

    expect(result.ok).toBe(true);
    const saved = await savedPause(c.id);
    expect(saved!.pausedUntil!.getTime()).toBe(expired.getTime());
  });
});

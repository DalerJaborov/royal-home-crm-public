import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ДЕЙСТВУЮЩУЮ ПАУЗУ БОТА НЕ УКОРАЧИВАЕТ НИКТО, КРОМЕ ЧЕЛОВЕКА (23.09.2026).
 *
 * Свой агент ответил клиенту — бот на паузе на 10 лет (OPERATOR_REPLY_PAUSE_MS).
 * Следом CRM сама отправляла клиенту напоминание о показе, вопрос об отзыве,
 * «уточняю у собственника» (без отправителя-агента — короткая пауза), или
 * сотрудник дописывал из приложения Instagram (эхо — тоже короткая), и запись
 * срока была безусловной: 10 лет превращались в 10 минут. Через 10 минут бот
 * снова вёл разговор параллельно с агентом.
 *
 * Явный срок, выбранный живым человеком в инбоксе, по-прежнему ставится как есть
 * (см. operator-reply-pause-default.test.ts).
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
const { deliverToConversation, applyDeliveryPause, OPERATOR_REPLY_PAUSE_MS } = await import(
  "../src/lib/conversationDelivery.js"
);
const { handleOutgoingEcho } = await import("../src/routes/webhooks.js");

let fixture: CustomerMessengerFixture;
beforeAll(async () => { fixture = await createCustomerMessengerFixture("INSTAGRAM"); });

const runId = Date.now().toString(36);
const conversationIds: string[] = [];
const telegramIds: string[] = [];
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

async function makePausedConversation() {
  const long = new Date(Date.now() + OPERATOR_REPLY_PAUSE_MS);
  const startedAt = new Date(Date.now() - 60 * 60 * 1000);
  const c = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      accountId: fixture.id, endpointScopeId: fixture.transport.endpointScopeId,
      subscriberId: `pause-keep-${runId}-${conversationIds.length}`,
      messages: [],
      pausedUntil: long,
      botPausedAt: startedAt,
    },
  });
  conversationIds.push(c.id);
  return { c, long, startedAt };
}

afterEach(() => vi.clearAllMocks());
afterAll(async () => {
  await fixture?.dispose();
  if (telegramIds.length > 0) await prisma.telegramConversation.deleteMany({ where: { id: { in: telegramIds } } });
});

async function savedPause(id: string) {
  return prisma.botConversation.findUnique({ where: { id }, select: { pausedUntil: true, botPausedAt: true } });
}

describe("Действующая пауза бота не укорачивается", () => {
  it("служебная отправка CRM (без отправителя) не сжимает паузу агента до 10 минут", async () => {
    const { c, long, startedAt } = await makePausedConversation();

    const result = await deliverToConversation(
      { kind: "bot", id: c.id, channel: c.channel, subscriberId: c.subscriberId, accountId: fixture.id, transport: fixture.transport },
      "Напоминаем о показе завтра в 11:00"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pausedUntil.getTime()).toBe(long.getTime());
    const saved = await savedPause(c.id);
    expect(saved!.pausedUntil!.getTime()).toBe(long.getTime());
    // Паузу начал не этот вызов — отметка её начала на месте.
    expect(saved!.botPausedAt!.getTime()).toBe(startedAt.getTime());
  });

  it("отправка от имени бота (вопрос об отзыве) не сжимает паузу", async () => {
    const { c, long } = await makePausedConversation();

    const result = await deliverToConversation(
      { kind: "bot", id: c.id, channel: c.channel, subscriberId: c.subscriberId, accountId: fixture.id, transport: fixture.transport },
      "Оцените, пожалуйста, работу агента",
      undefined,
      { sender: { kind: "bot" } }
    );

    expect(result.ok).toBe(true);
    const saved = await savedPause(c.id);
    expect(saved!.pausedUntil!.getTime()).toBe(long.getTime());
  });

  it("сотрудник дописал из приложения Instagram (эхо) — пауза остаётся длинной", async () => {
    const { c, long } = await makePausedConversation();

    await handleOutgoingEcho({
      channel: "INSTAGRAM",
      senderId: c.subscriberId,
      accountExternalId: fixture.externalId,
      text: "Дописываю с телефона",
      messageId: `mid-phone-${runId}`,
    });

    const saved = await savedPause(c.id);
    expect(saved!.pausedUntil!.getTime()).toBe(long.getTime());
    expect(saved!.pausedUntil!.getTime() - Date.now()).toBeGreaterThan(ONE_YEAR_MS);
  });

  // ПОПРАВЛЕНО 24.09.2026 (ночная проверка, «Бот, служебные отправки»): раньше этот
  // тест называл «как раньше» и проверял, что служебная отправка ставит истёкшей
  // паузе новый срок наперёд. Решение владельца — от «system» пауза не должна
  // ставиться ВООБЩЕ, даже поверх истёкшей: см. system-sender-no-pause.test.ts.
  it("истёкшую паузу служебная отправка не переставляет заново", async () => {
    const expired = new Date(Date.now() - 60_000);
    const c = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        accountId: fixture.id, endpointScopeId: fixture.transport.endpointScopeId,
        subscriberId: `pause-expired-${runId}`,
        messages: [],
        pausedUntil: expired,
      },
    });
    conversationIds.push(c.id);

    const result = await deliverToConversation(
      { kind: "bot", id: c.id, channel: c.channel, subscriberId: c.subscriberId, accountId: fixture.id, transport: fixture.transport },
      "Служебное сообщение"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pausedUntil.getTime()).toBe(expired.getTime());
    const saved = await savedPause(c.id);
    expect(saved!.pausedUntil!.getTime()).toBe(expired.getTime());
  });

  it("явный срок, выбранный человеком, по-прежнему укорачивает паузу", async () => {
    const { c } = await makePausedConversation();
    const hour = new Date(Date.now() + 60 * 60 * 1000);

    const result = await deliverToConversation(
      { kind: "bot", id: c.id, channel: c.channel, subscriberId: c.subscriberId, accountId: fixture.id, transport: fixture.transport },
      "Верну бота через час",
      hour,
      { sender: { kind: "agent", agentId: "agent-x", agentName: "Агент" } }
    );

    expect(result.ok).toBe(true);
    const saved = await savedPause(c.id);
    expect(saved!.pausedUntil!.getTime()).toBe(hour.getTime());
  });

  it("Telegram: срок по умолчанию не укорачивает действующую паузу", async () => {
    const long = new Date(Date.now() + OPERATOR_REPLY_PAUSE_MS);
    const t = await prisma.telegramConversation.create({
      data: { chatId: `pause-keep-tg-${runId}`, messages: [], pausedUntil: long },
    });
    telegramIds.push(t.id);

    const effective = await applyDeliveryPause({ kind: "telegram", id: t.id }, new Date(Date.now() + 10 * 60 * 1000), true);

    expect(effective.getTime()).toBe(long.getTime());
    const saved = await prisma.telegramConversation.findUnique({ where: { id: t.id }, select: { pausedUntil: true } });
    expect(saved!.pausedUntil!.getTime()).toBe(long.getTime());
  });
});

import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";

/**
 * ТРИ ОТСЕЧКИ «НЕ ПО ТЕМЕ» ПОДРЯД — БОТ ЗОВЁТ ЧЕЛОВЕКА (пачка 7, 11.09.2026).
 *
 * До этой правки офтопик-отсечка (messengers/conversation.ts, ai/offTopicGuard.ts)
 * молчала НАВСЕГДА — решение владельца 21.08.2026, и это верно для разовой отсечки.
 * Но если один и тот же диалог трижды подряд получает «не по теме», значит бот
 * застрял на ходе, который код не умеет разобрать, а offTopicReplies растёт молча —
 * и клиент остаётся без ответа НАВСЕГДА, а не просто без ответа бота. Третья
 * отсечка подряд обязана снять бота с диалога (тем же полем pausedUntil, каким это
 * делает jobs/aiReplyRetry.ts при непроходимом ходе) и позвать человека пушем.
 *
 * Гвард срабатывает КОДОМ, без обращения к модели — поэтому callAiText замокан
 * пустышкой: тест обязан упасть, если по ошибке сработает ход модели там, где
 * должно быть чистое молчание/передача человеку.
 */
const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { sendPushToAgents } = vi.hoisted(() => ({ sendPushToAgents: vi.fn(async () => 0) }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents }));
vi.mock("../src/lib/recipients.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/recipients.js")>()),
  findAgentsWithPermission: async () => ["agent-1"],
}));

const { processMessengerTurn: actualProcessMessengerTurn } = await import("../src/messengers/conversation.js");

let messengerFixture: CustomerMessengerFixture;
function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  return actualProcessMessengerTurn({ ...input, ...messengerFixture.turnInput(input.subscriberId) });
}

const runId = Date.now().toString(36);
const SUBSCRIBER_PREFIX = `offtopic-handover-${runId}`;

// Разведка про устройство бота — код-детектируемая офтопик-отсечка (см.
// off-topic-guard.test.ts), ходу модели тут взяться неоткуда.
const OFFTOPIC_TEXT = "а кто тебя создал?";

beforeAll(async () => {
  messengerFixture = await createCustomerMessengerFixture("INSTAGRAM");
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  await messengerFixture?.dispose();
});

describe("первая и вторая отсечка подряд — бот молчит, но НЕ снимается с диалога", () => {
  it("первая отсечка: offTopicReplies 0 → 1, пауза не ставится, пуш не идёт", async () => {
    const subscriber = `${SUBSCRIBER_PREFIX}-first`;
    callAi.mockClear();
    sendPushToAgents.mockClear();

    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: subscriber, text: OFFTOPIC_TEXT });

    expect(result.shouldReply).toBe(false);
    expect(callAi).not.toHaveBeenCalled();
    expect(sendPushToAgents).not.toHaveBeenCalled();

    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: subscriber },
      select: { offTopicReplies: true, pausedUntil: true },
    });
    expect(conv?.offTopicReplies).toBe(1);
    expect(conv?.pausedUntil).toBeNull();
  });

  it("вторая отсечка подряд: offTopicReplies 1 → 2, всё ещё без паузы и без пуша", async () => {
    const subscriber = `${SUBSCRIBER_PREFIX}-second`;
    await prisma.botConversation.update({
      where: { id: (await messengerFixture.ensureConversation(subscriber)).id },
      data: {
        channel: "INSTAGRAM",
        subscriberId: subscriber,
        offTopicReplies: 1,
        messages: [
          { role: "user", content: OFFTOPIC_TEXT },
          { role: "assistant", content: "[⛔ разведка про устройство бота — бот молчит]" },
        ] as never,
      },
    });
    callAi.mockClear();
    sendPushToAgents.mockClear();

    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: subscriber, text: OFFTOPIC_TEXT });

    expect(result.shouldReply).toBe(false);
    expect(callAi).not.toHaveBeenCalled();
    expect(sendPushToAgents).not.toHaveBeenCalled();

    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: subscriber },
      select: { offTopicReplies: true, pausedUntil: true },
    });
    expect(conv?.offTopicReplies).toBe(2);
    expect(conv?.pausedUntil).toBeNull();
  });
});

describe("третья отсечка подряд — бот снят с диалога и позван человек", () => {
  it("пауза ставится в далёкое будущее, счётчик сбрасывается, идёт пуш", async () => {
    const subscriber = `${SUBSCRIBER_PREFIX}-third`;
    await prisma.botConversation.update({
      where: { id: (await messengerFixture.ensureConversation(subscriber)).id },
      data: {
        channel: "INSTAGRAM",
        subscriberId: subscriber,
        offTopicReplies: 2,
        messages: [
          { role: "user", content: OFFTOPIC_TEXT },
          { role: "assistant", content: "[⛔ разведка про устройство бота — бот молчит]" },
          { role: "user", content: OFFTOPIC_TEXT },
          { role: "assistant", content: "[⛔ разведка про устройство бота — бот молчит]" },
        ] as never,
      },
    });
    callAi.mockClear();
    sendPushToAgents.mockClear();

    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: subscriber, text: OFFTOPIC_TEXT });

    expect(result.shouldReply).toBe(false);
    expect(callAi).not.toHaveBeenCalled();

    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: subscriber },
      select: { offTopicReplies: true, pausedUntil: true, botPausedAt: true },
    });
    // Счётчик сброшен — третий эпизод закрыт передачей человеку, а не тихим накоплением.
    expect(conv?.offTopicReplies).toBe(0);
    // Пауза — тем же приёмом, что и у непроходимого хода ИИ: далеко в будущем, а не
    // на пару минут, чтобы кнопка «Вернуть боту» была единственным путём назад.
    expect(conv?.pausedUntil).toBeInstanceOf(Date);
    expect(conv!.pausedUntil!.getTime()).toBeGreaterThan(Date.now() + 365 * 24 * 60 * 60 * 1000);
    expect(conv?.botPausedAt).toBeInstanceOf(Date);

    // И позван человек — оба получателя: общая рассылка «сообщения» (findAgentsWithPermission
    // замокан одним "agent-1", реальное разделение на роли проверяется в recipients.ts).
    expect(sendPushToAgents).toHaveBeenCalledTimes(1);
    expect(sendPushToAgents).toHaveBeenCalledWith(
      ["agent-1"],
      expect.objectContaining({ tag: expect.stringContaining("ai-offtopic-handover-") })
    );
  });

  it("разговор о жилье после передачи человеку остаётся заблокированным ботом (пауза не спадает сама)", async () => {
    // Регресс-щит: пауза выставлена НАДОЛГО намеренно — снять её может только
    // кнопка «Вернуть боту», а не следующее сообщение клиента.
    const subscriber = `${SUBSCRIBER_PREFIX}-stays-paused`;
    await prisma.botConversation.update({
      where: { id: (await messengerFixture.ensureConversation(subscriber)).id },
      data: {
        channel: "INSTAGRAM",
        subscriberId: subscriber,
        pausedUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        botPausedAt: new Date(),
        messages: [{ role: "user", content: OFFTOPIC_TEXT }] as never,
      },
    });
    callAi.mockClear();

    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: subscriber, text: "3 хона дар Сино" });

    expect(result.shouldReply).toBe(false);
    expect(callAi).not.toHaveBeenCalled();
  });
});

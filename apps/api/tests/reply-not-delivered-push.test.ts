import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ОТВЕТ НЕ ДОШЁЛ — ПУШ АГЕНТУ, А НЕ ТОЛЬКО ЖУРНАЛ (24.09.2026, ночная проверка,
 * находка №108).
 *
 * Отказ отправки в Meta (5xx, протухший маркер) внутри catch у обработчика
 * ответа бота (routes/webhooks.ts) уже ставит отметку «не дошло»
 * (markLastReplyUndelivered) и пишет в журнал ошибок — но до этой правки никто
 * из тех, кто читает переписки, не узнавал об этом раньше утреннего отчёта или
 * следующего заглядывания в журнал. `notifyBotReplyNotDelivered` экспортирован
 * из webhooks.ts тем же приёмом, что и groupMetaBySender там же — гонять ради
 * него весь вебхук с подписью Meta не нужно.
 */

const { sendPushToAgents, findAgentsWithPermission, logSystemError } = vi.hoisted(() => ({
  sendPushToAgents: vi.fn(async () => 1),
  findAgentsWithPermission: vi.fn(async () => ["agent-1", "agent-2"]),
  logSystemError: vi.fn(async () => undefined),
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents }));

vi.mock("../src/lib/recipients.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/recipients.js")>()), findAgentsWithPermission,
}));

vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logSystemError,
}));

const { notifyBotReplyNotDelivered } = await import("../src/routes/webhooks.js");
const { prisma } = await import("../src/db.js");

const runId = Date.now().toString(36);
let instagram: CustomerMessengerFixture;
beforeAll(async () => { instagram = await createCustomerMessengerFixture("INSTAGRAM"); });
const conversationIds: string[] = [];

beforeEach(() => {
  sendPushToAgents.mockClear();
  findAgentsWithPermission.mockClear();
  logSystemError.mockClear();
});

afterEach(async () => {
  await instagram.cleanupConversations();
  conversationIds.length = 0;
});

afterAll(async () => {
  await instagram?.dispose();
  await prisma.$disconnect();
});

describe("notifyBotReplyNotDelivered", () => {
  it("шлёт пуш тем, кто читает переписки, со ссылкой на конкретный диалог", async () => {
    const subscriberId = `push-fail-${runId}-a`;
    const conv = await prisma.botConversation.create({
      data: { channel: "INSTAGRAM", accountId: instagram.id, endpointScopeId: instagram.transport.endpointScopeId,
        subscriberId, messages: [{ role: "user", content: "Салом" }] },
    });
    conversationIds.push(conv.id);

    await notifyBotReplyNotDelivered("INSTAGRAM", subscriberId, instagram.id);

    expect(findAgentsWithPermission).toHaveBeenCalledWith("messages.view");
    expect(sendPushToAgents).toHaveBeenCalledTimes(1);
    expect(sendPushToAgents).toHaveBeenCalledWith(
      ["agent-1", "agent-2"],
      expect.objectContaining({ url: `/messages?open=${conv.id}`, tag: `bot-reply-failed-INSTAGRAM-${subscriberId}` })
    );
  });

  it("диалог не найден (уже удалён) — пуш всё равно уходит, но без конкретной ссылки", async () => {
    await notifyBotReplyNotDelivered("INSTAGRAM", `push-fail-${runId}-missing`, instagram.id);

    expect(sendPushToAgents).toHaveBeenCalledTimes(1);
    expect(sendPushToAgents).toHaveBeenCalledWith(["agent-1", "agent-2"], expect.objectContaining({ url: "/messages" }));
  });

  it("сбой самого пуша не бросает исключение наружу — уходит в журнал ошибок", async () => {
    sendPushToAgents.mockRejectedValueOnce(new Error("push service недоступен"));

    await expect(notifyBotReplyNotDelivered("INSTAGRAM", `push-fail-${runId}-boom`, instagram.id)).resolves.toBeUndefined();
    expect(logSystemError).toHaveBeenCalledTimes(1);
  });
});

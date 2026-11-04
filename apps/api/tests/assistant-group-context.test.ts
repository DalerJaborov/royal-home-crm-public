import { randomInt } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  captureAssistantTelegramContext,
  cleanupAssistantTelegramContext,
  loadAssistantTelegramContext,
} from "../src/telegram/assistantGroupContext.js";

const unique = randomInt(100_000, 900_000);
const chatId = -980_000_000 - unique;
const otherChatId = chatId - 1_000_000;
const telegramUserId = 980_000_000 + unique;
const enabledAt = new Date("2026-11-01T09:00:00Z");
const now = new Date("2026-11-01T10:00:00Z");
const sourceDate = Math.floor(now.getTime() / 1_000);
let agentId: string;

function message(id: number, extra: Record<string, unknown> = {}) {
  return {
    message_id: id,
    chat: { id: chatId, type: "group" },
    from: { id: telegramUserId },
    date: sourceDate,
    text: "По ОБ-123 исходники переданы монтажёру.",
    ...extra,
  };
}

function lookup(extra: Partial<Parameters<typeof loadAssistantTelegramContext>[0]> = {}, at = now) {
  return loadAssistantTelegramContext({
    chatId: String(chatId), threadId: null, agentId,
    telegramUserId: String(telegramUserId), beforeMessageId: 15,
    selector: { propertyShortId: 123 }, ...extra,
  }, at);
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: "Контекст тест", phone: `+992980${unique}`, telegramUserId: String(telegramUserId) },
  });
  agentId = agent.id;
});

beforeEach(async () => {
  await prisma.assistantTelegramGroup.deleteMany({ where: { chatId: { in: [String(chatId), String(otherChatId)] } } });
  await prisma.assistantTelegramGroup.createMany({ data: [
    { chatId: String(chatId), registeredByAgentId: agentId, contextEnabledAt: enabledAt },
    { chatId: String(otherChatId), registeredByAgentId: agentId, contextEnabledAt: enabledAt },
  ] });
});

afterAll(async () => {
  await prisma.assistantTelegramGroup.deleteMany({ where: { chatId: { in: [String(chatId), String(otherChatId)] } } });
  if (agentId) await prisma.agent.delete({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("opted-in Telegram group evidence", () => {
  it("captures only messages from an opted-in work group after enrollment and from an active linked user", async () => {
    await captureAssistantTelegramContext(message(1, { date: sourceDate - 3_601 }), 1, now);
    await captureAssistantTelegramContext(message(2, { from: { id: telegramUserId + 1 } }), 2, now);
    await captureAssistantTelegramContext(message(3, { chat: { id: chatId, type: "private" } }), 3, now);
    await captureAssistantTelegramContext(message(4, { forward_origin: { type: "user" } }), 4, now);
    await captureAssistantTelegramContext(message(5, { has_protected_content: true }), 5, now);
    await captureAssistantTelegramContext(message(6, { contact: { phone_number: "test-contact" } }), 6, now);
    await prisma.assistantTelegramGroup.update({ where: { chatId: String(otherChatId) }, data: { contextEnabledAt: null } });
    await captureAssistantTelegramContext(message(7, { chat: { id: otherChatId, type: "group" } }), 7, now);
    await captureAssistantTelegramContext(message(8, {
      text: undefined,
      caption: "ОБ-123. Почта evidence@example.test. Фото https://example.test/private",
      document: { file_id: "test-private-file" },
    }), 8, now);
    const rows = await prisma.assistantTelegramContext.findMany({
      where: { groupChatId: { in: [String(chatId), String(otherChatId)] } },
      select: { messageId: true, text: true, attachmentKind: true },
    });
    expect(rows).toEqual([{
      messageId: 8, text: "ОБ-123. Почта [почта]. Фото [ссылка]", attachmentKind: "document",
    }]);
  });

  it("is idempotent and orders same-second edits by provider update ID", async () => {
    const first = message(11);
    const edit = message(11, { text: "По ОБ-123 исходники ещё в очереди.", edit_date: sourceDate });
    await captureAssistantTelegramContext(first, 100, now);
    await captureAssistantTelegramContext(edit, 102, now);
    await captureAssistantTelegramContext(first, 100, now);
    await captureAssistantTelegramContext(message(11, { text: "Старая версия ОБ-123.", edit_date: sourceDate }), 101, now);
    const found = await lookup({ selector: { replyToMessageId: 11 } });
    expect(found.map(row => row.text)).toEqual(["По ОБ-123 исходники ещё в очереди."]);
  });

  it("reads only prior exact evidence from the same group and topic for the linked requester", async () => {
    await captureAssistantTelegramContext(message(11), 1, now);
    await captureAssistantTelegramContext(message(12, { chat: { id: otherChatId, type: "group" } }), 2, now);
    await captureAssistantTelegramContext(message(13, { message_thread_id: 4 }), 3, now);
    await captureAssistantTelegramContext(message(14, { text: "По ОБ-124 отдельное решение." }), 4, now);
    await captureAssistantTelegramContext(message(15), 5, now);
    expect((await lookup()).map(row => row.messageId)).toEqual([11]);
    expect(await lookup({ selector: { replyToMessageId: 12 } })).toEqual([]);
    expect(await lookup({ telegramUserId: String(telegramUserId + 1) })).toEqual([]);
    expect((await lookup({ threadId: 4 })).map(row => row.messageId)).toEqual([13]);
  });

  it("hides expired or disabled evidence and cascades on group removal", async () => {
    await captureAssistantTelegramContext(message(11), 1, now);
    await captureAssistantTelegramContext(message(12, { chat: { id: otherChatId, type: "group" } }), 2, now);
    const expired = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000);
    expect(await lookup({}, expired)).toEqual([]);
    await prisma.assistantTelegramGroup.update({ where: { chatId: String(chatId) }, data: { contextEnabledAt: null } });
    expect(await lookup()).toEqual([]);
    expect(await cleanupAssistantTelegramContext(now)).toBeGreaterThanOrEqual(1);
    expect(await prisma.assistantTelegramContext.count({ where: { groupChatId: String(chatId) } })).toBe(0);
    await prisma.assistantTelegramGroup.delete({ where: { chatId: String(otherChatId) } });
    expect(await prisma.assistantTelegramContext.count({ where: { groupChatId: String(otherChatId) } })).toBe(0);
  });
});

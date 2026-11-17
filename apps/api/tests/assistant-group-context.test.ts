import { randomInt } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  captureAssistantTelegramContext,
  cleanupAssistantTelegramContext,
  loadAssistantTelegramContext,
  retainAssistantTelegramTranscript,
} from "../src/telegram/assistantGroupContext.js";
import { groupHistoryQuestion, groupPropertyRefs } from "../src/telegram/assistantGroupParticipation.js";

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
  it("attributes only the original still-linked author and never exposes a Telegram ID", async () => {
    const otherTelegramId = telegramUserId + 1;
    const other = await prisma.agent.create({ data: {
      fullName: "Умед Примеров", phone: `+992981${unique}`, telegramUserId: String(otherTelegramId),
    } });
    try {
      await captureAssistantTelegramContext(message(11, { text: "По ОБ-123 готовы исходники." }), 1, now);
      await captureAssistantTelegramContext(message(12, { from: { id: otherTelegramId }, text: "ОБ-123 ещё в очереди." }), 2, now);
      const found = await lookup();
      expect(found.map(row => [row.text, row.authorLabel])).toEqual([
        ["ОБ-123 ещё в очереди.", "Умед Примеров"], ["По ОБ-123 готовы исходники.", "Контекст тест"],
      ]);
      expect(JSON.stringify(found)).not.toContain(String(otherTelegramId));
      await prisma.agent.update({ where: { id: other.id }, data: { telegramUserId: String(otherTelegramId + 10) } });
      expect((await lookup())[0].authorLabel).toBeNull();
      await prisma.agent.update({ where: { id: other.id }, data: { telegramUserId: String(otherTelegramId), isActive: false } });
      expect((await lookup())[0].authorLabel).toBeNull();
    } finally {
      await prisma.agent.delete({ where: { id: other.id } });
    }
  });

  it("indexes the same visible object code variants that a history question accepts", async () => {
    await captureAssistantTelegramContext(message(11, { text: "ОБ №123. Исходники готовы." }), 1, now);
    await captureAssistantTelegramContext(message(12, { text: "ОБ 123. Монтажёр подтвердил." }), 2, now);
    await captureAssistantTelegramContext(message(13, { text: "OB#000123. Есть файлы. https://example.test/OB-999" }), 3, now);
    await captureAssistantTelegramContext(message(14, { text: "ОБ-123 810000 сомони." }), 4, now);
    const selector = groupHistoryQuestion("Что писали по ОБ-123?");
    expect(selector).toEqual({ propertyShortId: 123 });
    expect((await lookup({ selector: selector! })).map(row => row.messageId)).toEqual([14, 13, 12, 11]);
    expect(await lookup({ selector: { propertyShortId: 999 } })).toEqual([]);
  });

  it("preserves the full stored ID range without widening direct action reference matching", async () => {
    await captureAssistantTelegramContext(message(11, { text: "ОБ-2147483647. Исходники готовы." }), 1, now);
    const selector = groupHistoryQuestion("Что писали по ОБ 2147483647?");
    expect(selector).toEqual({ propertyShortId: 2_147_483_647 });
    expect((await lookup({ selector: selector! })).map(row => row.messageId)).toEqual([11]);
    expect(groupHistoryQuestion("Что писали по ОБ 2147483648?")).toBeNull();
    expect(groupPropertyRefs("ОБ-2147483647")).toEqual([]);
  });

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

  it("keeps unlinked messages only in the opted-in group and hides them immediately on opt-out", async () => {
    await prisma.assistantTelegramGroup.update({
      where: { chatId: String(chatId) }, data: { contextIncludeUnlinked: true },
    });
    const from = { id: telegramUserId + 1 };
    await captureAssistantTelegramContext(message(11, { from }), 100, now);
    await captureAssistantTelegramContext(message(11, {
      from: { id: telegramUserId + 2 }, edit_date: sourceDate, text: "Wrong author for ОБ-123.",
    }), 103, now);
    await captureAssistantTelegramContext(message(11, {
      from, edit_date: sourceDate, text: "По ОБ-123 уточнили. Почта evidence@example.test.",
    }), 102, now);
    await captureAssistantTelegramContext(message(12, { from, chat: { id: otherChatId, type: "group" } }), 104, now);
    await captureAssistantTelegramContext(message(13, { from, has_protected_content: true }), 105, now);
    expect((await lookup()).map(row => row.text)).toEqual(["По ОБ-123 уточнили. Почта [почта]."]);
    expect(await lookup({ chatId: String(otherChatId) })).toEqual([]);
    expect(await lookup({ telegramUserId: String(from.id) })).toEqual([]);
    await prisma.assistantTelegramGroup.update({
      where: { chatId: String(chatId) }, data: { contextIncludeUnlinked: false },
    });
    expect(await lookup()).toEqual([]);
    await cleanupAssistantTelegramContext(now);
    expect(await prisma.assistantTelegramContext.count({ where: { groupChatId: String(chatId) } })).toBe(0);
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

  it("retracts an edit to a command and ignores older deliveries without retaining the command", async () => {
    const command = "/отмена ОБ-123";
    await captureAssistantTelegramContext(message(11), 100, now);
    await captureAssistantTelegramContext(message(11, { text: command, edit_date: sourceDate }), 103, now);
    await captureAssistantTelegramContext(message(11, { text: "Старая версия ОБ-123.", edit_date: sourceDate }), 102, now);
    await captureAssistantTelegramContext(message(12, { text: command, edit_date: sourceDate }), 104, now);
    await captureAssistantTelegramContext(message(12), 101, now);
    await captureAssistantTelegramContext(message(13, { text: command }), 105, now);

    expect(await lookup()).toEqual([]);
    expect(await lookup({ selector: { replyToMessageId: 11 } })).toEqual([]);
    expect(await prisma.assistantTelegramContext.findMany({
      where: { groupChatId: String(chatId) }, orderBy: { messageId: "asc" },
      select: { messageId: true, text: true, propertyRefs: true },
    })).toEqual([11, 12].map(messageId => ({ messageId, text: "", propertyRefs: [] })));

    await captureAssistantTelegramContext(message(11, { text: "Исправление по ОБ-124.", edit_date: sourceDate }), 106, now);
    await captureAssistantTelegramContext(message(11, { text: command, edit_date: sourceDate }), 103, now);
    expect((await lookup({ selector: { propertyShortId: 124 } })).map(row => row.text)).toEqual(["Исправление по ОБ-124."]);
  });

  it("retracts the transcript when an audio caption is edited to a command", async () => {
    const audio = message(11, { text: undefined, audio: { file_id: "test-audio-source" } });
    await captureAssistantTelegramContext(audio, 100, now);
    await retainAssistantTelegramTranscript(audio, 100, agentId, "ОБ-123. Готовы исходники.", now);
    expect(await lookup()).toHaveLength(1);
    await captureAssistantTelegramContext({ ...audio, caption: "/отмена ОБ-123", edit_date: sourceDate }, 101, now);
    await retainAssistantTelegramTranscript(audio, 100, agentId, "Поздняя расшифровка ОБ-123.", now);
    expect(await lookup()).toEqual([]);
    expect(await lookup({ selector: { replyToMessageId: 11 } })).toEqual([]);
  });

  it.each(["/отмена ОБ-123", "ОБ-124. Новая версия без привязки."])(
    "retracts the same author’s old evidence after unlinking without keeping the edit: %s", async text => {
      const author = await prisma.agent.create({
        data: { fullName: "Другой автор", phone: `+992981${unique}`, telegramUserId: String(telegramUserId + 1) },
      });
      try {
        const from = { id: telegramUserId + 1 };
        const original = message(11, { from });
        await captureAssistantTelegramContext(original, 100, now);
        expect(await lookup()).toHaveLength(1);
        await prisma.agent.update({ where: { id: author.id }, data: { telegramUserId: null } });
        await captureAssistantTelegramContext(message(11, { from: { id: telegramUserId + 2 }, text, edit_date: sourceDate }), 101, now);
        expect(await lookup()).toHaveLength(1);
        await captureAssistantTelegramContext({ ...original, text, edit_date: sourceDate }, 103, now);
        await captureAssistantTelegramContext(message(12, { from }), 104, now);
        await captureAssistantTelegramContext(message(13, { from, text, edit_date: sourceDate }), 105, now);
        expect(await lookup()).toEqual([]);
        expect(await lookup({ selector: { propertyShortId: 124 } })).toEqual([]);
        expect(await lookup({ selector: { replyToMessageId: 11 } })).toEqual([]);
        expect(await prisma.assistantTelegramContext.findMany({
          where: { groupChatId: String(chatId) }, select: { messageId: true, text: true, authorAgentId: true },
        })).toEqual([{ messageId: 11, text: "", authorAgentId: author.id }]);

        await prisma.agent.update({ where: { id: author.id }, data: { telegramUserId: String(from.id) } });
        await captureAssistantTelegramContext({ ...original, edit_date: sourceDate }, 102, now);
        expect(await lookup()).toEqual([]);
      } finally {
        await prisma.agent.delete({ where: { id: author.id } });
      }
    },
  );

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

  it("enriches the captured native audio once, keeps its caption, and masks contacts", async () => {
    const audio = message(11, {
      text: undefined, caption: "Материалы по ОБ-125.", audio: { file_id: "test-audio-source" },
    });
    await captureAssistantTelegramContext(audio, 100, now);
    const phone = ["+992", "111", "222", "333"].join("");
    await retainAssistantTelegramTranscript(audio, 100, agentId,
      `По ОБ-123 готовы исходники. Почта evidence@example.test, телефон ${phone}.`, now);
    await retainAssistantTelegramTranscript(audio, 100, agentId, "Другая расшифровка.", now);
    const [found] = await lookup();
    expect(found?.text).toContain("Материалы по ОБ-125.");
    expect(found?.text).toContain("Расшифровка аудио: По ОБ-123 готовы исходники.");
    expect(found?.text).not.toContain(phone);
    expect(found?.text).not.toContain("evidence@example.test");
    expect(found?.text).not.toContain("Другая расшифровка");
    expect((await lookup({ selector: { propertyShortId: 125 } })).map(row => row.messageId)).toEqual([11]);
  });

  it("clears an older voice transcript when the message is edited and rejects late ASR", async () => {
    const voice = message(11, { text: undefined, voice: { file_id: "test-voice-source" } });
    await captureAssistantTelegramContext(voice, 100, now);
    await retainAssistantTelegramTranscript(voice, 100, agentId, "Решение по ОБ-123.", now);
    expect(await lookup()).toHaveLength(1);
    await captureAssistantTelegramContext({
      ...voice, edit_date: sourceDate, caption: "Уточнение по ОБ-125.",
    }, 101, now);
    await retainAssistantTelegramTranscript(voice, 100, agentId, "Запоздалая расшифровка по ОБ-123.", now);
    expect(await lookup()).toEqual([]);
    expect((await lookup({ selector: { replyToMessageId: 11 } }))[0]?.text).toBe("Уточнение по ОБ-125.");
  });

  it("keeps the edited source if ASR and the edit are committed concurrently", async () => {
    const voice = message(11, { text: undefined, voice: { file_id: "test-voice-source" } });
    await captureAssistantTelegramContext(voice, 100, now);
    await Promise.all([
      retainAssistantTelegramTranscript(voice, 100, agentId, "Предыдущие слова про ОБ-123.", now),
      captureAssistantTelegramContext({ ...voice, edit_date: sourceDate, caption: "Новое по ОБ-125." }, 101, now),
    ]);
    expect(await lookup()).toEqual([]);
    expect((await lookup({ selector: { replyToMessageId: 11 } }))[0]?.text).toBe("Новое по ОБ-125.");
  });

  it("never creates evidence for uncaptured, forwarded, private, protected, expired or opted-out audio", async () => {
    const audio = message(11, { text: undefined, voice: { file_id: "test-voice-source" } });
    await retainAssistantTelegramTranscript(audio, 100, agentId, "Нет исходной записи по ОБ-123.", now);
    await captureAssistantTelegramContext(audio, 100, now);
    const denied = [
      { ...audio, forward_origin: { type: "user" } },
      { ...audio, chat: { id: chatId, type: "private" } },
      { ...audio, has_protected_content: true },
    ];
    for (const input of denied) await retainAssistantTelegramTranscript(input, 100, agentId, "ОБ-123.", now);
    await retainAssistantTelegramTranscript(audio, 101, agentId, "Неверная версия, ОБ-123.", now);
    await retainAssistantTelegramTranscript(audio, 100, "test-other-agent", "Чужой автор, ОБ-123.", now);
    await prisma.agent.update({ where: { id: agentId }, data: { isActive: false } });
    try {
      await retainAssistantTelegramTranscript(audio, 100, agentId, "Учётка отключена, ОБ-123.", now);
    } finally {
      await prisma.agent.update({ where: { id: agentId }, data: { isActive: true } });
    }
    await retainAssistantTelegramTranscript(audio, 100, agentId, "Просрочено, ОБ-123.",
      new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000));
    await prisma.assistantTelegramGroup.update({ where: { chatId: String(chatId) }, data: { contextEnabledAt: null } });
    await retainAssistantTelegramTranscript(audio, 100, agentId, "Хранение отключено, ОБ-123.", now);
    const records = await prisma.assistantTelegramContext.findMany({
      where: { groupChatId: String(chatId) }, select: { transcript: true },
    });
    expect(records).toEqual([{ transcript: null }]);
  });
});

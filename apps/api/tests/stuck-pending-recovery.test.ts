import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { recoverStuckPendingMessages } from "../src/messengers/conversation.js";

/**
 * СООБЩЕНИЕ КЛИЕНТА, ЗАСТРЯВШЕЕ В БУФЕРЕ ДЕБАУНСА, ВОССТАНАВЛИВАЕТСЯ.
 *
 * Найдено проверкой прода 19.08.2026: владелец пожаловался, что переписка с двумя
 * Instagram-контактами открывается пустой, хотя диалог в списке выглядит живым.
 * В базе у обоих диалог "выиграл" окно дебаунса лишь наполовину — pendingMessages
 * хранил реальный вопрос клиента, а debounceAndMerge, судя по всему, не успел его
 * забрать (процесс API перезапустился посреди ожидания). lastMessageAt при этом
 * уже стоял свежим — диалог поднимался в списке, а в messages ничего не было.
 *
 * Тест не воспроизводит сам перезапуск — только его СЛЕД в базе (pendingSince
 * старше порога) — и проверяет, что recoverStuckPendingMessages находит такой
 * диалог, переносит текст в messages и чистит буфер.
 */
const runId = Date.now().toString(36);
const SUBSCRIBER = `stuck-${runId}`;

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { subscriberId: { startsWith: SUBSCRIBER } } });
});

describe("Застрявшее сообщение в буфере дебаунса", () => {
  it("переносится в переписку и буфер очищается", async () => {
    const staleSince = new Date(Date.now() - 10 * 60 * 1000); // 10 минут — заведомо старше порога
    const conv = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: SUBSCRIBER,
        messages: [],
        leadDraft: { stage: "chatting" } as never,
        pendingMessages: ["Какие услуги вы предлагаете?"],
        pendingAttachments: [{ mid: "mid-123", saved: [], sources: [] }] as never,
        lastMessageAt: staleSince,
        pendingSince: staleSince,
      },
    });

    const recovered = await recoverStuckPendingMessages();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const after = await prisma.botConversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { messages: true, pendingMessages: true, pendingSince: true, pendingAttachments: true },
    });
    expect(after.pendingMessages).toEqual([]);
    expect(after.pendingSince).toBeNull();
    expect(after.pendingAttachments).toEqual([]);
    const messages = after.messages as unknown as { role: string; content: string; mid?: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Какие услуги вы предлагаете?");
    expect(messages[0].mid).toBe("mid-123");
  });

  it("не трогает диалог, чей буфер ещё в пределах окна ожидания", async () => {
    const fresh = new Date(); // только что пришло — recoverStuckPendingMessages не должен мешать живому ходу
    const conv = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: `${SUBSCRIBER}-fresh`,
        messages: [],
        leadDraft: { stage: "chatting" } as never,
        pendingMessages: ["ещё жду ответа"],
        lastMessageAt: fresh,
        pendingSince: fresh,
      },
    });

    await recoverStuckPendingMessages();

    const after = await prisma.botConversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { messages: true, pendingMessages: true, pendingSince: true },
    });
    expect(after.pendingSince).not.toBeNull();
    expect(after.pendingMessages).toEqual(["ещё жду ответа"]);
    expect(after.messages).toEqual([]);
  });
});

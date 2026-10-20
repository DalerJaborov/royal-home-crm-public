import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { prisma } = await import("../src/db.js");
const { loadWebsiteChatMessages, WEBSITE_CHANNEL } = await import("../src/messengers/websiteChat.js");

/**
 * ОТВЕТ ВИДЖЕТА ПОЯВЛЯЕТСЯ ЧЕРЕЗ 5–15 СЕКУНД, А НЕ МГНОВЕННО (владелец 23.08.2026:
 * мгновенный ответ выдаёт в боте машину — «пусть печатает»). Механика: реплика уже
 * лежит в БД с моментом создания, отдельным полем `visibleAt` отмечено, когда её
 * вообще можно отдать опросу виджета. Здесь эта видимость проверяется напрямую —
 * без настоящего хода ИИ, вставкой готовой переписки в БД, как и другие тесты
 * этого файла-соседа (website-chat-widget.test.ts) делают для рубильника.
 */

const runId = Date.now();
const SESSION_ID = `chatreveal${runId}`;

let conversationId: string;

beforeAll(async () => {
  const conv = await prisma.botConversation.create({
    data: {
      channel: WEBSITE_CHANNEL,
      subscriberId: SESSION_ID,
      messages: [
        { role: "user", content: "привет", at: new Date(Date.now() - 5000).toISOString() },
        {
          role: "assistant",
          content: "Здравствуйте! Чем помочь?",
          at: new Date(Date.now() - 4000).toISOString(),
          by: { kind: "bot" },
          // Ещё не наступило — реплика написана, но виджет её пока не должен видеть.
          visibleAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        },
      ] as never,
    },
  });
  conversationId = conv.id;
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: conversationId } });
});

describe("visibleAt — искусственная задержка ответа виджета", () => {
  it("реплика с visibleAt в будущем не отдаётся опросу", async () => {
    const { messages } = await loadWebsiteChatMessages(SESSION_ID);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("привет");
  });

  it("как только visibleAt в прошлом — реплика появляется", async () => {
    await prisma.botConversation.update({
      where: { id: conversationId },
      data: {
        messages: [
          { role: "user", content: "привет", at: new Date(Date.now() - 5000).toISOString() },
          {
            role: "assistant",
            content: "Здравствуйте! Чем помочь?",
            at: new Date(Date.now() - 4000).toISOString(),
            by: { kind: "bot" },
            visibleAt: new Date(Date.now() - 1000).toISOString(),
          },
        ] as never,
      },
    });
    const { messages } = await loadWebsiteChatMessages(SESSION_ID);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe("Здравствуйте! Чем помочь?");
    expect(messages[1].author).toBe("bot");
  });

  it("реплика без visibleAt (старые записи, каналы Meta) видна как обычно", async () => {
    await prisma.botConversation.update({
      where: { id: conversationId },
      data: {
        messages: [
          { role: "user", content: "привет", at: new Date(Date.now() - 5000).toISOString() },
          {
            role: "assistant",
            content: "Без задержки",
            at: new Date(Date.now() - 1000).toISOString(),
            by: { kind: "bot" },
          },
        ] as never,
      },
    });
    const { messages } = await loadWebsiteChatMessages(SESSION_ID);
    expect(messages.map((m) => m.content)).toContain("Без задержки");
  });
});

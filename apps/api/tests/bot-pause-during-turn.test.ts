import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * СОТРУДНИК ВЗЯЛ РАЗГОВОР, ПОКА БОТ ДУМАЛ (23.09.2026).
 *
 * Пауза бота проверялась один раз — в начале хода, до окна склейки сообщений
 * (25–90 секунд) и до вызова модели. Если за это время живой сотрудник успел
 * ответить клиенту (его ответ ставит паузу), бот всё равно дописывал и отправлял
 * свой ответ сразу следом за человеком.
 *
 * Модель подменена: её «ответ» ставит паузу диалогу ровно в тот момент, когда
 * сотрудник ответил бы, пока ход ждёт модель.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { prisma } = await import("../src/db.js");
const { processMessengerTurn } = await import("../src/messengers/conversation.js");

const runId = Date.now().toString(36);
let settingsBefore: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;
let fixture: CustomerMessengerFixture;

beforeAll(async () => {
  fixture = await createCustomerMessengerFixture("INSTAGRAM");
  settingsBefore = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  // Короткое окно склейки, иначе каждый ход ждёт настройку по умолчанию.
  await prisma.settings.update({ where: { id: "singleton" }, data: { botReplyDelaySec: 1, botReplyMaxWaitSec: 3 } });
});

afterAll(async () => {
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await fixture?.dispose();
});

type Stored = { role: string; content: string; by?: { kind: string } };

async function botLines(subscriberId: string): Promise<Stored[]> {
  const conv = await prisma.botConversation.findUniqueOrThrow({
    where: { endpointScopeId_subscriberId: { endpointScopeId: fixture.transport.endpointScopeId, subscriberId } },
    select: { messages: true },
  });
  return ((conv.messages as unknown as Stored[]) ?? []).filter((m) => m.role === "assistant" && m.by?.kind === "bot");
}

describe("Пауза, поставленная пока бот готовил ответ", () => {
  it("сотрудник ответил, пока ход ждал модель — ответ бота не пишется и не уходит", async () => {
    const subscriberId = `pause-turn-${runId}-a`;
    callAi.mockImplementationOnce(async () => {
      await prisma.botConversation.update({
        where: { endpointScopeId_subscriberId: { endpointScopeId: fixture.transport.endpointScopeId, subscriberId } },
        data: { pausedUntil: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000), botPausedAt: new Date() },
      });
      return { reply: ["Здравствуйте! Какой район вас интересует?"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false };
    });

    const result = await processMessengerTurn({ ...fixture.turnInput(subscriberId), text: "Салом, хочу купить квартиру" });

    expect(result.shouldReply).toBe(false);
    expect(await botLines(subscriberId)).toHaveLength(0);
  });

  it("без паузы ход отвечает как прежде", async () => {
    const subscriberId = `pause-turn-${runId}-b`;
    callAi.mockReset();
    callAi.mockResolvedValue({ reply: ["Здравствуйте! Какой район вас интересует?"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });

    const result = await processMessengerTurn({ ...fixture.turnInput(subscriberId), text: "Салом, хочу купить квартиру" });

    expect(result.shouldReply).not.toBe(false);
    expect(result.reply).toContain("район");
    expect(await botLines(subscriberId)).toHaveLength(1);
  });
});

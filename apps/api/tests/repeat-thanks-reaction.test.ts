import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { processMessengerTurn as actualProcessMessengerTurn } from "../src/messengers/conversation.js";

/**
 * ПОВТОРНОЕ «СПАСИБО» ПОСЛЕ ЗАКРЫТИЯ РАЗГОВОРА — БЕЗ НОВОГО ХОДА ИИ.
 *
 * Владелец 19.08.2026: разговор, где бот уже попрощался («Обращайтесь!»), не
 * должен продолжать отвечать текстом на каждое следующее «спасибо» — довольно
 * реакции (см. reactOnly в MessengerTurnResult). Модель подменена: если тест
 * упадёт из-за вызова callAi, значит отсечка не сработала и ход ушёл в ИИ.
 */
const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

let messengerFixture: CustomerMessengerFixture;
function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  return actualProcessMessengerTurn({ ...input, ...messengerFixture.turnInput(input.subscriberId) });
}

const runId = Date.now().toString(36);
const SUBSCRIBER = `closing-${runId}`;

let settingsBefore: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;

beforeAll(async () => {
  messengerFixture = await createCustomerMessengerFixture("INSTAGRAM");
  const s = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  settingsBefore = s;
  // Короткое окно — тесту не нужно ждать реальные секунды дебаунса.
  await prisma.settings.update({ where: { id: "singleton" }, data: { botReplyDelaySec: 0, botReplyMaxWaitSec: 1 } });
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await messengerFixture?.dispose();
});

describe("Разговор уже закрыт прощанием бота", () => {
  it("новое «спасибо» получает реакцию, а не ответ модели", async () => {
    await prisma.botConversation.update({
      where: { id: (await messengerFixture.ensureConversation(SUBSCRIBER)).id },
      data: {
        channel: "INSTAGRAM",
        subscriberId: SUBSCRIBER,
        leadDraft: { stage: "chatting" } as never,
        messages: [
          { role: "user", content: "Спасибо большое за помощь!", at: new Date().toISOString() },
          { role: "assistant", content: "Пожалуйста, обращайтесь!", at: new Date().toISOString() },
        ] as never,
      },
    });
    callAi.mockClear();

    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: SUBSCRIBER, text: "Спасибо!" });

    expect(result.shouldReply).toBe(false);
    expect(result.reactOnly).toBe(true);
    expect(callAi).not.toHaveBeenCalled();

    // Реплика клиента всё равно видна в переписке — молчим ответом, а не фактом обращения.
    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: SUBSCRIBER },
      select: { messages: true },
    });
    const messages = conv?.messages as unknown as { role: string; content: string }[];
    expect(messages).toHaveLength(3);
    expect(messages[2]).toMatchObject({ role: "user", content: "Спасибо!" });
  });
});

describe("Первое «спасибо» в разговоре", () => {
  /*
   * До 25.09.2026 первое «спасибо» всегда шло в модель. Владелец 25.09.2026 по
   * выдержкам живых диалогов: на «рахмат/ок» бот писал длинные сообщения и
   * «выдавал себя». Теперь на вежливость после нашей реплики БЕЗ вопроса —
   * реакция (ai/ackOnly.ts); после вопроса «спасибо» по-прежнему разбирает модель.
   */
  it("после реплики бота без вопроса — реакция, без хода модели", async () => {
    const subscriber = `${SUBSCRIBER}-first`;
    await prisma.botConversation.update({
      where: { id: (await messengerFixture.ensureConversation(subscriber)).id },
      data: {
        channel: "INSTAGRAM",
        subscriberId: subscriber,
        leadDraft: { stage: "chatting" } as never,
        messages: [
          { role: "user", content: "Сино, 3 хона, бюджет 400", at: new Date().toISOString() },
          { role: "assistant", content: "Вот подходящие варианты...", at: new Date().toISOString() },
        ] as never,
      },
    });
    callAi.mockClear();

    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: subscriber, text: "Спасибо!" });

    expect(result.shouldReply).toBe(false);
    expect(result.reactOnly).toBe(true);
    expect(callAi).not.toHaveBeenCalled();
  });

  it("после вопроса бота — отвечает моделью как обычно", async () => {
    const subscriber = `${SUBSCRIBER}-asked`;
    await prisma.botConversation.update({
      where: { id: (await messengerFixture.ensureConversation(subscriber)).id },
      data: {
        channel: "INSTAGRAM",
        subscriberId: subscriber,
        leadDraft: { stage: "chatting" } as never,
        messages: [
          { role: "user", content: "Сино, 3 хона, бюджет 400", at: new Date().toISOString() },
          { role: "assistant", content: "Хотите посмотреть варианты?", at: new Date().toISOString() },
        ] as never,
      },
    });
    callAi.mockResolvedValue({ reply: ["Пожалуйста! Обращайтесь, если понадобится помощь."], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    callAi.mockClear();

    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: subscriber, text: "Спасибо!" });

    expect(result.shouldReply).not.toBe(false);
    expect(result.aiUnavailable ?? false).toBe(false);
    expect(result.reply).not.toBe("");
    expect(callAi).toHaveBeenCalled();
  });
});

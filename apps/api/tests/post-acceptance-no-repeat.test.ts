import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { processMessengerTurn as actualProcessMessengerTurn } from "../src/messengers/conversation.js";

/**
 * ПОСЛЕ ПРИЁМА ЗАЯВКИ БОТ БОЛЬШЕ НЕ ЗАМОЛКАЕТ И НЕ ОГРАНИЧИВАЕТСЯ РЕАКЦИЕЙ
 * (владелец, 18.09.2026, отменяет решение 19.08.2026).
 *
 * Раньше здесь проверялся гейт «alreadyClosedOnce» + классификатор
 * classifyNeedsReply (reply-worth-check), который гасил сообщение клиента без
 * «?» одной эмодзи-реакцией вместо полноценного ответа — экономил ходы ИИ, но
 * выглядел как «робот, повторяющий агент вам перезвонит». Владелец прямо
 * попросил обратное: бот отвечает ПОЛНОСТЬЮ на любой вопрос клиента и
 * замолкает только когда агент РЕАЛЬНО связался — вручную в переписке или по
 * звонку (см. `pauseConversationsAfterRealContact`, lib/conversationDelivery.ts).
 * Гейт и классификатор отсюда убраны целиком (см. `messengers/conversation.ts`) —
 * этот файл теперь проверяет, что после приёма заявки, но ДО реального
 * контакта агента, каждое сообщение клиента доходит до обычного
 * квалификатора (endpoint lead-qualify), а не гасится реакцией.
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
const SUBSCRIBER = `postaccept-${runId}`;
let clientId: string;
let clientId2: string;
let savedSettings: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;

beforeAll(async () => {
  messengerFixture = await createCustomerMessengerFixture("INSTAGRAM");
  // Эти ходы (заявка уже принята) с 18.09.2026 идут через обычный
  // debounceAndMerge — без ускорения тест ждал бы реальные 25 секунд на
  // каждый сценарий (см. тот же приём в lead-name-capture.test.ts).
  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  savedSettings = settings;
  await prisma.settings.update({ where: { id: "singleton" }, data: { botReplyDelaySec: 0, botReplyMaxWaitSec: 5 } });

  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Тест-клиент ${runId}`,
        phone: `+99290${runId}`,
        source: "PHONE_CALL",
        acceptedAt: new Date(),
      },
    })
  ).id;
  // Ограничение уникальности clientId в BotConversation (один диалог на клиента) —
  // второму сценарию нужен свой клиент, а не переиспользование первого.
  clientId2 = (
    await prisma.client.create({
      data: {
        fullName: `Тест-клиент-2 ${runId}`,
        phone: `+99291${runId}`,
        source: "PHONE_CALL",
        acceptedAt: new Date(),
      },
    })
  ).id;
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.client.deleteMany({ where: { id: { in: [clientId, clientId2].filter(Boolean) } } });
  await messengerFixture?.dispose();
});

describe("Заявка принята, реального контакта агента ещё не было", () => {
  it("реплика без вопроса — всё равно обычный ход квалификатора, а не реакция", async () => {
    await prisma.botConversation.update({
      where: { id: (await messengerFixture.ensureConversation(SUBSCRIBER)).id },
      data: {
        channel: "INSTAGRAM",
        subscriberId: SUBSCRIBER,
        clientId,
        leadDraft: { stage: "accepted" } as never,
        messages: [
          { role: "user", content: "027557272", at: new Date().toISOString() },
          {
            role: "assistant",
            content: "Ташаккур, агенти мо ба зудй бо шумо тамос мегирад",
            by: { kind: "bot" },
            at: new Date().toISOString(),
          },
        ] as never,
      },
    });
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: "Хуш омадед, Бону! Чи хел метавонам кумак кунам?", ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });

    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: SUBSCRIBER, text: "Бону" });

    expect(result.shouldReply).not.toBe(false);
    expect(result.aiUnavailable ?? false).toBe(false);
    expect(result.reply).not.toBe("");
    expect(result.reactOnly).toBeFalsy();
    expect(callAi.mock.calls.some(([params]) => params?.endpoint === "lead-qualify")).toBe(true);
  });

  it("настоящий вопрос тоже получает обычный ход ИИ, а не отдельную переадресацию", async () => {
    const subscriber = `${SUBSCRIBER}-q`;
    await prisma.botConversation.update({
      where: { id: (await messengerFixture.ensureConversation(subscriber)).id },
      data: {
        channel: "INSTAGRAM",
        subscriberId: subscriber,
        clientId: clientId2,
        leadDraft: { stage: "accepted" } as never,
        messages: [
          { role: "user", content: "027557272", at: new Date().toISOString() },
          {
            role: "assistant",
            content: "Ташаккур, агенти мо ба зудй бо шумо тамос мегирад",
            by: { kind: "bot" },
            at: new Date().toISOString(),
          },
        ] as never,
      },
    });
    callAi.mockResolvedValue({ reply: "Агент скоро позвонит и всё расскажет.", ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    callAi.mockClear();

    const result = await processMessengerTurn({
      channel: "INSTAGRAM",
      subscriberId: subscriber,
      text: "А когда агент позвонит?",
    });

    expect(result.shouldReply).not.toBe(false);
    expect(result.aiUnavailable ?? false).toBe(false);
    expect(result.reply).not.toBe("");
    expect(callAi.mock.calls.some(([params]) => params?.endpoint === "lead-qualify")).toBe(true);
  });
});

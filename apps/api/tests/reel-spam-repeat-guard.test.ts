import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";

/**
 * НАКРУТКА ПОВТОРНОЙ ПЕРЕСЫЛКОЙ НЕРАСПОЗНАННОГО ВИДЕО (разбор 30.08.2026).
 *
 * Живой лид «Муродали»: четыре чужих рилса подряд без единого слова — замок,
 * певец, стоматолог, борьба, — и бот на каждый вежливо отвечал заново «видео
 * не открылось, сколько комнат ищете?». Владелец прямым текстом: «усилить надо
 * защиту от спамеров... бот бедный сидит и отвечает всем».
 *
 * Три вещи проверяются здесь:
 *  1. Первые попытки (до порога MAX_UNRESOLVED_SHARE_REPLIES) — бот ещё
 *     отвечает: настоящего горячего лида, который просто не подписал видео
 *     словами, отсекать нельзя.
 *  2. После порога — тишина: ни ответа, ни вызова модели, ни лишних денег.
 *  3. Молчание НАВСЕГДА: Instagram Messaging API не даёт заблокировать
 *     отправителя программно, поэтому отметка (BotConversation.spamFlaggedAt)
 *     остаётся и глушит даже обычное текстовое сообщение того же человека
 *     следующим ходом — без этого спамер, не получив ответа на видео, просто
 *     переключился бы на текст и получил его снова.
 *
 * Модель подменена: тест не платит за токены. Если он упадёт из-за вызова
 * callAi там, где ожидается тишина, — значит отсечка не сработала.
 */
const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { processMessengerTurn: actualProcessMessengerTurn } = await import("../src/messengers/conversation.js");
const { MAX_UNRESOLVED_SHARE_REPLIES } = await import("../src/ai/replyRepeatGuard.js");

let messengerFixture: CustomerMessengerFixture;
function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  return actualProcessMessengerTurn({ ...input, ...messengerFixture.turnInput(input.subscriberId) });
}

const runId = Date.now().toString(36);
const SUBSCRIBER_PREFIX = `reel-spam-${runId}`;

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

const FALLBACK_RU = "Видео у меня не открылось. Вы такую квартиру ищете? Сколько комнат нужно?";
const FALLBACK_TJ = "Ин видео дар ман кушода нашуд. Шумо чунин хона мекобед? Чандхонага?";

/** Ровно то, что вебхук передал бы processMessengerTurn на голую пересылку
 *  чужого ролика (см. routes/webhooks.ts, unresolvedSharedPost). */
function forwardUnresolvedReel(subscriber: string) {
  return processMessengerTurn({
    channel: "INSTAGRAM",
    subscriberId: subscriber,
    text: "[вложение: ig_reel]",
    sharedPost: true,
    unresolvedSharedPost: true,
  });
}

describe(`первые ${MAX_UNRESOLVED_SHARE_REPLIES} нераспознанных пересылки — бот ещё отвечает`, () => {
  it("самая первая пересылка получает обычный ход модели", async () => {
    const subscriber = `${SUBSCRIBER_PREFIX}-first`;
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: [FALLBACK_RU], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });

    const result = await forwardUnresolvedReel(subscriber);

    expect(callAi).toHaveBeenCalled();
    expect(result.shouldReply).not.toBe(false);
    expect(result.aiUnavailable ?? false).toBe(false);
    expect(result.reply).not.toBe("");
  });

  it(`${MAX_UNRESOLVED_SHARE_REPLIES}-я подряд тоже получает ответ — порог ещё не пройден`, async () => {
    const subscriber = `${SUBSCRIBER_PREFIX}-still-under`;
    // На один прошлый ответ меньше порога — MAX_UNRESOLVED_SHARE_REPLIES - 1 штук.
    const priorReplies = Array.from({ length: MAX_UNRESOLVED_SHARE_REPLIES - 1 }, (_, i) => [
      { role: "user", content: "[вложение: ig_reel]" },
      { role: "assistant", content: i % 2 === 0 ? FALLBACK_TJ : FALLBACK_RU, by: { kind: "bot" } },
    ]).flat();
    await prisma.botConversation.update({
      where: { id: (await messengerFixture.ensureConversation(subscriber)).id },
      data: { channel: "INSTAGRAM", subscriberId: subscriber, messages: priorReplies as never },
    });
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: [FALLBACK_RU], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });

    const result = await forwardUnresolvedReel(subscriber);

    expect(callAi).toHaveBeenCalled();
    expect(result.shouldReply).not.toBe(false);
    expect(result.aiUnavailable ?? false).toBe(false);
    expect(result.reply).not.toBe("");
  });
});

describe("пересылка сверх порога — бот замолкает НАВСЕГДА", () => {
  it("следующая нераспознанная пересылка уходит в тишину и метит диалог спамом", async () => {
    const subscriber = `${SUBSCRIBER_PREFIX}-over`;
    const priorReplies = Array.from({ length: MAX_UNRESOLVED_SHARE_REPLIES }, (_, i) => [
      { role: "user", content: "[вложение: ig_reel]" },
      { role: "assistant", content: i % 2 === 0 ? FALLBACK_TJ : FALLBACK_RU, by: { kind: "bot" } },
    ]).flat();
    await prisma.botConversation.update({
      where: { id: (await messengerFixture.ensureConversation(subscriber)).id },
      data: { channel: "INSTAGRAM", subscriberId: subscriber, messages: priorReplies as never },
    });
    callAi.mockClear();

    const result = await forwardUnresolvedReel(subscriber);

    expect(result.shouldReply).toBe(false);
    expect(callAi).not.toHaveBeenCalled();

    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: subscriber },
      select: { messages: true, spamFlaggedAt: true, spamFlagReason: true },
    });
    expect(conv?.spamFlaggedAt).toBeInstanceOf(Date);
    expect(conv?.spamFlagReason).toContain("нераспознанное видео");

    const messages = conv?.messages as unknown as { role: string; content: string }[];
    expect(messages[messages.length - 1].content).toContain("бот не отвечал");
    // Заблокировать программно нельзя (нет такой ручки у Instagram Messaging API) —
    // сотрудник обязан увидеть прямую просьбу сделать это руками.
    expect(messages[messages.length - 1].content).toContain("заблокируйте отправителя вручную");
  });

  it("метка навсегда: даже обычное текстовое сообщение того же человека дальше игнорируется без вызова модели", async () => {
    const subscriber = `${SUBSCRIBER_PREFIX}-flagged-then-text`;
    await prisma.botConversation.update({
      where: { id: (await messengerFixture.ensureConversation(subscriber)).id },
      data: {
        channel: "INSTAGRAM",
        subscriberId: subscriber,
        spamFlaggedAt: new Date(),
        spamFlagReason: "подряд пересылает нераспознанное видео и не отвечает на вопросы бота (тест)",
        messages: [
          { role: "user", content: "[вложение: ig_reel]" },
          { role: "assistant", content: FALLBACK_TJ, by: { kind: "bot" } },
        ] as never,
      },
    });
    callAi.mockClear();

    // Обычный текст, БЕЗ пересланного видео вовсе — метка обязана держаться
    // и на этот случай, иначе спамер просто переключится со видео на слова.
    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: subscriber, text: "привет" });

    expect(result.shouldReply).toBe(false);
    expect(callAi).not.toHaveBeenCalled();
  });
});

describe("реальный вопрос между пересылками не даёт ложного срабатывания", () => {
  it("одно извинение плюс содержательный ответ клиента — следующий ролик не считается сверх порога", async () => {
    const subscriber = `${SUBSCRIBER_PREFIX}-genuine`;
    await prisma.botConversation.update({
      where: { id: (await messengerFixture.ensureConversation(subscriber)).id },
      data: {
        channel: "INSTAGRAM",
        subscriberId: subscriber,
        messages: [
          { role: "user", content: "[вложение: ig_reel]" },
          { role: "assistant", content: FALLBACK_TJ, by: { kind: "bot" } },
          { role: "user", content: "3 хона дар Сино, бюджет 60 000" },
          { role: "assistant", content: "Хуб, чунин вариантҳо ҳастанд...", by: { kind: "bot" } },
        ] as never,
      },
    });
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: [FALLBACK_RU], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });

    const result = await forwardUnresolvedReel(subscriber);

    expect(callAi).toHaveBeenCalled();
    expect(result.shouldReply).not.toBe(false);
    expect(result.aiUnavailable ?? false).toBe(false);
    expect(result.reply).not.toBe("");

    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: subscriber },
      select: { spamFlaggedAt: true },
    });
    expect(conv?.spamFlaggedAt).toBeNull();
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { processMessengerTurn } from "../src/messengers/conversation.js";
import { submitReplySchema } from "@royal-home/shared";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ПРИВЕТСТВИЕ ОТВЕЧАЕТСЯ БЫСТРО, НО НЕ ЦЕНОЙ ГОНКИ (18.08.2026, владелец: «если
 * пишет здравствуйте или салом — бот быстро отвечает на приветствие, дальше уже
 * по нашей логике»). Голое «Салом» первым сообщением диалога получает готовую
 * фразу без обращения к модели и без обычного окна ожидания (Настройки → Бот,
 * по умолчанию 15 сек) — но короткое окно (3-8 сек) у этого пути всё равно есть:
 * первая версия отвечала СРАЗУ, в обход debounceAndMerge, и тест-регресс поймал
 * ту же гонку, ради которой этот механизм написан (bot-debounce-capture.test.ts):
 * «Салом» + «хона даркор» почти одновременно превращались в два ответа вместо
 * одного. Модель подменена — тест не должен платить за токены.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const runId = Date.now().toString(36);
const fetchDenied = vi.fn(async () => { throw new Error("Unexpected external fetch in greeting fixture"); });

let settingsBefore: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;
let fixture: CustomerMessengerFixture | undefined;
function modelReply(raw: unknown) {
  submitReplySchema({ showings: true, askOwner: true, vacancies: true, promptEconomy: true,
    canSendPhotos: true, canSendGuide: true, topicLock: true }).parse(raw);
  callAi.mockResolvedValue(raw);
}

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchDenied);
  const s = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  settingsBefore = s;
  // Быстрое окно на обычный путь (как в bot-debounce-capture.test.ts) — иначе
  // второй/третий тесты ждали бы полную настройку по умолчанию (15 сек).
  await prisma.settings.update({ where: { id: "singleton" }, data: { botReplyDelaySec: 2, botReplyMaxWaitSec: 5 } });
  fixture = await createCustomerMessengerFixture("INSTAGRAM");
});

afterAll(async () => {
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await fixture?.dispose();
  expect(fetchDenied).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("Быстрый ответ на голое приветствие", () => {
  it("отвечает заготовленной фразой без вызова модели", async () => {
    callAi.mockClear();
    const subscriber = `greet-${runId}-solo`;

    const result = await processMessengerTurn({ ...fixture!.turnInput(subscriber), text: "Салом" });

    expect(result.shouldReply).not.toBe(false);
    expect(result.reply).toBe("Ассалому алейкум! Чӣ хизмат карда метавонем?");
    expect(callAi).not.toHaveBeenCalled();

    const conv = await prisma.botConversation.findFirst({
      where: { endpointScopeId: fixture!.transport.endpointScopeId, subscriberId: subscriber },
      select: { messages: true },
    });
    const messages = (conv?.messages ?? []) as { role: string; content: string }[];
    expect(messages.some((m) => m.role === "user" && m.content === "Салом")).toBe(true);
    expect(messages.some((m) => m.role === "assistant" && m.content.includes("Чӣ хизмат карда метавонем"))).toBe(true);
  });

  it("приветствие + сразу вопрос почти одновременно — один ответ по существу, не голое приветствие", async () => {
    callAi.mockClear();
    modelReply({ reply: ["Дар кадом минтақа?"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const subscriber = `greet-${runId}-burst`;

    const [first, second] = await Promise.all([
      processMessengerTurn({ ...fixture!.turnInput(subscriber), text: "Салом" }),
      processMessengerTurn({ ...fixture!.turnInput(subscriber), text: "хона даркор" }),
    ]);

    const answered = [first, second].filter((r) => r.shouldReply !== false);
    expect(answered).toHaveLength(1);
    expect(answered[0].reply).toContain("Дар кадом минтақа?");
    expect(answered[0].aiUnavailable).toBeUndefined();
    // Победитель ответил моделью (не заготовленной фразой), а значит увидел оба сообщения.
    expect(callAi).toHaveBeenCalledTimes(1);
  });

  it("приветствие не первым сообщением диалога идёт обычным путём", async () => {
    callAi.mockClear();
    // Содержательный ответ: голое повторное приветствие специально срезает guard.
    modelReply({ reply: ["Буҷетатон то чанд сомонӣ аст?"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const subscriber = `greet-${runId}-repeat`;

    const seeded = await fixture!.ensureConversation(subscriber);
    await prisma.botConversation.update({
      where: { id: seeded.id },
      data: {
        messages: [
          { role: "user", content: "Хона даркор" },
          { role: "assistant", content: "Дар кадом минтақа?", by: { kind: "bot" } },
        ] as never,
        leadDraft: { stage: "chatting" } as never,
      },
    });

    const result = await processMessengerTurn({ ...fixture!.turnInput(subscriber), text: "Салом" });

    expect(result.shouldReply).not.toBe(false);
    expect(callAi).toHaveBeenCalledTimes(1);
    expect(result.reply).toContain("Буҷетатон то чанд сомонӣ аст?");
    expect(result.aiUnavailable).toBeUndefined();
  });
});

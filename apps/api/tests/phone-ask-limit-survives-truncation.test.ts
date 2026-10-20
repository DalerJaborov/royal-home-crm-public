import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { prisma } from "../src/db.js";
import { processMessengerTurn as actualProcessMessengerTurn } from "../src/messengers/conversation.js";
let fixture: CustomerMessengerFixture | undefined;
function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  return actualProcessMessengerTurn({ ...input, ...fixture!.turnInput(input.subscriberId) });
}
import { MAX_PHONE_ASKS, effectivePhoneAsks, countPhoneAsksIn } from "../src/ai/replyRepeatGuard.js";

/**
 * ПРЕДЕЛ НА ПРОСЬБЫ НОМЕРА ПЕРЕЖИВАЕТ ОБРЕЗКУ ПЕРЕПИСКИ (разбор 775 живых
 * переписок, 20.09.2026; жалоба владельца «он опять спрашивает по 35 раз»).
 *
 * Хранимая лента обрезана до 40 реплик (messengers/appendMessages.ts), а предел
 * считался ПО НЕЙ. В длинном разговоре ранние просьбы из ленты выпадали, счёт
 * возвращался к нулю, и бот принимался просить номер заново — ровно та
 * навязчивость, против которой предел и поставлен (владелец 30.08.2026).
 *
 * Здесь проверяется главное: когда в ленте просьб УЖЕ НЕ ВИДНО, а счётчик
 * разговора говорит «просили трижды», бот номер больше не просит.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const runId = Date.now().toString(36);
const PHONE_ASK = "Рақами телефонатонро нависед, то агент тамос гирад.";
const subscriberOf = (suffix: string): string => `phoneask-${runId}-${suffix}`;

let settingsBefore: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;

beforeAll(async () => {
  fixture = await createCustomerMessengerFixture("INSTAGRAM");
  const s = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  settingsBefore = s;
  await prisma.settings.update({ where: { id: "singleton" }, data: { botReplyDelaySec: 1, botReplyMaxWaitSec: 3 } });
});

afterAll(async () => {
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await fixture?.dispose();
});

describe("Счёт просьб номера не зависит от обрезанной ленты", () => {
  it("считает по счётчику, когда в ленте просьб уже не видно", () => {
    // Лента пуста (просьбы выпали при обрезке), счётчик разговора помнит три.
    expect(effectivePhoneAsks(MAX_PHONE_ASKS, [])).toBe(MAX_PHONE_ASKS);
  });

  it("у старых разговоров (счётчик 0) поведение прежнее — считает по ленте", () => {
    expect(effectivePhoneAsks(0, [PHONE_ASK, "Хуб", PHONE_ASK])).toBe(2);
  });

  it("берёт большее, а не сумму: одна и та же просьба не считается дважды", () => {
    expect(effectivePhoneAsks(2, [PHONE_ASK, PHONE_ASK])).toBe(2);
  });

  it("считает просьбы в отправляемой пачке", () => {
    expect(countPhoneAsksIn([PHONE_ASK, "Дар кадом район?"])).toBe(1);
  });
});

describe("Бот не просит номер заново после обрезки переписки", () => {
  it("лента без просьб, счётчик на пределе — просьба не уходит клиенту", async () => {
    const subscriberId = subscriberOf("truncated");
    await prisma.botConversation.update({
      where: { id: (await fixture!.ensureConversation(subscriberId)).id },
      data: {
        channel: "INSTAGRAM",
        subscriberId,
        // Ровно то состояние, которое давала обрезка: в ленте НИ ОДНОЙ просьбы,
        // а на деле их было три. До правки счёт по ленте давал 0.
        messages: [
          { role: "user", content: "Салом" },
          { role: "assistant", content: "Ассалому алейкум! Чӣ гуна хона мекобед?" },
          { role: "user", content: "Ду хона" },
        ] as unknown as object,
        phoneAsksSent: MAX_PHONE_ASKS,
        leadDraft: { stage: "awaiting_phone" } as unknown as object,
      },
    });

    callAi.mockClear();
    callAi.mockResolvedValue({ reply: [PHONE_ASK], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });

    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId, text: "Боз чӣ гап?" });

    expect(callAi).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "lead-qualify" }));
    const sent = [result.reply, result.reply2].filter(Boolean).join("\n");
    expect(sent).not.toContain("Рақами телефонатон");
    expect(sent).not.toContain("Номератон");
  });
});

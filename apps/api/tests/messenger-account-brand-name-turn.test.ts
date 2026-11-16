import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { processMessengerTurn } from "../src/messengers/conversation.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ЦЕЛЫЙ ХОД ЧЕРЕЗ processMessengerTurn: у аккаунта с именем компании модель вспомнила
 * «Royal Home» — клиент всё равно получает «Арван». Держит провод accountId от хода
 * до finalizeBotReply в messengers/conversation.ts (убери `accountId: account.id` из
 * вызова finalizeBotReply — тест краснеет) и подмену промта в runQualifyTurn.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));
// The brain of the channel body is the one door now (one brain, step 3b): it answers with this test's scripted model.
vi.mock("../src/ai/customerChannelTurn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/customerChannelTurn.js")>()),
  runCustomerChannelTurn: (await import("./helpers/fakeChannelBrain.js")).channelBrainFromModel((input) => callAi(input as never)),
}));

const runId = Date.now().toString(36);
let settingsBefore: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;
let fixture: CustomerMessengerFixture | undefined;

const REPLY = {
  reply: ["Трёхкомнатные квартиры в центре у Royal Home есть. В каком районе точнее?"],
  ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false,
};

async function turn(subscriber: string) {
  const seeded = await fixture!.ensureConversation(subscriber);
  await prisma.botConversation.update({
    where: { id: seeded.id },
    data: {
      messages: [
        { role: "user", content: "Хона даркор" },
        { role: "assistant", content: "Чӣ гуна хона мекобед?", by: { kind: "bot" } },
      ] as never,
      leadDraft: { stage: "chatting" } as never,
    },
  });
  callAi.mockReset();
  callAi.mockResolvedValue(REPLY);
  return processMessengerTurn({ ...fixture!.turnInput(subscriber), text: "Здравствуйте, ищу трёхкомнатную квартиру в центре" });
}

beforeAll(async () => {
  settingsBefore = await prisma.settings.upsert({
    where: { id: "singleton" }, update: {}, create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botReplyDelaySec: 2, botReplyMaxWaitSec: 5 } });
  fixture = await createCustomerMessengerFixture("INSTAGRAM");
});

afterAll(async () => {
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await fixture?.cleanupConversations();
  await fixture?.dispose();
});

describe("ход аккаунта с именем компании", () => {
  it("клиент видит «Арван», промт модели без «Royal Home»", async () => {
    await prisma.messengerAccount.update({ where: { id: fixture!.id }, data: { brandName: "Арван" } });
    resetAccountsCache();
    const result = await turn(`brand-turn-${runId}-a`);
    expect(result.shouldReply).not.toBe(false);
    expect(result.reply).toContain("Арван");
    expect(result.reply).not.toMatch(/Royal Home/);
    // The old prompt is gone (one brain, step 3b): the customer-visible text is what is checked here.
  });

  it("аккаунт без имени: «Royal Home» остаётся как был", async () => {
    await prisma.messengerAccount.update({ where: { id: fixture!.id }, data: { brandName: null } });
    resetAccountsCache();
    const result = await turn(`brand-turn-${runId}-b`);
    expect(result.reply).toContain("Royal Home");
    // The old prompt is gone (one brain, step 3b): the customer-visible text is what is checked here.
  });
});

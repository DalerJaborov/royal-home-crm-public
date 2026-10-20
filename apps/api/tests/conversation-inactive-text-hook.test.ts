import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ПРОВЕРКА ПОДКЛЮЧЕНИЯ (не логики самой детекции — она проверена отдельно, см.
 * client-inactive-text-detector.test.ts): messengers/conversation.ts действительно
 * зовёт checkClientInactiveSignal на финальную реплику УЖЕ ПРИНЯТОГО клиента
 * (ветка `if (conversation.clientId)`, план 19-plan-03-09-evening.md, раздел B).
 *
 * Модуль детектора замокан целиком — так тест не гоняется наперегонки со вторым,
 * независимым вызовом ИИ (shortAgentReply) внутри той же ветки processMessengerTurn:
 * оба вызова фоновые/асинхронные, и делить один и тот же мок callAiText между ними
 * было бы гонкой, а не тестом. Здесь проверяется РОВНО факт и аргументы вызова.
 */

const { checkClientInactiveSignal, callAiText } = vi.hoisted(() => ({
  checkClientInactiveSignal: vi.fn(async () => undefined),
  callAiText: vi.fn(async () => ({ reply: "Спасибо, агент скоро свяжется.", ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false })),
}));
vi.mock("../src/lib/clientInactiveTextDetector.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/clientInactiveTextDetector.js")>()),
  checkClientInactiveSignal,
}));

vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));

const { prisma } = await import("../src/db.js");
const { processMessengerTurn: actualProcessMessengerTurn } = await import("../src/messengers/conversation.js");

let messengerFixture: CustomerMessengerFixture;
function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  return actualProcessMessengerTurn({ ...input, ...messengerFixture.turnInput(input.subscriberId) });
}

const runId = Date.now();
const conversationIds: string[] = [];
const clientIds: string[] = [];
let agentId = "";

beforeEach(async () => {
  checkClientInactiveSignal.mockClear();
  callAiText.mockClear();
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botEnabled: true, botFacebookEnabled: true },
  });
  if (!agentId) {
    const agent = await prisma.agent.create({
      data: { fullName: `Агент wiring ${runId}`, phone: `+992973${runId}`, role: "AGENT", passwordHash: "x" },
    });
    agentId = agent.id;
  }
});

afterEach(async () => {
  await messengerFixture?.cleanupConversations();
  conversationIds.length = 0;
});

beforeAll(async () => {
  messengerFixture = await createCustomerMessengerFixture("FACEBOOK");
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  if (agentId) await prisma.agent.deleteMany({ where: { id: agentId } });
  await messengerFixture?.dispose();
  await prisma.$disconnect();
});

async function makeAcceptedConversation(subscriberId: string) {
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент wiring ${runId}`,
      phone: `+992974${runId}${clientIds.length}`,
      source: "FACEBOOK",
      kind: "BUYER",
      assignedAgentId: agentId,
      workStatus: "ACTIVE",
      acceptedAt: new Date(),
    },
  });
  clientIds.push(client.id);
  const conv = await prisma.botConversation.update({
      where: { id: (await messengerFixture.ensureConversation(subscriberId)).id },
    data: {
      channel: "FACEBOOK",
      subscriberId,
      clientId: client.id,
      messages: [{ role: "assistant", content: "Спасибо! Агент скоро свяжется.", by: { kind: "bot" } }],
      leadDraft: { stage: "done" } as any,
    },
  });
  conversationIds.push(conv.id);
  return { client, conv };
}

describe("processMessengerTurn — хук детектора неактивности на реплике принятого клиента", () => {
  it("зовёт checkClientInactiveSignal с (clientId, текст сообщения)", async () => {
    const { client } = await makeAcceptedConversation(`wiring-${runId}-a`);

    await processMessengerTurn({
      channel: "FACEBOOK",
      subscriberId: `wiring-${runId}-a`,
      text: "Мне надо подумать ещё немного",
    });

    expect(checkClientInactiveSignal).toHaveBeenCalledTimes(1);
    expect(checkClientInactiveSignal).toHaveBeenCalledWith(client.id, "Мне надо подумать ещё немного");
  });

  it("пустая реплика (стикер/голос без текста) — детектор не зовётся", async () => {
    await makeAcceptedConversation(`wiring-${runId}-b`);

    await processMessengerTurn({
      channel: "FACEBOOK",
      subscriberId: `wiring-${runId}-b`,
      text: "",
    });

    expect(checkClientInactiveSignal).not.toHaveBeenCalled();
  });
});

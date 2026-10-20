import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { processMessengerTurn as actualProcessMessengerTurn } from "../src/messengers/conversation.js";

/**
 * Живые диалоги 13.10.2026: бот принял номер («Ташаккур, рақаматонро қабул
 * кардам») и через минуту снова — «Рақами телефонатон ва номатонро нависед».
 * acceptLead ставил стадию "done", но следующий ход с ready=true от модели
 * возвращал "awaiting_phone" диалогу, у которого карточка с телефоном уже есть.
 */

const { qualify } = vi.hoisted(() => ({ qualify: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: qualify,
}));

let messengerFixture: CustomerMessengerFixture;
function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  return actualProcessMessengerTurn({ ...input, ...messengerFixture.turnInput(input.subscriberId) });
}

const runId = Date.now().toString(36);
const SUBSCRIBER = `reask-${runId}`;
let clientId = "";
let saved: { botEnabled: boolean; botWhatsappEnabled: boolean; botReplyDelaySec: number; botReplyMaxWaitSec: number };

beforeAll(async () => {
  messengerFixture = await createCustomerMessengerFixture("WHATSAPP");
  saved = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botEnabled: true, botWhatsappEnabled: true, botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botEnabled: true, botWhatsappEnabled: true, botReplyDelaySec: 0, botReplyMaxWaitSec: 5 },
  });
  const client = await prisma.client.create({
    data: { fullName: `Тест повтора номера ${runId}`, phone: `+99290${String(Date.now()).slice(-7)}`, source: "WHATSAPP" },
  });
  clientId = client.id;
  await prisma.botConversation.update({
    where: { id: (await messengerFixture.ensureConversation(SUBSCRIBER)).id },
    data: {
      channel: "WHATSAPP",
      subscriberId: SUBSCRIBER,
      clientId,
      leadDraft: { stage: "done", intent: "buy", rooms: 2 } as never,
      messages: [
        { role: "user", content: "Номерои ман 900000000", at: new Date(Date.now() - 60_000).toISOString() },
        { role: "assistant", content: "Ташаккур, рақаматонро қабул кардам!", by: { kind: "bot" }, at: new Date(Date.now() - 59_000).toISOString() },
      ] as never,
    },
  });
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  if (clientId) await prisma.client.deleteMany({ where: { id: clientId } });
  await messengerFixture?.dispose();
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
});

describe("номер уже принят — бот не возвращается к «ждём номер»", () => {
  it("модель прислала ready=true, а у диалога есть карточка: стадия остаётся done", async () => {
    qualify.mockResolvedValue({
      reply: ["Дар 101 ва 102 мкр вариантҳо ҳастанд"],
      ready: true,
      confident: true,
      intent: "buy",
      topic: "other",
      openQuestion: "",
      clientAnsweredOpenQuestion: false,
      lead: { rooms: 2 },
    });

    const result = await processMessengerTurn({ channel: "WHATSAPP", subscriberId: SUBSCRIBER, text: "Кай малум мекунед" });
    // Отказ boundary тоже оставил бы done: тест обязан пройти настоящий ход.
    expect(result.aiUnavailable ?? false).toBe(false);
    expect(result.shouldReply).not.toBe(false);
    expect(qualify.mock.calls.some(([params]) => params.endpoint === "lead-qualify")).toBe(true);

    const conv = await prisma.botConversation.findUnique({
      where: { channel_subscriberId: { channel: "WHATSAPP", subscriberId: SUBSCRIBER } },
      select: { leadDraft: true },
    });
    expect((conv!.leadDraft as { stage?: string }).stage).toBe("done");
  });
});

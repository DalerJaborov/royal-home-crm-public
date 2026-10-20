import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ТИШИНА ПЕРВЫХ СЕКУНД ВХОДЯЩЕГО (04.09.2026).
 *
 * Живой разбор (владелец тестировал сам): `royalhome-inbound` отвечает на канал
 * сразу, а дальше — поиск клиента в базе CRM и, для известного клиента, перевод
 * на агента через AMI (два действия через туннель офис↔VPS). Всё это время
 * звонящий слышал АБСОЛЮТНУЮ ТИШИНУ — не гудок, не музыку. Часть повторных
 * звонков в тот же день заканчивалась `redirect_failed` («нет такого канала»)
 * ровно потому, что звонивший клал трубку раньше, чем перевод успевал дойти.
 *
 * Тест проверяет не сам перевод (это `inbound-routing.test.ts`), а то, что CRM
 * САМА, СРАЗУ по факту нового канала — до похода в базу — отвечает на канал и
 * включает музыку ожидания. Без реальной станции: ariClient подменён.
 */

const ariCalls: { fn: string; channelId: string }[] = [];
vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: "http://pbx.test", username: "crm", password: "x" }),
  answerChannel: vi.fn(async (_creds: unknown, channelId: string) => {
    ariCalls.push({ fn: "answer", channelId });
    return { ok: true };
  }),
  startMoh: vi.fn(async (_creds: unknown, channelId: string) => {
    ariCalls.push({ fn: "moh", channelId });
    return { ok: true };
  }),
}));

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent }));

const { prisma } = await import("../src/db.js");
const { handleAriEvent } = await import("../src/lib/telephony/ariEvents.js");
const { resetIncomingCalls } = await import("../src/lib/telephony/incomingCalls.js");

const runId = Date.now();

afterEach(() => {
  ariCalls.length = 0;
  resetIncomingCalls();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function inboundChannel(id: string, callerNumber: string) {
  return {
    id,
    name: `SIP/out-${id}`,
    state: "Ring",
    caller: { number: callerNumber },
    dialplan: { context: "ext-queues", exten: "1000" },
  };
}

describe("Музыка ожидания на новом входящем", () => {
  it("отвечает на канал и включает МОН СРАЗУ на ChannelCreated, не дожидаясь поиска клиента", async () => {
    const channelId = `hold-${runId}`;
    await handleAriEvent({ type: "ChannelCreated", channel: inboundChannel(channelId, "992900" + String(runId).slice(-6)) });

    await vi.waitFor(() => {
      expect(ariCalls).toContainEqual({ fn: "answer", channelId });
      expect(ariCalls).toContainEqual({ fn: "moh", channelId });
    });
  });

  it("не падает и не блокирует звонок, если станция недоступна", async () => {
    const channelId = `hold-fail-${runId}`;
    const { startMoh } = await import("../src/lib/telephony/ariClient.js");
    vi.mocked(startMoh).mockRejectedValueOnce(new Error("станция лежит"));

    // Событие обязано отработать до конца (запись звонка завестись) несмотря на
    // отказ МОН — тишина первых секунд не должна становиться потерянным звонком.
    await expect(
      handleAriEvent({ type: "ChannelCreated", channel: inboundChannel(channelId, "992900" + String(runId).slice(-6)) })
    ).resolves.toBeUndefined();
  });
});

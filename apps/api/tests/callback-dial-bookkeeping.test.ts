import { describe, expect, it, vi } from "vitest";

/** Станция набрала номер, а запись в базу упала: набор НЕ теряется, иначе автоперезвон набрал бы заново каждую минуту. */
vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: "http://pbx.local", username: "crm", password: "x" }),
  loadAgentDialMode: async () => "desk",
  resolveAgentDialTarget: async () => ({ agentMobile: null }),
  originateCall: async () => ({ ok: true, channelId: "redial-bookkeeping-ch" }),
}));
vi.mock("../src/lib/timeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/timeline.js")>()),
  logTimeline: async () => {
    throw new Error("база моргнула");
  },
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: async () => 1,
}));

const { dialOperatorThenClient } = await import("../src/lib/telephony/callbackConnect.js");

describe("dialOperatorThenClient: сбой записи после набора", () => {
  it("набор состоялся: результат «соединяю», а не «не набрали»; запись не сохранена, interactionId пуст", async () => {
    const res = await dialOperatorThenClient({
      operator: { id: "op-1", sipExtension: "1500", phone: null },
      phone: "+992900000321",
      client: { id: "c-1", shortId: 1, fullName: "Клиент" },
      topic: "пропущенный звонок",
      callerName: "Пропущенный: Клиент",
      redial: true,
    });
    expect(res).toEqual({ outcome: "connected", interactionId: null });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendPushToAgents = vi.fn(async (..._a: unknown[]) => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents: (...a: unknown[]) => sendPushToAgents(...a),
}));

import { prisma } from "../src/db.js";
import { notifyRobotTookInboundCall, resetInboundPushMemoryForTests } from "../src/lib/telephony/liveVoiceInboundPush.js";

/** Пуш «робот взял входящий»: один на разговор, отказ наружу не выходит. */
describe("пуш руководству о входящем звонке робота", () => {
  beforeEach(() => {
    sendPushToAgents.mockClear();
    resetInboundPushMemoryForTests();
  });

  it("шлёт директору и один раз на разговор", async () => {
    const spy = vi
      .spyOn(prisma.agent, "findMany")
      .mockResolvedValue([{ id: "dir-1", role: "DIRECTOR", permissions: null }] as never);
    const key = `lv-push-${Date.now()}`;
    await notifyRobotTookInboundCall({ key, callerNumber: "+992901234567" });
    expect(sendPushToAgents).toHaveBeenCalledTimes(1);
    expect(sendPushToAgents.mock.calls[0][0]).toEqual(["dir-1"]);
    expect(sendPushToAgents.mock.calls[0][1]).toMatchObject({ url: "/calls", tag: `live-voice-listen-${key}` });
    await notifyRobotTookInboundCall({ key, callerNumber: "+992901234567" });
    expect(sendPushToAgents).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("отказ базы не выходит наружу", async () => {
    const spy = vi.spyOn(prisma.agent, "findMany").mockRejectedValueOnce(new Error("база недоступна"));
    await expect(notifyRobotTookInboundCall({ key: `lv-push-fail-${Date.now()}`, callerNumber: null })).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("отказ пуша не выходит наружу", async () => {
    sendPushToAgents.mockRejectedValueOnce(new Error("пуш упал"));
    await expect(notifyRobotTookInboundCall({ key: `lv-push-err-${Date.now()}`, callerNumber: null })).resolves.toBeUndefined();
  });
});

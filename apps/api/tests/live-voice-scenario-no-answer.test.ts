import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * НЕДОЗВОН РОБОТА — СЦЕНАРИЮ СРАЗУ (02.10.2026, находка треда «Анкеты кандидатов»).
 *
 * Канал входит в Stasis только по ответу. Трубку не сняли — мост об этом узнаёт
 * лишь по истечении срока задания, и раньше молча его выбрасывал: приглашение
 * кандидату, опрос после показа и проверка продавца висели в CALLING до
 * 20-минутной уборки, и HR узнавал о недозвоне через треть часа.
 */

const originateToStasisApp = vi.fn(async () => ({ ok: true, channelId: `lv-noans-${Date.now()}` }));
vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: "http://station", username: "u", password: "p" }),
  originateToStasisApp,
}));

const { prisma } = await import("../src/db.js");
const { originateLiveVoiceScenarioCall, liveVoiceLineBusy } = await import("../src/lib/telephony/liveVoiceBridge.js");

const portBefore = process.env.LIVE_VOICE_RTP_PORT;
const hostBefore = process.env.LIVE_VOICE_RTP_HOST;
let enabledBefore = false;

beforeAll(async () => {
  process.env.LIVE_VOICE_RTP_PORT = "40800";
  process.env.LIVE_VOICE_RTP_HOST = "127.0.0.1";
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { liveVoiceEnabled: true } });
  enabledBefore = s?.liveVoiceEnabled ?? false;
  await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceEnabled: true } });
});

afterAll(async () => {
  vi.useRealTimers();
  if (portBefore === undefined) delete process.env.LIVE_VOICE_RTP_PORT;
  else process.env.LIVE_VOICE_RTP_PORT = portBefore;
  if (hostBefore === undefined) delete process.env.LIVE_VOICE_RTP_HOST;
  else process.env.LIVE_VOICE_RTP_HOST = hostBefore;
  await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceEnabled: enabledBefore } });
});

describe("сценарный звонок без ответа", () => {
  it("по истечении срока задания зовёт onFinished с «никто не говорил» и освобождает линию", async () => {
    const onFinished = vi.fn(async () => {});
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const res = await originateLiveVoiceScenarioCall("+992 93 000 55 66", { systemInstruction: "тест", onFinished });
    expect(res).toMatchObject({ ok: true });
    expect(liveVoiceLineBusy()).toBe(true);
    expect(onFinished).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(61_000);
    vi.useRealTimers();

    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished.mock.calls[0][0]).toMatchObject({
      channelId: res.channelId,
      reason: "no_answer",
      clientSpoke: false,
      transcript: [],
    });
    expect(liveVoiceLineBusy()).toBe(false);
  });
});

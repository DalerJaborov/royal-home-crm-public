import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ОДНА ЛИНИЯ ЖИВОГО ГОЛОСА (02.10.2026, проверка робозвонка перед пробой Dan).
 *
 * На сайте проброшен один порт RTP: разговор у консультанта один. Набранный, но
 * ещё не отвеченный исходящий (приглашение кандидату, опрос после показа,
 * проверочный звонок) уже держит линию: если её возьмёт входящий, человек на
 * исходящем снимет трубку и услышит тишину — порт занят. Раньше такой звонок
 * линию не занимал.
 */

const originateToStasisApp = vi.fn(async () => ({ ok: true, channelId: `lv-busy-${Date.now()}` }));
vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: "http://station", username: "u", password: "p" }),
  originateToStasisApp,
}));

const { prisma } = await import("../src/db.js");
const { originateLiveVoiceTestCall, liveVoiceLineBusy } = await import("../src/lib/telephony/liveVoiceBridge.js");

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
  if (portBefore === undefined) delete process.env.LIVE_VOICE_RTP_PORT;
  else process.env.LIVE_VOICE_RTP_PORT = portBefore;
  if (hostBefore === undefined) delete process.env.LIVE_VOICE_RTP_HOST;
  else process.env.LIVE_VOICE_RTP_HOST = hostBefore;
  await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceEnabled: enabledBefore } });
});

describe("набранный исходящий держит линию", () => {
  it("пока исходящий не отвечен, линия занята и второй звонок не набирается", async () => {
    expect(liveVoiceLineBusy()).toBe(false);
    const first = await originateLiveVoiceTestCall("+992 93 000 11 22");
    expect(first).toMatchObject({ ok: true });
    expect(liveVoiceLineBusy()).toBe(true);

    const second = await originateLiveVoiceTestCall("+992 93 000 33 44");
    expect(second).toMatchObject({ ok: false, busy: true });
    expect(originateToStasisApp).toHaveBeenCalledTimes(1);
  });
});

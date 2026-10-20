import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ДВА НАБОРА В ОДНУ СЕКУНДУ (02.10.2026, разбор сценарных звонков).
 *
 * Линия считалась занятой, только когда originate уже вернулся (до 5 с), а тики
 * приглашения и опроса после показа срабатывают в одну и ту же секунду. Оба
 * видели свободную линию, набирались два человека, второй снимал трубку в
 * тишину (порт RTP один) и сжигал свою единственную попытку. Резерв набора
 * держит линию с момента проверки, до всякого await.
 */

let release: () => void = () => {};
const originateToStasisApp = vi.fn(
  () =>
    new Promise<{ ok: boolean; channelId: string }>((resolve) => {
      release = () => resolve({ ok: true, channelId: `lv-race-${Date.now()}` });
    })
);
vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: "http://station", username: "u", password: "p" }),
  originateToStasisApp,
}));

const { prisma } = await import("../src/db.js");
const { originateLiveVoiceTestCall, liveVoiceLineBusy, stationAudioHoldMs, STATION_AUDIO_DEAD_HOLD_MS, STATION_AUDIO_DEAD_HOLD_MAX_MS } =
  await import("../src/lib/telephony/liveVoiceBridge.js");

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

describe("линия занята с момента набора", () => {
  it("пока первый originate ещё не вернулся, второй звонок не набирается", async () => {
    expect(liveVoiceLineBusy()).toBe(false);
    const first = originateLiveVoiceTestCall("+992 93 000 55 66");
    await vi.waitFor(() => expect(originateToStasisApp).toHaveBeenCalledTimes(1));
    expect(liveVoiceLineBusy()).toBe(true);

    const second = await originateLiveVoiceTestCall("+992 93 000 77 88");
    expect(second).toMatchObject({ ok: false, busy: true });
    expect(originateToStasisApp).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toMatchObject({ ok: true });
  });
});

describe("пауза без звука станции растёт", () => {
  it("10, 20, 40 мин… не больше потолка", () => {
    expect(stationAudioHoldMs(1)).toBe(STATION_AUDIO_DEAD_HOLD_MS);
    expect(stationAudioHoldMs(2)).toBe(2 * STATION_AUDIO_DEAD_HOLD_MS);
    expect(stationAudioHoldMs(3)).toBe(4 * STATION_AUDIO_DEAD_HOLD_MS);
    expect(stationAudioHoldMs(20)).toBe(STATION_AUDIO_DEAD_HOLD_MAX_MS);
  });
});

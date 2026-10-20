import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Строка журнала «исходящий звонок клиенту undefined» (02.10.2026, глубокий аудит).
 *
 * Сценарный звонок (приглашение кандидата, опрос после показа) идёт без карточки
 * клиента, и мост печатал в журнал «клиенту ${clientId}» — то есть «undefined».
 * Станция и Gemini подменены, мост настоящий.
 */

const station = vi.hoisted(() => ({ seq: 0 }));
const logged = vi.hoisted(() => ({ messages: [] as string[] }));

vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: "http://station", username: "u", password: "p" }),
  originateToStasisApp: async () => ({ ok: true, channelId: `lv-acc-chan-${++station.seq}` }),
  createBridge: async () => ({ ok: true, bridgeId: `br-${++station.seq}` }),
  createExternalMediaChannel: async () => ({ ok: true, channelId: `UnicastRTP/127.0.0.1-${++station.seq}` }),
  answerChannel: async () => ({ ok: true }),
  addChannelToBridge: async () => ({ ok: true }),
  readChannelVariable: async (_c: unknown, _id: string, name: string) =>
    // Станция называет адрес звука всегда (без него мост с 09.10.2026 трубку не берёт).
    name === "UNICASTRTP_LOCAL_ADDRESS" ? "127.0.0.1" : name === "UNICASTRTP_LOCAL_PORT" ? "40997" : null,
  deleteBridge: async () => ({ ok: true }),
  hangupCall: async () => ({ ok: true }),
  continueInDialplan: async () => ({ ok: true }),
  listActiveChannels: async () => [],
  playChannelSound: async () => ({ ok: true }),
}));

vi.mock("../src/ai/liveVoiceClient.js", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  class FakeLiveVoiceClient extends EventEmitter {
    activeModel = "fake-live";
    async connect(): Promise<void> {
      this.emit("ready");
    }
    sendText(): void {}
    sendAudioChunk(): void {}
    sendToolResponse(): void {}
    close(): void {}
  }
  return { ...(await importOriginal<typeof import("../src/ai/liveVoiceClient.js")>()), LiveVoiceClient: FakeLiveVoiceClient };
});

vi.mock("../src/lib/r2Client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/r2Client.js")>()),
  isR2Configured: () => false,
}));

vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: async (_source: string, message: string) => {
    logged.messages.push(String(message));
  },
}));

const { prisma } = await import("../src/db.js");
const { onLiveVoiceAriEvent, originateLiveVoiceScenarioCall, resetLiveVoiceAudioPathForTests } = await import(
  "../src/lib/telephony/liveVoiceBridge.js"
);
const { waitFor } = await import("./helpers/waitFor.js");

const RTP_PORT = 42000 + Math.floor(Math.random() * 900);
const envBefore = { host: process.env.LIVE_VOICE_RTP_HOST, port: process.env.LIVE_VOICE_RTP_PORT };
let settingsBefore: { liveVoiceEnabled: boolean } | null = null;

beforeAll(async () => {
  process.env.LIVE_VOICE_RTP_HOST = "127.0.0.1";
  process.env.LIVE_VOICE_RTP_PORT = String(RTP_PORT);
  settingsBefore = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { liveVoiceEnabled: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceEnabled: true } });
  resetLiveVoiceAudioPathForTests();
});

afterAll(async () => {
  for (const [key, value] of [
    ["LIVE_VOICE_RTP_HOST", envBefore.host],
    ["LIVE_VOICE_RTP_PORT", envBefore.port],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await prisma.liveVoiceSession.deleteMany({ where: { channelId: { startsWith: "lv-acc-chan-" } } });
});

describe("журнал: исходящий звонок принят", () => {
  it("сценарный звонок без карточки клиента — без «undefined», с пояснением", async () => {
    const dial = await originateLiveVoiceScenarioCall("+992 93 000 66 55", { systemInstruction: "тест" });
    expect(dial.ok).toBe(true);
    const channelId = dial.channelId!;
    await onLiveVoiceAriEvent({
      type: "StasisStart",
      application: "royalhome-live-voice",
      args: [],
      channel: { id: channelId, name: `SIP/out-${channelId}`, state: "Up", caller: { number: "930006655" } },
    } as never);
    const line = await waitFor(() => logged.messages.find((m) => m.includes("исходящий звонок") && m.includes("принят")) ?? null, {
      label: "строка о принятом звонке",
    });
    expect(line).not.toContain("undefined");
    expect(line).toContain("по сценарию");
    await onLiveVoiceAriEvent({ type: "StasisEnd", channel: { id: channelId, name: `SIP/out-${channelId}`, state: "Up", caller: {} } } as never);
  });
});

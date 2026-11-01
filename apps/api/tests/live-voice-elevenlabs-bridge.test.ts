import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * МОСТ С ВТОРЫМ ПОСТАВЩИКОМ ГОЛОСА НА СВЕЖЕМ main (03.10.2026). Станция и оба клиента
 * (Gemini и ElevenLabs) подменены; мост настоящий, события идут через
 * onLiveVoiceAriEvent тем же путём, что из подписки ARI. Проверяется то, ради чего
 * ElevenLabs переносили поверх правок робота:
 *  - по умолчанию звонок идёт через Gemini как раньше (поставщик в журнале — google,
 *    стоимость в журнал ИИ пишется, звук 16 кГц);
 *  - ElevenLabs получает ТОТ ЖЕ итоговый промт: правило рода — по полу голоса из
 *    Настроек, замок «только русский» — язык ru, даже если досье говорит «таджикский»;
 *  - агент сам закончил разговор — это не сбой (трубка кладётся, автоответчика нет),
 *    любое иное закрытие — сбой, человек уходит на автоответчик;
 *  - звонок ElevenLabs в журнал ИИ не пишется (известное ограничение).
 */

const station = vi.hoisted(() => ({
  /** Порт, с которого «станция» шлёт звук (UNICASTRTP_LOCAL_PORT). */
  rtpPort: 45000 + Math.floor(Math.random() * 900),
  bridges: 0,
  continued: [] as string[],
  hangups: [] as string[],
}));

interface FakeProvider {
  kind: "google" | "elevenlabs";
  connectOpts: Record<string, unknown> | null;
  texts: string[];
  audio: { bytes: number; rate?: number }[];
  closed: boolean;
  emit(event: string, ...args: unknown[]): boolean;
}
const clients = vi.hoisted(() => ({ list: [] as FakeProvider[] }));

vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: "http://station", username: "u", password: "p" }),
  createBridge: async () => ({ ok: true, bridgeId: `br-${++station.bridges}` }),
  createExternalMediaChannel: async () => ({ ok: true, channelId: `UnicastRTP/127.0.0.1-${station.bridges}` }),
  answerChannel: async () => ({ ok: true }),
  addChannelToBridge: async () => ({ ok: true }),
  readChannelVariable: async (_c: unknown, _id: string, name: string) =>
    // Станция называет адрес звука всегда (без него мост с 09.10.2026 трубку не берёт).
    name === "UNICASTRTP_LOCAL_ADDRESS" ? "127.0.0.1" : name === "UNICASTRTP_LOCAL_PORT" ? String(station.rtpPort) : null,
  deleteBridge: async () => ({ ok: true }),
  hangupCall: async (_creds: unknown, channelId: string) => {
    station.hangups.push(channelId);
    return { ok: true };
  },
  continueInDialplan: async (_creds: unknown, channelId: string) => {
    station.continued.push(channelId);
    return { ok: true };
  },
  listActiveChannels: async () => [],
  listBridges: async () => [],
  playChannelSound: async () => ({ ok: true }),
}));

async function makeFake(kind: "google" | "elevenlabs") {
  const { EventEmitter } = await import("node:events");
  return class extends EventEmitter {
    kind = kind;
    connectOpts: Record<string, unknown> | null = null;
    texts: string[] = [];
    audio: { bytes: number; rate?: number }[] = [];
    closed = false;
    activeModel = kind === "google" ? "fake-live" : null;
    asyncTools = false;
    outputSampleRateHz = kind === "google" ? 24_000 : 8_000;
    inputSampleRateHz = kind === "google" ? 16_000 : 8_000;
    constructor() {
      super();
      clients.list.push(this as unknown as FakeProvider);
    }
    async connect(opts: Record<string, unknown>): Promise<void> {
      this.connectOpts = opts;
      this.emit("ready");
    }
    sendText(text: string): void {
      this.texts.push(text);
    }
    sendAudioChunk(buf: Buffer, rate?: number): void {
      this.audio.push({ bytes: buf.length, rate });
    }
    sendToolResponse(): void {}
    resendToolResponse(): boolean {
      return false;
    }
    close(): void {
      this.closed = true;
    }
  };
}

vi.mock("../src/ai/liveVoiceClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/liveVoiceClient.js")>()),
  LiveVoiceClient: await makeFake("google"),
}));

vi.mock("../src/ai/elevenLabsVoiceClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/elevenLabsVoiceClient.js")>()),
  ElevenLabsVoiceClient: await makeFake("elevenlabs"),
}));

vi.mock("../src/lib/r2Client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/r2Client.js")>()),
  isR2Configured: () => false,
}));

// Замок «только русский», амбиент, вдох и тестовый номер — константы с 01.11.2026
// (lib/settingsConstants.ts). Тест держит прежнюю среду (амбиент выключен) и
// переключает замок подменой константы, а не полем Settings.
const voiceTuning = vi.hoisted(() => ({
  testExtension: "101008890", forceRussianOnly: false, breathEnabled: false, officeAmbienceEnabled: false, officeAmbienceVolume: 0.35,
}));
vi.mock("../src/lib/settingsConstants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/settingsConstants.js")>()),
  LIVE_VOICE_TUNING: voiceTuning,
}));

const { prisma } = await import("../src/db.js");
const bridge = await import("../src/lib/telephony/liveVoiceBridge.js");
const { onLiveVoiceAriEvent, liveVoiceLineBusy, setLiveVoiceCallResolver, resetLiveVoiceAudioPathForTests } = bridge;
const { waitFor, waitForCount, waitForSettled } = await import("./helpers/waitFor.js");
const { selfGenderRule } = await import("@royal-home/shared");

const runId = Date.now().toString(36);
const RTP_PORT = 43000 + Math.floor(Math.random() * 900);
const envBefore = { host: process.env.LIVE_VOICE_RTP_HOST, port: process.env.LIVE_VOICE_RTP_PORT, peer: process.env.LIVE_VOICE_RTP_PEER };
let seq = 0;
const startedChannels: string[] = [];
type SettingsSnapshot = {
  liveVoiceEnabled: boolean;
  liveVoiceInboundMode: string;
  liveVoiceForceRussianOnly: boolean;
  liveVoiceProvider: string;
  elevenLabsVoiceGender: string | null;
};
let before: SettingsSnapshot | null = null;

function stasisStart(channelId: string) {
  return {
    type: "StasisStart",
    application: "royalhome-live-voice",
    args: ["inbound"],
    channel: { id: channelId, name: `SIP/out-${channelId}`, state: "Up", caller: { number: "931112299" } },
  };
}
function stasisEnd(channelId: string) {
  return { type: "StasisEnd", channel: { id: channelId, name: `SIP/out-${channelId}`, state: "Up", caller: {} } };
}

async function startInbound(tag: string): Promise<{ channelId: string; client: FakeProvider }> {
  seq += 1;
  const channelId = `lv-el-${runId}-${tag}-${seq}`;
  startedChannels.push(channelId);
  await onLiveVoiceAriEvent(stasisStart(channelId) as never);
  return { channelId, client: clients.list.at(-1)! };
}

async function useSettings(data: Partial<SettingsSnapshot>): Promise<void> {
  const { liveVoiceForceRussianOnly, ...dbData } = data;
  if (liveVoiceForceRussianOnly !== undefined) voiceTuning.forceRussianOnly = liveVoiceForceRussianOnly;
  if (Object.keys(dbData).length > 0) await prisma.settings.update({ where: { id: "singleton" }, data: dbData });
}

const aiLogCount = (channelId: string) => () => prisma.aiLog.count({ where: { conversationId: channelId } });

beforeAll(async () => {
  process.env.LIVE_VOICE_RTP_HOST = "127.0.0.1";
  process.env.LIVE_VOICE_RTP_PORT = String(RTP_PORT);
  delete process.env.LIVE_VOICE_RTP_PEER;
  before = (await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      liveVoiceEnabled: true,
      liveVoiceInboundMode: true,
      liveVoiceForceRussianOnly: true,
      liveVoiceProvider: true,
      elevenLabsVoiceGender: true,
    },
  })) as SettingsSnapshot | null;
  await useSettings({ liveVoiceEnabled: true, liveVoiceInboundMode: "always" });
});

afterAll(async () => {
  for (const [key, value] of [
    ["LIVE_VOICE_RTP_HOST", envBefore.host],
    ["LIVE_VOICE_RTP_PORT", envBefore.port],
    ["LIVE_VOICE_RTP_PEER", envBefore.peer],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setLiveVoiceCallResolver(null);
  if (before) await useSettings(before);
  await prisma.aiLog.deleteMany({ where: { conversationId: { startsWith: `lv-el-${runId}` } } });
  await prisma.liveVoiceSession.deleteMany({ where: { channelId: { startsWith: `lv-el-${runId}` } } });
});

beforeEach(async () => {
  resetLiveVoiceAudioPathForTests();
  station.continued.length = 0;
  station.hangups.length = 0;
  setLiveVoiceCallResolver(null);
  await useSettings({ liveVoiceProvider: "google", elevenLabsVoiceGender: null, liveVoiceForceRussianOnly: true });
});

afterEach(async () => {
  for (const id of startedChannels.splice(0)) await onLiveVoiceAriEvent(stasisEnd(id) as never);
  await waitFor(() => !liveVoiceLineBusy(), { timeoutMs: 6000 });
});

describe("по умолчанию — Google, как до переключателя", () => {
  it("клиент Gemini, поставщик в журнале — google, женский голос по умолчанию — женский род", async () => {
    const { channelId, client } = await startInbound("g1");
    expect(client.kind).toBe("google");
    const opts = client.connectOpts as { systemInstruction: string; language: string; voiceName: string };
    expect(opts.systemInstruction).toContain(selfGenderRule("female"));
    expect(opts.language).toBe("ru");
    const row = await waitFor(() => prisma.liveVoiceSession.findFirst({ where: { channelId } }));
    expect(row.provider).toBe("google");
  });

  it("звук идёт на 16 кГц одним аргументом, как до правки; расход пишется в журнал ИИ", async () => {
    const { channelId, client } = await startInbound("g2");
    // Пакет со станции: 160 байт ulaw = 160 отсчётов (20 мс на 8 кГц) → 320 отсчётов = 640 байт на 16 кГц.
    const dgram = await import("node:dgram");
    const port = RTP_PORT;
    const socket = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => socket.bind(station.rtpPort, "127.0.0.1", () => resolve()));
    await new Promise<void>((resolve, reject) =>
      socket.send(
        bridge.buildRtpPacket({ payloadType: bridge.ULAW_PAYLOAD_TYPE, sequenceNumber: 1, timestamp: 0, ssrc: 1, payload: Buffer.alloc(160, 0x80) }),
        port,
        "127.0.0.1",
        (err) => (err ? reject(err) : resolve())
      )
    );
    socket.close();
    await waitFor(() => client.audio.length > 0);
    expect(client.audio[0]).toEqual({ bytes: 640, rate: undefined });

    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    expect(await waitForCount(aiLogCount(channelId), 1, { timeoutMs: 4000 })).toBeGreaterThanOrEqual(1);
  });
});

describe("ElevenLabs получает тот же итоговый промт", () => {
  beforeEach(async () => {
    await useSettings({ liveVoiceProvider: "elevenlabs" });
  });

  it("мужской голос из Настроек — мужской род в промте и в первой реплике, пока Gemini-голос по умолчанию женский", async () => {
    await useSettings({ elevenLabsVoiceGender: "male" });
    const { channelId, client } = await startInbound("e-male");
    expect(client.kind).toBe("elevenlabs");
    const opts = client.connectOpts as { systemInstruction: string };
    expect(opts.systemInstruction).toContain(selfGenderRule("male"));
    expect(opts.systemInstruction).not.toContain(selfGenderRule("female"));
    expect(client.texts[0]).toContain("мужском роде");
    const row = await waitFor(() => prisma.liveVoiceSession.findFirst({ where: { channelId } }));
    expect(row.provider).toBe("elevenlabs");
  });

  it("пол не указан — женский, как для неузнанного голоса Gemini", async () => {
    const { client } = await startInbound("e-female");
    expect((client.connectOpts as { systemInstruction: string }).systemInstruction).toContain(selfGenderRule("female"));
    expect(client.texts[0]).toContain("женском роде");
  });

  it("замок «только русский» держит язык ru, даже если досье говорит «таджикский»", async () => {
    setLiveVoiceCallResolver(async () => ({ systemInstruction: "роль", language: "tg" }));
    const locked = await startInbound("e-lock");
    expect((locked.client.connectOpts as { language: string }).language).toBe("ru");
    await onLiveVoiceAriEvent(stasisEnd(locked.channelId) as never);
    await waitFor(() => !liveVoiceLineBusy(), { timeoutMs: 6000 });

    await useSettings({ liveVoiceForceRussianOnly: false });
    const open = await startInbound("e-open");
    expect((open.client.connectOpts as { language: string }).language).toBe("tg");
  });

  it("звук собеседника уходит в частоте поставщика (8 кГц — без подъёма), второй аргумент задан", async () => {
    const { client } = await startInbound("e-audio");
    const dgram = await import("node:dgram");
    const port = RTP_PORT;
    const socket = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => socket.bind(station.rtpPort, "127.0.0.1", () => resolve()));
    await new Promise<void>((resolve, reject) =>
      socket.send(
        bridge.buildRtpPacket({ payloadType: bridge.ULAW_PAYLOAD_TYPE, sequenceNumber: 1, timestamp: 0, ssrc: 1, payload: Buffer.alloc(160, 0x80) }),
        port,
        "127.0.0.1",
        (err) => (err ? reject(err) : resolve())
      )
    );
    socket.close();
    await waitFor(() => client.audio.length > 0);
    expect(client.audio[0]).toEqual({ bytes: 320, rate: 8_000 });
  });
});

describe("конец разговора у ElevenLabs", () => {
  beforeEach(async () => {
    await useSettings({ liveVoiceProvider: "elevenlabs" });
  });

  it("агент сам закончил разговор — не сбой: трубка кладётся, автоответчика нет, в журнал ИИ ничего не пишется", async () => {
    const { channelId, client } = await startInbound("e-end");
    client.emit("close", { code: 1000, reason: "end_call", normal: true });
    await waitFor(() => !liveVoiceLineBusy(), { timeoutMs: 8000 });
    expect(station.continued).not.toContain(channelId);
    const row = await waitFor(async () => {
      const r = await prisma.liveVoiceSession.findFirst({ where: { channelId } });
      return r?.endedAt ? r : null;
    });
    expect(row.endedReason).toMatch(/^model_ended_call:/);
    // ElevenLabs расход не присылает; оценка по цене Gemini была бы выдуманной.
    expect(await waitForSettled(aiLogCount(channelId))).toBe(0);
  });

  it("любое другое закрытие — сбой: звонок уходит на автоответчик станции", async () => {
    const { channelId, client } = await startInbound("e-fail");
    client.emit("close", { code: 1008, reason: "invalid api key", normal: false });
    await waitFor(() => !liveVoiceLineBusy(), { timeoutMs: 4000 });
    expect(station.continued).toContain(channelId);
    const row = await waitFor(async () => {
      const r = await prisma.liveVoiceSession.findFirst({ where: { channelId } });
      return r?.endedAt ? r : null;
    });
    expect(row.endedReason).toBe("gemini_closed");
  });

  it("Google: закрытие без признака — сбой, как и раньше", async () => {
    await useSettings({ liveVoiceProvider: "google" });
    const { channelId, client } = await startInbound("g-close");
    client.emit("close");
    await waitFor(() => !liveVoiceLineBusy(), { timeoutMs: 4000 });
    expect(station.continued).toContain(channelId);
  });
});

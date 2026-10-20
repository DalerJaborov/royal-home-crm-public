import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import dgram from "node:dgram";
import { readFileSync } from "node:fs";

/**
 * АУДИТ 3, МОСТ ЖИВОГО ГОЛОСА (02.10.2026). Каждая проверка падает на коде до правки:
 *  п.2  входящий путь проверяет и ПОРТ звука, не только хост (звонок станции, паузы нет);
 *  п.1  кнопка «Проверить» не упирается в паузу «нет звука» и снимает её;
 *  п.3  замок на отправителя RTP берёт порт станции (stationRtpTarget), а не первого пришедшего;
 *       линия занята, пока станция убирает мост прошлого звонка;
 *  п.11 исключение в тике выдачи звука не убивает процесс, а сессию закрывает;
 *  п.4  перезапуск подписки ждёт набранный, но не отвеченный звонок;
 *  п.5  бюджеты остановки согласованы;
 *  п.6  failStart сначала отпускает человека, потом убирает мост;
 *  п.7  прощание сторожа тишины не обрывается раньше, чем модель его начнёт;
 *  п.8  перевод другому получателю не получает «ок» первого;
 *  п.9  повторный вызов функции получает ответ, а не молчание;
 *  п.10 отбой человека на подъёме — channel_ended, а не start_failed;
 *  п.13 сверка после переподписки не перетирает причину уже закрытой сессии;
 *  п.16 перевод не ждёт конца закрытия сессии целиком.
 */

const station = vi.hoisted(() => ({
  bridges: 0,
  lastExt: "",
  lastBridge: "",
  originated: 0,
  originateCalls: 0,
  hangups: [] as string[],
  continued: [] as string[],
  events: [] as string[],
  vars: {} as Record<string, string | null>,
  deleteBridgeDelayMs: 0,
  addGate: null as null | (() => Promise<{ ok: boolean; error?: string }>),
  onList: null as null | (() => Promise<void>),
  liveChannels: [] as unknown[],
}));

const gem = vi.hoisted(() => ({ clients: [] as FakeGemini[] }));
interface FakeGemini {
  texts: string[];
  audioChunks: number;
  closed: boolean;
  toolResponses: { id: string; response: Record<string, unknown> }[];
  resends: string[];
  emit(event: string, ...args: unknown[]): boolean;
}

const logged = vi.hoisted(() => ({ keys: [] as (string | undefined)[], messages: [] as string[] }));

vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: "http://station", username: "u", password: "p" }),
  createBridge: async () => {
    station.lastBridge = `br-${++station.bridges}`;
    return { ok: true, bridgeId: station.lastBridge };
  },
  createExternalMediaChannel: async () => {
    station.lastExt = `UnicastRTP/127.0.0.1-${station.bridges}`;
    return { ok: true, channelId: station.lastExt };
  },
  answerChannel: async () => ({ ok: true }),
  addChannelToBridge: async () => (station.addGate ? station.addGate() : { ok: true }),
  readChannelVariable: async (_c: unknown, _id: string, name: string) => station.vars[name] ?? null,
  deleteBridge: async (_creds: unknown, bridgeId: string) => {
    if (station.deleteBridgeDelayMs) await new Promise((r) => setTimeout(r, station.deleteBridgeDelayMs));
    station.events.push(`deleteBridge:${bridgeId}`);
    return { ok: true };
  },
  hangupCall: async (_creds: unknown, channelId: string) => {
    station.hangups.push(channelId);
    station.events.push(`hangup:${channelId}`);
    return { ok: true };
  },
  continueInDialplan: async (_creds: unknown, channelId: string) => {
    station.continued.push(channelId);
    station.events.push(`continue:${channelId}`);
    return { ok: true };
  },
  listActiveChannels: async () => {
    if (station.onList) await station.onList();
    return station.liveChannels;
  },
  listBridges: async () => [],
  playChannelSound: async () => ({ ok: true }),
  originateToStasisApp: async () => {
    station.originateCalls += 1;
    return { ok: true, channelId: `lv-a3-orig-${Date.now().toString(36)}-${++station.originated}` };
  },
}));

vi.mock("../src/ai/liveVoiceClient.js", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  class FakeLiveVoiceClient extends EventEmitter {
    texts: string[] = [];
    audioChunks = 0;
    closed = false;
    activeModel = "fake-live";
    toolResponses: { id: string; response: Record<string, unknown> }[] = [];
    resends: string[] = [];
    constructor() {
      super();
      gem.clients.push(this as unknown as FakeGemini);
    }
    async connect(): Promise<void> {
      this.emit("ready");
    }
    sendText(text: string): void {
      this.texts.push(text);
    }
    sendAudioChunk(): void {
      this.audioChunks += 1;
    }
    sendToolResponse(call: { id: string }, response: Record<string, unknown>): void {
      this.toolResponses.push({ id: call.id, response });
    }
    resendToolResponse(call: { id: string }): boolean {
      if (!this.toolResponses.some((r) => r.id === call.id)) return false;
      this.resends.push(call.id);
      return true;
    }
    close(): void {
      this.closed = true;
    }
  }
  return {
    ...(await importOriginal<typeof import("../src/ai/liveVoiceClient.js")>()),
    LiveVoiceClient: FakeLiveVoiceClient,
  };
});

vi.mock("../src/lib/r2Client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/r2Client.js")>()),
  isR2Configured: () => false,
}));

vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: async (_source: string, message: string, opts?: { dedupKey?: string }) => {
    logged.messages.push(String(message));
    logged.keys.push(opts?.dedupKey);
  },
}));

const { prisma } = await import("../src/db.js");
const bridge = await import("../src/lib/telephony/liveVoiceBridge.js");
const rtpConfig = await import("../src/lib/telephony/liveVoiceRtpConfig.js");
const {
  onLiveVoiceAriEvent,
  liveVoiceLineBusy,
  liveVoiceAudioPathDown,
  clearLiveVoiceAudioPathHold,
  originateLiveVoiceTestCall,
  originateLiveVoiceScenarioCall,
  startLiveVoiceListener,
  stopLiveVoiceListener,
  restartLiveVoiceListener,
  transferLiveVoiceCall,
  resyncLiveVoiceSessions,
  buildRtpPacket,
  ULAW_PAYLOAD_TYPE,
  NO_STATION_AUDIO_MS,
  NO_STATION_AUDIO_REASON,
  RTP_UNMATCHED_SOURCE_ADOPT_PACKETS,
  PACER_MAX_FAILED_TICKS,
  PROCESS_SHUTDOWN_GRACE_MS,
  LIVE_VOICE_SHUTDOWN_WAIT_MS,
  resetLiveVoiceAudioPathForTests,
} = bridge;
const { waitFor } = await import("./helpers/waitFor.js");

const runId = Date.now().toString(36);
const RTP_PORT = 43000 + Math.floor(Math.random() * 900);
const envBefore = {
  host: process.env.LIVE_VOICE_RTP_HOST,
  port: process.env.LIVE_VOICE_RTP_PORT,
  peer: process.env.LIVE_VOICE_RTP_PEER,
};
let settingsBefore: { liveVoiceEnabled: boolean; liveVoiceInboundMode: string; liveVoiceForceRussianOnly: boolean } | null = null;
let seq = 0;
const startedChannels: string[] = [];

function nextChannel(tag: string): string {
  seq += 1;
  return `lv-a3-${runId}-${tag}-${seq}`;
}

function stasisStart(channelId: string, arg = "inbound") {
  return {
    type: "StasisStart",
    application: "royalhome-live-voice",
    args: [arg],
    channel: { id: channelId, name: `SIP/out-${channelId}`, state: "Up", caller: { number: "931112233" } },
  };
}

function stasisEnd(channelId: string) {
  return { type: "StasisEnd", channel: { id: channelId, name: `SIP/out-${channelId}`, state: "Up", caller: {} } };
}

async function startInbound(tag: string): Promise<{ channelId: string; client: FakeGemini }> {
  const channelId = nextChannel(tag);
  startedChannels.push(channelId);
  await onLiveVoiceAriEvent(stasisStart(channelId) as never);
  return { channelId, client: gem.clients.at(-1)! };
}

async function endAll(): Promise<void> {
  for (const id of startedChannels.splice(0)) await onLiveVoiceAriEvent(stasisEnd(id) as never);
  await waitFor(() => !liveVoiceLineBusy(), { timeoutMs: 8000 });
}

function rtpPacket(seqNo = 1): Buffer {
  return buildRtpPacket({
    payloadType: ULAW_PAYLOAD_TYPE,
    sequenceNumber: seqNo,
    timestamp: 0,
    ssrc: 1,
    // 0xff — тихий кадр: не считается голосом звонящего (сторож тишины не сбивается).
    payload: Buffer.alloc(160, 0xff),
  });
}

async function sendRtpFrom(socket: dgram.Socket, seqNo = 1): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    socket.send(rtpPacket(seqNo), RTP_PORT, "127.0.0.1", (err) => (err ? reject(err) : resolve()))
  );
}

async function openSocket(port = 0): Promise<dgram.Socket> {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(port, "127.0.0.1", () => resolve()));
  return socket;
}

beforeAll(async () => {
  process.env.LIVE_VOICE_RTP_HOST = "127.0.0.1";
  process.env.LIVE_VOICE_RTP_PORT = String(RTP_PORT);
  delete process.env.LIVE_VOICE_RTP_PEER;
  settingsBefore = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { liveVoiceEnabled: true, liveVoiceInboundMode: true, liveVoiceForceRussianOnly: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { liveVoiceEnabled: true, liveVoiceInboundMode: "always", liveVoiceForceRussianOnly: false },
  });
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
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await prisma.liveVoiceSession.deleteMany({ where: { channelId: { startsWith: `lv-a3-${runId}` } } });
});

beforeEach(() => {
  resetLiveVoiceAudioPathForTests();
  station.hangups.length = 0;
  station.continued.length = 0;
  station.events.length = 0;
  // Станция называет адрес звука всегда: без него мост с 09.10.2026 трубку не берёт
  // (звук робота некуда слать). Порт — пустой: туда никто не шлёт и не слушает.
  station.vars = { UNICASTRTP_LOCAL_ADDRESS: "127.0.0.1", UNICASTRTP_LOCAL_PORT: "40998" };
  station.deleteBridgeDelayMs = 0;
  station.addGate = null;
  station.onList = null;
  station.liveChannels = [];
  station.originateCalls = 0;
  logged.keys.length = 0;
  logged.messages.length = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env.LIVE_VOICE_RTP_HOST = "127.0.0.1";
  process.env.LIVE_VOICE_RTP_PORT = String(RTP_PORT);
  delete process.env.LIVE_VOICE_RTP_PEER;
  await endAll();
});

describe("п.2: адрес И порт звука", () => {
  it("порт не задан — входящий консультант отдан станции без звонка в Gemini, паузы нет", async () => {
    delete process.env.LIVE_VOICE_RTP_PORT;
    const channelId = nextChannel("noport");
    const bridgesBefore = station.bridges;
    const clientsBefore = gem.clients.length;
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);

    expect(station.continued).toContain(channelId);
    expect(station.bridges).toBe(bridgesBefore);
    expect(gem.clients.length).toBe(clientsBefore);
    expect(liveVoiceAudioPathDown()).toBe(false);
    expect(logged.keys).toContain("live-voice-rtp-not-configured");
  });

  it("configuredRtpHost: хост отдаётся только вместе с портом (режим консультанта на станции)", () => {
    process.env.LIVE_VOICE_RTP_HOST = "10.9.0.1";
    delete process.env.LIVE_VOICE_RTP_PORT;
    expect(rtpConfig.configuredRtpHost()).toBeNull();
    process.env.LIVE_VOICE_RTP_PORT = "40800";
    expect(rtpConfig.configuredRtpHost()).toBe("10.9.0.1");
  });
});

describe("п.1: ручная проверка и пауза «нет звука»", () => {
  it("кнопка «Проверить» проходит мимо паузы и снимает её; сценарный звонок во время паузы по-прежнему отказывает", async () => {
    const channelId = nextChannel("deaf");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    await waitFor(() => station.continued.includes(channelId), { timeoutMs: NO_STATION_AUDIO_MS + 4_000 });
    await waitFor(() => !liveVoiceLineBusy());
    expect(liveVoiceAudioPathDown()).toBe(true);

    const scenario = await originateLiveVoiceScenarioCall("+992 93 000 81 11", { systemInstruction: "тест" });
    expect(scenario).toMatchObject({ ok: false, busy: true });

    const probe = await originateLiveVoiceTestCall("+992 93 000 81 12");
    expect(probe.ok).toBe(true);
    expect(liveVoiceAudioPathDown()).toBe(false);
    // Проба снята со станции: резерв линии освобождаем так же, как по ответу и отбою.
    startedChannels.push(probe.channelId!);
    await onLiveVoiceAriEvent(stasisStart(probe.channelId!, "x") as never);
  }, NO_STATION_AUDIO_MS + 12_000);

  it("clearLiveVoiceAudioPathHold снимает паузу и счёт", async () => {
    const channelId = nextChannel("deaf2");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    await waitFor(() => liveVoiceAudioPathDown(), { timeoutMs: NO_STATION_AUDIO_MS + 4_000 });
    clearLiveVoiceAudioPathHold();
    expect(liveVoiceAudioPathDown()).toBe(false);
  }, NO_STATION_AUDIO_MS + 10_000);
});

describe("п.3: замок на отправителя RTP", () => {
  it("запоздавший чужой кадр приходит первым — настоящая станция (порт из UNICASTRTP_LOCAL_PORT) всё равно принимается", async () => {
    const real = await openSocket();
    const stray = await openSocket();
    try {
      station.vars = {
        UNICASTRTP_LOCAL_ADDRESS: "127.0.0.1",
        UNICASTRTP_LOCAL_PORT: String(real.address().port),
      };
      const { client } = await startInbound("lock-target");
      await sendRtpFrom(stray, 1);
      await new Promise((r) => setTimeout(r, 60));
      expect(client.audioChunks).toBe(0);

      await sendRtpFrom(real, 1);
      await waitFor(() => client.audioChunks >= 1);
      const accepted = client.audioChunks;

      // Чужой после замка по-прежнему не слышен.
      await sendRtpFrom(stray, 2);
      await new Promise((r) => setTimeout(r, 60));
      expect(client.audioChunks).toBe(accepted);
    } finally {
      real.close();
      stray.close();
    }
  });

  it("порт станции не совпал (NAT) — устойчивый отправитель признаётся после RTP_UNMATCHED_SOURCE_ADOPT_PACKETS кадров", async () => {
    const sender = await openSocket();
    try {
      station.vars = { UNICASTRTP_LOCAL_ADDRESS: "127.0.0.1", UNICASTRTP_LOCAL_PORT: "1" };
      const { client } = await startInbound("lock-nat");
      for (let i = 1; i < RTP_UNMATCHED_SOURCE_ADOPT_PACKETS; i++) await sendRtpFrom(sender, i);
      await new Promise((r) => setTimeout(r, 80));
      expect(client.audioChunks).toBe(0);
      await sendRtpFrom(sender, 99);
      await waitFor(() => client.audioChunks >= 1);
      expect(logged.keys).toContain("live-voice-rtp-source-port-differs");
    } finally {
      sender.close();
    }
  });

  it("порт станции — не число: цель не создаётся, замок на первом кадре, процесс не падает", async () => {
    expect(rtpConfig.parseStationRtpTarget("127.0.0.1", "abc")).toBeNull();
    expect(rtpConfig.parseStationRtpTarget("127.0.0.1", "0")).toBeNull();
    expect(rtpConfig.parseStationRtpTarget("127.0.0.1", "70000")).toBeNull();
    expect(rtpConfig.parseStationRtpTarget("127.0.0.1", "4000")).toEqual({ address: "127.0.0.1", port: 4000 });
    expect(rtpConfig.parseStationRtpTarget("", "4000")).toBeNull();
  });

  it("линия занята, пока станция убирает мост прошлого звонка", async () => {
    const { channelId } = await startInbound("release-busy");
    station.deleteBridgeDelayMs = 400;
    const ending = onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    await new Promise((r) => setTimeout(r, 120));
    // Сессии в списке уже нет, но мост на станции ещё жив — порт занимать рано.
    expect(liveVoiceLineBusy()).toBe(true);
    await ending;
    await waitFor(() => !liveVoiceLineBusy(), { timeoutMs: 3000 });
  });
});

describe("п.11: тик выдачи звука не убивает процесс", () => {
  it("send бросает синхронно — исключение в журнал, через PACER_MAX_FAILED_TICKS подряд сессия закрыта как rtp_socket_error", async () => {
    station.vars = { UNICASTRTP_LOCAL_ADDRESS: "127.0.0.1", UNICASTRTP_LOCAL_PORT: "40999" };
    const spy = vi.spyOn(dgram.Socket.prototype, "send").mockImplementation(() => {
      throw new Error("send boom");
    });
    const { channelId } = await startInbound("pacer");
    await waitFor(() => logged.keys.includes("live-voice-pacer-tick-failed"), { timeoutMs: 2000 });
    const row = await waitFor(
      () => prisma.liveVoiceSession.findFirst({ where: { channelId, endedAt: { not: null } } }),
      { timeoutMs: 5000, label: "сессия закрыта после серии отказов" }
    );
    spy.mockRestore();
    expect(row.endedReason).toBe("rtp_socket_error");
    expect(PACER_MAX_FAILED_TICKS).toBeGreaterThan(0);
  });
});

describe("п.4: перезапуск подписки и набранный, но не отвеченный звонок", () => {
  it("restartLiveVoiceListener откладывается, пока исходящий не отвечен", async () => {
    startLiveVoiceListener();
    const log = vi.spyOn(console, "log");
    try {
      const probe = await originateLiveVoiceTestCall("+992 93 000 81 21");
      expect(probe.ok).toBe(true);
      restartLiveVoiceListener();
      expect(log.mock.calls.some((c) => String(c[0]).includes("перезапуск подписки отложен"))).toBe(true);
      startedChannels.push(probe.channelId!);
      await onLiveVoiceAriEvent(stasisStart(probe.channelId!, "x") as never);
    } finally {
      stopLiveVoiceListener();
    }
  });
});

describe("п.5: бюджеты остановки", () => {
  it("разговорам отдана часть потолка процесса; index.ts и compose не короче потолка", () => {
    expect(LIVE_VOICE_SHUTDOWN_WAIT_MS).toBeLessThan(PROCESS_SHUTDOWN_GRACE_MS);
    expect(LIVE_VOICE_SHUTDOWN_WAIT_MS).toBeGreaterThanOrEqual(10_000);
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const grace = Number(/const SHUTDOWN_GRACE_MS = ([\d_]+);/.exec(index)?.[1]?.replace(/_/g, ""));
    expect(grace).toBe(PROCESS_SHUTDOWN_GRACE_MS);
    const compose = readFileSync(new URL("../../../docker-compose.prod.yml", import.meta.url), "utf8");
    const dockerGrace = Number(/stop_grace_period: (\d+)s/.exec(compose)?.[1]) * 1000;
    expect(dockerGrace).toBeGreaterThanOrEqual(PROCESS_SHUTDOWN_GRACE_MS);
  });

  it("compose: порт по умолчанию 40800 и в пробросе, и в окружении контейнера; PEER передаётся", () => {
    const compose = readFileSync(new URL("../../../docker-compose.prod.yml", import.meta.url), "utf8");
    expect(compose).toContain("LIVE_VOICE_RTP_PORT: ${LIVE_VOICE_RTP_PORT:-40800}");
    expect(compose).toContain("LIVE_VOICE_RTP_PEER: ${LIVE_VOICE_RTP_PEER:-}");
  });
});

describe("п.6/п.10: подъём не удался", () => {
  it("failStart без сессии: человека отпускают РАНЬШЕ, чем убирают мост", async () => {
    const onFinished = vi.fn(async () => {});
    const res = await originateLiveVoiceScenarioCall("+992 93 000 81 31", { systemInstruction: "тест", onFinished });
    station.deleteBridgeDelayMs = 150;
    station.addGate = async () => ({ ok: false, error: "станция не добавила канал в мост" });
    await onLiveVoiceAriEvent(stasisStart(res.channelId!, "x") as never);

    const released = station.events.findIndex((e) => e === `hangup:${res.channelId}` || e === `continue:${res.channelId}`);
    const bridgeGone = station.events.findIndex((e) => e.startsWith("deleteBridge:"));
    expect(released).toBeGreaterThanOrEqual(0);
    expect(bridgeGone).toBeGreaterThanOrEqual(0);
    expect(released).toBeLessThan(bridgeGone);
    expect((onFinished.mock.calls[0][0] as { reason: string }).reason).toMatch(/^start_failed/);
  });

  it("человек положил трубку, пока канал добавлялся в мост — сценарий получает channel_ended, а не start_failed", async () => {
    const onFinished = vi.fn(async () => {});
    const res = await originateLiveVoiceScenarioCall("+992 93 000 81 32", { systemInstruction: "тест", onFinished });
    let waiting = false;
    let release: (value: { ok: boolean; error?: string }) => void = () => {};
    station.addGate = () =>
      new Promise((resolve) => {
        waiting = true;
        release = resolve;
      });
    const start = onLiveVoiceAriEvent(stasisStart(res.channelId!, "x") as never);
    await waitFor(() => waiting);
    await onLiveVoiceAriEvent(stasisEnd(res.channelId!) as never);
    release({ ok: false, error: "Channel not found" });
    await start;

    expect(onFinished).toHaveBeenCalledTimes(1);
    expect((onFinished.mock.calls[0][0] as { reason: string }).reason).toBe("channel_ended");
    expect(logged.keys).not.toContain("live-voice-start-failed");
  });
});

describe("п.7: прощание сторожа тишины", () => {
  it("модель ещё не начала прощаться — звонок не возвращается станции в первые 3 с после просьбы", async () => {
    const channelId = nextChannel("farewell");
    startedChannels.push(channelId);
    // Подмена часов — ДО подъёма: сторож тишины заводит свой setInterval при старте.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    // Реальное время идёт, а подменённые часы Date — нет: подгоняем их вручную, иначе
    // отсчёты моста (Date.now) разойдутся с настоящими таймерами.
    // Станция шлёт звук всё время (с 09.10.2026 пропажа кадров посреди разговора —
    // отдельный сторож): кадр на каждый шаг подменённых часов.
    const station1 = await openSocket(Number(station.vars.UNICASTRTP_LOCAL_PORT));
    let frame = 1;
    const tick = async (ms: number) => {
      await sendRtpFrom(station1, frame++);
      await new Promise((r) => setTimeout(r, 5));
      vi.advanceTimersByTime(ms);
    };
    const sleepWithClock = async (ms: number) => {
      for (let t = 0; t < ms; t += 50) {
        await sendRtpFrom(station1, frame++);
        await new Promise((r) => setTimeout(r, 50));
        vi.advanceTimersByTime(50);
      }
    };
    try {
      await onLiveVoiceAriEvent(stasisStart(channelId) as never);
      const client = gem.clients.at(-1)!;
      // Модель поздоровалась — иначе это сторож «модель молчит», а не тишина звонящего.
      client.emit("turnComplete");
      // Кадр со станции — сторож «нет звука» не вмешивается.
      // UDP может потерять первый кадр. Date уже заморожен: общий waitFor
      // здесь не имеет действующего срока. Подаём звук до готовности по
      // настоящим монотонным часам, сохраняя ограничение в две секунды.
      const audioDeadline = performance.now() + 2_000;
      while (client.audioChunks < 1 && performance.now() < audioDeadline) {
        await sendRtpFrom(station1, frame++);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(client.audioChunks).toBeGreaterThanOrEqual(1);
      for (let t = 0; t < 51_000; t += 1_000) await tick(1_000);
      expect(client.texts.some((t) => t.includes("попрощайся"))).toBe(true);
      // Раньше звонок уходил станции уже на 2,5-й секунде — до первого слова модели.
      await sleepWithClock(3_200);
      expect(station.continued).not.toContain(channelId);
      expect(liveVoiceLineBusy()).toBe(true);
      // Модель так и не заговорила — после потолка ожидания звонок всё же уходит.
      for (let i = 0; i < 80 && !station.continued.includes(channelId); i++) await sleepWithClock(100);
      expect(station.continued).toContain(channelId);
    } finally {
      vi.useRealTimers();
      station1.close();
    }
  }, 15_000);
});

describe("п.8: перевод — кому", () => {
  it("второй вызов с другим получателем получает отказ и не выполняет move; тот же получатель — исход первого", async () => {
    const { channelId } = await startInbound("transfer-who");
    const move1 = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return true;
    });
    const move2 = vi.fn(async () => true);
    const first = transferLiveVoiceCall(channelId, move1, "agent-umed");
    const other = transferLiveVoiceCall(channelId, move2, "agent-noza");
    const same = transferLiveVoiceCall(channelId, move2, "agent-umed");
    expect(await other).toBe("failed");
    expect(await first).toBe("ok");
    expect(await same).toBe("ok");
    expect(move1).toHaveBeenCalledTimes(1);
    expect(move2).not.toHaveBeenCalled();
  });

  it("п.16: итог перевода не ждёт, пока итог сценария и запись закроются целиком", async () => {
    const onFinished = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 6_000)));
    const res = await originateLiveVoiceScenarioCall("+992 93 000 81 41", { systemInstruction: "тест", onFinished });
    startedChannels.push(res.channelId!);
    await onLiveVoiceAriEvent(stasisStart(res.channelId!, "x") as never);
    const started = Date.now();
    expect(await transferLiveVoiceCall(res.channelId!, async () => true, "agent-x")).toBe("ok");
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);
});

describe("п.9: повторный вызов функции", () => {
  it("вызов уже не исполняется — модель получает повторный ответ, а не молчание", async () => {
    const { client } = await startInbound("tool-dup");
    client.emit("toolCall", [{ id: "t1", name: "no_such_tool", args: {} }]);
    await waitFor(() => client.toolResponses.some((r) => r.id === "t1"));
    client.emit("toolCall", [{ id: "t1", name: "no_such_tool", args: {} }]);
    await waitFor(() => client.resends.includes("t1"));
    // Исполнился один раз, ответ — повторён из кэша клиента.
    expect(client.toolResponses.filter((r) => r.id === "t1")).toHaveLength(1);
  });
});

describe("п.13: сверка после переподписки", () => {
  it("сессия закрылась сама, пока шёл запрос к станции, — её причина не перетирается", async () => {
    const channelId = nextChannel("resync");
    const row = await prisma.liveVoiceSession.create({
      data: {
        channelId,
        direction: "inbound",
        startedAt: new Date(Date.now() - 5 * 60_000),
      } as never,
    });
    station.liveChannels = [{ id: channelId, name: "x", state: "Up" }];
    station.onList = async () => {
      await prisma.liveVoiceSession.update({
        where: { id: row.id },
        data: { endedAt: new Date(), endedReason: "transferred" },
      });
    };
    await resyncLiveVoiceSessions({ url: "http://station", username: "u", password: "p" } as never);
    const after = await prisma.liveVoiceSession.findUnique({ where: { id: row.id } });
    expect(after?.endedReason).toBe("transferred");
  });
});

describe("константы", () => {
  it("NO_STATION_AUDIO_REASON по-прежнему отдаёт станции", () => {
    expect(NO_STATION_AUDIO_REASON).toBe("no_station_audio");
  });
});

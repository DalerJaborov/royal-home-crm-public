import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import dgram from "node:dgram";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";

/**
 * ЛИНИЯ РОБОТА ПЕРЕД ПЕРВЫМ КЛИЕНТОМ (09.10.2026, docs/robot-audit-2026-10-09-pipeline.md,
 * раздел «Починить до первого клиента»). Каждый тест падает на коде до правки:
 *  п.1  сироты в Stasis: сбой обработки события, отказ continue без повтора, канал без
 *       хозяина после переподписки (сверка по списку каналов станции);
 *  п.2  трубка снимается только когда Gemini готов; отказ Gemini — автоответчик без тишины;
 *       отбой во время подключения сворачивает подъём сразу;
 *  п.3  итог сессии несёт botSpoke — «робот не сказал ни слова»;
 *  п.4  звук со станции пропал посреди разговора — звонок станции;
 *  п.5  станция не назвала адрес звука — трубку не берём; «алло, не слышно» — звонок станции;
 *  п.6  модель молчит — напоминание, потом звонок станции;
 *  п.7  два отказа Gemini подряд — пауза робота;
 *  п.10 обрыв живой подписки — быстрый реконнект и запись в журнал.
 * Станция и Gemini подменены, мост настоящий: события идут через onLiveVoiceAriEvent.
 */

const station = vi.hoisted(() => ({
  log: [] as string[],
  hangups: [] as string[],
  continued: [] as string[],
  continueMode: "ok" as "ok" | "fail-twice" | "network" | "gone",
  continueCalls: 0,
  vars: true,
  liveChannels: [] as unknown[],
  ariUrl: "http://station",
  stationPort: 0,
}));

const gem = vi.hoisted(() => ({
  clients: [] as FakeGemini[],
  connectMode: "ok" as "ok" | "reject" | "deferred",
  pending: [] as (() => void)[],
}));
interface FakeGemini {
  texts: string[];
  connected: boolean;
  closed: boolean;
  emit(event: string, ...args: unknown[]): boolean;
}

const logged = vi.hoisted(() => ({ entries: [] as { message: string; key?: string }[] }));

vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: station.ariUrl, username: "u", password: "p" }),
  createBridge: async () => {
    station.log.push("bridge");
    return { ok: true, bridgeId: `br-${station.log.length}` };
  },
  createExternalMediaChannel: async () => ({ ok: true, channelId: `UnicastRTP/127.0.0.1-${station.log.length}` }),
  answerChannel: async (_c: unknown, channelId: string) => {
    station.log.push(`answer:${channelId}`);
    return { ok: true };
  },
  addChannelToBridge: async (_c: unknown, _b: string, channelId: string) => {
    station.log.push(`add:${channelId.startsWith("UnicastRTP") ? "media" : channelId}`);
    return { ok: true };
  },
  readChannelVariable: async (_c: unknown, _id: string, name: string) =>
    !station.vars ? null : name === "UNICASTRTP_LOCAL_ADDRESS" ? "127.0.0.1" : String(station.stationPort),
  deleteBridge: async () => ({ ok: true }),
  hangupCall: async (_c: unknown, channelId: string) => {
    station.hangups.push(channelId);
    return { ok: true };
  },
  continueInDialplan: async (_c: unknown, channelId: string) => {
    station.continueCalls += 1;
    if (station.continueMode === "network") return { ok: false, error: "Не удалось соединиться с Asterisk: ECONNRESET" };
    if (station.continueMode === "gone") return { ok: false, error: "HTTP 404 — Channel not found" };
    if (station.continueMode === "fail-twice" && station.continueCalls <= 2) {
      return { ok: false, error: "Не удалось соединиться с Asterisk: ETIMEDOUT" };
    }
    station.continued.push(channelId);
    return { ok: true };
  },
  listActiveChannels: async () => station.liveChannels,
  listBridges: async () => [],
  playChannelSound: async () => ({ ok: true }),
  originateToStasisApp: async () => ({ ok: true, channelId: `lv-line-orig-${Date.now()}-${station.log.length}` }),
}));

vi.mock("../src/ai/liveVoiceClient.js", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  class FakeLiveVoiceClient extends EventEmitter {
    texts: string[] = [];
    connected = false;
    closed = false;
    activeModel = "fake-live";
    asyncTools = false;
    outputSampleRateHz = 24_000;
    inputSampleRateHz = 16_000;
    constructor() {
      super();
      gem.clients.push(this as unknown as FakeGemini);
    }
    async connect(): Promise<void> {
      station.log.push("connect");
      if (gem.connectMode === "reject") throw new Error("Unexpected server response: 429");
      if (gem.connectMode === "deferred") {
        await new Promise<void>((resolve) => gem.pending.push(resolve));
      }
      if (this.closed) throw new Error("сессия закрыта до подключения");
      this.connected = true;
      station.log.push("ready");
      this.emit("ready");
    }
    sendText(text: string): void {
      station.log.push("text");
      this.texts.push(text);
    }
    sendAudioChunk(): void {}
    sendToolResponse(): void {}
    resendToolResponse(): boolean {
      return false;
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
    logged.entries.push({ message: String(message), key: opts?.dedupKey });
  },
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
const {
  onLiveVoiceAriEvent,
  liveVoiceLineBusy,
  resetLiveVoiceAudioPathForTests,
  liveVoiceGeminiPaused,
  liveVoiceAudioPathDown,
  handBackOrHangup,
  sweepStasisOrphans,
  resetStasisOrphanSweepForTests,
  isOwnerlessLiveVoiceStasisChannel,
  setLiveVoiceCallResolver,
  originateLiveVoiceScenarioCall,
  callerHelloScore,
  noBotAudioSuspected,
  modelStallStep,
  handsCallerBackToDialplan,
  buildRtpPacket,
  ULAW_PAYLOAD_TYPE,
  MODEL_STALL_NUDGE_MS,
  MODEL_STALL_END_MS,
  MODEL_STALL_NUDGE_TRIGGER,
  STATION_AUDIO_GAP_MS,
  STASIS_ORPHAN_MIN_AGE_MS,
  GEMINI_STALLED_REASON,
  NO_BOT_AUDIO_SUSPECTED_REASON,
  NO_STATION_AUDIO_REASON,
  startLiveVoiceListener,
  stopLiveVoiceListener,
  isLiveVoiceListenerConnected,
} = bridge;
const { robotHandedCallBack } = await import("../src/lib/telephony/liveVoiceConsultant.js");
const { waitFor } = await import("./helpers/waitFor.js");

const runId = Date.now().toString(36);
const RTP_PORT = 42000 + Math.floor(Math.random() * 900);
const CREDS = { url: "http://station", username: "u", password: "p" };
const envBefore = { host: process.env.LIVE_VOICE_RTP_HOST, port: process.env.LIVE_VOICE_RTP_PORT };
let settingsBefore: { liveVoiceEnabled: boolean; liveVoiceInboundMode: string; liveVoiceForceRussianOnly: boolean } | null = null;
let seq = 0;
let feeder: dgram.Socket;

function nextChannel(tag: string): string {
  seq += 1;
  return `lv-line-${runId}-${tag}-${seq}`;
}

function stasisStart(channelId: string, arg: string | null = "inbound") {
  return {
    type: "StasisStart",
    application: "royalhome-live-voice",
    args: arg ? [arg] : [],
    channel: { id: channelId, name: `SIP/out-${channelId}`, state: "Ring", caller: { number: "931112233" } },
  };
}

function stasisEnd(channelId: string) {
  return { type: "StasisEnd", channel: { id: channelId, name: `SIP/out-${channelId}`, state: "Up", caller: {} } };
}

function keys(): (string | undefined)[] {
  return logged.entries.map((e) => e.key);
}

/** Кадр звука «со станции»: тот же порт, что станция назвала в UNICASTRTP_LOCAL_PORT. */
async function sendStationFrame(n: number): Promise<void> {
  const packet = buildRtpPacket({
    payloadType: ULAW_PAYLOAD_TYPE,
    sequenceNumber: n,
    timestamp: n * 160,
    ssrc: 7,
    payload: Buffer.alloc(160, 0xff),
  });
  await new Promise<void>((resolve, reject) => feeder.send(packet, RTP_PORT, "127.0.0.1", (err) => (err ? reject(err) : resolve())));
}

beforeAll(async () => {
  feeder = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => feeder.bind(0, "127.0.0.1", () => resolve()));
  station.stationPort = (feeder.address() as AddressInfo).port;
  process.env.LIVE_VOICE_RTP_HOST = "127.0.0.1";
  process.env.LIVE_VOICE_RTP_PORT = String(RTP_PORT);
  settingsBefore = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { liveVoiceEnabled: true, liveVoiceInboundMode: true, liveVoiceForceRussianOnly: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { liveVoiceEnabled: true, liveVoiceInboundMode: "always" },
  });
});

afterAll(async () => {
  feeder.close();
  for (const [key, value] of [
    ["LIVE_VOICE_RTP_HOST", envBefore.host],
    ["LIVE_VOICE_RTP_PORT", envBefore.port],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await prisma.liveVoiceSession.deleteMany({ where: { channelId: { startsWith: `lv-line-${runId}` } } });
  await prisma.liveVoiceSession.deleteMany({ where: { channelId: { startsWith: "lv-line-orig-" } } });
});

beforeEach(() => {
  resetLiveVoiceAudioPathForTests();
  resetStasisOrphanSweepForTests();
  setLiveVoiceCallResolver(null);
  station.log.length = 0;
  station.hangups.length = 0;
  station.continued.length = 0;
  station.continueMode = "ok";
  station.continueCalls = 0;
  station.vars = true;
  station.liveChannels = [];
  station.ariUrl = "http://station";
  gem.connectMode = "ok";
  gem.pending.length = 0;
  logged.entries.length = 0;
});

describe("п.2: трубка — только когда Gemini готов", () => {
  it("пока Gemini подключается, канал не отвечен (гудки); ответ и приветствие — после ready", async () => {
    gem.connectMode = "deferred";
    const channelId = nextChannel("ready");
    const started = onLiveVoiceAriEvent(stasisStart(channelId) as never);
    await waitFor(() => gem.pending.length > 0 && station.log.includes("bridge"), { label: "подключение началось" });
    // Станция поднимается параллельно, но трубку не снимаем — человек слышит гудки, а не тишину.
    expect(station.log).not.toContain(`answer:${channelId}`);
    gem.pending.shift()!();
    await started;
    const ready = station.log.indexOf("ready");
    const answer = station.log.indexOf(`answer:${channelId}`);
    const addCaller = station.log.indexOf(`add:${channelId}`);
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(answer).toBeGreaterThan(ready);
    expect(addCaller).toBeGreaterThan(answer);
    // Приветствие заказывается сразу после готовности модели, ДО снятия трубки (09.10.2026,
    // исследование С2): звук ложится в очередь и звучит с первым тиком пейсера, уже в снятую
    // трубку (live-voice-speed-understanding-09-10: ни кадра в неотвеченный канал).
    const text = station.log.indexOf("text");
    expect(text).toBeGreaterThan(ready);
    expect(text).toBeLessThan(answer);
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    expect(liveVoiceLineBusy()).toBe(false);
  });

  it("Gemini отказал — трубку не брали, звонок сразу станции (автоответчик без тишины)", async () => {
    gem.connectMode = "reject";
    const channelId = nextChannel("reject");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    expect(station.log).not.toContain(`answer:${channelId}`);
    expect(station.continued).toContain(channelId);
    expect(station.hangups).not.toContain(channelId);
    expect(liveVoiceLineBusy()).toBe(false);
  });

  it("человек положил трубку, пока Gemini подключается, — подъём свёрнут сразу, линия свободна", async () => {
    gem.connectMode = "deferred";
    const channelId = nextChannel("gone");
    const started = onLiveVoiceAriEvent(stasisStart(channelId) as never);
    await waitFor(() => gem.pending.length > 0, { label: "подключение началось" });
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    // Раньше линия была занята до конца подключения (до 25 с) и каждый следующий шёл на автоответчик.
    await waitFor(() => !liveVoiceLineBusy(), { timeoutMs: 1_000, label: "линия свободна" });
    expect(gem.clients.at(-1)!.closed).toBe(true);
    gem.pending.shift()!();
    await started;
    expect(station.log).not.toContain(`answer:${channelId}`);
  });
});

describe("п.5: звук робота некуда слать", () => {
  it("станция не назвала UNICASTRTP_LOCAL_ADDRESS/PORT — трубку не берём, звонок станции", async () => {
    station.vars = false;
    const channelId = nextChannel("novars");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    expect(station.log).not.toContain(`answer:${channelId}`);
    expect(station.continued).toContain(channelId);
    expect(keys()).toContain("live-voice-no-unicastrtp");
    expect(liveVoiceLineBusy()).toBe(false);
  });

  it("«алло, не слышно» без слов по делу — подозрение, что робота не слышно", () => {
    expect(callerHelloScore("Алло? Алло, вас не слышно!")).toMatchObject({ hellos: 3, content: 0 });
    // Кусками без пробелов («Ал»+«ло») — всё равно «алло».
    expect(callerHelloScore("Аллоалло")).toMatchObject({ hellos: 2, content: 0 });
    expect(callerHelloScore("Алло, да, здравствуйте, я по квартире")).toMatchObject({ content: 3 });
    expect(noBotAudioSuspected("Алло? Алло?", 19_000)).toBe(false);
    expect(noBotAudioSuspected("Алло? Алло?", 20_000)).toBe(true);
    expect(noBotAudioSuspected("Алло. Алло. Говорите!", 10_000)).toBe(true);
    expect(noBotAudioSuspected("Алло, здравствуйте", 25_000)).toBe(false);
    expect(handsCallerBackToDialplan(NO_BOT_AUDIO_SUSPECTED_REASON)).toBe(true);
    expect(robotHandedCallBack(NO_BOT_AUDIO_SUSPECTED_REASON)).toBe(true);
  });
});

describe("п.6: модель молчит", () => {
  it("чистая функция: напомнить через 10 с, закончить ещё через 6 с; бот говорит или идёт функция — ждать", () => {
    const base = { awaitingSince: 0, nudgedAt: null, toolRunning: false, botBusy: false };
    expect(modelStallStep(base, MODEL_STALL_NUDGE_MS - 1)).toBeNull();
    expect(modelStallStep(base, MODEL_STALL_NUDGE_MS)).toBe("nudge");
    expect(modelStallStep({ ...base, toolRunning: true }, 60_000)).toBeNull();
    expect(modelStallStep({ ...base, botBusy: true }, 60_000)).toBeNull();
    expect(modelStallStep({ ...base, awaitingSince: null }, 60_000)).toBeNull();
    expect(modelStallStep({ ...base, nudgedAt: 10_000 }, 10_000 + MODEL_STALL_END_MS - 1)).toBeNull();
    expect(modelStallStep({ ...base, nudgedAt: 10_000 }, 10_000 + MODEL_STALL_END_MS)).toBe("end");
    expect(robotHandedCallBack(GEMINI_STALLED_REASON)).toBe(true);
  });

  it("человек сказал, модель молчит — напоминание, потом звонок станции и запись в журнал", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const channelId = nextChannel("stall");
    try {
      await onLiveVoiceAriEvent(stasisStart(channelId) as never);
      const client = gem.clients.at(-1)!;
      client.emit("transcript", { role: "user", text: "Здравствуйте, я ищу квартиру" });
      vi.advanceTimersByTime(MODEL_STALL_NUDGE_MS + 1_000);
      expect(client.texts).toContain(MODEL_STALL_NUDGE_TRIGGER);
      expect(station.continued).not.toContain(channelId);
      vi.advanceTimersByTime(MODEL_STALL_END_MS + 1_000);
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => station.continued.includes(channelId), { label: "звонок отдан станции" });
    expect(station.hangups).not.toContain(channelId);
    expect(keys()).toContain("live-voice-gemini-stalled");
    const row = await waitFor(
      () => prisma.liveVoiceSession.findFirst({ where: { channelId, endedAt: { not: null } } }),
      { label: "сессия закрыта" }
    );
    expect(row.endedReason).toBe(GEMINI_STALLED_REASON);
  });

  it("модель ответила — сторож молчит", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const channelId = nextChannel("answers");
    try {
      await onLiveVoiceAriEvent(stasisStart(channelId) as never);
      const client = gem.clients.at(-1)!;
      client.emit("transcript", { role: "user", text: "Здравствуйте" });
      vi.advanceTimersByTime(3_000);
      client.emit("turnComplete");
      vi.advanceTimersByTime(MODEL_STALL_NUDGE_MS + MODEL_STALL_END_MS + 2_000);
      expect(client.texts).not.toContain(MODEL_STALL_NUDGE_TRIGGER);
    } finally {
      vi.useRealTimers();
    }
    expect(station.continued).not.toContain(channelId);
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
  });
});

describe("п.4: звук со станции пропал посреди разговора", () => {
  it("кадры шли и перестали — через STATION_AUDIO_GAP_MS звонок станции, робот на паузе", async () => {
    const channelId = nextChannel("gap");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    for (let i = 0; i < 25; i++) {
      await sendStationFrame(i);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(station.continued).not.toContain(channelId);
    await waitFor(() => station.continued.includes(channelId), {
      timeoutMs: STATION_AUDIO_GAP_MS + 3_000,
      label: "звонок отдан станции",
    });
    const row = await waitFor(
      () => prisma.liveVoiceSession.findFirst({ where: { channelId, endedAt: { not: null } } }),
      { label: "сессия закрыта" }
    );
    expect(row.endedReason).toBe(NO_STATION_AUDIO_REASON);
    expect(liveVoiceAudioPathDown()).toBe(true);
    expect(logged.entries.some((e) => e.message.includes("посреди разговора"))).toBe(true);
  }, 15_000);
});

describe("п.3: итог сессии знает, сказал ли робот хоть слово", () => {
  it("робот не говорил — botSpoke=false в итоге сценария", async () => {
    const onFinished = vi.fn(async () => {});
    const res = await originateLiveVoiceScenarioCall("+992 93 000 81 01", { systemInstruction: "тест", onFinished });
    expect(res.ok).toBe(true);
    await onLiveVoiceAriEvent(stasisStart(res.channelId!, null) as never);
    await onLiveVoiceAriEvent(stasisEnd(res.channelId!) as never);
    await waitFor(() => onFinished.mock.calls.length > 0, { label: "итог" });
    expect(onFinished.mock.calls[0][0]).toMatchObject({ botSpoke: false });
  });
});

describe("п.7: выключатель «Gemini отказывает»", () => {
  it("два отказа подряд — пауза: следующий входящий сразу станции, Gemini даже не открывается", async () => {
    gem.connectMode = "reject";
    await onLiveVoiceAriEvent(stasisStart(nextChannel("q1")) as never);
    expect(liveVoiceGeminiPaused()).toBe(false);
    await onLiveVoiceAriEvent(stasisStart(nextChannel("q2")) as never);
    expect(liveVoiceGeminiPaused()).toBe(true);
    expect(keys()).toContain("live-voice-gemini-paused");

    const third = nextChannel("q3");
    const clientsBefore = gem.clients.length;
    await onLiveVoiceAriEvent(stasisStart(third) as never);
    expect(gem.clients.length).toBe(clientsBefore);
    expect(station.continued).toContain(third);
    expect(station.log).not.toContain(`answer:${third}`);
    // Сценарный звонок не набирается: «занято», без потери попытки.
    expect(await originateLiveVoiceScenarioCall("+992 93 000 81 02", { systemInstruction: "тест" })).toMatchObject({
      ok: false,
      busy: true,
    });
  });

  it("один отказ, потом удачный звонок — счёт сброшен, паузы нет", async () => {
    gem.connectMode = "reject";
    await onLiveVoiceAriEvent(stasisStart(nextChannel("r1")) as never);
    gem.connectMode = "ok";
    const ok = nextChannel("r2");
    await onLiveVoiceAriEvent(stasisStart(ok) as never);
    await onLiveVoiceAriEvent(stasisEnd(ok) as never);
    gem.connectMode = "reject";
    await onLiveVoiceAriEvent(stasisStart(nextChannel("r3")) as never);
    expect(liveVoiceGeminiPaused()).toBe(false);
  });
});

describe("п.1: сироты в Stasis", () => {
  it("сбой обработки события до подъёма сессии — канал отдан станции, а не брошен в гудках", async () => {
    setLiveVoiceCallResolver(() => {
      throw new Error("задание сломалось синхронно");
    });
    const channelId = nextChannel("throw");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    expect(station.continued).toContain(channelId);
    expect(keys()).toContain("live-voice-event-failed");
    expect(liveVoiceLineBusy()).toBe(false);
  });

  it("handBackOrHangup: сеть моргнула дважды — третья попытка отдаёт звонок", async () => {
    station.continueMode = "fail-twice";
    expect(await handBackOrHangup(CREDS, "lv-hb-1", "тест")).toBe("handed_back");
    expect(station.continueCalls).toBe(3);
    expect(station.hangups).not.toContain("lv-hb-1");
  });

  it("handBackOrHangup: станция не принимает continue — трубка положена, одна запись в журнале", async () => {
    station.continueMode = "network";
    expect(await handBackOrHangup(CREDS, "lv-hb-2", "тест")).toBe("hung_up");
    expect(station.hangups).toContain("lv-hb-2");
    expect(keys()).toContain("live-voice-handback-failed");
  });

  it("handBackOrHangup: канала уже нет (404) — трубку НЕ кладём, повторов нет", async () => {
    station.continueMode = "gone";
    expect(await handBackOrHangup(CREDS, "lv-hb-3", "тест")).toBe("gone");
    expect(station.continueCalls).toBe(1);
    expect(station.hangups).not.toContain("lv-hb-3");
  });

  it("сверка по каналам станции: сирота старше порога — станции (входящий) или отбой (наш), остальное не трогаем", async () => {
    const stasis = (id: string, appData: string, name = `SIP/out-${id}`) => ({
      id,
      name,
      state: "Up",
      caller: {},
      dialplan: { app_name: "Stasis", app_data: appData },
    });
    const inbound = `lv-orph-in-${runId}`;
    const ours = `lv-orph-out-${runId}`;
    station.liveChannels = [
      stasis(inbound, "royalhome-live-voice,inbound"),
      stasis(ours, "royalhome-live-voice"),
      stasis(`lv-orph-rtp-${runId}`, "royalhome-live-voice", "UnicastRTP/127.0.0.1:4000-0x1"),
      stasis(`lv-orph-main-${runId}`, "royal-home-crm"),
      { id: `lv-orph-dial-${runId}`, name: "SIP/1044-1", state: "Up", caller: {}, dialplan: { app_name: "Dial", app_data: "SIP/1044" } },
    ];
    const now = Date.now();
    // Первый взгляд — только запомнить: StasisStart мог быть ещё в пути.
    expect(await sweepStasisOrphans(now)).toMatchObject({ found: 0 });
    expect(station.continued).toHaveLength(0);
    const second = await sweepStasisOrphans(now + STASIS_ORPHAN_MIN_AGE_MS + 1);
    expect(second).toMatchObject({ found: 2, handedBack: 1, hungUp: 1 });
    expect(station.continued).toEqual([inbound]);
    expect(station.hangups).toEqual([ours]);
    expect(keys()).toContain("live-voice-stasis-orphans");
  });

  it("канал с идущей сессией сиротой не считается", () => {
    const ch = { id: "x1", name: "SIP/x1", state: "Up", caller: {}, dialplan: { app_name: "Stasis", app_data: "royalhome-live-voice,inbound" } };
    expect(isOwnerlessLiveVoiceStasisChannel(ch as never, new Set())).toBe(true);
    expect(isOwnerlessLiveVoiceStasisChannel(ch as never, new Set(["x1"]))).toBe(false);
  });
});

describe("п.10: живая подписка ARI", () => {
  it("обрыв подписки, жившей дольше 5 с, — переподключение почти сразу и запись в журнал", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const connections: number[] = [];
    server.on("connection", (socket) => {
      connections.push(Date.now());
      socket.on("error", () => {});
    });
    station.ariUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      startLiveVoiceListener();
      await waitFor(() => isLiveVoiceListenerConnected(), { timeoutMs: 5_000, label: "подписка открыта" });
      await new Promise((resolve) => setTimeout(resolve, 5_300));
      const droppedAt = Date.now();
      for (const client of server.clients) client.terminate();
      await waitFor(() => connections.length >= 2, { timeoutMs: 3_000, label: "переподключение" });
      // Раньше — фиксированные 5 с, всё это время звонки шли мимо робота.
      expect(connections[1] - droppedAt).toBeLessThan(2_000);
      expect(keys()).toContain("live-voice-subscription-down");
    } finally {
      stopLiveVoiceListener();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});

/**
 * ВРЕЗКИ СТОРОЖЕЙ В МОСТ (09.10.2026, «Отложено в мост» из
 * docs/journal/2026-10-09-robot-guards-and-callbacks.md): по расшифровке видно, откуда
 * робот взял цену; находка «вне подборки» — в расшифровку и поправкой модели; таджикский
 * при замке «только русский» — извинение не на первом слове, на упорство — человек.
 */
describe("врезки сторожей в мост", () => {
  async function sessionRow(channelId: string) {
    return waitFor(() => prisma.liveVoiceSession.findFirst({ where: { channelId, endedAt: { not: null } } }), {
      label: "сессия закрыта",
    });
  }

  it("ответ функции поиска — строкой в расшифровку (номера объектов, без цен)", async () => {
    setLiveVoiceCallResolver(async () => ({
      systemInstruction: "роль консультанта",
      onToolCall: async () => ({ response: { ok: true, found: 2, options: [{ number: 12 }, { number: 40 }] } }),
    }));
    const channelId = nextChannel("tool");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    gem.clients.at(-1)!.emit("toolCall", [{ id: "fc-1", name: "search_properties", args: {} }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    expect((await sessionRow(channelId)).transcript).toContain("[функция search_properties: найдено 2, номера 12, 40]");
  });

  it("цена вне подборки — строка сторожа в расшифровке и поправка модели (не больше двух за звонок)", async () => {
    const channelId = nextChannel("offcat");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    const client = gem.clients.at(-1)!;
    const before = client.texts.length;
    for (const price of ["897", "950", "990"]) {
      client.emit("transcript", { role: "model", text: `Есть двушка на улице Ломоносова за ${price} тыс. сомони.` });
      client.emit("turnComplete");
    }
    const corrections = client.texts.slice(before).filter((t) => t.startsWith("(Служебное"));
    expect(corrections).toHaveLength(2);
    const entry = logged.entries.find((e) => e.key === "live-voice-off-catalog-claim");
    expect(entry?.message).toContain("Робот назвал вне подборки");
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    expect((await sessionRow(channelId)).transcript).toContain("[сторож: вне подборки:");
  });

  describe("таджикский при замке «только русский»", () => {
    beforeAll(async () => {
      voiceTuning.forceRussianOnly = true;
    });
    afterAll(async () => {
      voiceTuning.forceRussianOnly = false;
    });
    const apologized = (texts: string[]) => texts.some((t) => t.includes("фразу-извинение на таджикском"));

    it("одно короткое таджикское слово — без извинения; вторая таджикская реплика — извинение", async () => {
      const channelId = nextChannel("tg-short");
      await onLiveVoiceAriEvent(stasisStart(channelId) as never);
      const client = gem.clients.at(-1)!;
      client.emit("transcript", { role: "user", text: "Ҳа, хуб" });
      expect(apologized(client.texts)).toBe(false);
      client.emit("turnComplete");
      client.emit("transcript", { role: "user", text: "Ҳа, ман" });
      expect(apologized(client.texts)).toBe(true);
      await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    });

    it("длинная таджикская реплика — извинение сразу; две таджикские после него — эскалация и прощание по-таджикски", async () => {
      const channelId = nextChannel("tg-long");
      await onLiveVoiceAriEvent(stasisStart(channelId) as never);
      const client = gem.clients.at(-1)!;
      client.emit("transcript", { role: "user", text: "Ман хона мехоҳам дар маркази шаҳр" });
      expect(apologized(client.texts)).toBe(true);
      client.emit("turnComplete");
      client.emit("transcript", { role: "user", text: "Нархаш чанд аст ҳамин хона?" });
      expect(client.texts.some((t) => t.includes("ПО-ТАДЖИКСКИ"))).toBe(false);
      client.emit("turnComplete");
      client.emit("transcript", { role: "user", text: "Ман русӣ намедонам, бародар" });
      expect(client.texts.some((t) => t.includes("ПО-ТАДЖИКСКИ"))).toBe(true);
      const row = await waitFor(() => prisma.liveVoiceSession.findFirst({ where: { channelId, endedAt: { not: null } } }), {
        timeoutMs: 10_000,
        label: "звонок завершён эскалацией",
      });
      expect(row.endedReason).toContain("escalate_to_human");
      expect(row.transcript).toContain("только по-таджикски");
    }, 15_000);
  });

  it("прощание сторожа тишины — на языке разговора, если замка нет", () => {
    expect(bridge.noSpeechFarewellTrigger(true, true)).toContain("по-русски");
    expect(bridge.noSpeechFarewellTrigger(true, false)).toContain("на том языке, на котором идёт разговор");
  });
});

/**
 * ТАДЖИКСКИЙ В ПРИОРИТЕТЕ И РАЗРЫВ ПЕТЛИ «ПЛОХО СЛЫШНО» В МОСТУ (10.10.2026, реальные звонки:
 * расшифровка таджикской речи — арабская вязь и латиница с ş ğ ı, робот переспрашивал по
 * кругу, клиент уходил). Расшифровки обезличены. Чистая логика — live-voice-tajik-first.test.ts.
 */
describe("10.10: язык звонящего и петля «плохо слышно» в мосту", () => {
  const URDU = "میں آپ کو بتا رہا ہوں گھر چاہیے سینو میں";
  const SPANISH_ITALIAN = "Hola quiero una casa per favore molto bene grazie";
  const REPROMPTS = ["Простите, плохо слышно, повторите, пожалуйста?", "Не расслышала, ещё раз?", "Алло, прервалось, повторите?"];
  const consultantTask = (language: "ru" | "tg") => async () => ({ systemInstruction: "роль консультанта", language });

  async function sessionRow(channelId: string) {
    return waitFor(() => prisma.liveVoiceSession.findFirst({ where: { channelId, endedAt: { not: null } } }), { label: "сессия закрыта" });
  }

  it("мусор (урду) и переспросы: на третьем ходу — вопрос о языке, не «повторите»; после третьего переспроса — перезвон и строка для задачи", async () => {
    setLiveVoiceCallResolver(consultantTask("tg"));
    const channelId = nextChannel("poorline");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    const client = gem.clients.at(-1)!;
    client.emit("turnComplete"); // приветствие
    for (let turn = 0; turn < 2; turn++) {
      client.emit("transcript", { role: "user", text: URDU });
      client.emit("transcript", { role: "model", text: REPROMPTS[turn] });
      client.emit("turnComplete");
    }
    client.emit("transcript", { role: "user", text: URDU });
    expect(client.texts.at(-1)).toContain("Тоҷикӣ ё русӣ");
    expect(client.texts.at(-1)).toContain("третий раз повторить НЕ проси");
    client.emit("transcript", { role: "model", text: "Тоҷикӣ ё русӣ — бо кадом забон гап занем? На каком языке вам удобнее?" });
    client.emit("turnComplete");
    client.emit("transcript", { role: "user", text: URDU });
    client.emit("transcript", { role: "model", text: REPROMPTS[2] });
    client.emit("turnComplete");
    client.emit("transcript", { role: "user", text: URDU });
    const last = client.texts.at(-1)!;
    expect(last).toContain("Мо ба ҳамин рақам занг мезанем");
    expect(last).toContain("Мы перезвоним на этот номер");
    expect(last).toContain("Повторить больше НЕ проси");
    // Урду — не сигнал языка ни в какую сторону.
    expect(client.texts.some((t) => t.includes("человек говорит по-"))).toBe(false);
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    const row = await sessionRow(channelId);
    expect(row.transcript).toContain("[плохая слышимость]");
    expect(row.transcript).toContain("язык: не определён");
  });

  it("звонок владельца 15:59: русская речь, записанная немецким/португальским, — язык не меняется, «плохо слышно» не копится, никаких поправок", async () => {
    setLiveVoiceCallResolver(consultantTask("tg"));
    const channelId = nextChannel("owner-ru");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    const client = gem.clients.at(-1)!;
    client.emit("turnComplete");
    const before = client.texts.length;
    const answers = ["Наш офис в центре, на Рудаки. Подсказать, как доехать?", "Да, в субботу работаем до пяти."];
    ["am 20 Uhr", "Was hast du denn heute"].forEach((garbage, i) => {
      client.emit("transcript", { role: "user", text: garbage });
      client.emit("transcript", { role: "model", text: answers[i] });
      client.emit("turnComplete");
    });
    client.emit("transcript", { role: "user", text: "Não, é para o próximo mês" });
    // Ни перехода на язык, ни вопроса о языке (две неясные реплики — ещё не повод), ни перезвона.
    expect(client.texts.slice(before)).toEqual([]);
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    expect((await sessionRow(channelId)).transcript).not.toContain("[плохая слышимость]");
  });

  it("испанский/итальянский мусор: после двух переспросов — вопрос «тоҷикӣ ё русӣ», после третьего — перезвон", async () => {
    setLiveVoiceCallResolver(consultantTask("tg"));
    const channelId = nextChannel("poorline-ask");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    const client = gem.clients.at(-1)!;
    client.emit("turnComplete");
    for (let turn = 0; turn < 2; turn++) {
      client.emit("transcript", { role: "user", text: SPANISH_ITALIAN });
      client.emit("transcript", { role: "model", text: REPROMPTS[turn] });
      client.emit("turnComplete");
    }
    client.emit("transcript", { role: "user", text: SPANISH_ITALIAN });
    expect(client.texts.at(-1)).toContain("Тоҷикӣ ё русӣ");
    client.emit("transcript", { role: "model", text: "Тоҷикӣ ё русӣ — бо кадом забон гап занем? На каком языке вам удобнее?" });
    client.emit("turnComplete");
    client.emit("transcript", { role: "user", text: SPANISH_ITALIAN });
    client.emit("transcript", { role: "model", text: REPROMPTS[2] });
    client.emit("turnComplete");
    client.emit("transcript", { role: "user", text: SPANISH_ITALIAN });
    expect(client.texts.at(-1)).toContain("Мы перезвоним на этот номер");
    // Мусор языка не меняет: на русский не переключались.
    expect(client.texts.some((t) => t.includes("человек говорит по-русски"))).toBe(false);
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
  });

  it("одна русская реплика — язык не меняется; вторая подряд — модели велено перейти на русский", async () => {
    setLiveVoiceCallResolver(consultantTask("tg"));
    const channelId = nextChannel("lang-ru");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    const client = gem.clients.at(-1)!;
    client.emit("turnComplete");
    const switched = () => client.texts.some((t) => t.includes("человек говорит по-русски"));
    client.emit("transcript", { role: "user", text: "Мне нужна квартира в Сино" });
    expect(switched()).toBe(false);
    client.emit("turnComplete");
    client.emit("transcript", { role: "user", text: "Сколько стоит двушка, скажите" });
    expect(switched()).toBe(true);
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    expect((await sessionRow(channelId)).transcript).toContain("[язык] звонящий говорит по-русски");
  });

  describe("замок «только русский» — как раньше", () => {
    beforeAll(async () => {
      voiceTuning.forceRussianOnly = true;
    });
    afterAll(async () => {
      voiceTuning.forceRussianOnly = false;
    });

    it("никаких служебных реплик о языке; петля «плохо слышно» рвётся перезвоном только по-русски", async () => {
      setLiveVoiceCallResolver(consultantTask("ru"));
      const channelId = nextChannel("lock-poorline");
      await onLiveVoiceAriEvent(stasisStart(channelId) as never);
      const client = gem.clients.at(-1)!;
      client.emit("turnComplete");
      // Мусорная латиница русской речи (10.10.2026): замок больше не принимает её за
      // таджикский — без таджикского извинения и без передачи «говорит только по-таджикски».
      for (let turn = 0; turn < 2; turn++) {
        client.emit("transcript", { role: "user", text: SPANISH_ITALIAN });
        client.emit("transcript", { role: "model", text: REPROMPTS[turn] });
        client.emit("turnComplete");
      }
      expect(client.texts.some((t) => t.includes("фразу-извинение на таджикском"))).toBe(false);
      client.emit("transcript", { role: "user", text: SPANISH_ITALIAN });
      const last = client.texts.at(-1)!;
      expect(last).toContain("Мы перезвоним на этот номер");
      expect(last).not.toMatch(/[ҳҷӣӯқғ]/u);
      expect(client.texts.some((t) => t.includes("Тоҷикӣ ё русӣ") || t.includes("человек говорит по-"))).toBe(false);
      await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    });
  });
});

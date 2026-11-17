import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import dgram from "node:dgram";
import type { AddressInfo } from "node:net";

/**
 * РОБОТ: БЫСТРЕЕ И ПОНЯТЛИВЕЕ (09.10.2026, docs/robot-upgrade-speed-understanding-2026-10-09.md,
 * «быстрые выигрыши»). Каждый тест падает на коде до правки:
 *  - приветствие заказывается сразу после готовности модели, до снятия трубки (С2), и звучит
 *    с первым тиком пейсера — первое слово не ждёт генерации после ответа;
 *  - строка журнала сессии не держит снятие трубки (С3), итог её дожидается;
 *  - замеры звонка строкой «[метрики] …» в конце расшифровки (П8);
 *  - подъём частоты 8→16 кГц с памятью между кадрами (С8);
 *  - клиент перебивает доигрывающий хвост реплики — хвост сброшен (С7), приветствие — нет;
 *  - узбек/англоязычный — прощание на его языке и передача человеку, а не сброс (П2);
 *  - подсказки распознаванию только за флагом (П1); правило коротких реплик (П5).
 * Станция и Gemini подменены, мост настоящий: события идут через onLiveVoiceAriEvent.
 */

const station = vi.hoisted(() => ({
  log: [] as string[],
  answerDelayMs: 0,
  stationPort: 0,
}));

const gem = vi.hoisted(() => ({
  clients: [] as FakeGemini[],
  /** Модель «здоровается» звуком через столько мс после служебной реплики; null — молчит. */
  greetAfterMs: null as number | null,
  greetAudioMs: 100,
}));
interface FakeGemini {
  texts: string[];
  audioIn: Buffer[];
  emit(event: string, ...args: unknown[]): boolean;
}

vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: "http://station", username: "u", password: "p" }),
  createBridge: async () => ({ ok: true, bridgeId: `br-speed-${Date.now()}-${Math.random()}` }),
  createExternalMediaChannel: async () => ({ ok: true, channelId: `UnicastRTP/127.0.0.1-${Math.random()}` }),
  answerChannel: async (_c: unknown, channelId: string) => {
    if (station.answerDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, station.answerDelayMs));
    station.log.push(`answer:${channelId}`);
    return { ok: true };
  },
  addChannelToBridge: async (_c: unknown, _b: string, channelId: string) => {
    station.log.push(`add:${channelId.startsWith("UnicastRTP") ? "media" : channelId}`);
    return { ok: true };
  },
  readChannelVariable: async (_c: unknown, _id: string, name: string) =>
    name === "UNICASTRTP_LOCAL_ADDRESS" ? "127.0.0.1" : String(station.stationPort),
  deleteBridge: async () => ({ ok: true }),
  hangupCall: async () => ({ ok: true }),
  continueInDialplan: async () => ({ ok: true }),
  listActiveChannels: async () => [],
  listBridges: async () => [],
  playChannelSound: async () => ({ ok: true }),
}));

vi.mock("../src/ai/liveVoiceClient.js", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  class FakeLiveVoiceClient extends EventEmitter {
    texts: string[] = [];
    audioIn: Buffer[] = [];
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
      this.connected = true;
      station.log.push("ready");
      this.emit("ready");
    }
    sendText(text: string): void {
      station.log.push("text");
      this.texts.push(text);
      if (gem.greetAfterMs !== null && this.texts.length === 1) {
        setTimeout(() => {
          if (this.closed) return;
          this.emit("audio", speech24k(gem.greetAudioMs));
          this.emit("turnComplete");
        }, gem.greetAfterMs);
      }
    }
    sendAudioChunk(buf: Buffer): void {
      this.audioIn.push(buf);
    }
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
  logSystemError: async () => {},
}));

/** Громкая речь модели: синус 300 Гц на 24 кГц, little-endian. */
function speech24k(ms: number): Buffer {
  const n = Math.round((ms / 1000) * 24_000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 300 * i) / 24_000)), i * 2);
  return buf;
}

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
  resetLiveVoiceAudioPathForTests,
  resetStasisOrphanSweepForTests,
  setLiveVoiceCallResolver,
  buildRtpPacket,
  parseRtpPacket,
  ULAW_PAYLOAD_TYPE,
  ulawEncode,
  ulawDecode,
  LOCAL_BARGE_IN_FRAMES,
} = bridge;
const { StreamingInterpolator, createLineToModelInterpolator, resamplePcm16, designLowPassFir } = await import(
  "../src/lib/telephony/pcmCodec.js"
);
const { LiveVoiceReplyGuard, detectForeignCallerLanguage } = await import("../src/lib/telephony/liveVoiceGuards.js");
const { LiveVoiceMetricsTracker } = await import("../src/lib/telephony/liveVoiceMetrics.js");
const { buildLiveVoiceSetupMessage } = await import("../src/ai/liveVoiceClient.js");
const { CONSULTANT_TAIL_RULES } = await import("../src/ai/liveVoiceConsultantPersona.js");
const { LIVE_VOICE_METRICS_LINE_PREFIX, mergeTranscriptFragments } = await import("@royal-home/shared");
const scriptMetrics = await import("../../../scripts/robot-call-metrics.mjs");
const { waitFor } = await import("./helpers/waitFor.js");

const runId = Date.now().toString(36);
const RTP_PORT = 43000 + Math.floor(Math.random() * 900);
const envBefore = { host: process.env.LIVE_VOICE_RTP_HOST, port: process.env.LIVE_VOICE_RTP_PORT, hints: process.env.LIVE_VOICE_TRANSCRIBE_HINTS };
let settingsBefore: { liveVoiceEnabled: boolean; liveVoiceInboundMode: string; liveVoiceForceRussianOnly: boolean } | null = null;
let seq = 0;
let feeder: dgram.Socket;
/** Когда «станция» получила от моста кадр речи бота (не тишину). */
const speechPackets: number[] = [];
let rtpSeq = 0;
let stream: ReturnType<typeof setInterval> | null = null;

function nextChannel(tag: string): string {
  seq += 1;
  return `lv-speed-${runId}-${tag}-${seq}`;
}
function stasisStart(channelId: string) {
  return {
    type: "StasisStart",
    application: "royalhome-live-voice",
    args: ["inbound"],
    channel: { id: channelId, name: `SIP/out-${channelId}`, state: "Ring", caller: { number: "931112233" } },
  };
}
function stasisEnd(channelId: string) {
  return { type: "StasisEnd", channel: { id: channelId, name: `SIP/out-${channelId}`, state: "Up", caller: {} } };
}

const LOUD = ulawEncode(new Int16Array(160).fill(8000));
const SILENCE = Buffer.alloc(160, 0xff);

async function sendStation(payload: Buffer): Promise<void> {
  rtpSeq += 1;
  const packet = buildRtpPacket({ payloadType: ULAW_PAYLOAD_TYPE, sequenceNumber: rtpSeq & 0xffff, timestamp: rtpSeq * 160, ssrc: 7, payload });
  await new Promise<void>((resolve, reject) => feeder.send(packet, RTP_PORT, "127.0.0.1", (err) => (err ? reject(err) : resolve())));
}

/** Тихая речь: энергия 200 — ниже прежнего порога VAD 400 (тихий абонент, замер 10.10). */
const QUIET = ulawEncode(new Int16Array(160).fill(200));

/** Станция шлёт кадр каждые 20 мс: тишину или, пока burst > 0, речь (по умолчанию громкую). */
const streamState = { burst: 0, payload: LOUD, silenceDelayMs: 0, silenceAfter: 0 };
function startStationStream(): void {
  stream = setInterval(() => {
    const loud = streamState.burst > 0;
    if (loud) {
      streamState.burst -= 1;
      if (streamState.burst === 0) streamState.silenceAfter = Date.now() + streamState.silenceDelayMs;
    } else if (Date.now() < streamState.silenceAfter) {
      // Имитируем задержку входящих UDP-кадров, не подменяя часы/код моста.
      return;
    }
    void sendStation(loud ? streamState.payload : SILENCE).catch(() => {});
  }, 20);
}
async function speak(frames: number, payload: Buffer = LOUD): Promise<void> {
  streamState.payload = payload;
  streamState.burst = frames;
  await waitFor(() => streamState.burst === 0, { label: "человек договорил" });
}

async function sessionRow(channelId: string) {
  return waitFor(() => prisma.liveVoiceSession.findFirst({ where: { channelId, endedAt: { not: null } } }), {
    label: "сессия закрыта",
    timeoutMs: 15_000,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  feeder = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => feeder.bind(0, "127.0.0.1", () => resolve()));
  station.stationPort = (feeder.address() as AddressInfo).port;
  feeder.on("message", (msg) => {
    const p = parseRtpPacket(msg);
    if (p && p.payload.some((b) => b !== 0xff && b !== 0x7f)) speechPackets.push(Date.now());
  });
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
    ["LIVE_VOICE_TRANSCRIBE_HINTS", envBefore.hints],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await prisma.liveVoiceSession.deleteMany({ where: { channelId: { startsWith: `lv-speed-${runId}` } } });
});

beforeEach(() => {
  resetLiveVoiceAudioPathForTests();
  resetStasisOrphanSweepForTests();
  setLiveVoiceCallResolver(null);
  station.log.length = 0;
  station.answerDelayMs = 0;
  gem.greetAfterMs = null;
  gem.greetAudioMs = 100;
  speechPackets.length = 0;
  streamState.burst = 0;
  streamState.silenceDelayMs = 0;
  streamState.silenceAfter = 0;
});

afterEach(() => {
  if (stream) clearInterval(stream);
  stream = null;
  vi.restoreAllMocks();
});

describe("С2: приветствие заказывается до снятия трубки", () => {
  it("служебная реплика уходит сразу после готовности модели, а звук — только после моста", async () => {
    gem.greetAfterMs = 0;
    const channelId = nextChannel("order");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    await waitFor(() => speechPackets.length > 0, { label: "первое слово бота в линии" });
    const ready = station.log.indexOf("ready");
    const text = station.log.indexOf("text");
    const answer = station.log.indexOf(`answer:${channelId}`);
    const add = station.log.indexOf(`add:${channelId}`);
    expect(text).toBeGreaterThan(ready);
    expect(text).toBeLessThan(answer);
    expect(add).toBeGreaterThan(answer);
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
  });

  it("модель генерирует, пока снимается трубка: первое слово — без задержки генерации после ответа", async () => {
    // Снятие трубки и генерация первого слова занимают по 400 мс. Раньше они шли друг за
    // другом (первое слово ≥ 400 мс после ответа), теперь параллельно.
    station.answerDelayMs = 400;
    gem.greetAfterMs = 400;
    const channelId = nextChannel("first-word");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    await waitFor(() => speechPackets.length > 0, { label: "первое слово" });
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    const row = await sessionRow(channelId);
    const m = scriptMetrics.parseCallMetrics(row.transcript);
    expect(m).not.toBeNull();
    expect(m.firstWordMs).toBeLessThan(250);
    expect(m.answerMs).toBeGreaterThanOrEqual(400);
    expect(m.readyMs).not.toBeNull();
  });
});

describe("С3: строка журнала не держит трубку", () => {
  it("медленная запись строки — трубку снимаем, итог дожидается строки и пишется", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delegate = prisma.liveVoiceSession;
    const realCreate = delegate.create.bind(delegate);
    vi.spyOn(delegate, "create").mockImplementation(((args: Parameters<typeof realCreate>[0]) =>
      gate.then(() => realCreate(args))) as never);
    const channelId = nextChannel("row");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    expect(station.log).toContain(`answer:${channelId}`);
    expect(await prisma.liveVoiceSession.findFirst({ where: { channelId } })).toBeNull();
    // Человек положил трубку раньше, чем строка записалась: итог обязан её дождаться.
    const ended = onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    await sleep(300);
    release();
    await ended;
    const row = await sessionRow(channelId);
    expect(row.endedReason).toBe("channel_ended");
    expect(row.transcript).toContain(LIVE_VOICE_METRICS_LINE_PREFIX);
  });
});

describe("П8: замеры звонка", () => {
  it.each([0, 500])("подъём, первое слово, пауза хода и перебивание — строкой в конце расшифровки (задержка UDP %i мс)", async (silenceDelayMs) => {
    const speechEnd = vi.spyOn(LiveVoiceMetricsTracker.prototype, "onClientSpeechEnd");
    streamState.silenceDelayMs = silenceDelayMs;
    gem.greetAfterMs = 0;
    const channelId = nextChannel("metrics");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    startStationStream();
    const client = gem.clients.at(-1)!;
    await waitFor(() => speechPackets.length > 0, { label: "приветствие" });
    await sleep(300); // приветствие доиграло
    // Счётчик feeder означает отправку, а не обработку UDP мостом. Модель
    // отвечает после настоящего VAD-события; spy вызывает оригинал, не подменяет метрики.
    await speak(15);
    await waitFor(() => speechEnd.mock.calls.length === 1, { label: "мост зарегистрировал конец речи" });
    await sleep(300);
    client.emit("audio", speech24k(1_500));
    const before = speechPackets.length;
    await waitFor(() => speechPackets.length > before, { label: "ответ в линии" });
    // Человек заговорил поверх ответа.
    await speak(3);
    await sleep(100);
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    const row = await sessionRow(channelId);
    const lines = row.transcript!.split("\n");
    expect(lines.at(-1)!.startsWith(LIVE_VOICE_METRICS_LINE_PREFIX)).toBe(true);
    const m = scriptMetrics.parseCallMetrics(row.transcript);
    expect(m.v).toBe(1);
    expect(m.turnGapsMs).toHaveLength(1);
    expect(m.turnGapsMs[0]).toBeGreaterThanOrEqual(250);
    expect(m.turnGapsMs[0]).toBeLessThan(1_500);
    expect(m.bargeIns).toBe(1);
    // Людям на экране строка замеров не показывается.
    expect(mergeTranscriptFragments(row.transcript!)).not.toContain(LIVE_VOICE_METRICS_LINE_PREFIX);
  }, 20_000);

  it.each([0, 500])("тихий абонент (ниже прежних 400): конец реплики виден по порогу от шумового пола (10.10, задержка UDP %i мс)", async (silenceDelayMs) => {
    const speechEnd = vi.spyOn(LiveVoiceMetricsTracker.prototype, "onClientSpeechEnd");
    streamState.silenceDelayMs = silenceDelayMs;
    gem.greetAfterMs = 0;
    const channelId = nextChannel("quiet");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    startStationStream();
    const client = gem.clients.at(-1)!;
    await waitFor(() => speechPackets.length > 0, { label: "приветствие" });
    await sleep(1_500); // приветствие доиграло, пол линии набран (1 с тишины бота)
    await speak(15, QUIET);
    await waitFor(() => speechEnd.mock.calls.length === 1, { label: "мост зарегистрировал конец тихой речи" });
    await sleep(300);
    client.emit("audio", speech24k(300));
    const before = speechPackets.length;
    await waitFor(() => speechPackets.length > before, { label: "ответ в линии" });
    await sleep(100);
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    const m = scriptMetrics.parseCallMetrics((await sessionRow(channelId)).transcript);
    expect(m.echoAdaptive).toBe(true);
    expect(m.vadThreshold).toBeLessThan(200);
    expect(m.noiseFloor).toBe(0);
    // Прежний VAD (400) этой реплики не видел: пауза хода не считалась вовсе.
    expect(m.turnGapsMs).toHaveLength(1);
    expect(typeof m.echoFramesLegacy).toBe("number");
  }, 20_000);

  it("разбор звонков читает тот же формат и считает сводку", () => {
    expect(scriptMetrics.METRICS_LINE_PREFIX).toBe(LIVE_VOICE_METRICS_LINE_PREFIX);
    const t = (m: object) => `Бот: Здравствуйте\n${LIVE_VOICE_METRICS_LINE_PREFIX}${JSON.stringify(m)}`;
    const a = scriptMetrics.parseCallMetrics(t({ v: 1, readyMs: 2000, firstWordMs: 300, turnGapsMs: [800, 1200], bargeIns: 1, talkOverMs: [200] }));
    const b = scriptMetrics.parseCallMetrics(t({ v: 1, readyMs: 2400, firstWordMs: 500, turnGapsMs: [1000, 2000], bargeIns: 1, talkOverMs: [900] }));
    const s = scriptMetrics.summarizeCallMetrics([a, b, scriptMetrics.parseCallMetrics("Бот: старый звонок")]);
    expect(s).toMatchObject({ calls: 2, turns: 4, turnGapAvgMs: 1250, turnGapP50Ms: 1000, turnGapP90Ms: 2000, bargeIns: 2 });
    expect(s.bargeInPerTurnPct).toBe(50);
    expect(s.bargeInQuickStopPct).toBe(50);
    expect(scriptMetrics.stripCallMetrics(t({ v: 1 }))).toBe("Бот: Здравствуйте");
  });
});

describe("С8: подъём частоты 8→16 кГц с памятью между кадрами", () => {
  const sine8k = (n: number, hz: number, amp = 8000) =>
    Int16Array.from({ length: n }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * hz * i) / 8000)));
  /** Мощность частоты hz в сигнале (Гёрцель). */
  function power(x: Int16Array, hz: number, rate: number): number {
    const w = (2 * Math.PI * hz) / rate;
    let s1 = 0;
    let s2 = 0;
    for (const v of x) {
      const s = v + 2 * Math.cos(w) * s1 - s2;
      s2 = s1;
      s1 = s;
    }
    return s1 * s1 + s2 * s2 - 2 * Math.cos(w) * s1 * s2;
  }

  it("кадры по 20 мс дают ровно тот же звук, что весь сигнал разом (нет щелчков на стыках)", () => {
    const x = sine8k(1600, 440);
    const whole = createLineToModelInterpolator().process(x);
    const up = createLineToModelInterpolator();
    const parts: number[] = [];
    for (let i = 0; i < x.length; i += 160) parts.push(...up.process(x.subarray(i, i + 160)));
    expect(Int16Array.from(parts)).toEqual(whole);
    // Старый путь — ступенька на каждом стыке: последний отсчёт кадра повторяется.
    const old: number[] = [];
    for (let i = 0; i < x.length; i += 160) old.push(...resamplePcm16(x.subarray(i, i + 160), 8000, 16000));
    // Излом (вторая разность) на стыках кадров против изломов внутри кадров: у гладкой
    // синусоиды они одного порядка, у ступеньки на стыке — заметно больше.
    const seamRatio = (y: ArrayLike<number>) => {
      let seams = 0;
      let inner = 0;
      for (let k = 2; k < y.length; k++) {
        const d = Math.abs(y[k] - 2 * y[k - 1] + y[k - 2]);
        if (k % 320 <= 1) seams = Math.max(seams, d);
        else inner = Math.max(inner, d);
      }
      return seams / inner;
    };
    expect(seamRatio(parts)).toBeLessThan(1.1);
    expect(seamRatio(old)).toBeGreaterThan(1.5);
  });

  it("частота 1 кГц проходит, её зеркало на 7 кГц давится больше чем на 30 дБ", () => {
    const y = createLineToModelInterpolator().process(sine8k(1600, 1000));
    const signal = power(y.subarray(200), 1000, 16000);
    const image = power(y.subarray(200), 7000, 16000);
    expect(10 * Math.log10(signal / image)).toBeGreaterThan(30);
    // Усиление на полосе пропускания — единичное (громкость голоса не меняется).
    const peak = Math.max(...Array.from(y.subarray(200)).map(Math.abs));
    expect(peak).toBeGreaterThan(7600);
    expect(peak).toBeLessThan(8400);
    expect(() => new StreamingInterpolator(0, designLowPassFir(3, 1000, 8000))).toThrow();
  });

  it("мост шлёт модели звук через потоковый интерполятор, а не покадровый пересчёт", async () => {
    const channelId = nextChannel("upsample");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    const client = gem.clients.at(-1)!;
    const x = sine8k(160 * 20, 440, 4000);
    const payloads: Buffer[] = [];
    for (let i = 0; i < x.length; i += 160) {
      const payload = ulawEncode(x.subarray(i, i + 160));
      payloads.push(payload);
      await sendStation(payload);
    }
    await waitFor(() => client.audioIn.length >= 20, { label: "звук дошёл до модели" });
    const got = Buffer.concat(client.audioIn.slice(0, 20));
    const expected = createLineToModelInterpolator().process(ulawDecode(Buffer.concat(payloads)));
    expect(got.length).toBe(expected.length * 2);
    for (let i = 0; i < expected.length; i++) expect(got.readInt16LE(i * 2)).toBe(expected[i]);
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
  });
});

describe("С7: человек перебивает доигрывающий хвост реплики", () => {
  it(`громкая речь ${LOCAL_BARGE_IN_FRAMES} кадров поверх хвоста после turnComplete — хвост сброшен`, async () => {
    gem.greetAfterMs = 0;
    const channelId = nextChannel("barge");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    startStationStream();
    const client = gem.clients.at(-1)!;
    await waitFor(() => speechPackets.length > 0, { label: "приветствие" });
    await sleep(300);
    // Модель сгенерировала 3 с ответа разом и закончила ход: для неё перебивать уже нечего.
    client.emit("audio", speech24k(3_000));
    client.emit("turnComplete");
    const before = speechPackets.length;
    await waitFor(() => speechPackets.length > before + 5, { label: "ответ звучит" });
    await speak(LOCAL_BARGE_IN_FRAMES + 2);
    await sleep(150);
    const afterBarge = speechPackets.length;
    await sleep(400);
    // Хвост (ещё ~2 с) больше не звучит.
    expect(speechPackets.length - afterBarge).toBeLessThanOrEqual(2);
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    const m = scriptMetrics.parseCallMetrics((await sessionRow(channelId)).transcript);
    expect(m.localBargeIns).toBe(1);
    expect(m.talkOverMs[0]).toBeLessThan(1_000);
  }, 20_000);

  it("приветствие человек не обрывает своим «алло»", async () => {
    gem.greetAfterMs = 0;
    gem.greetAudioMs = 2_000;
    const channelId = nextChannel("greet-safe");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    startStationStream();
    await waitFor(() => speechPackets.length > 5, { label: "приветствие звучит" });
    await speak(LOCAL_BARGE_IN_FRAMES + 2);
    const afterHello = speechPackets.length;
    await sleep(400);
    expect(speechPackets.length - afterHello).toBeGreaterThan(10);
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    const m = scriptMetrics.parseCallMetrics((await sessionRow(channelId)).transcript);
    expect(m.localBargeIns).toBe(0);
  }, 20_000);
});

describe("П2: сторож языка — узбек и англоязычный не сбрасываются", () => {
  it("определитель: приметы узбекского и английского, мусор и кириллица — не узнаны", () => {
    expect(detectForeignCallerLanguage("Assalomu alaykum, menga uch xonali kvartira kerak, narxi qancha?")).toBe("uz");
    expect(detectForeignCallerLanguage("Hello, I am looking for an apartment to rent, how much is it?")).toBe("en");
    expect(detectForeignCallerLanguage("Здравствуйте, ищу квартиру в Сино")).toBeNull();
    expect(detectForeignCallerLanguage("Kumbaya sentro lindo mercado")).toBeNull();
  });

  it("находка сторожа несёт язык звонящего", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru" });
    g.addClientText("Assalomu alaykum, menga kvartira kerak, narxi qancha?");
    g.onModelText("Assalomu alaykum! Sizga qanday kvartira kerak?");
    g.onTurnComplete();
    const second = g.onModelText("Albatta, bizda yaxshi variantlar bor, qaysi tumanda?");
    expect(second[0]).toMatchObject({ kind: "wrong_language", endCall: true, callerLanguage: "uz" });
  });

  it("мост: прощание по-узбекски и передача человеку с причиной «язык: узбекский»", async () => {
    const channelId = nextChannel("uz");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    const client = gem.clients.at(-1)!;
    client.emit("transcript", { role: "user", text: "Assalomu alaykum, menga kvartira kerak, narxi qancha?" });
    client.emit("transcript", { role: "model", text: "Assalomu alaykum! Sizga qanday kvartira kerak?" });
    client.emit("turnComplete");
    client.emit("transcript", { role: "model", text: "Albatta, bizda yaxshi variantlar bor, qaysi tumanda?" });
    expect(client.texts.some((t) => t.includes("ПО-УЗБЕКСКИ"))).toBe(true);
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    const row = await sessionRow(channelId);
    expect(row.transcript).toContain("[эскалация к оператору] язык: узбекский");
  });
});

describe("П1 и П5: подсказки распознаванию и короткие реплики", () => {
  // 11.10.2026: подсказка языка включена по умолчанию (замер на записях прода), словарь —
  // отдельным флагом LIVE_VOICE_TRANSCRIBE_VOCAB=1 (подробно: live-voice-transcribe-hints-11-10).
  it("подсказка языка — по умолчанию tg+ru; =0 — прежний {}; словарь мест — только с LIVE_VOICE_TRANSCRIBE_VOCAB=1", () => {
    const tx = () =>
      (buildLiveVoiceSetupMessage({ systemInstruction: "x" }).setup as {
        inputAudioTranscription: { languageCodes?: string[]; customVocabulary?: string[] };
      }).inputAudioTranscription;
    const vocabBefore = process.env.LIVE_VOICE_TRANSCRIBE_VOCAB;
    delete process.env.LIVE_VOICE_TRANSCRIBE_HINTS;
    delete process.env.LIVE_VOICE_TRANSCRIBE_VOCAB;
    try {
      expect(tx()).toEqual({ languageCodes: ["tg-TJ", "ru-RU"] });
      process.env.LIVE_VOICE_TRANSCRIBE_HINTS = "0";
      expect(tx()).toEqual({});
      delete process.env.LIVE_VOICE_TRANSCRIBE_HINTS;
      process.env.LIVE_VOICE_TRANSCRIBE_VOCAB = "1";
      expect(tx().languageCodes).toEqual(["tg-TJ", "ru-RU"]);
      expect(tx().customVocabulary).toEqual(expect.arrayContaining(["Royal Home", "Сино", "Профсоюз", "Мехргон"]));
      expect(tx().customVocabulary!.length).toBeLessThanOrEqual(100);
    } finally {
      delete process.env.LIVE_VOICE_TRANSCRIBE_HINTS;
      if (vocabBefore === undefined) delete process.env.LIVE_VOICE_TRANSCRIBE_VOCAB;
      else process.env.LIVE_VOICE_TRANSCRIBE_VOCAB = vocabBefore;
    }
  });

  it("в хвосте промта консультанта — не длиннее двух коротких предложений за ход", () => {
    expect(CONSULTANT_TAIL_RULES).toContain("не длиннее двух коротких предложений");
    expect(CONSULTANT_TAIL_RULES).toContain("сначала суть");
  });
});

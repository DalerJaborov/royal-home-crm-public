import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import dgram from "node:dgram";

/**
 * ЖИЗНЕННЫЙ ЦИКЛ РОБОЗВОНКА (02.10.2026, аудит надёжности: В1, В2, В5, В6, В7, В17,
 * Г21, функции модели). Каждая проверка здесь падает на коде до правки:
 *  - подъём упал или завис — сценарий узнаёт `start_failed`, человек отпущен;
 *  - завершение сессии идёт до конца, даже если база/станция отказали;
 *  - отказ отбоя и моста — в журнал и в уборщика, сироты по списку станции снимаются;
 *  - второй перевод не снимает отметку «переведён» после первого;
 *  - второй StasisStart на тот же канал не трогает первую сессию;
 *  - исключение в слушателе Gemini не вылетает наружу;
 *  - функции модели: потолок времени, один ответ на id, отмена, save_contact;
 *  - звук принимается только от станции;
 *  - звонок не набирается без адреса звука.
 *
 * Станция, Gemini, R2 подменены; мост настоящий, события идут через
 * onLiveVoiceAriEvent тем же путём, что из подписки ARI.
 */

const station = vi.hoisted(() => ({
  bridges: 0,
  lastExt: "",
  lastBridge: "",
  originated: 0,
  originateCalls: 0,
  hangups: [] as string[],
  hangupsOk: [] as string[],
  deletedBridges: [] as string[],
  continued: [] as string[],
  hangupFails: false,
  createBridgeFails: false,
  deleteBridgeFails: false,
  credsFail: false,
  liveChannels: [] as unknown[],
  bridgeList: [] as unknown[],
  /** Порт, с которого «станция» шлёт звук (UNICASTRTP_LOCAL_PORT). */
  rtpPort: 44000 + Math.floor(Math.random() * 900),
}));

const gem = vi.hoisted(() => ({
  clients: [] as FakeGemini[],
  connectMode: "ok" as "ok" | "reject" | "hang",
  connects: 0,
}));
interface FakeGemini {
  texts: string[];
  audioChunks: number;
  closed: boolean;
  toolResponses: { id: string; response: Record<string, unknown>; scheduling?: string }[];
  emit(event: string, ...args: unknown[]): boolean;
}

const logged = vi.hoisted(() => ({ messages: [] as string[], keys: [] as (string | undefined)[] }));
const callbacks = vi.hoisted(() => ({ requests: [] as Record<string, unknown>[] }));

vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => {
    if (station.credsFail) throw new Error("база недоступна");
    return { url: "http://station", username: "u", password: "p" };
  },
  createBridge: async () => {
    if (station.createBridgeFails) return { ok: false, error: "станция не создала мост" };
    station.lastBridge = `br-${++station.bridges}`;
    return { ok: true, bridgeId: station.lastBridge };
  },
  createExternalMediaChannel: async () => {
    station.lastExt = `UnicastRTP/127.0.0.1-${station.bridges}`;
    return { ok: true, channelId: station.lastExt };
  },
  answerChannel: async () => ({ ok: true }),
  addChannelToBridge: async () => ({ ok: true }),
  readChannelVariable: async (_c: unknown, _id: string, name: string) =>
    // Станция называет адрес звука всегда (без него мост с 09.10.2026 трубку не берёт).
    name === "UNICASTRTP_LOCAL_ADDRESS" ? "127.0.0.1" : name === "UNICASTRTP_LOCAL_PORT" ? String(station.rtpPort) : null,
  deleteBridge: async (_creds: unknown, bridgeId: string) => {
    if (station.deleteBridgeFails) return { ok: false, error: "станция не ответила" };
    station.deletedBridges.push(bridgeId);
    return { ok: true };
  },
  hangupCall: async (_creds: unknown, channelId: string) => {
    station.hangups.push(channelId);
    if (station.hangupFails) return { ok: false, error: "станция не ответила" };
    station.hangupsOk.push(channelId);
    return { ok: true };
  },
  continueInDialplan: async (_creds: unknown, channelId: string) => {
    station.continued.push(channelId);
    return { ok: true };
  },
  listActiveChannels: async () => station.liveChannels,
  listBridges: async () => station.bridgeList,
  playChannelSound: async () => ({ ok: true }),
  originateToStasisApp: async () => {
    station.originateCalls += 1;
    return { ok: true, channelId: `lv-life-orig-${Date.now().toString(36)}-${++station.originated}` };
  },
}));

vi.mock("../src/ai/liveVoiceClient.js", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  class FakeLiveVoiceClient extends EventEmitter {
    texts: string[] = [];
    audioChunks = 0;
    closed = false;
    activeModel = "fake-live";
    toolResponses: { id: string; response: Record<string, unknown>; scheduling?: string }[] = [];
    constructor() {
      super();
      gem.clients.push(this as unknown as FakeGemini);
    }
    async connect(): Promise<void> {
      gem.connects += 1;
      if (gem.connectMode === "reject") throw new Error("Gemini недоступен");
      if (gem.connectMode === "hang") return new Promise<void>(() => {});
      if (this.closed) throw new Error("сессия закрыта до подключения");
      this.emit("ready");
    }
    sendText(text: string): void {
      this.texts.push(text);
    }
    sendAudioChunk(): void {
      this.audioChunks += 1;
    }
    sendToolResponse(call: { id: string }, response: Record<string, unknown>, scheduling?: string): void {
      this.toolResponses.push({ id: call.id, response, scheduling });
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

vi.mock("../src/lib/callbackRequests.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/callbackRequests.js")>()),
  recordCallbackRequest: async (input: Record<string, unknown>) => {
    callbacks.requests.push(input);
  },
}));

const { prisma } = await import("../src/db.js");
const bridge = await import("../src/lib/telephony/liveVoiceBridge.js");
const {
  onLiveVoiceAriEvent,
  liveVoiceLineBusy,
  originateLiveVoiceScenarioCall,
  originateLiveVoiceTestCall,
  startLiveVoiceListener,
  stopLiveVoiceListener,
  restartLiveVoiceListener,
  setLiveVoiceCallResolver,
  transferLiveVoiceCall,
  sweepLiveVoiceStationLeftovers,
  buildRtpPacket,
  ULAW_PAYLOAD_TYPE,
  LIVE_VOICE_CONNECT_TIMEOUT_MS,
  LIVE_VOICE_TOOL_TIMEOUT_MS,
  LIVE_VOICE_TRANSFER_TOOL_TIMEOUT_MS,
  LIVE_VOICE_ORPHAN_AGE_MS,
  resetLiveVoiceAudioPathForTests,
} = bridge;
const { waitFor } = await import("./helpers/waitFor.js");

const runId = Date.now().toString(36);
const RTP_PORT = 42000 + Math.floor(Math.random() * 900);
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
  return `lv-life-${runId}-${tag}-${seq}`;
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

/** Входящая сессия поднята: возвращает канал и её (подменённый) клиент Gemini. */
async function startInbound(tag: string): Promise<{ channelId: string; client: FakeGemini }> {
  const channelId = nextChannel(tag);
  startedChannels.push(channelId);
  await onLiveVoiceAriEvent(stasisStart(channelId) as never);
  return { channelId, client: gem.clients.at(-1)! };
}

async function endAll(): Promise<void> {
  for (const id of startedChannels.splice(0)) await onLiveVoiceAriEvent(stasisEnd(id) as never);
  await waitFor(() => !liveVoiceLineBusy());
}

function rtpPacket(seqNo = 1): Buffer {
  return buildRtpPacket({
    payloadType: ULAW_PAYLOAD_TYPE,
    sequenceNumber: seqNo,
    timestamp: 0,
    ssrc: 1,
    payload: Buffer.alloc(160, 0x80),
  });
}

/** Отправить RTP-пакет в порт моста с заданного локального порта (0 — любого). */
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
  setLiveVoiceCallResolver(null);
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await prisma.liveVoiceSession.deleteMany({ where: { channelId: { startsWith: `lv-life-${runId}` } } });
});

beforeEach(() => {
  resetLiveVoiceAudioPathForTests();
  station.hangups.length = 0;
  station.hangupsOk.length = 0;
  station.deletedBridges.length = 0;
  station.continued.length = 0;
  station.hangupFails = false;
  station.createBridgeFails = false;
  station.deleteBridgeFails = false;
  station.credsFail = false;
  station.liveChannels = [];
  station.bridgeList = [];
  station.originateCalls = 0;
  gem.connectMode = "ok";
  logged.messages.length = 0;
  logged.keys.length = 0;
  callbacks.requests.length = 0;
  setLiveVoiceCallResolver(null);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.LIVE_VOICE_RTP_PEER;
  process.env.LIVE_VOICE_RTP_HOST = "127.0.0.1";
  process.env.LIVE_VOICE_RTP_PORT = String(RTP_PORT);
  await endAll();
});

/** Пока условие не выполнится: опрос через setImmediate (его фальшивые таймеры не трогают). */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("не дождались условия");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("В1/В17: подъём сессии не удался", () => {
  it("Gemini не подключился — сценарий получает start_failed, человек отпущен, линия свободна", async () => {
    const onFinished = vi.fn(async () => {});
    const res = await originateLiveVoiceScenarioCall("+992 93 000 71 01", { systemInstruction: "тест", onFinished });
    expect(res.ok).toBe(true);
    gem.connectMode = "reject";
    await onLiveVoiceAriEvent(stasisStart(res.channelId!, "x") as never);

    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished.mock.calls[0][0]).toMatchObject({ channelId: res.channelId, clientSpoke: false });
    expect((onFinished.mock.calls[0][0] as { reason: string }).reason).toMatch(/^start_failed/);
    // Человек, снявший трубку, не остаётся в Stasis без хозяина.
    expect(station.hangups).toContain(res.channelId);
    expect(liveVoiceLineBusy()).toBe(false);
  });

  it("станция не создала мост (сбой ДО появления сессии) — сценарий получает start_failed, человек отпущен", async () => {
    const onFinished = vi.fn(async () => {});
    const res = await originateLiveVoiceScenarioCall("+992 93 000 71 03", { systemInstruction: "тест", onFinished });
    station.createBridgeFails = true;
    await onLiveVoiceAriEvent(stasisStart(res.channelId!, "x") as never);

    // Раньше этот путь отпускал человека, но сценарий не узнавал ничего и ждал 20 минут.
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect((onFinished.mock.calls[0][0] as { reason: string }).reason).toMatch(/^start_failed/);
    expect(station.hangups).toContain(res.channelId);
    expect(liveVoiceLineBusy()).toBe(false);
  });

  it("подъём завис — через потолок сторож отпускает человека и сообщает сценарию (В17)", async () => {
    const onFinished = vi.fn(async () => {});
    const res = await originateLiveVoiceScenarioCall("+992 93 000 71 02", { systemInstruction: "тест", onFinished });
    gem.connectMode = "hang";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const connectsBefore = gem.connects;
    const started = onLiveVoiceAriEvent(stasisStart(res.channelId!, "x") as never);
    // Подъём дошёл до подключения к Gemini и завис там (мост и канал звука созданы).
    await until(() => gem.connects > connectsBefore);
    expect(onFinished).not.toHaveBeenCalled();
    // Станция звук присылает (путь звука жив) — виснет именно Gemini, а не станция.
    const feeder = await openSocket();
    await sendRtpFrom(feeder, 1);
    feeder.close();
    await new Promise((resolve) => setImmediate(resolve));

    await vi.advanceTimersByTimeAsync(LIVE_VOICE_CONNECT_TIMEOUT_MS + 500);
    await started;
    vi.useRealTimers();

    expect(onFinished).toHaveBeenCalledTimes(1);
    expect((onFinished.mock.calls[0][0] as { reason: string }).reason).toMatch(/^start_failed/);
    expect(station.hangups).toContain(res.channelId);
    // Мост и канал звука, созданные до зависания, убраны.
    expect(station.deletedBridges).toContain(station.lastBridge);
    expect(liveVoiceLineBusy()).toBe(false);
    // Следующий звонок поднимается нормально, а не уходит на автоответчик.
    gem.connectMode = "ok";
    const next = await startInbound("after-hang");
    expect(next.client.closed).toBe(false);
    expect(liveVoiceLineBusy()).toBe(true);
  });

  it("база с кредами отказала на подъёме — канал отпускается по последним известным кредам", async () => {
    // Прогрев: хоть один удачный разговор запоминает креды.
    const warm = await startInbound("warm");
    await onLiveVoiceAriEvent(stasisEnd(warm.channelId) as never);
    await waitFor(() => !liveVoiceLineBusy());
    station.hangups.length = 0;
    station.continued.length = 0;

    station.credsFail = true;
    gem.connectMode = "reject";
    const channelId = nextChannel("nocreds");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    // Входящий со станции — назад в диалплан (автоответчик), а не молчание в мосте.
    expect(station.continued).toContain(channelId);
    expect(liveVoiceLineBusy()).toBe(false);
  });
});

describe("В2: завершение сессии доходит до конца", () => {
  it("база не отвечает на выходе — отбой, мост и итог сценарию всё равно выполняются", async () => {
    const onFinished = vi.fn(async () => {});
    const res = await originateLiveVoiceScenarioCall("+992 93 000 72 01", { systemInstruction: "тест", onFinished });
    await onLiveVoiceAriEvent(stasisStart(res.channelId!, "x") as never);
    expect(liveVoiceLineBusy()).toBe(true);
    const ext = station.lastExt;
    const br = station.lastBridge;

    station.credsFail = true;
    await onLiveVoiceAriEvent(stasisEnd(res.channelId!) as never);

    // Раньше функция отклонялась на чтении кредов: ни отбоя, ни итога.
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(station.hangupsOk).toContain(ext);
    expect(station.deletedBridges).toContain(br);
    expect(liveVoiceLineBusy()).toBe(false);
  });

  it("отказ hangup/deleteBridge попадает в журнал и повторяется уборщиком", async () => {
    const { channelId } = await startInbound("cleanup");
    const ext = station.lastExt;
    const br = station.lastBridge;

    station.hangupFails = true;
    station.deleteBridgeFails = true;
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    await waitFor(() => logged.keys.includes("live-voice-cleanup-bridge") && logged.keys.includes("live-voice-cleanup-channel"));
    expect(station.hangupsOk).not.toContain(ext);

    station.hangupFails = false;
    station.deleteBridgeFails = false;
    const swept = await sweepLiveVoiceStationLeftovers();
    expect(swept.retried).toBeGreaterThanOrEqual(2);
    expect(station.hangupsOk).toContain(ext);
    expect(station.deletedBridges).toContain(br);
  });

  it("уборщик снимает канал звука старше потолка сессии и его мост, живые сессии не трогает", async () => {
    const now = Date.now();
    const old = new Date(now - LIVE_VOICE_ORPHAN_AGE_MS - 60_000).toISOString();
    station.liveChannels = [
      { id: "UnicastRTP/orphan-old", name: "UnicastRTP/10.9.0.1-0000aa", state: "Up", creationtime: old },
      { id: "UnicastRTP/orphan-fresh", name: "UnicastRTP/10.9.0.1-0000bb", state: "Up", creationtime: new Date(now).toISOString() },
      { id: "SIP/old-human", name: "SIP/old-human-0001", state: "Up", creationtime: old },
    ];
    station.bridgeList = [
      { id: "br-orphan", channels: ["UnicastRTP/orphan-old", "SIP/old-human"] },
      { id: "br-unrelated", channels: ["SIP/other"] },
    ];
    const swept = await sweepLiveVoiceStationLeftovers(now);
    expect(swept).toMatchObject({ channelsHungUp: 1, bridgesDeleted: 1 });
    expect(station.hangupsOk).toEqual(["UnicastRTP/orphan-old"]);
    expect(station.deletedBridges).toEqual(["br-orphan"]);
  });

  it("уборщик не трогает канал звука идущей сессии, даже если он «старый»", async () => {
    await startInbound("live-sweep");
    const old = new Date(Date.now() - LIVE_VOICE_ORPHAN_AGE_MS - 60_000).toISOString();
    station.liveChannels = [{ id: station.lastExt, name: station.lastExt, state: "Up", creationtime: old }];
    station.bridgeList = [{ id: station.lastBridge, channels: [station.lastExt] }];
    const swept = await sweepLiveVoiceStationLeftovers();
    expect(swept).toMatchObject({ channelsHungUp: 0, bridgesDeleted: 0 });
    expect(station.hangupsOk).not.toContain(station.lastExt);
  });
});

describe("В5: перевод звонка", () => {
  it("повторный перевод получает исход первого и не вызывает move второй раз; трубку не кладут", async () => {
    const { channelId } = await startInbound("transfer");
    const move1 = vi.fn(async () => true);
    const move2 = vi.fn(async () => false);
    const first = transferLiveVoiceCall(channelId, move1);
    const second = transferLiveVoiceCall(channelId, move2);
    expect(await first).toBe("ok");
    expect(await second).toBe("ok");
    expect(move1).toHaveBeenCalledTimes(1);
    // Раньше провалившийся второй move сбрасывал «переведён» после успешного первого.
    expect(move2).not.toHaveBeenCalled();
    // Переведённому к агенту человеку отбой не шлют.
    expect(station.hangups).not.toContain(channelId);
    expect(station.continued).not.toContain(channelId);
  });

  it("неудавшийся перевод можно повторить — сессия остаётся у консультанта", async () => {
    const { channelId } = await startInbound("transfer-retry");
    expect(await transferLiveVoiceCall(channelId, async () => false)).toBe("failed");
    expect(liveVoiceLineBusy()).toBe(true);
    expect(await transferLiveVoiceCall(channelId, async () => true)).toBe("ok");
  });
});

describe("В6: повторный StasisStart", () => {
  it("дубль события на канал с идущей сессией игнорируется и первую сессию не стирает", async () => {
    const { channelId, client } = await startInbound("dup");
    const clientsBefore = gem.clients.length;
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);

    expect(gem.clients.length).toBe(clientsBefore);
    expect(client.closed).toBe(false);
    expect(liveVoiceLineBusy()).toBe(true);
    expect(logged.keys).toContain("live-voice-duplicate-stasis-start");
    // Первая сессия продолжает жить и закрывается штатно.
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    expect(client.closed).toBe(true);
    expect(liveVoiceLineBusy()).toBe(false);
  });
});

describe("LIVE02: дубль StasisStart в окне чтения настроек", () => {
  it("повтор, пришедший пока первый ждёт настройки, не уводит запускаемый звонок в диалплан", async () => {
    const channelId = nextChannel("dup-window");
    startedChannels.push(channelId);
    const realFind = prisma.settings.findUnique.bind(prisma.settings);
    const gates: (() => void)[] = [];
    const spy = vi.spyOn(prisma.settings, "findUnique").mockImplementation(((args: never) =>
      new Promise((resolve, reject) => {
        gates.push(() => (realFind(args) as Promise<unknown>).then(resolve, reject));
      })) as never);
    try {
      const clientsBefore = gem.clients.length;
      const first = onLiveVoiceAriEvent(stasisStart(channelId) as never);
      const second = onLiveVoiceAriEvent(stasisStart(channelId) as never);
      await waitFor(() => gates.length >= 1);
      // Первому отдаём настройки и ждём, пока сессия поднимется; второй (если он
      // вообще дошёл до чтения) получит настройки уже при занятой линии.
      gates[0]();
      await first;
      gates.slice(1).forEach((g) => g());
      await second;
      expect(gem.clients.length).toBe(clientsBefore + 1);
      expect(station.continued).not.toContain(channelId);
      expect(liveVoiceLineBusy()).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("В7: исключение в слушателе Gemini", () => {
  it("не вылетает из emit, пишется в журнал с постоянным ключом, звонок продолжается", async () => {
    const { client } = await startInbound("listener");
    // usage без полезной нагрузки — обработчик бросает TypeError.
    expect(() => client.emit("usage", undefined)).not.toThrow();
    expect(logged.keys).toContain("live-voice-listener-usage");
    expect(liveVoiceLineBusy()).toBe(true);
    expect(client.closed).toBe(false);
  });
});

describe("функции модели", () => {
  type ToolReply = { response: Record<string, unknown>; scheduling?: "SILENT" } | null;

  function useHandler(onToolCall: (call: { id: string; name: string; args: unknown }, ctx: { isCancelled(): boolean }) => Promise<ToolReply>, clientId?: string) {
    setLiveVoiceCallResolver(async () => ({
      systemInstruction: "тест",
      clientId,
      onToolCall: onToolCall as never,
    }));
  }

  it("функция, не ответившая за потолок, получает отказ; поздний результат отбрасывается", async () => {
    let finish: (r: ToolReply) => void = () => {};
    useHandler(() => new Promise<ToolReply>((resolve) => (finish = resolve)));
    const { client } = await startInbound("tool-timeout");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    client.emit("toolCall", [{ id: "t1", name: "find_property", args: {} }]);
    await vi.advanceTimersByTimeAsync(LIVE_VOICE_TOOL_TIMEOUT_MS + 100);
    vi.useRealTimers();

    expect(client.toolResponses).toHaveLength(1);
    expect(client.toolResponses[0]).toMatchObject({ id: "t1", response: { ok: false } });
    finish({ response: { ok: true } });
    await new Promise((r) => setTimeout(r, 30));
    expect(client.toolResponses).toHaveLength(1);
  });

  it("повторный вызов с тем же id не выполняется второй раз", async () => {
    const handler = vi.fn(async () => ({ response: { ok: true } }) as ToolReply);
    useHandler(handler);
    const { client } = await startInbound("tool-dedup");
    client.emit("toolCall", [{ id: "same", name: "find_property", args: {} }]);
    client.emit("toolCall", [{ id: "same", name: "find_property", args: {} }]);
    await waitFor(() => client.toolResponses.length >= 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(client.toolResponses).toHaveLength(1);
  });

  it("вызов, отменённый моделью (toolCallCancellation), остаётся без ответа", async () => {
    let finish: (r: ToolReply) => void = () => {};
    let seenCancelled: (() => boolean) | null = null;
    useHandler((_call, ctx) => {
      seenCancelled = ctx.isCancelled;
      return new Promise<ToolReply>((resolve) => (finish = resolve));
    });
    const { client } = await startInbound("tool-cancel");
    client.emit("toolCall", [{ id: "c1", name: "find_property", args: {} }]);
    await waitFor(() => seenCancelled !== null);
    expect(seenCancelled!()).toBe(false);
    client.emit("toolCallCancellation", ["c1"]);
    expect(seenCancelled!()).toBe(true);
    finish({ response: { ok: true } });
    await new Promise((r) => setTimeout(r, 30));
    expect(client.toolResponses).toHaveLength(0);
  });

  it("LIVE05: перевод, отменённый перебиванием и опоздавший за потолок, канал не уводит", async () => {
    let finish: () => void = () => {};
    let seenCancelled: (() => boolean) | null = null;
    const move = vi.fn(async () => true);
    let outcome: string | null = null;
    useHandler(async (_call, ctx) => {
      seenCancelled = ctx.isCancelled;
      // Подготовка перевода (база, станция, подсказка агенту) затянулась.
      await new Promise<void>((resolve) => (finish = resolve));
      outcome = await transferLiveVoiceCall(channelId, move, "agent-1", ctx.isCancelled);
      return { response: { ok: true } };
    });
    const { channelId, client } = await startInbound("tool-transfer-late");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    client.emit("toolCall", [{ id: "tr1", name: "transfer_to_agent", args: {} }]);
    await vi.advanceTimersByTimeAsync(10);
    client.emit("toolCallCancellation", ["tr1"]);
    await vi.advanceTimersByTimeAsync(LIVE_VOICE_TRANSFER_TOOL_TIMEOUT_MS + 100);
    vi.useRealTimers();
    expect(seenCancelled!()).toBe(true);

    finish();
    await waitFor(() => outcome !== null);
    expect(outcome).toBe("failed");
    expect(move).not.toHaveBeenCalled();
    expect(client.toolResponses).toHaveLength(0);
    expect(liveVoiceLineBusy()).toBe(true);
  });

  it("LIVE05: перевод, не уложившийся в потолок без перебивания, тоже считается отменённым", async () => {
    let finish: () => void = () => {};
    const move = vi.fn(async () => true);
    let outcome: string | null = null;
    useHandler(async (_call, ctx) => {
      await new Promise<void>((resolve) => (finish = resolve));
      outcome = await transferLiveVoiceCall(channelId, move, "agent-1", ctx.isCancelled);
      return { response: { ok: true } };
    });
    const { channelId, client } = await startInbound("tool-transfer-timeout");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    client.emit("toolCall", [{ id: "tr2", name: "transfer_to_agent", args: {} }]);
    await vi.advanceTimersByTimeAsync(LIVE_VOICE_TRANSFER_TOOL_TIMEOUT_MS + 100);
    vi.useRealTimers();
    // Модель уже получила отказ по таймауту: сразу после него канал уводить нельзя.
    expect(client.toolResponses).toHaveLength(1);
    finish();
    await waitFor(() => outcome !== null);
    expect(outcome).toBe("failed");
    expect(move).not.toHaveBeenCalled();
  });

  it("save_contact: обрывок номера отклоняется, поправка принимается новой заявкой с +992…", async () => {
    useHandler(async () => null, "client-life-1");
    const { client } = await startInbound("save-contact");

    client.emit("toolCall", [{ id: "s1", name: "save_contact", args: { name: "Рустам", phone: "88" } }]);
    await waitFor(() => client.toolResponses.length >= 1);
    expect(client.toolResponses[0].response).toMatchObject({ ok: false });
    // Заявка заведена (человек просил перезвонить), но без выдуманного номера.
    await waitFor(() => callbacks.requests.length >= 1);
    expect(callbacks.requests[0].phone).toBeNull();

    client.emit("toolCall", [{ id: "s2", name: "save_contact", args: { name: "Рустам", phone: "93 000 11 22" } }]);
    await waitFor(() => client.toolResponses.length >= 2);
    expect(client.toolResponses[1].response).toMatchObject({ ok: true });
    await waitFor(() => callbacks.requests.length >= 2);
    expect(callbacks.requests[1].phone).toBe("+992930001122");
    expect(callbacks.requests[1].byClientRequest).toBe(false);
  });

  it("escalate_to_human: автодозвон оператора только если клиент сам попросил человека", async () => {
    useHandler(async () => null, "client-life-2");
    const { client } = await startInbound("escalate");
    client.emit("toolCall", [{ id: "e1", name: "escalate_to_human", args: { reason: "не поняла вопрос" } }]);
    await waitFor(() => callbacks.requests.length >= 1);
    expect(callbacks.requests[0].byClientRequest).toBe(false);
    await endAll();

    const second = await startInbound("escalate-asked");
    second.client.emit("toolCall", [
      { id: "e2", name: "escalate_to_human", args: { reason: "хочу живого человека", by_client_request: true } },
    ]);
    await waitFor(() => callbacks.requests.length >= 2);
    expect(callbacks.requests[1].byClientRequest).toBe(true);
  });
});

describe("Г21: звук принимается только от станции", () => {
  it("без LIVE_VOICE_RTP_PEER сессия запоминает первого отправителя, чужого порта не слушает", async () => {
    const { client } = await startInbound("rtp-lock");
    const station1 = await openSocket(station.rtpPort);
    const stranger = await openSocket();
    try {
      await sendRtpFrom(station1, 1);
      await waitFor(() => client.audioChunks >= 1);
      const accepted = client.audioChunks;

      await sendRtpFrom(stranger, 1);
      await sendRtpFrom(stranger, 2);
      await new Promise((r) => setTimeout(r, 80));
      expect(client.audioChunks).toBe(accepted);
      expect(logged.keys).toContain("live-voice-rtp-foreign-source");

      // Станция продолжает слать с того же порта — звук идёт.
      await sendRtpFrom(station1, 2);
      await waitFor(() => client.audioChunks > accepted);
    } finally {
      station1.close();
      stranger.close();
    }
  });

  it("LIVE_VOICE_RTP_PEER задан — пакеты не от него отбрасываются с первого", async () => {
    process.env.LIVE_VOICE_RTP_PEER = "10.9.0.2";
    const { client } = await startInbound("rtp-peer");
    const other = await openSocket();
    try {
      await sendRtpFrom(other, 1);
      await new Promise((r) => setTimeout(r, 80));
      expect(client.audioChunks).toBe(0);
      expect(logged.keys).toContain("live-voice-rtp-foreign-source");
    } finally {
      other.close();
    }
  });

  it("LIVE_VOICE_RTP_PEER с адресом отправителя — пакеты принимаются", async () => {
    process.env.LIVE_VOICE_RTP_PEER = "127.0.0.1";
    const { client } = await startInbound("rtp-peer-ok");
    const ok = await openSocket(station.rtpPort);
    try {
      await sendRtpFrom(ok, 1);
      await waitFor(() => client.audioChunks >= 1);
    } finally {
      ok.close();
    }
  });
});

describe("звонок не набирается без адреса звука (пункт с)", () => {
  it("нет LIVE_VOICE_RTP_HOST — исходящий не набирается, один пункт в журнале, ответ «занято»", async () => {
    delete process.env.LIVE_VOICE_RTP_HOST;
    const before = station.originateCalls;
    const test = await originateLiveVoiceTestCall("+992 93 000 73 01");
    const scenario = await originateLiveVoiceScenarioCall("+992 93 000 73 02", { systemInstruction: "тест" });
    expect(test).toMatchObject({ ok: false, busy: true });
    expect(scenario).toMatchObject({ ok: false, busy: true });
    expect(String((test as { error?: string }).error)).toContain("LIVE_VOICE_RTP_HOST");
    expect(station.originateCalls).toBe(before);
    expect(logged.keys.filter((k) => k === "live-voice-rtp-not-configured").length).toBeGreaterThanOrEqual(1);
    // Резерв номера не завис: после починки звонок на тот же номер набирается.
    process.env.LIVE_VOICE_RTP_HOST = "127.0.0.1";
    const again = await originateLiveVoiceScenarioCall("+992 93 000 73 02", { systemInstruction: "тест" });
    expect(again.ok).toBe(true);
    // Сняли трубку — задание уходит в сессию, линия освобождается в afterEach.
    startedChannels.push(again.channelId!);
    await onLiveVoiceAriEvent(stasisStart(again.channelId!, "x") as never);
  });
});

describe("перезапуск подписки не рвёт идущие разговоры (пункт d, С5/В18)", () => {
  it("restartLiveVoiceListener при живой сессии откладывается до конца разговора", async () => {
    startLiveVoiceListener();
    try {
      const { channelId, client } = await startInbound("restart");
      restartLiveVoiceListener();
      // Раньше перезапуск закрывал все сессии (listener_stopped): человека обрывало.
      await new Promise((r) => setTimeout(r, 100));
      expect(client.closed).toBe(false);
      expect(liveVoiceLineBusy()).toBe(true);
      expect(station.hangups).not.toContain(channelId);
      expect(station.continued).not.toContain(channelId);

      // Разговор закончился штатно — отложенный перезапуск выполняется сам.
      await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
      expect(liveVoiceLineBusy()).toBe(false);
    } finally {
      stopLiveVoiceListener();
    }
  });

  it("смена тестового номера не перезапускает подписку вовсе", async () => {
    vi.resetModules();
    const restart = vi.fn();
    vi.doMock("../src/lib/telephony/liveVoiceBridge.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/lib/telephony/liveVoiceBridge.js")>()),
      restartLiveVoiceListener: restart,
    }));
    const { applySettingsSideEffects } = await import("../src/lib/settingsSideEffects.js");
    applySettingsSideEffects(["liveVoiceTestExtension"]);
    expect(restart).not.toHaveBeenCalled();
    vi.doUnmock("../src/lib/telephony/liveVoiceBridge.js");
    vi.resetModules();
  });
});

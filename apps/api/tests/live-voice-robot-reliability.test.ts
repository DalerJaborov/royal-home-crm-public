import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import dgram from "node:dgram";

/**
 * НАДЁЖНОСТЬ РОБОЗВОНКА (02.10.2026, аудит перед пробой консультанта на линии).
 *
 * Линия у консультанта одна (liveVoiceLineBusy): любая сессия, которая живёт
 * дольше разговора, отправляет каждого следующего звонящего на автоответчик.
 * Здесь стерегутся пути, которыми это случалось, и два соседних дефекта:
 *  - звонящий положил трубку, пока поднимался мост, — сессия всё равно
 *    заводилась и говорила в пустой мост до пятнадцатиминутного потолка;
 *  - звонящий молчит (звук в одну сторону) — сторожа не было вовсе;
 *  - остановка процесса на выкате не закрывала разговоры, а сверка после
 *    перезапуска клала трубку тому, кого станция прислала вместо автоответчика;
 *  - вторая сессия на том же канале (звонок вернулся от агента) не могла
 *    завести строку журнала, а её запись перетирала запись первой части;
 *  - вся расшифровка каждого звонка уходила в журнал ошибок.
 *
 * Станция и Gemini подменены: живой станции у тестов нет. Мост — настоящий,
 * события станции идут через onLiveVoiceAriEvent тем же путём, что из подписки.
 */

const station = vi.hoisted(() => ({
  bridges: 0,
  hangups: [] as string[],
  continued: [] as string[],
  /** Вызывается, когда в мост добавляют канал звонящего (не канал звука). */
  onAddCaller: null as null | ((channelId: string) => Promise<void>),
  liveChannels: [] as unknown[],
  /** Порт, с которого «станция» шлёт звук (UNICASTRTP_LOCAL_PORT). */
  rtpPort: 44900 + Math.floor(Math.random() * 90),
}));

const gem = vi.hoisted(() => ({ clients: [] as FakeGemini[] }));
interface FakeGemini {
  texts: string[];
  connected: boolean;
  closed: boolean;
  emit(event: string, ...args: unknown[]): boolean;
}

const r2 = vi.hoisted(() => ({ keys: [] as string[], failTimes: 0 }));
const logged = vi.hoisted(() => ({ messages: [] as string[] }));

vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: "http://station", username: "u", password: "p" }),
  createBridge: async () => ({ ok: true, bridgeId: `br-${++station.bridges}` }),
  createExternalMediaChannel: async () => ({ ok: true, channelId: `UnicastRTP/127.0.0.1-${station.bridges}` }),
  answerChannel: async () => ({ ok: true }),
  addChannelToBridge: async (_creds: unknown, _bridgeId: string, channelId: string) => {
    if (!channelId.startsWith("UnicastRTP") && station.onAddCaller) await station.onAddCaller(channelId);
    return { ok: true };
  },
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
  listActiveChannels: async () => station.liveChannels,
  playChannelSound: async () => ({ ok: true }),
}));

vi.mock("../src/ai/liveVoiceClient.js", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  class FakeLiveVoiceClient extends EventEmitter {
    texts: string[] = [];
    connected = false;
    closed = false;
    activeModel = "fake-live";
    constructor() {
      super();
      gem.clients.push(this as unknown as FakeGemini);
    }
    async connect(): Promise<void> {
      if (this.closed) throw new Error("сессия закрыта до подключения");
      this.connected = true;
      this.emit("ready");
    }
    sendText(text: string): void {
      this.texts.push(text);
    }
    sendAudioChunk(): void {}
    sendToolResponse(): void {}
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
  isR2Configured: () => true,
  r2Upload: async (key: string) => {
    if (r2.failTimes > 0) {
      r2.failTimes -= 1;
      throw new Error("R2 недоступен");
    }
    r2.keys.push(key);
  },
}));

vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: async (_source: string, message: string) => {
    logged.messages.push(String(message));
  },
}));

const { prisma } = await import("../src/db.js");
const bridge = await import("../src/lib/telephony/liveVoiceBridge.js");
const {
  onLiveVoiceAriEvent,
  liveVoiceLineBusy,
  shutdownLiveVoiceListener,
  resyncLiveVoiceSessions,
  orphanChannelAction,
  noSpeechWatchStep,
  liveVoiceRecordingKey,
  retryAsync,
  buildRtpPacket,
  ULAW_PAYLOAD_TYPE,
  NO_CALLER_SPEECH_REASON,
  NO_STATION_AUDIO_REASON,
  NO_STATION_AUDIO_MS,
  liveVoiceAudioPathDown,
  resetLiveVoiceAudioPathForTests,
  originateLiveVoiceScenarioCall,
} = bridge;
const { waitFor } = await import("./helpers/waitFor.js");

const runId = Date.now().toString(36);
const RTP_PORT = 41000 + Math.floor(Math.random() * 900);
const envBefore = { host: process.env.LIVE_VOICE_RTP_HOST, port: process.env.LIVE_VOICE_RTP_PORT };
let settingsBefore: { liveVoiceEnabled: boolean; liveVoiceInboundMode: string; liveVoiceForceRussianOnly: boolean } | null = null;
let seq = 0;

function nextChannel(tag: string): string {
  seq += 1;
  return `lv-rel-${runId}-${tag}-${seq}`;
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

/** Секунда звука от звонящего — RTP-пакетом в порт моста, как шлёт станция. */
async function sendCallerSecond(): Promise<void> {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(station.rtpPort, "127.0.0.1", () => resolve()));
  const packet = buildRtpPacket({
    payloadType: ULAW_PAYLOAD_TYPE,
    sequenceNumber: 1,
    timestamp: 0,
    ssrc: 1,
    // 0x80 — громкий ulaw-сэмпл (тишина — 0xff): секунда на 8 кГц.
    payload: Buffer.alloc(8000, 0x80),
  });
  await new Promise<void>((resolve, reject) =>
    socket.send(packet, RTP_PORT, "127.0.0.1", (err) => (err ? reject(err) : resolve()))
  );
  socket.close();
}

beforeAll(async () => {
  process.env.LIVE_VOICE_RTP_HOST = "127.0.0.1";
  process.env.LIVE_VOICE_RTP_PORT = String(RTP_PORT);
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
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await prisma.liveVoiceSession.deleteMany({ where: { channelId: { startsWith: `lv-rel-${runId}` } } });
});

beforeEach(() => {
  resetLiveVoiceAudioPathForTests();
  station.hangups.length = 0;
  station.continued.length = 0;
  station.onAddCaller = null;
  station.liveChannels = [];
  r2.keys.length = 0;
  r2.failTimes = 0;
  logged.messages.length = 0;
});

describe("звонящий положил трубку, пока поднималась сессия", () => {
  // С 09.10.2026 Gemini подключается ДО снятия трубки (трубку снимают, только когда голос
  // готов), поэтому к моменту, когда звонящий встаёт в мост, клиент уже открыт: важно, что
  // он закрыт и линия свободна, а не висит пятнадцать минут.
  it("сессия закрывается сразу, Gemini закрыт, линия свободна", async () => {
    const channelId = nextChannel("gone");
    station.onAddCaller = async (id) => {
      await onLiveVoiceAriEvent(stasisEnd(id) as never);
    };
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);

    const client = gem.clients.at(-1)!;
    expect(client.closed).toBe(true);
    // Раньше здесь висела живая сессия на пятнадцать минут, и линия была занята.
    expect(liveVoiceLineBusy()).toBe(false);
  });
});

describe("сторож тишины", () => {
  it("чистая функция: спросить на 25-й секунде тишины, прощаться не раньше 50-й и не сразу после вопроса", () => {
    const base = { lastCallerActivityAt: 0, lastBotAudioAt: 0, botBusy: false, promptedAt: null };
    expect(noSpeechWatchStep(base, 24_000)).toBeNull();
    expect(noSpeechWatchStep(base, 25_000)).toBe("prompt");
    // Бот говорил до 20-й секунды — тишина на линии считается от конца его речи.
    expect(noSpeechWatchStep({ ...base, lastBotAudioAt: 20_000 }, 30_000)).toBeNull();
    // Бот говорит прямо сейчас — человек слушает, это не тишина.
    expect(noSpeechWatchStep({ ...base, botBusy: true }, 60_000)).toBeNull();
    expect(noSpeechWatchStep({ ...base, promptedAt: 25_000 }, 49_000)).toBeNull();
    expect(noSpeechWatchStep({ ...base, promptedAt: 25_000 }, 50_000)).toBe("end");
    // Спросили поздно (бот долго говорил) — дать человеку ответить.
    expect(noSpeechWatchStep({ ...base, promptedAt: 45_000 }, 50_000)).toBeNull();
    expect(noSpeechWatchStep({ ...base, promptedAt: 45_000 }, 55_000)).toBe("end");
  });

  it("молчащий звонящий: «Алло, вы меня слышите?», потом прощание и звонок назад станции, а не отбой", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const channelId = nextChannel("silent");
    try {
      await onLiveVoiceAriEvent(stasisStart(channelId) as never);
      const client = gem.clients.at(-1)!;
      expect(client.connected).toBe(true);
      expect(liveVoiceLineBusy()).toBe(true);
      // Модель поздоровалась (конец хода) — иначе это сторож «модель молчит», а не тишина звонящего.
      client.emit("turnComplete");
      const asked = () => client.texts.some((t) => t.includes("Алло, вы меня слышите?"));
      const farewell = () => client.texts.some((t) => t.includes("попрощайся"));

      vi.advanceTimersByTime(24_000);
      expect(asked()).toBe(false);
      vi.advanceTimersByTime(2_000);
      expect(asked()).toBe(true);
      // Без замка на русский — спросить на языке разговора, таджикский образец есть.
      expect(client.texts.at(-1)).toContain("шумо маро мешунавед");
      expect(farewell()).toBe(false);

      vi.advanceTimersByTime(25_000);
      expect(farewell()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    // Тишина дождалась конца очереди звука (обычными таймерами) — звонок ушёл назад
    // в диалплан станции (там автоответчик), трубку человеку не клали.
    await waitFor(() => station.continued.includes(channelId), { timeoutMs: 6000, label: "звонок отдан станции" });
    expect(station.hangups).not.toContain(channelId);
    const row = await waitFor(
      () => prisma.liveVoiceSession.findFirst({ where: { channelId, endedAt: { not: null } } }),
      { label: "сессия закрыта" }
    );
    expect(row.endedReason).toBe(NO_CALLER_SPEECH_REASON);
    expect(liveVoiceLineBusy()).toBe(false);
  });

  it("звонящий заговорил — сторож молчит", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const channelId = nextChannel("talks");
    try {
      await onLiveVoiceAriEvent(stasisStart(channelId) as never);
      const client = gem.clients.at(-1)!;
      client.emit("turnComplete"); // модель поздоровалась
      vi.advanceTimersByTime(20_000);
      client.emit("transcript", { role: "user", text: "Алло, здравствуйте" });
      client.emit("turnComplete");
      vi.advanceTimersByTime(20_000);
      expect(client.texts.some((t) => t.includes("Алло, вы меня слышите?"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    expect(liveVoiceLineBusy()).toBe(false);
  });
});

/**
 * МЁРТВЫЙ ПУТЬ ЗВУКА (02.10.2026, живая проба Dan): тоннель звука станция→CRM
 * умер 28.09, команды станции ходили другим путём — робот брал трубку и говорил
 * в тишину пять дней. Ни одного кадра со станции — звонок назад станции и пауза.
 */
describe("звук со станции не доходит", () => {
  it("ни одного кадра за NO_STATION_AUDIO_MS — звонок отдан станции, робот на паузе, новые звонки не берёт", async () => {
    const channelId = nextChannel("deaf");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    expect(liveVoiceLineBusy()).toBe(true);

    await waitFor(() => station.continued.includes(channelId), {
      timeoutMs: NO_STATION_AUDIO_MS + 4_000,
      label: "звонок отдан станции",
    });
    expect(station.hangups).not.toContain(channelId);
    const row = await waitFor(
      () => prisma.liveVoiceSession.findFirst({ where: { channelId, endedAt: { not: null } } }),
      { label: "сессия закрыта" }
    );
    expect(row.endedReason).toBe(NO_STATION_AUDIO_REASON);
    expect(liveVoiceLineBusy()).toBe(false);
    expect(liveVoiceAudioPathDown()).toBe(true);
    expect(logged.messages.some((m) => m.includes("не пришло ни одного кадра звука"))).toBe(true);

    // Следующий входящий — сразу станции, без Gemini и без тишины в трубке.
    const next = nextChannel("deaf-next");
    const clientsBefore = gem.clients.length;
    await onLiveVoiceAriEvent(stasisStart(next) as never);
    expect(station.continued).toContain(next);
    expect(gem.clients.length).toBe(clientsBefore);
    expect(liveVoiceLineBusy()).toBe(false);

    // Сценарный звонок не набирается: «занято», вызывающий перенесёт без потери попытки.
    const dial = await originateLiveVoiceScenarioCall("+992 93 000 77 88", { systemInstruction: "тест" });
    expect(dial).toMatchObject({ ok: false, busy: true });
  }, NO_STATION_AUDIO_MS + 10_000);

  it("кадры со станции идут — сторож молчит, разговор продолжается", async () => {
    const channelId = nextChannel("hears");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    // Живая станция шлёт кадр каждые 20 мс; здесь — каждые 500 мс, реже порога пропажи звука.
    const until = Date.now() + NO_STATION_AUDIO_MS + 500;
    while (Date.now() < until) {
      await sendCallerSecond();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(station.continued).not.toContain(channelId);
    expect(liveVoiceLineBusy()).toBe(true);
    expect(liveVoiceAudioPathDown()).toBe(false);
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    expect(liveVoiceLineBusy()).toBe(false);
  }, NO_STATION_AUDIO_MS + 10_000);
});

describe("остановка процесса посреди разговора", () => {
  it("разговор закрывается с listener_stopped: звонок со станции уходит назад в её диалплан", async () => {
    const channelId = nextChannel("shutdown");
    // «inbound», а не «missed»: с 11.10.2026 «missed» (свой клиент агента) робот не берёт.
    await onLiveVoiceAriEvent(stasisStart(channelId, "inbound") as never);
    expect(liveVoiceLineBusy()).toBe(true);

    expect(await shutdownLiveVoiceListener(5_000)).toBe(1);
    expect(station.continued).toContain(channelId);
    expect(station.hangups).not.toContain(channelId);
    const row = await prisma.liveVoiceSession.findFirst({ where: { channelId } });
    expect(row?.endedReason).toBe("listener_stopped");
    expect(liveVoiceLineBusy()).toBe(false);
    // Повторная остановка — разговоров нет, ждать нечего.
    expect(await shutdownLiveVoiceListener(5_000)).toBe(0);
  });

  it("решение по каналу после перезапуска: станционный — назад, наш тестовый — отбой, чужой — не трогать", () => {
    const ch = (app_name?: string, app_data?: string) =>
      ({ id: "x", name: "SIP/x", state: "Up", caller: {}, dialplan: { app_name, app_data } }) as never;
    expect(orphanChannelAction(ch("Stasis", "royalhome-live-voice,inbound"), "inbound")).toBe("hand_back");
    expect(orphanChannelAction(ch("Stasis", "royalhome-live-voice,missed"), "inbound")).toBe("hand_back");
    expect(orphanChannelAction(ch("Stasis", "royalhome-live-voice,returned"), "inbound")).toBe("hand_back");
    expect(orphanChannelAction(ch("Stasis", "royalhome-live-voice,known"), "inbound")).toBe("hand_back");
    expect(orphanChannelAction(ch("Stasis", "royalhome-live-voice"), "outbound")).toBe("hangup");
    // Канал уже у агента (Dial) или в чужом приложении — там идёт другой разговор.
    expect(orphanChannelAction(ch("Dial", "SIP/1044,30"), "inbound")).toBe("leave");
    expect(orphanChannelAction(ch("Stasis", "royal-home-crm"), "inbound")).toBe("leave");
    // Станция не назвала приложение — по записи сессии.
    expect(orphanChannelAction(ch(), "inbound")).toBe("hand_back");
    expect(orphanChannelAction(ch(), "outbound")).toBe("hangup");
  });

  it("сверка после перезапуска отдаёт станции звонок, который она прислала вместо автоответчика", async () => {
    const stationCall = nextChannel("orphan-station");
    const agentCall = nextChannel("orphan-agent");
    const old = new Date(Date.now() - 5 * 60_000);
    await prisma.liveVoiceSession.createMany({
      data: [
        { channelId: stationCall, startedAt: old, direction: "inbound" },
        { channelId: agentCall, startedAt: old, direction: "inbound" },
      ],
    });
    station.liveChannels = [
      { id: stationCall, name: "SIP/a", state: "Up", caller: {}, dialplan: { app_name: "Stasis", app_data: "royalhome-live-voice,inbound" } },
      { id: agentCall, name: "SIP/b", state: "Up", caller: {}, dialplan: { app_name: "Dial", app_data: "SIP/1044" } },
    ];

    await resyncLiveVoiceSessions({ url: "http://station", username: "u", password: "p" });

    expect(station.continued).toContain(stationCall);
    expect(station.hangups).not.toContain(stationCall);
    expect(station.continued).not.toContain(agentCall);
    expect(station.hangups).not.toContain(agentCall);
    const rows = await prisma.liveVoiceSession.findMany({
      where: { channelId: { in: [stationCall, agentCall] } },
      select: { channelId: true, endedReason: true },
    });
    expect(Object.fromEntries(rows.map((r) => [r.channelId, r.endedReason]))).toEqual({
      [stationCall]: "orphan_after_restart",
      [agentCall]: "orphan_left_stasis",
    });
  });
});

describe("звонок вернулся от агента — вторая сессия на том же канале", () => {
  it("у каждой сессии своя строка журнала и своя запись; расшифровка в журнал ошибок не уходит", async () => {
    const channelId = nextChannel("returned");

    // Первая часть: консультант поговорил (и, допустим, соединял с агентом).
    await onLiveVoiceAriEvent(stasisStart(channelId, "inbound") as never);
    gem.clients.at(-1)!.emit("transcript", { role: "user", text: "Меня зовут Фарход, ищу квартиру в Сино" });
    await sendCallerSecond();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);

    // Агент не взял — станция вернула звонок консультанту на том же канале.
    await onLiveVoiceAriEvent(stasisStart(channelId, "returned") as never);
    gem.clients.at(-1)!.emit("transcript", { role: "user", text: "Хорошо, жду звонка агента" });
    await sendCallerSecond();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);

    const rows = await prisma.liveVoiceSession.findMany({
      where: { channelId },
      orderBy: { startedAt: "asc" },
      select: { transcript: true, recordingUrl: true, endedAt: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].transcript).toContain("Фарход");
    expect(rows[1].transcript).toContain("жду звонка агента");
    expect(rows.every((r) => r.endedAt)).toBe(true);
    expect(r2.keys).toHaveLength(2);
    expect(new Set(r2.keys).size).toBe(2);
    expect(rows.map((r) => r.recordingUrl)).toEqual(r2.keys);

    // Журнал ошибок: ни разговора, ни имени звонящего.
    expect(logged.messages.some((m) => m.includes("Фарход") || m.includes("расшифровка звонка"))).toBe(false);
  });

  it("ключ записи — канал и время начала сессии", () => {
    const a = liveVoiceRecordingKey("1727000000.42", 1_000);
    const b = liveVoiceRecordingKey("1727000000.42", 2_000);
    expect(a).toMatch(/^call-recordings\/live-voice\/\d{4}\/\d{2}\/1727000000\.42-1000\.wav$/);
    expect(a).not.toBe(b);
  });

  it("R2 один раз не ответил — запись всё равно залита со второй попытки", async () => {
    r2.failTimes = 1;
    const channelId = nextChannel("r2retry");
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    await sendCallerSecond();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
    expect(r2.keys).toHaveLength(1);
    const row = await prisma.liveVoiceSession.findFirst({ where: { channelId }, select: { recordingUrl: true } });
    expect(row?.recordingUrl).toBe(r2.keys[0]);
  }, 10_000);

  it("retryAsync: удача со второй попытки; все неудачны — последняя ошибка наружу", async () => {
    let calls = 0;
    await expect(
      retryAsync(async () => {
        calls += 1;
        if (calls < 2) throw new Error("раз");
        return "ok";
      }, [1])
    ).resolves.toBe("ok");
    await expect(
      retryAsync(async (attempt) => {
        throw new Error(`попытка ${attempt}`);
      }, [1, 1])
    ).rejects.toThrow("попытка 3");
  });
});

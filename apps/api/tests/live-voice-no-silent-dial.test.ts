import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * П1 «НЕ НАБИРАТЬ В ТИШИНУ» (11.11.2026, docs/voice-robot-plan-2026-11-11.md, находки Б1, В5, В6).
 *
 * Исходящая сессия робота поднимается ПОСЛЕ ответа человека. Робозвонок — только
 * ElevenLabs (решение владельца 11.11.2026), запасного голоса нет. Здесь проверяется:
 *  - ElevenLabs не выдаёт разговор (проба signed URL) → «занято», ни одного набора;
 *  - у ElevenLabs кончились кредиты → «занято», ни одного набора, одна тревога директору;
 *  - ElevenLabs отказал при подключении после «алло» → трубка кладётся сразу (не тишина),
 *    сценарию — start_failed (его сценарии повторяют), тревога; Gemini НЕ подключается;
 *  - пауза у каждого поставщика своя: две неудачи ElevenLabs и откат на Google —
 *    следующий звонок сразу, без паузы;
 *  - прогрев агента при старте не падает и не держит старт;
 *  - сторож: каждый набор функций, с которым CRM звонит, есть в списке прогрева.
 * Станция и оба клиента голоса подменены, мост настоящий; сеть (fetch) подменена —
 * живые ElevenLabs и Gemini не зовутся.
 */

const station = vi.hoisted(() => ({
  seq: 0,
  rtpPort: 42000 + Math.floor(Math.random() * 900),
  originates: 0,
  bridged: [] as string[],
  hangups: [] as string[],
}));

interface FakeProvider {
  kind: "google" | "elevenlabs";
  connectOpts: Record<string, unknown> | null;
  connected: boolean;
  closed: boolean;
}
const voice = vi.hoisted(() => ({
  list: [] as FakeProvider[],
  /** Как подключается ElevenLabs: ok, отказ, отказ «нет кредитов». */
  elevenMode: "ok" as "ok" | "reject" | "quota",
}));
const logged = vi.hoisted(() => ({ entries: [] as { message: string; key?: string }[] }));
/** Ответ ElevenLabs на запрос ссылки разговора (проба). */
const net = vi.hoisted(() => ({
  signedUrl: "ok" as "ok" | "fail" | "quota",
  requests: [] as string[],
  /** Задержать ответ на запрос ссылки, пока тест не отпустит (гонка «проба ↔ бронь линии»). */
  holdSignedUrl: null as Promise<void> | null,
  /** Ответ подписки (остаток минут): used/limit или отказ. */
  subscription: { used: 100, limit: 100 } as { used: number; limit: number } | "fail",
}));

vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: "http://station", username: "u", password: "p" }),
  originateToStasisApp: async () => {
    station.originates += 1;
    return { ok: true, channelId: `lv-p1-${Date.now().toString(36)}-${++station.seq}` };
  },
  createBridge: async () => ({ ok: true, bridgeId: `br-p1-${++station.seq}` }),
  createExternalMediaChannel: async () => ({ ok: true, channelId: `UnicastRTP/127.0.0.1-p1-${++station.seq}` }),
  answerChannel: async () => ({ ok: true }),
  addChannelToBridge: async (_c: unknown, _b: string, channelId: string) => {
    station.bridged.push(channelId);
    return { ok: true };
  },
  readChannelVariable: async (_c: unknown, _id: string, name: string) =>
    name === "UNICASTRTP_LOCAL_ADDRESS" ? "127.0.0.1" : name === "UNICASTRTP_LOCAL_PORT" ? String(station.rtpPort) : null,
  deleteBridge: async () => ({ ok: true }),
  hangupCall: async (_c: unknown, channelId: string) => {
    station.hangups.push(channelId);
    return { ok: true };
  },
  continueInDialplan: async () => ({ ok: true }),
  listActiveChannels: async () => [],
  listBridges: async () => [],
  playChannelSound: async () => ({ ok: true }),
}));

async function makeFake(kind: "google" | "elevenlabs") {
  const { EventEmitter } = await import("node:events");
  return class extends EventEmitter {
    kind = kind;
    connectOpts: Record<string, unknown> | null = null;
    connected = false;
    closed = false;
    activeModel = kind === "google" ? "fake-live" : "elevenlabs:agent_p1";
    asyncTools = false;
    outputSampleRateHz = kind === "google" ? 24_000 : 8_000;
    inputSampleRateHz = kind === "google" ? 16_000 : 8_000;
    constructor() {
      super();
      voice.list.push(this as unknown as FakeProvider);
    }
    async connect(opts: Record<string, unknown>): Promise<void> {
      this.connectOpts = opts;
      if (kind === "elevenlabs" && voice.elevenMode === "reject") {
        throw new Error("Живой голос (ElevenLabs): закрыто до начала разговора: код 1011 «internal error»");
      }
      if (kind === "elevenlabs" && voice.elevenMode === "quota") {
        throw new Error("закрыто до начала разговора: код 1008 «quota_exceeded: This request exceeds your quota»");
      }
      this.connected = true;
      this.emit("ready");
    }
    sendText(): void {}
    sendAudioChunk(): void {}
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

vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: async (_source: string, message: string, opts?: { dedupKey?: string }) => {
    logged.entries.push({ message: String(message), key: opts?.dedupKey });
  },
}));

const { prisma } = await import("../src/db.js");
const bridge = await import("../src/lib/telephony/liveVoiceBridge.js");
const {
  onLiveVoiceAriEvent,
  originateLiveVoiceScenarioCall,
  liveVoiceLineBusy,
  liveVoiceProviderPaused,
  resetLiveVoiceAudioPathForTests,
  resetLiveVoiceProviderHolds,
} = bridge;
const { applySettingsSideEffects } = await import("../src/lib/settingsSideEffects.js");
const { startLiveVoiceAgentWarmup, liveVoiceWarmupToolSets } = await import("../src/lib/telephony/liveVoiceWarmup.js");
const { elevenLabsQuotaExhausted, isElevenLabsQuotaError, noteElevenLabsQuotaExhausted, recheckElevenLabsQuota } = await import(
  "../src/ai/liveVoiceProvider.js"
);
const { resetElevenLabsSyncCacheForTests } = await import("../src/ai/elevenLabsAgentSync.js");
const { waitFor } = await import("./helpers/waitFor.js");
import type { LiveVoiceFunctionDeclaration } from "../src/ai/liveVoiceClient.js";

const RTP_PORT = 45000 + Math.floor(Math.random() * 900);
const envBefore = {
  host: process.env.LIVE_VOICE_RTP_HOST,
  port: process.env.LIVE_VOICE_RTP_PORT,
  peer: process.env.LIVE_VOICE_RTP_PEER,
  key: process.env.ELEVENLABS_API_KEY,
  base: process.env.ELEVENLABS_API_BASE,
};
let settingsBefore: Record<string, unknown> | null = null;
const started: string[] = [];

const INVITE_TOOL: LiveVoiceFunctionDeclaration = {
  name: "record_interview_answer",
  description: "Записать ответ кандидата.",
  parameters: { type: "OBJECT", properties: { answer: { type: "STRING", description: "Ответ." } }, required: ["answer"] },
};
const PERSONA = "СЦЕНАРИЙ П1: приглашение на собеседование";

const keys = () => logged.entries.map((e) => e.key);
const countKey = (k: string) => logged.entries.filter((e) => e.key === k).length;

function quotaBody(): string {
  // ФАКТ (help-center «API - Error Code 400 or 401»): статус quota_exceeded; текст — как в журналах интеграций.
  return JSON.stringify({ detail: { status: "quota_exceeded", message: "This request exceeds your quota. You have 0 credits remaining." } });
}

function stubElevenLabsNetwork(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(String(url)).pathname;
      net.requests.push(path);
      if (path === "/v1/user/subscription") {
        if (net.subscription === "fail") return new Response(JSON.stringify({ detail: "missing_permissions" }), { status: 401 });
        return new Response(
          JSON.stringify({ character_count: net.subscription.used, character_limit: net.subscription.limit }),
          { status: 200 }
        );
      }
      if (path === "/v1/convai/conversation/get-signed-url") {
        // Ответ — каким он был в момент запроса, даже если тест держит его дольше.
        const mode = net.signedUrl;
        if (net.holdSignedUrl) await net.holdSignedUrl;
        if (mode === "fail") return new Response(JSON.stringify({ detail: "invalid api key" }), { status: 401 });
        if (mode === "quota") return new Response(quotaBody(), { status: 401 });
        return new Response(JSON.stringify({ signed_url: "wss://example.test/convai?token=t" }), { status: 200 });
      }
      // Подготовка агента в этом файле не нужна (клиент ElevenLabs подменён) — сеть «лежит».
      throw new Error("ECONNREFUSED");
    })
  );
}

async function setProvider(provider: "google" | "elevenlabs"): Promise<void> {
  await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceProvider: provider } });
}

/** Набрать сценарный звонок; если набран — «человек снял трубку» (StasisStart). Ждём,
 *  пока голос подключится ИЛИ подъём сдастся (итог сценарию). */
async function dial(phone: string) {
  const before = voice.list.length;
  const originatesBefore = station.originates;
  const finished: { reason: string }[] = [];
  const res = await originateLiveVoiceScenarioCall(phone, {
    systemInstruction: PERSONA,
    tools: [INVITE_TOOL],
    forceRussianOnly: false,
    language: "tg",
    onFinished: async (r) => {
      finished.push({ reason: r.reason });
    },
  });
  if (!res.ok || !res.channelId) {
    return { res, dialed: station.originates > originatesBefore, clients: [] as FakeProvider[], finished, channelId: undefined };
  }
  const channelId = res.channelId;
  started.push(channelId);
  await onLiveVoiceAriEvent({
    type: "StasisStart",
    application: "royalhome-live-voice",
    args: [],
    channel: { id: channelId, name: `SIP/out-${channelId}`, state: "Up", caller: { number: phone.replace(/\D/g, "").slice(-9) } },
  } as never);
  await waitFor(() => voice.list.slice(before).some((c) => c.connected) || finished.length > 0 || null, {
    label: "голос подключён или подъём сдался",
  });
  return { res, dialed: true, clients: voice.list.slice(before), finished, channelId };
}

async function hangUpAll(): Promise<void> {
  for (const id of started.splice(0)) {
    await onLiveVoiceAriEvent({ type: "StasisEnd", channel: { id, name: `SIP/out-${id}`, state: "Up", caller: {} } } as never);
  }
  await waitFor(() => !liveVoiceLineBusy(), { timeoutMs: 6000, label: "линия свободна" });
}

beforeAll(async () => {
  process.env.LIVE_VOICE_RTP_HOST = "127.0.0.1";
  process.env.LIVE_VOICE_RTP_PORT = String(RTP_PORT);
  delete process.env.LIVE_VOICE_RTP_PEER;
  // Ненастоящий ключ: resolveElevenLabsKey берёт .env, когда в Настройках ключа нет.
  process.env.ELEVENLABS_API_KEY = "sk_p1_fake_key_not_real";
  // Страховка от живых запросов: даже если фоновая подготовка переживёт подмену fetch,
  // она уйдёт в закрытый локальный порт, а не в ElevenLabs.
  process.env.ELEVENLABS_API_BASE = "http://127.0.0.1:9";
  settingsBefore = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      liveVoiceEnabled: true,
      liveVoiceProvider: true,
      liveVoiceInboundMode: true,
      elevenLabsApiKey: true,
      elevenLabsAgentId: true,
    },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    // Входящие берёт робот — для гонки «проба ↔ входящий занял линию».
    data: { liveVoiceEnabled: true, liveVoiceInboundMode: "always", elevenLabsApiKey: null, elevenLabsAgentId: "agent_p1" },
  });
});

beforeEach(() => {
  resetLiveVoiceAudioPathForTests();
  resetLiveVoiceProviderHolds();
  logged.entries.length = 0;
  net.requests.length = 0;
  net.signedUrl = "ok";
  net.holdSignedUrl = null;
  net.subscription = { used: 100, limit: 100 };
  voice.elevenMode = "ok";
  stubElevenLabsNetwork();
});

afterEach(async () => {
  await hangUpAll();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  for (const [key, value] of [
    ["LIVE_VOICE_RTP_HOST", envBefore.host],
    ["LIVE_VOICE_RTP_PORT", envBefore.port],
    ["LIVE_VOICE_RTP_PEER", envBefore.peer],
    ["ELEVENLABS_API_KEY", envBefore.key],
    ["ELEVENLABS_API_BASE", envBefore.base],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  resetLiveVoiceProviderHolds();
  resetElevenLabsSyncCacheForTests();
  await prisma.liveVoiceSession.deleteMany({ where: { channelId: { startsWith: "lv-p1-" } } });
  await prisma.aiLog.deleteMany({ where: { conversationId: { startsWith: "lv-p1-" } } });
});

describe("проба перед набором", () => {
  it("ElevenLabs не выдал ссылку на разговор — «занято», ни одного набора, одна запись в журнале", async () => {
    await setProvider("elevenlabs");
    net.signedUrl = "fail";
    const first = await dial("+992 93 000 71 01");
    expect(first.res).toMatchObject({ ok: false, busy: true });
    expect(first.dialed).toBe(false);
    // Вторая попытка в пределах минуты — из памяти пробы, без нового запроса и без второй записи.
    const requestsAfterFirst = net.requests.length;
    const second = await dial("+992 93 000 71 02");
    expect(second.res).toMatchObject({ ok: false, busy: true });
    expect(second.dialed).toBe(false);
    expect(net.requests.length).toBe(requestsAfterFirst);
    expect(countKey("elevenlabs-probe-failed")).toBe(1);
  });

  it("проба прошла — звонок набирается и идёт через ElevenLabs", async () => {
    await setProvider("elevenlabs");
    const call = await dial("+992 93 000 71 03");
    expect(call.res.ok).toBe(true);
    expect(call.clients.map((c) => c.kind)).toEqual(["elevenlabs"]);
  });

  it("голос робота — Google: проба в ElevenLabs не ходит", async () => {
    await setProvider("google");
    net.signedUrl = "fail";
    const call = await dial("+992 93 000 71 04");
    expect(call.res.ok).toBe(true);
    expect(net.requests).toEqual([]);
    expect(call.clients.map((c) => c.kind)).toEqual(["google"]);
  });
});

describe("отказ ElevenLabs после «алло» — не тишина и без запасного голоса", () => {
  it("трубка кладётся сразу, в мост человека не ставят, сценарию start_failed (повтор), тревога; Gemini не подключается", async () => {
    await setProvider("elevenlabs");
    voice.elevenMode = "reject";
    const t0 = Date.now();
    const call = await dial("+992 93 000 72 01");
    expect(call.res.ok).toBe(true);
    await waitFor(() => (call.finished.length > 0 && station.hangups.includes(call.channelId!)) || null, { label: "отбой и итог" });
    // Не 25 с тишины до потолка подъёма — отбой сразу после отказа.
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(call.clients.map((c) => c.kind)).toEqual(["elevenlabs"]);
    expect(station.bridged).not.toContain(call.channelId);
    expect(call.finished[0].reason.startsWith("start_failed")).toBe(true);
    expect(keys()).toContain("elevenlabs-connect-failed");
    expect(keys()).not.toContain("elevenlabs-fallback-google");
  });
});

describe("пауза — у каждого поставщика своя", () => {
  it("две неудачи ElevenLabs — исходящие «занято»; откат на Google — следующий звонок сразу", async () => {
    await setProvider("elevenlabs");
    voice.elevenMode = "reject";
    await dial("+992 93 000 73 01");
    await hangUpAll();
    await dial("+992 93 000 73 02");
    await hangUpAll();
    expect(liveVoiceProviderPaused("elevenlabs")).toBe(true);
    expect(liveVoiceProviderPaused("google")).toBe(false);
    expect(keys()).toContain("live-voice-elevenlabs-paused");
    const paused = await dial("+992 93 000 73 03");
    expect(paused.res).toMatchObject({ ok: false, busy: true });
    expect(paused.dialed).toBe(false);

    // Владелец переключил голос на Google — даже без сброса паузы звонок идёт сразу.
    await setProvider("google");
    const after = await dial("+992 93 000 73 04");
    expect(after.res.ok).toBe(true);
    expect(after.clients.map((c) => c.kind)).toEqual(["google"]);
  });

  it("смена поставщика в Настройках снимает паузу ElevenLabs (settingsSideEffects)", async () => {
    await setProvider("elevenlabs");
    voice.elevenMode = "reject";
    await dial("+992 93 000 74 01");
    await hangUpAll();
    await dial("+992 93 000 74 02");
    await hangUpAll();
    expect(liveVoiceProviderPaused("elevenlabs")).toBe(true);
    applySettingsSideEffects(["liveVoiceProvider"]);
    expect(liveVoiceProviderPaused("elevenlabs")).toBe(false);
    voice.elevenMode = "ok";
    const call = await dial("+992 93 000 74 03");
    expect(call.res.ok).toBe(true);
    expect(call.clients.map((c) => c.kind)).toEqual(["elevenlabs"]);
  });
});

describe("у ElevenLabs кончились кредиты — робозвонок остановлен, одна тревога", () => {
  it("распознаётся ответ quota_exceeded (и в теле HTTP, и в закрытии сокета)", () => {
    expect(isElevenLabsQuotaError(`ElevenLabs GET /x: ключ не принят. ${quotaBody()}`)).toBe(true);
    expect(isElevenLabsQuotaError("закрыто до начала разговора: код 1008 «This request exceeds your quota»")).toBe(true);
    expect(isElevenLabsQuotaError("ElevenLabs GET /x: ключ не принят. invalid api key")).toBe(false);
    expect(isElevenLabsQuotaError("too many concurrent requests")).toBe(false);
  });

  it("проба сказала «нет кредитов» — «занято», ни одного набора; тревога одна на все попытки", async () => {
    await setProvider("elevenlabs");
    net.signedUrl = "quota";
    const clientsBefore = voice.list.length;
    const first = await dial("+992 93 000 75 01");
    expect(first.res).toMatchObject({ ok: false, busy: true });
    expect(first.dialed).toBe(false);
    expect(elevenLabsQuotaExhausted()).toBe(true);
    const requests = net.requests.length;
    const second = await dial("+992 93 000 75 02");
    expect(second.res).toMatchObject({ ok: false, busy: true });
    expect(second.dialed).toBe(false);
    // Пока отметка «нет кредитов» жива — ElevenLabs не спрашиваем на каждый номер.
    expect(net.requests.length).toBe(requests);
    expect(countKey("elevenlabs-quota-exhausted")).toBe(1);
    const alarm = logged.entries.find((e) => e.key === "elevenlabs-quota-exhausted")!;
    expect(alarm.message).toContain("Робозвонок остановлен");
    expect(alarm.message).toContain("закончились минуты");
    expect(countKey("elevenlabs-probe-failed")).toBe(0);
    // Ни одного клиента голоса — ни ElevenLabs, ни Gemini «в запас».
    expect(voice.list.length).toBe(clientsBefore);
  });

  it("подключение после «алло» сказало «нет кредитов» — отбой; следующий звонок не набирается; входящие — станции", async () => {
    await setProvider("elevenlabs");
    voice.elevenMode = "quota";
    const first = await dial("+992 93 000 76 01");
    await waitFor(() => (first.finished.length > 0 && station.hangups.includes(first.channelId!)) || null, { label: "отбой" });
    expect(first.clients.map((c) => c.kind)).toEqual(["elevenlabs"]);
    expect(first.finished[0].reason.startsWith("start_failed")).toBe(true);
    await hangUpAll();
    const second = await dial("+992 93 000 76 02");
    expect(second.res).toMatchObject({ ok: false, busy: true });
    expect(second.dialed).toBe(false);
    expect(bridge.liveVoiceInboundPaused()).toBe(true);
    // «Нет кредитов» — не поломка ElevenLabs: счёт паузы не растёт, тревога одна.
    expect(liveVoiceProviderPaused("elevenlabs")).toBe(false);
    expect(countKey("elevenlabs-quota-exhausted")).toBe(1);
    expect(countKey("elevenlabs-connect-failed")).toBe(0);
  });

  it("пополнили баланс и сохранили Настройки — отметка снята, звонки снова идут", async () => {
    await setProvider("elevenlabs");
    net.signedUrl = "quota";
    await dial("+992 93 000 77 01");
    expect(elevenLabsQuotaExhausted()).toBe(true);
    net.signedUrl = "ok";
    applySettingsSideEffects(["elevenLabsApiKey"]);
    expect(elevenLabsQuotaExhausted()).toBe(false);
    const call = await dial("+992 93 000 77 02");
    expect(call.res.ok).toBe(true);
    expect(call.clients.map((c) => c.kind)).toEqual(["elevenlabs"]);
  });
});

describe("ревью П1: остаток минут, бронь линии, сброс проб, выбор поставщика", () => {
  it("«нет минут» не гаснет по часам: ссылку не спрашиваем; перепроверка подписки — ноль → стоим, есть → звоним", async () => {
    await setProvider("elevenlabs");
    noteElevenLabsQuotaExhausted("quota_exceeded", "sk_p1_fake_key_not_real");
    const busy = await dial("+992 93 000 78 01");
    expect(busy.res).toMatchObject({ ok: false, busy: true });
    expect(net.requests).not.toContain("/v1/convai/conversation/get-signed-url");
    net.subscription = { used: 100, limit: 100 };
    expect(await recheckElevenLabsQuota()).toBe("still");
    expect(elevenLabsQuotaExhausted()).toBe(true);
    net.subscription = { used: 10, limit: 100 };
    expect(await recheckElevenLabsQuota()).toBe("cleared");
    expect(elevenLabsQuotaExhausted()).toBe(false);
    const call = await dial("+992 93 000 78 02");
    expect(call.res.ok).toBe(true);
    expect(call.clients.map((c) => c.kind)).toEqual(["elevenlabs"]);
  });

  it("остаток спросить не вышло — отметка остаётся, одна запись в журнале", async () => {
    noteElevenLabsQuotaExhausted("quota_exceeded", "sk_p1_fake_key_not_real");
    net.subscription = "fail";
    expect(await recheckElevenLabsQuota()).toBe("failed");
    expect(elevenLabsQuotaExhausted()).toBe(true);
    expect(keys()).toContain("elevenlabs-quota-recheck-failed");
  });

  it("удачный разговор ElevenLabs снимает отметку «нет минут» (проверочный звонок владельца)", async () => {
    await setProvider("elevenlabs");
    noteElevenLabsQuotaExhausted("quota_exceeded", "sk_p1_fake_key_not_real");
    const res = await bridge.originateLiveVoiceTestCall("+992 93 000 78 03");
    expect(res.ok).toBe(true);
    started.push(res.channelId!);
    await onLiveVoiceAriEvent({
      type: "StasisStart",
      application: "royalhome-live-voice",
      args: [],
      channel: { id: res.channelId!, name: `SIP/out-${res.channelId}`, state: "Up", caller: { number: "930007803" } },
    } as never);
    await waitFor(() => !elevenLabsQuotaExhausted() || null, { label: "отметка снята" });
  });

  for (const kind of ["проверочный", "из карточки"] as const) {
    it(`звонок ${kind}: пока шла проба, линию занял другой разговор — второй человек НЕ набирается`, async () => {
      await setProvider("elevenlabs");
      let release!: () => void;
      net.holdSignedUrl = new Promise<void>((r) => (release = r));
      const originatesBefore = station.originates;
      const pending =
        kind === "проверочный"
          ? bridge.originateLiveVoiceTestCall("+992 93 000 79 01")
          : bridge.originateLiveVoiceCallToClient({ id: "p1-race-client", phone: "+992 93 000 79 02", fullName: "Гонка" });
      await waitFor(() => net.requests.includes("/v1/convai/conversation/get-signed-url") || null, { label: "проба началась" });
      // Пока проба ждёт ответа, входящий занимает единственную линию.
      const inbound = `lv-p1-inbound-${kind === "проверочный" ? "t" : "c"}-${Date.now().toString(36)}`;
      started.push(inbound);
      await onLiveVoiceAriEvent({
        type: "StasisStart",
        application: "royalhome-live-voice",
        args: ["inbound"],
        channel: { id: inbound, name: `SIP/in-${inbound}`, state: "Ring", caller: { number: "931112233" } },
      } as never);
      await waitFor(() => liveVoiceLineBusy() || null, { label: "линия занята входящим" });
      const originatesAtRelease = station.originates;
      release();
      const res = await pending;
      expect(res.ok).toBe(false);
      expect(station.originates).toBe(originatesAtRelease);
      expect(originatesAtRelease).toBe(originatesBefore);
    });
  }

  it("итог пробы, начатой до правки Настроек, в память не ложится", async () => {
    await setProvider("elevenlabs");
    let release!: () => void;
    net.holdSignedUrl = new Promise<void>((r) => (release = r));
    net.signedUrl = "fail";
    const first = dial("+992 93 000 79 11");
    await waitFor(() => net.requests.includes("/v1/convai/conversation/get-signed-url") || null, { label: "проба началась" });
    applySettingsSideEffects(["elevenLabsApiKey"]);
    net.signedUrl = "ok";
    release();
    net.holdSignedUrl = null;
    expect((await first).res).toMatchObject({ ok: false, busy: true });
    // Старый отказ не помнится: новая проба (уже удачная) — и звонок идёт.
    const second = await dial("+992 93 000 79 12");
    expect(second.res.ok).toBe(true);
  });

  it("переключили поставщика в Настройках — входящий сразу смотрит паузу нового поставщика", async () => {
    // Мост последним читал «google» (сброс в beforeEach), в базе уже elevenlabs.
    await setProvider("elevenlabs");
    applySettingsSideEffects(["liveVoiceProvider"]);
    noteElevenLabsQuotaExhausted("quota_exceeded", null);
    await waitFor(() => bridge.liveVoiceInboundPaused() || null, { label: "входящий видит «нет минут» ElevenLabs" });
  });
});

describe("прогрев агента при старте", () => {
  it("ElevenLabs недоступен (сеть лежит) — прогрев завершается без исключения", async () => {
    await setProvider("elevenlabs");
    resetElevenLabsSyncCacheForTests();
    await expect(startLiveVoiceAgentWarmup()).resolves.toBeUndefined();
    // Подготовка честно пыталась (запрос был) и честно записала отказ.
    expect(net.requests.length).toBeGreaterThan(0);
    expect(keys()).toContain("elevenlabs-agent-sync");
    resetElevenLabsSyncCacheForTests();
  });

  it("ElevenLabs висит — прогрев отпускает по потолку и пишет об этом; старт его не ждёт", async () => {
    await setProvider("elevenlabs");
    const hanging = vi.fn(() => new Promise<Map<string, string> | null>(() => {}));
    const t0 = Date.now();
    const warm = startLiveVoiceAgentWarmup({ ensure: hanging, budgetMs: 50 });
    await expect(warm).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(keys()).toContain("elevenlabs-warmup-slow");
  });

  it("голос робота — Google: прогрев ничего не делает", async () => {
    await setProvider("google");
    const ensure = vi.fn(async () => new Map<string, string>());
    await startLiveVoiceAgentWarmup({ ensure });
    expect(ensure).not.toHaveBeenCalled();
  });
});

describe("сторож: каждый набор функций, с которым CRM звонит, прогревается", () => {
  const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (name === "generated" || name === "node_modules") return [];
      return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
    });
  }

  it("имена *_TOOLS в строках `tools:` кода сервера — все в списке liveVoiceWarmupToolSets()", () => {
    // Сверяется ТЕЛО функции списка, а не весь файл: имя в строке импорта ничего не прогревает.
    const fileText = readFileSync(join(srcRoot, "lib/telephony/liveVoiceWarmup.ts"), "utf8");
    const start = fileText.indexOf("export function liveVoiceWarmupToolSets(");
    expect(start).toBeGreaterThan(-1);
    const warmupText = fileText.slice(start, fileText.indexOf("\n}\n", start));
    const used = new Set<string>();
    for (const file of walk(srcRoot)) {
      const rel = relative(srcRoot, file).split(sep).join("/");
      if (rel === "lib/telephony/liveVoiceWarmup.ts") continue;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!/\btools:/.test(line)) continue;
        for (const m of line.matchAll(/\b([A-Z][A-Z0-9_]*_TOOLS|consultantToolsFor)\b/g)) {
          // Функции текстового бота в переписке — не звонок, ElevenLabs их не видит.
          if (m[1].startsWith("CUSTOMER_AGENT_")) continue;
          used.add(m[1]);
        }
      }
    }
    expect([...used].sort()).toEqual(
      ["INTERVIEW_INVITE_CALL_TOOLS", "LIVE_VOICE_TOOLS", "POST_SHOWING_CALL_TOOLS", "SELLER_PROBE_CALL_TOOLS", "consultantToolsFor"].sort()
    );
    const missing = [...used].filter((name) => !new RegExp(`\\b${name}\\b`).test(warmupText));
    expect(missing).toEqual([]);
  });

  it("в списке прогрева нет пустых наборов", () => {
    for (const set of liveVoiceWarmupToolSets()) expect(set.tools.length).toBeGreaterThan(0);
  });
});

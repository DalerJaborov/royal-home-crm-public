import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ИСХОДЯЩИЙ РОБОЗВОНОК ИДЁТ ЧЕРЕЗ ВЫБРАННОГО ПОСТАВЩИКА ГОЛОСА (10.11.2026).
 *
 * Приглашение кандидата, опрос после показа и проверка собственника звонят через
 * originateLiveVoiceScenarioCall; сессию поднимает тот же мост, что у входящего,
 * а поставщика выбирает Settings.liveVoiceProvider (ai/liveVoiceProvider.ts).
 * Станция и оба клиента подменены, мост настоящий. Плюс сторож одной двери:
 * клиента голоса в коде сервера создаёт только ai/liveVoiceProvider.ts.
 */

const station = vi.hoisted(() => ({ seq: 0, rtpPort: 41000 + Math.floor(Math.random() * 900) }));

interface FakeProvider {
  kind: "google" | "elevenlabs";
  connectOpts: Record<string, unknown> | null;
}
const clients = vi.hoisted(() => ({ list: [] as FakeProvider[] }));

vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: "http://station", username: "u", password: "p" }),
  originateToStasisApp: async () => ({ ok: true, channelId: `lv-prov-${Date.now().toString(36)}-${++station.seq}` }),
  createBridge: async () => ({ ok: true, bridgeId: `br-prov-${++station.seq}` }),
  createExternalMediaChannel: async () => ({ ok: true, channelId: `UnicastRTP/127.0.0.1-prov-${++station.seq}` }),
  answerChannel: async () => ({ ok: true }),
  addChannelToBridge: async () => ({ ok: true }),
  readChannelVariable: async (_c: unknown, _id: string, name: string) =>
    name === "UNICASTRTP_LOCAL_ADDRESS" ? "127.0.0.1" : name === "UNICASTRTP_LOCAL_PORT" ? String(station.rtpPort) : null,
  deleteBridge: async () => ({ ok: true }),
  hangupCall: async () => ({ ok: true }),
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
    activeModel = kind === "google" ? "fake-live" : "elevenlabs:agent_test";
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
    sendText(): void {}
    sendAudioChunk(): void {}
    sendToolResponse(): void {}
    resendToolResponse(): boolean {
      return false;
    }
    close(): void {}
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

const { prisma } = await import("../src/db.js");
const { onLiveVoiceAriEvent, originateLiveVoiceScenarioCall, liveVoiceLineBusy, resetLiveVoiceAudioPathForTests } = await import(
  "../src/lib/telephony/liveVoiceBridge.js"
);
const { waitFor } = await import("./helpers/waitFor.js");
import type { LiveVoiceFunctionDeclaration } from "../src/ai/liveVoiceClient.js";

const RTP_PORT = 44000 + Math.floor(Math.random() * 900);
const envBefore = { host: process.env.LIVE_VOICE_RTP_HOST, port: process.env.LIVE_VOICE_RTP_PORT, peer: process.env.LIVE_VOICE_RTP_PEER };
let settingsBefore: { liveVoiceEnabled: boolean; liveVoiceProvider: string } | null = null;
const started: string[] = [];

const INVITE_TOOL: LiveVoiceFunctionDeclaration = {
  name: "record_interview_answer",
  description: "Записать ответ кандидата.",
  parameters: { type: "OBJECT", properties: { answer: { type: "STRING", description: "Ответ." } }, required: ["answer"] },
};

async function dialScenario(phone: string): Promise<FakeProvider> {
  const before = clients.list.length;
  const dial = await originateLiveVoiceScenarioCall(phone, {
    systemInstruction: "СЦЕНАРИЙ: приглашение на собеседование",
    tools: [INVITE_TOOL],
    forceRussianOnly: false,
    language: "tg",
  });
  expect(dial.ok).toBe(true);
  const channelId = dial.channelId!;
  started.push(channelId);
  await onLiveVoiceAriEvent({
    type: "StasisStart",
    application: "royalhome-live-voice",
    args: [],
    channel: { id: channelId, name: `SIP/out-${channelId}`, state: "Up", caller: { number: phone.replace(/\D/g, "").slice(-9) } },
  } as never);
  return waitFor(() => (clients.list.length > before && clients.list.at(-1)!.connectOpts ? clients.list.at(-1)! : null), {
    label: "клиент голоса подключён",
  });
}

beforeAll(async () => {
  process.env.LIVE_VOICE_RTP_HOST = "127.0.0.1";
  process.env.LIVE_VOICE_RTP_PORT = String(RTP_PORT);
  delete process.env.LIVE_VOICE_RTP_PEER;
  settingsBefore = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { liveVoiceEnabled: true, liveVoiceProvider: true },
  });
  await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceEnabled: true } });
});

beforeEach(() => resetLiveVoiceAudioPathForTests());

afterEach(async () => {
  for (const id of started.splice(0)) {
    await onLiveVoiceAriEvent({ type: "StasisEnd", channel: { id, name: `SIP/out-${id}`, state: "Up", caller: {} } } as never);
  }
  await waitFor(() => !liveVoiceLineBusy(), { timeoutMs: 6000, label: "линия свободна" });
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
  await prisma.liveVoiceSession.deleteMany({ where: { channelId: { startsWith: "lv-prov-" } } });
  await prisma.aiLog.deleteMany({ where: { conversationId: { startsWith: "lv-prov-" } } });
});

describe("сценарный исходящий звонок и переключатель поставщика", () => {
  it("Настройки = elevenlabs — звонок идёт через ElevenLabs с промтом, функциями и языком сценария", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceProvider: "elevenlabs" } });
    const client = await dialScenario("+992 93 000 81 01");
    expect(client.kind).toBe("elevenlabs");
    expect(String(client.connectOpts!.systemInstruction)).toContain("СЦЕНАРИЙ: приглашение на собеседование");
    expect(client.connectOpts!.tools).toEqual([INVITE_TOOL]);
    expect(client.connectOpts!.language).toBe("tg");
  });

  it("Настройки = google (по умолчанию) — тот же звонок идёт через Gemini", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceProvider: "google" } });
    const client = await dialScenario("+992 93 000 81 02");
    expect(client.kind).toBe("google");
    expect(client.connectOpts!.tools).toEqual([INVITE_TOOL]);
  });
});

describe("сторож одной двери: клиента голоса создаёт только ai/liveVoiceProvider.ts", () => {
  const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (name === "generated" || name === "node_modules") return [];
      return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
    });
  }
  const files = walk(srcRoot).map((f) => ({ rel: relative(srcRoot, f).split(sep).join("/"), text: readFileSync(f, "utf8") }));

  it("new ElevenLabsVoiceClient( — только в liveVoiceProvider.ts", () => {
    const hits = files.filter((f) => /new\s+ElevenLabsVoiceClient\s*\(/.test(f.text)).map((f) => f.rel);
    expect(hits).toEqual(["ai/liveVoiceProvider.ts"]);
  });

  it("new LiveVoiceClient( — в liveVoiceProvider.ts и в превью приветствия (liveVoiceClient.ts), больше нигде", () => {
    // Превью (previewLiveVoiceGreeting) — кнопка «послушать приветствие» в Настройках,
    // не звонок: оно пока всегда звучит голосом Gemini. Новый звонок мимо переключателя
    // сделает этот список длиннее, и тест покраснеет.
    const hits = files
      .filter((f) => /new\s+LiveVoiceClient\s*\(/.test(f.text.replace(/^\s*\*.*$/gm, "")))
      .map((f) => f.rel)
      .sort();
    expect(hits).toEqual(["ai/liveVoiceClient.ts", "ai/liveVoiceProvider.ts"]);
  });
});

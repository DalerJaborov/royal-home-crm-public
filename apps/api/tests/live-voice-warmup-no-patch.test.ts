import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import type WebSocket from "ws";

/**
 * П1 (11.11.2026, находка В6): после кнопки «Проверить агента» звонок любого вида
 * НЕ готовит агента заново — ни одного PATCH/POST перед разговором. Кнопка и
 * звонок идут одной дверью (lib/telephony/liveVoiceWarmup.ts → ensureElevenLabsAgentReady)
 * с одинаковыми аргументами, поэтому память подготовки звонку достаётся.
 * Сеть ElevenLabs подменена (fetch и сокет), ключ ненастоящий.
 */

// Голая копия без секретов входа (.env только с базой): вход тестового админа подписывает
// маркер этим ключом. Настоящее значение окружения не перекрывается.
vi.hoisted(() => {
  process.env.JWT_ACCESS_SECRET ??= "p1-test-access-secret";
  process.env.JWT_REFRESH_SECRET ??= "p1-test-refresh-secret";
});

vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: async () => {},
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { grantElevation } = await import("../src/lib/stepUp.js");
const { ElevenLabsVoiceClient } = await import("../src/ai/elevenLabsVoiceClient.js");
const { loadLiveVoiceProviderConfig } = await import("../src/ai/liveVoiceProvider.js");
const { resetElevenLabsSyncCacheForTests } = await import("../src/ai/elevenLabsAgentSync.js");
const { liveVoiceWarmupToolSets } = await import("../src/lib/telephony/liveVoiceWarmup.js");

const runId = Date.now();
const password = "testpass123";
let adminId: string;
let token: string;
let saved: Record<string, unknown> | null = null;
const keyBefore = process.env.ELEVENLABS_API_KEY;

type Call = { method: string; path: string };
let calls: Call[] = [];

const AGENT = {
  name: "Тестовый агент П1",
  conversation_config: {
    agent: { language: "ru", first_message: "", prompt: { prompt: "кабинет", tool_ids: [] } },
    tts: { voice_id: "larisa" },
  },
  platform_settings: {},
};

function stubNetwork(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const method = String(init?.method ?? "GET");
      const path = new URL(String(url)).pathname;
      calls.push({ method, path });
      let json: unknown = {};
      if (method === "GET" && path === "/v1/convai/tools") json = { tools: [] };
      else if (method === "POST" && path === "/v1/convai/tools") {
        const body = JSON.parse(String(init.body)) as { tool_config?: { name?: string } };
        json = { id: `tool_${body.tool_config?.name ?? "x"}` };
      } else if (method === "GET" && path.startsWith("/v1/convai/agents/")) json = AGENT;
      return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
    })
  );
}

/** Поддельный сокет разговора: открылся, принял первое сообщение, прислал metadata. */
class FakeSocket extends EventEmitter {
  readyState = 0;
  send(): void {
    setImmediate(() =>
      this.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "conversation_initiation_metadata",
            conversation_initiation_metadata_event: {
              conversation_id: "conv_p1",
              agent_output_audio_format: "ulaw_8000",
              user_input_audio_format: "ulaw_8000",
            },
          })
        )
      )
    );
  }
  close(): void {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }
}

beforeAll(async () => {
  process.env.ELEVENLABS_API_KEY = "sk_p1_fake_key_not_real";
  saved = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { liveVoiceProvider: true, elevenLabsApiKey: true, elevenLabsAgentId: true, elevenLabsVoiceIdTg: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    // Пробелы вокруг голоса — нарочно: кнопка и звонок обязаны обрезать их одинаково.
    data: { liveVoiceProvider: "elevenlabs", elevenLabsApiKey: null, elevenLabsAgentId: "agent_p1_warm", elevenLabsVoiceIdTg: " voice_tg " },
  });
  const admin = await prisma.agent.create({
    data: { fullName: "Админ П1", phone: `+992937${String(runId).slice(-6)}`, role: "ADMIN", passwordHash: await bcrypt.hash(password, 10) },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  token = res.body.accessToken;
  grantElevation(adminId);
});

beforeEach(() => {
  calls = [];
  resetElevenLabsSyncCacheForTests();
  stubNetwork();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  if (keyBefore === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = keyBefore;
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.agent.delete({ where: { id: adminId } }).catch(() => {});
  resetElevenLabsSyncCacheForTests();
});

async function connectCall(tools: ReturnType<typeof liveVoiceWarmupToolSets>[number]["tools"]): Promise<void> {
  const config = await loadLiveVoiceProviderConfig();
  if (config.provider !== "elevenlabs") throw new Error("ожидался ElevenLabs");
  // Тот же конструктор и та же подготовка, что у звонка; подменены только ссылка и сокет.
  const client = new ElevenLabsVoiceClient(config, {
    signedUrl: async () => "wss://example.test/convai?token=t",
    socketFactory: () => {
      const ws = new FakeSocket();
      setImmediate(() => {
        ws.readyState = 1;
        ws.emit("open");
      });
      return ws as unknown as WebSocket;
    },
  });
  await client.connect({ systemInstruction: "тест", tools, language: "ru" } as never);
  client.close();
}

const writes = () => calls.filter((c) => c.method === "PATCH" || c.method === "POST" || c.path === "/v1/convai/tools");

describe("кнопка «Проверить агента» греет память подготовки для каждого вида звонка", () => {
  it("после кнопки — ни одного PATCH/POST ни у одного вида звонка", async () => {
    const res = await request(app).post("/api/v1/settings/live-voice/elevenlabs-check").set("Authorization", `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.agentName).toBe(AGENT.name);
    expect(res.body.toolsSynced).toBeGreaterThan(0);
    expect(writes().length).toBeGreaterThan(0);

    calls = [];
    for (const set of liveVoiceWarmupToolSets()) await connectCall(set.tools);
    expect(writes()).toEqual([]);
  });

  it("без кнопки первый звонок готовит агента сам (иначе тест выше ничего не доказывает)", async () => {
    const [first] = liveVoiceWarmupToolSets();
    await connectCall(first.tools);
    expect(calls.filter((c) => c.method === "PATCH").length).toBeGreaterThan(0);
  });
});

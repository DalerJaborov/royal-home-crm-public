import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { AddressInfo } from "node:net";

/**
 * ОТКАЗЫ GEMINI (09.10.2026, docs/robot-audit-2026-10-09-pipeline.md, п.7–9):
 *  - квота/деньги и ключ — отдельные постоянные ключи журнала, а не общий «start_failed»;
 *  - 429/403 на рукопожатии — запасной ключ (другой проект Google — другая квота);
 *  - обрыв посреди разговора без продолжения — запись в журнал (раньше только endedReason).
 * Настоящий Google заменён локальным WebSocket-сервером (как в live-voice-client-audit3).
 */
const keys = vi.hoisted(() => ({ first: "bad-key", all: ["bad-key", "good-key"] }));
vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGeminiKey: async () => keys.first,
  resolveGeminiKeys: async () => keys.all,
}));
const logged = vi.hoisted(() => ({ entries: [] as { message: string; key?: string }[] }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logSystemError: vi.fn(async (_s: string, message: string, opts?: { dedupKey?: string }) => {
    logged.entries.push({ message, key: opts?.dedupKey });
  }),
}));

import { classifyGeminiFailure, LiveVoiceClient } from "../src/ai/liveVoiceClient.js";

let server: WebSocketServer;
let sockets: ServerSocket[] = [];
const usedKeys: string[] = [];
const ORIGINAL_PROXY = process.env.GEMINI_PROXY_URL;

beforeEach(async () => {
  logged.entries.length = 0;
  usedKeys.length = 0;
  sockets = [];
  keys.first = "bad-key";
  keys.all = ["bad-key", "good-key"];
  server = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    // Ключ «bad-key» — как кончившаяся квота у Google: 429 на рукопожатии.
    verifyClient: (info, cb) => {
      const key = new URL(info.req.url ?? "/", "http://x").searchParams.get("key") ?? "";
      usedKeys.push(key);
      if (key === "bad-key") cb(false, 429, "Too Many Requests");
      else cb(true);
    },
  });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (raw) => {
      if ((JSON.parse(raw.toString()) as { setup?: unknown }).setup) socket.send(JSON.stringify({ setupComplete: {} }));
    });
  });
  process.env.GEMINI_PROXY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (ORIGINAL_PROXY === undefined) delete process.env.GEMINI_PROXY_URL;
  else process.env.GEMINI_PROXY_URL = ORIGINAL_PROXY;
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > ms) throw new Error("не дождались");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("разбор отказа Google", () => {
  it("квота/деньги, ключ, прочее", () => {
    expect(classifyGeminiFailure("Unexpected server response: 429")).toBe("quota");
    expect(classifyGeminiFailure("закрыто до setupComplete: код 1008 «RESOURCE_EXHAUSTED»")).toBe("quota");
    expect(classifyGeminiFailure('{"code":400,"message":"Billing account not active"}')).toBe("quota");
    expect(classifyGeminiFailure("Unexpected server response: 403")).toBe("key");
    expect(classifyGeminiFailure("1008 API key not valid. Please pass a valid API key.")).toBe("key");
    expect(classifyGeminiFailure("закрыто до setupComplete: код 1011 «Internal error»")).toBeNull();
    expect(classifyGeminiFailure("connect ETIMEDOUT")).toBeNull();
  });
});

describe("429 на рукопожатии", () => {
  it("первый ключ без квоты — сессия открывается на запасном; в журнале «квота»", async () => {
    const client = new LiveVoiceClient();
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null });
    expect(usedKeys).toEqual(["bad-key", "good-key"]);
    expect(logged.entries.map((e) => e.key)).toContain("live-voice-gemini-quota");
    client.close();
  });

  it("запасного ключа нет — отказ наружу (мост отдаст звонок станции), квота в журнале", async () => {
    keys.all = ["bad-key"];
    const client = new LiveVoiceClient();
    await expect(client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null })).rejects.toThrow(/429/);
    expect(logged.entries.map((e) => e.key)).toContain("live-voice-gemini-quota");
    client.close();
  });
});

describe("обрыв посреди разговора", () => {
  it("модель говорила, сокет закрылся, продолжать нечем — запись в журнал с постоянным ключом", async () => {
    keys.first = "good-key";
    const client = new LiveVoiceClient();
    const closed = vi.fn();
    client.on("close", closed);
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null });
    // Модель «заговорила» — сессия зажила, ранней смерти уже нет.
    sockets[0].send(JSON.stringify({ serverContent: { turnComplete: true } }));
    await new Promise((r) => setTimeout(r, 50));
    sockets[0].close(1011, "Internal error");
    await until(() => closed.mock.calls.length > 0);
    expect(logged.entries.map((e) => e.key)).toContain("live-voice-gemini-closed-midcall");
    client.close();
  });
});

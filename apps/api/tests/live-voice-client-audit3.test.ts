import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { AddressInfo } from "node:net";

/**
 * Аудит 3, клиент живого голоса (02.10.2026):
 *  п.9  ответ функции, который уже отправлялся, можно повторить (мост повторяет его на
 *       повторный вызов, а не молчит);
 *  п.14 одна попытка переподключения укладывается в остаток общего потолка «связи нет».
 * Настоящий Google заменён локальным WebSocket-сервером (как в live-voice-session-resume).
 */
vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGeminiKey: async () => "test-key",
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logSystemError: vi.fn(async () => {}),
}));

import { LiveVoiceClient, liveVoiceAttemptTimeouts } from "../src/ai/liveVoiceClient.js";

let server: WebSocketServer;
const received: string[] = [];
let sockets: ServerSocket[] = [];
const ORIGINAL_PROXY = process.env.GEMINI_PROXY_URL;

beforeEach(async () => {
  received.length = 0;
  sockets = [];
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (raw) => {
      const text = raw.toString();
      if ((JSON.parse(text) as { setup?: unknown }).setup) socket.send(JSON.stringify({ setupComplete: {} }));
      else received.push(text);
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

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > ms) throw new Error("не дождались");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("п.9: повтор ответа функции", () => {
  it("отправленный ответ повторяется из кэша тем же сообщением; на неизвестный id — false", async () => {
    const client = new LiveVoiceClient();
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null });
    const call = { id: "fc-1", name: "search_properties", args: {} };
    client.sendToolResponse(call, { ok: true });
    await until(() => received.length === 1);

    expect(client.resendToolResponse(call)).toBe(true);
    await until(() => received.length === 2);
    expect(received[1]).toBe(received[0]);
    expect(client.resendToolResponse({ id: "fc-other", name: "x", args: {} })).toBe(false);
    client.close();
  });
});

describe("п.14: срок одной попытки", () => {
  it("без бюджета — полные 15 и 10 с; с бюджетом попытка не выходит за остаток потолка", () => {
    expect(liveVoiceAttemptTimeouts(undefined, 0)).toEqual({ handshakeMs: 15_000, setupMs: 10_000 });
    // До потолка 30 с осталось 9 с: рукопожатие — не дольше, setup — остаток за вычетом ушедшего.
    expect(liveVoiceAttemptTimeouts(9_000, 0)).toEqual({ handshakeMs: 9_000, setupMs: 9_000 });
    expect(liveVoiceAttemptTimeouts(9_000, 4_000)).toEqual({ handshakeMs: 9_000, setupMs: 5_000 });
    // Остатка почти нет — секунда на setup, а не десять.
    expect(liveVoiceAttemptTimeouts(2_000, 1_900).setupMs).toBe(1_000);
    // Много времени — прежние пределы.
    expect(liveVoiceAttemptTimeouts(30_000, 0)).toEqual({ handshakeMs: 15_000, setupMs: 10_000 });
  });
});

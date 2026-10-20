import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { AddressInfo } from "node:net";

/**
 * Сессию Gemini Live закрыли, пока открывался сокет (02.10.2026, аудит надёжности
 * робозвонка): звонящий положил трубку на приветствии, мост позвал close(), а
 * connect() всё равно принимал новый сокет и держал платное соединение без
 * хозяина. Google заменён локальным WebSocket-сервером, как в
 * live-voice-session-resume.test.ts.
 */
vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiClient.js")>()),
  resolveGeminiKey: async () => "test-key",
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn(async () => {}),
}));

const { LiveVoiceClient } = await import("../src/ai/liveVoiceClient.js");

let server: WebSocketServer;
let pendingSetup: ServerSocket | null;
let serverSideClosed: boolean;
const ORIGINAL_PROXY = process.env.GEMINI_PROXY_URL;

beforeEach(async () => {
  pendingSetup = null;
  serverSideClosed = false;
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  server.on("connection", (socket) => {
    socket.on("close", () => {
      serverSideClosed = true;
    });
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { setup?: unknown };
      // setupComplete не шлём сразу: тест сам решает, когда «Google» ответит.
      if (msg.setup) pendingSetup = socket;
    });
  });
  const { port } = server.address() as AddressInfo;
  process.env.GEMINI_PROXY_URL = `http://127.0.0.1:${port}`;
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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("LiveVoiceClient: close() посреди подключения", () => {
  it("connect бросает, а сокет, открывшийся после close(), закрывается, и «ready» не приходит", async () => {
    const client = new LiveVoiceClient();
    const ready = vi.fn();
    client.on("ready", ready);
    const connecting = client.connect({ systemInstruction: "x", model: "gemini-3.8-live" });
    const outcome = connecting.then(
      () => "connected",
      (err: Error) => err.message
    );

    await until(() => pendingSetup !== null);
    client.close();
    pendingSetup!.send(JSON.stringify({ setupComplete: {} }));

    expect(await outcome).toContain("закрыта до подключения");
    await until(() => serverSideClosed);
    expect(ready).not.toHaveBeenCalled();
  });
});

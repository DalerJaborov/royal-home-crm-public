import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { AddressInfo } from "node:net";

/**
 * Живой голос, правка 1 робозвонка-консультанта (24.09.2026): откат на запасную
 * модель и продолжение сессии после GoAway. Настоящий Google здесь заменён
 * локальным WebSocket-сервером, который отвечает тем же протоколом (setup →
 * setupComplete, sessionResumptionUpdate, goAway) — клиент ходит к нему через
 * GEMINI_PROXY_URL ровно тем путём, каким в проде ходит к прокси-Worker.
 */
vi.mock("../src/ai/geminiClient.js", () => ({ resolveGeminiKey: async () => "test-key" }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn(async () => {}) }));

import { LiveVoiceClient } from "../src/ai/liveVoiceClient.js";
import { GEMINI_LIVE_LEGACY_MODEL, liveModelSupportsAsyncTools, liveVoiceModelChain } from "../src/ai/geminiTransport.js";

interface SetupSeen {
  model: string;
  handle: string | null;
  socket: ServerSocket;
}

let server: WebSocketServer;
let setups: SetupSeen[];
/** Что сервер делает с очередным setup — по умолчанию принимает. */
let onSetup: (seen: SetupSeen) => void;
const ORIGINAL_PROXY = process.env.GEMINI_PROXY_URL;

beforeEach(async () => {
  setups = [];
  onSetup = (seen) => seen.socket.send(JSON.stringify({ setupComplete: {} }));
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { setup?: { model: string; sessionResumption?: { handle?: string } } };
      if (!msg.setup) return;
      const seen: SetupSeen = {
        model: msg.setup.model.replace(/^models\//, ""),
        handle: msg.setup.sessionResumption?.handle ?? null,
        socket,
      };
      setups.push(seen);
      onSetup(seen);
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

function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - started > ms) return reject(new Error("не дождались"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("цепочка моделей живого голоса", () => {
  it("основная модель первой, прежняя запасной, без повторов", () => {
    expect(liveVoiceModelChain("gemini-3.8-live")).toEqual(["gemini-3.8-live", GEMINI_LIVE_LEGACY_MODEL]);
    expect(liveVoiceModelChain(GEMINI_LIVE_LEGACY_MODEL)).toEqual([GEMINI_LIVE_LEGACY_MODEL]);
  });

  it("асинхронные функции — только у линейки 3.8 и новее", () => {
    expect(liveModelSupportsAsyncTools("gemini-3.8-live")).toBe(true);
    expect(liveModelSupportsAsyncTools("gemini-3.8-live-extended-thinking")).toBe(true);
    expect(liveModelSupportsAsyncTools("gemini-4.0-live")).toBe(true);
    expect(liveModelSupportsAsyncTools("gemini-3.1-flash-live-preview")).toBe(false);
    expect(liveModelSupportsAsyncTools("gemini-2.5-flash-native-audio-preview-12-2025")).toBe(false);
    expect(liveModelSupportsAsyncTools("что-то другое")).toBe(false);
  });
});

describe("LiveVoiceClient: откат на запасную модель", () => {
  it("основная модель закрыла соединение до setupComplete — сессия открывается на запасной", async () => {
    onSetup = (seen) => {
      if (seen.model === "gemini-3.8-live") seen.socket.close(1008, "model not found");
      else seen.socket.send(JSON.stringify({ setupComplete: {} }));
    };
    const client = new LiveVoiceClient();
    const ready = vi.fn();
    client.on("ready", ready);
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live" });
    expect(setups.map((s) => s.model)).toEqual(["gemini-3.8-live", GEMINI_LIVE_LEGACY_MODEL]);
    expect(client.activeModel).toBe(GEMINI_LIVE_LEGACY_MODEL);
    expect(client.asyncTools).toBe(false);
    expect(ready).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("обе модели отказали — connect бросает, а не висит", async () => {
    onSetup = (seen) => seen.socket.close(1008, "nope");
    const client = new LiveVoiceClient();
    await expect(client.connect({ systemInstruction: "x", model: "gemini-3.8-live" })).rejects.toThrow();
    client.close();
  });

  it("setup просит присылать токены продолжения даже на первом соединении", async () => {
    let rawSetup: Record<string, unknown> | null = null;
    server.on("connection", (socket) =>
      socket.once("message", (raw) => {
        rawSetup = (JSON.parse(raw.toString()) as { setup: Record<string, unknown> }).setup;
      })
    );
    const client = new LiveVoiceClient();
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null });
    expect(rawSetup!.sessionResumption).toEqual({});
    client.close();
  });
});

describe("LiveVoiceClient: продолжение сессии", () => {
  it("GoAway в паузе — новое соединение с токеном, наружу resumed, а не close", async () => {
    const client = new LiveVoiceClient();
    const closed = vi.fn();
    const resumed = vi.fn();
    const ready = vi.fn();
    client.on("close", closed);
    client.on("resumed", resumed);
    client.on("ready", ready);
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null });

    const first = setups[0].socket;
    first.send(JSON.stringify({ sessionResumptionUpdate: { newHandle: "h-1", resumable: true } }));
    first.send(JSON.stringify({ goAway: { timeLeft: "5s" } }));

    await waitFor(() => resumed.mock.calls.length === 1);
    expect(setups).toHaveLength(2);
    expect(setups[1].handle).toBe("h-1");
    expect(setups[1].model).toBe("gemini-3.8-live");
    expect(closed).not.toHaveBeenCalled();
    // Приветствие не повторяется: "ready" — один раз за звонок.
    expect(ready).toHaveBeenCalledTimes(1);

    // Звук после подмены идёт в новое соединение.
    const got: string[] = [];
    setups[1].socket.on("message", (raw) => got.push(raw.toString()));
    client.sendAudioChunk(Buffer.alloc(640));
    await waitFor(() => got.some((m) => m.includes("realtimeInput")));
    client.close();
  });

  it("GoAway посреди реплики — подмена ждёт turnComplete", async () => {
    const client = new LiveVoiceClient();
    const resumed = vi.fn();
    client.on("resumed", resumed);
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null });
    const first = setups[0].socket;
    first.send(JSON.stringify({ sessionResumptionUpdate: { newHandle: "h-2", resumable: true } }));
    first.send(
      JSON.stringify({
        serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(48).toString("base64"), mimeType: "audio/pcm;rate=24000" } }] } },
      })
    );
    first.send(JSON.stringify({ goAway: { timeLeft: "30s" } }));
    await new Promise((r) => setTimeout(r, 150));
    expect(setups).toHaveLength(1);
    first.send(JSON.stringify({ serverContent: { turnComplete: true } }));
    await waitFor(() => resumed.mock.calls.length === 1);
    expect(setups[1].handle).toBe("h-2");
    client.close();
  });

  it("соединение оборвалось без GoAway — переподключение по последнему годному токену", async () => {
    const client = new LiveVoiceClient();
    const resumed = vi.fn();
    const closed = vi.fn();
    client.on("resumed", resumed);
    client.on("close", closed);
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null });
    const first = setups[0].socket;
    first.send(JSON.stringify({ sessionResumptionUpdate: { newHandle: "good", resumable: true } }));
    // Посреди генерации Google присылает негодный токен — его брать нельзя.
    first.send(JSON.stringify({ sessionResumptionUpdate: { newHandle: "bad", resumable: false } }));
    await new Promise((r) => setTimeout(r, 50));
    first.close(1011, "internal");
    await waitFor(() => resumed.mock.calls.length === 1);
    expect(setups[1].handle).toBe("good");
    expect(closed).not.toHaveBeenCalled();
    client.close();
  });

  it("токена нет — обрыв честно заканчивает сессию событием close", async () => {
    const client = new LiveVoiceClient();
    const closed = vi.fn();
    client.on("close", closed);
    // Запасная модель (она же последняя в цепочке): ранний отказ уже не откатывается
    // дальше, и без токена обрыв честно кончает сессию.
    await client.connect({ systemInstruction: "x", model: GEMINI_LIVE_LEGACY_MODEL, resumeHandle: null });
    setups[0].socket.close(1011, "internal");
    await waitFor(() => closed.mock.calls.length === 1);
    expect(setups).toHaveLength(1);
    client.close();
  });

  it("сами закрыли сессию — никаких переподключений", async () => {
    const client = new LiveVoiceClient();
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null });
    setups[0].socket.send(JSON.stringify({ sessionResumptionUpdate: { newHandle: "h", resumable: true } }));
    await new Promise((r) => setTimeout(r, 50));
    client.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(setups).toHaveLength(1);
  });
});

describe("LiveVoiceClient: ответ на вызов функции", () => {
  it("scheduling уходит только модели с асинхронными функциями", async () => {
    const got: string[] = [];
    server.on("connection", (socket) => socket.on("message", (raw) => got.push(raw.toString())));
    const client = new LiveVoiceClient();
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live" });
    client.sendToolResponse({ id: "1", name: "save_contact", args: {} }, { ok: true }, "SILENT");
    await waitFor(() => got.some((m) => m.includes("toolResponse")));
    const sent = JSON.parse(got.find((m) => m.includes("toolResponse"))!);
    expect(sent.toolResponse.functionResponses[0].response).toEqual({ ok: true, scheduling: "SILENT" });
    client.close();
  });

  it("прежней модели scheduling не отправляется", async () => {
    const got: string[] = [];
    server.on("connection", (socket) => socket.on("message", (raw) => got.push(raw.toString())));
    const client = new LiveVoiceClient();
    await client.connect({ systemInstruction: "x", model: GEMINI_LIVE_LEGACY_MODEL });
    client.sendToolResponse({ id: "1", name: "save_contact", args: {} }, { ok: true }, "SILENT");
    await waitFor(() => got.some((m) => m.includes("toolResponse")));
    const sent = JSON.parse(got.find((m) => m.includes("toolResponse"))!);
    expect(sent.toolResponse.functionResponses[0].response).toEqual({ ok: true });
    client.close();
  });
});

describe("LiveVoiceClient: надёжность обрыва (02.10.2026, аудит В3/В4/В7)", () => {
  it("В4: основная модель закрыла сокет вскоре ПОСЛЕ setupComplete — открывается запасная, один раз за звонок", async () => {
    // Основная принимает setup, а потом закрывает сокет (отказ на служебной реплике).
    onSetup = (seen) => {
      seen.socket.send(JSON.stringify({ setupComplete: {} }));
      if (seen.model === "gemini-3.8-live") setTimeout(() => seen.socket.close(1011, "internal"), 40);
    };
    const client = new LiveVoiceClient();
    const fallback = vi.fn();
    client.on("fallback", fallback);
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null });
    await waitFor(() => fallback.mock.calls.length === 1);
    expect(setups.map((s) => s.model)).toEqual(["gemini-3.8-live", GEMINI_LIVE_LEGACY_MODEL]);
    expect(client.activeModel).toBe(GEMINI_LIVE_LEGACY_MODEL);
    expect(client.asyncTools).toBe(false);

    // Запасная тоже умерла рано — второго отката нет, сессия честно заканчивается.
    const closed = vi.fn();
    client.on("close", closed);
    setups[1].socket.close(1011, "internal");
    await waitFor(() => closed.mock.calls.length === 1);
    expect(setups).toHaveLength(2);
    client.close();
  });

  it("В4: уже заговорившая модель при обрыве продолжает по токену, а не откатывается на запасную", async () => {
    const client = new LiveVoiceClient();
    const resumed = vi.fn();
    client.on("resumed", resumed);
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null });
    setups[0].socket.send(JSON.stringify({ sessionResumptionUpdate: { newHandle: "h", resumable: true } }));
    setups[0].socket.send(JSON.stringify({ serverContent: { turnComplete: true } }));
    await new Promise((r) => setTimeout(r, 50));
    setups[0].socket.close(1011, "internal");
    await waitFor(() => resumed.mock.calls.length === 1);
    expect(setups.map((s) => s.model)).toEqual(["gemini-3.8-live", "gemini-3.8-live"]);
    client.close();
  });

  it("В3: реплика, отправленная во время переподключения, не пропадает — уходит на новом соединении", async () => {
    const client = new LiveVoiceClient();
    const reconnecting = vi.fn();
    const resumed = vi.fn();
    client.on("reconnecting", reconnecting);
    client.on("resumed", resumed);
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null });
    setups[0].socket.send(JSON.stringify({ sessionResumptionUpdate: { newHandle: "h", resumable: true } }));
    await new Promise((r) => setTimeout(r, 50));

    // Новое соединение принимается не сразу: окно, в котором связи нет.
    const received: string[] = [];
    let completeSetup: () => void = () => {};
    onSetup = (seen) => {
      completeSetup = () => seen.socket.send(JSON.stringify({ setupComplete: {} }));
      seen.socket.on("message", (raw) => received.push(raw.toString()));
    };
    setups[0].socket.close(1011, "internal");
    await waitFor(() => reconnecting.mock.calls.length === 1);
    client.sendText("Алло, вы меня слышите?");
    expect(received).toHaveLength(0);

    await waitFor(() => setups.length === 2);
    completeSetup();
    await waitFor(() => resumed.mock.calls.length === 1);
    await waitFor(() => received.some((m) => m.includes("Алло, вы меня слышите?")));
    client.close();
  });

  it("В3: между неудачными попытками переподключения есть пауза, а не залп", async () => {
    const client = new LiveVoiceClient();
    const closed = vi.fn();
    client.on("close", closed);
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null });
    setups[0].socket.send(JSON.stringify({ sessionResumptionUpdate: { newHandle: "h", resumable: true } }));
    await new Promise((r) => setTimeout(r, 50));

    const at: number[] = [];
    onSetup = (seen) => {
      at.push(Date.now());
      seen.socket.close(1008, "nope");
    };
    setups[0].socket.close(1011, "internal");
    await waitFor(() => closed.mock.calls.length === 1, 10_000);
    expect(at.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(400);
    client.close();
  });

  it("В3: отмена вызова функции (toolCallCancellation) доходит до слушателей с id", async () => {
    const client = new LiveVoiceClient();
    const cancelled = vi.fn();
    client.on("toolCallCancellation", cancelled);
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null });
    setups[0].socket.send(JSON.stringify({ toolCallCancellation: { ids: ["call-1", "call-2"] } }));
    await waitFor(() => cancelled.mock.calls.length === 1);
    expect(cancelled.mock.calls[0][0]).toEqual(["call-1", "call-2"]);
    client.close();
  });

  it("В7: исключение в слушателе не вылетает из сокета и не мешает следующим событиям", async () => {
    const client = new LiveVoiceClient();
    const audio = vi.fn();
    client.on("transcript", () => {
      throw new Error("слушатель упал");
    });
    client.on("audio", audio);
    await client.connect({ systemInstruction: "x", model: "gemini-3.8-live", resumeHandle: null });
    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      setups[0].socket.send(JSON.stringify({ serverContent: { outputTranscription: { text: "Здравствуйте" } } }));
      setups[0].socket.send(
        JSON.stringify({
          serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(480).toString("base64") } }] } },
        })
      );
      await waitFor(() => audio.mock.calls.length === 1);
      expect(uncaught).toHaveLength(0);
    } finally {
      process.off("uncaughtException", onUncaught);
      client.close();
    }
  });
});

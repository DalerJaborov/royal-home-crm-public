import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CHANNEL-NEW-37 (04.10.2026): остановка или перезапуск подписки ARI во время чтения
 * настроек (loadAriCredentials) не отменяла начатое подключение: сокет создавался
 * после stopAriEvents, а при перезапуске новый connect() отбрасывался флагом
 * `connecting`, и подписка держалась на сокете со старыми настройками.
 * WebSocket и станция подменены.
 */

const sockets = vi.hoisted(() => [] as { url: string }[]);
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    url: string;
    constructor(url: string) {
      super();
      this.url = url;
      sockets.push(this);
    }
    close(): void {
      this.readyState = 3;
    }
    ping(): void {}
    terminate(): void {}
  }
  return { default: FakeWebSocket };
});

const loads = vi.hoisted(() => [] as ((creds: { url: string; username: string; password: string } | null) => void)[]);
vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: vi.fn(() => new Promise((resolve) => loads.push(resolve as never))),
  listActiveChannels: vi.fn().mockResolvedValue([]),
  readChannelVariable: vi.fn().mockResolvedValue(null),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/lib/telephony/callTracker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/callTracker.js")>()),
  finishCall: vi.fn(),
  getCall: vi.fn(() => undefined),
  reconcileOrphanedOutgoingCalls: vi.fn().mockResolvedValue(0),
  setCallState: vi.fn(),
  talkSeconds: vi.fn(() => 0),
}));
vi.mock("../src/lib/telephony/callRecordings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/callRecordings.js")>()),
  forgetRecordingPath: vi.fn(),
  ingestCallRecording: vi.fn(),
  rememberRecordingPath: vi.fn(),
}));
vi.mock("../src/lib/telephony/incomingCalls.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/incomingCalls.js")>()),
  classifyInboundChannel: vi.fn(() => ({ inbound: false, reason: "context" })),
  finishIncomingCall: vi.fn(),
  isInboundChannel: vi.fn(() => false),
  isTrackedIncoming: vi.fn(() => false),
  markIncomingBridged: vi.fn(),
  noteRejectedInbound: vi.fn(),
  refreshInboundContexts: vi.fn().mockResolvedValue(undefined),
  startIncomingCall: vi.fn(),
}));

const CREDS_OLD = { url: "http://old-station:8088", username: "u", password: "p" };
const CREDS_NEW = { url: "http://new-station:8088", username: "u", password: "p" };

describe("ariEvents: остановка и перезапуск во время чтения настроек", () => {
  beforeEach(() => {
    sockets.length = 0;
    loads.length = 0;
  });
  afterEach(async () => {
    const { stopAriEvents } = await import("../src/lib/telephony/ariEvents.js");
    stopAriEvents();
    vi.resetModules();
  });

  it("stopAriEvents до окончания чтения — сокет не создаётся", async () => {
    const { startAriEvents, stopAriEvents } = await import("../src/lib/telephony/ariEvents.js");
    startAriEvents();
    await new Promise((r) => setImmediate(r));
    expect(loads).toHaveLength(1);
    stopAriEvents();
    loads[0](CREDS_OLD);
    await new Promise((r) => setImmediate(r));
    expect(sockets).toHaveLength(0);
  });

  it("restartAriEvents до окончания чтения — подключение повторяется с новыми настройками, сокет один", async () => {
    const { startAriEvents, restartAriEvents } = await import("../src/lib/telephony/ariEvents.js");
    startAriEvents();
    await new Promise((r) => setImmediate(r));
    restartAriEvents();
    // Первое чтение вернулось со старыми настройками: по ним сокет не открывается.
    loads[0](CREDS_OLD);
    await new Promise((r) => setImmediate(r));
    expect(sockets).toHaveLength(0);
    // Подключение начато заново и читает настройки ещё раз.
    expect(loads).toHaveLength(2);
    loads[1](CREDS_NEW);
    await new Promise((r) => setImmediate(r));
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toContain("new-station");
  });
});

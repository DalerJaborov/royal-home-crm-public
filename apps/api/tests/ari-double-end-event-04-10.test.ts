import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CALL-02 (04.10.2026): два события конца одного исходящего звонка за время опроса
 * станции (readStationDialResult) запускали повторную выгрузку записи: защита от
 * повторного конца стояла ДО await, а `state = ended` finishCall ставит после него.
 * Станция и база подменены: важно число вызовов, а не их содержание.
 */

const releases = vi.hoisted(() => [] as (() => void)[]);
const releaseDialStatus = () => releases.splice(0).forEach((r) => r());
vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: vi.fn().mockResolvedValue({ url: "http://station", username: "u", password: "p" }),
  listActiveChannels: vi.fn().mockResolvedValue([]),
  // Ответ станции на DIALSTATUS держим, пока тест не отпустит: оба события успевают дойти до await.
  readChannelVariable: vi.fn(() => new Promise<string | null>((resolve) => releases.push(() => resolve("NOANSWER")))),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn().mockResolvedValue(undefined),
}));
const tracker = vi.hoisted(() => ({ state: "talking" as "talking" | "ended" }));
vi.mock("../src/lib/telephony/callTracker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/callTracker.js")>()),
  applyStationDialResult: vi.fn(),
  confirmClientAnswer: vi.fn(),
  // Как настоящий: state = ended — после await, второй вызов получает уже ended объект.
  finishCall: vi.fn(async () => {
    tracker.state = "ended";
    return { state: "ended" };
  }),
  getCall: vi.fn(() => ({ state: tracker.state })),
  collectRecordingAfterFinish: vi.fn(),
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

describe("ariEvents: два события конца одного звонка", () => {
  beforeEach(() => {
    tracker.state = "talking";
    vi.clearAllMocks();
  });
  afterEach(() => vi.resetModules());

  it("запись забирается и звонок закрывается один раз", async () => {
    const callTracker = await import("../src/lib/telephony/callTracker.js");
    const { handleAriEvent } = await import("../src/lib/telephony/ariEvents.js");
    const channel = { id: "out-dbl", name: "Local/1@from-internal", state: "Up", caller: {} };

    const first = handleAriEvent({ type: "ChannelDestroyed", channel } as never);
    const second = handleAriEvent({ type: "StasisEnd", channel } as never);
    await new Promise((r) => setImmediate(r));
    releaseDialStatus();
    await Promise.all([first, second]);

    expect(callTracker.finishCall).toHaveBeenCalledTimes(1);
    expect(callTracker.collectRecordingAfterFinish).toHaveBeenCalledTimes(1);
  });

  it("после завершения канал снова свободен для разбора (признак не залипает)", async () => {
    const callTracker = await import("../src/lib/telephony/callTracker.js");
    const { handleAriEvent } = await import("../src/lib/telephony/ariEvents.js");
    const channel = { id: "out-sticky", name: "Local/1@from-internal", state: "Up", caller: {} };
    const first = handleAriEvent({ type: "ChannelDestroyed", channel } as never);
    await new Promise((r) => setImmediate(r));
    releaseDialStatus();
    await first;
    // Тот же канал позже: звонок уже ended — отсекается обычной проверкой, не нашим признаком.
    await handleAriEvent({ type: "ChannelDestroyed", channel } as never);
    expect(callTracker.finishCall).toHaveBeenCalledTimes(1);
  });
});

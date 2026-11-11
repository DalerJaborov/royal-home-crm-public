import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Починки по аудиту сбоев голосового робота 08-11.11.2026 (без сети и без платных вызовов):
 *  5. очередь исходящего звука не выбрасывает хвост длинной реплики;
 *  7. промпт и описание поиска требуют вызов функции в том же ходе, что и «секунду, гляну»;
 * 10. пока идёт перевод, звук человека в модель не уходит (иначе «Tool execution was abandoned»);
 * 11. PATCH агента ждёт дольше 8 с, повторяется с паузой, неподготовленный агент добивается в фоне.
 */

const logged = vi.hoisted(() => ({ messages: [] as { key?: string; text: string }[] }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: async (_source: string, message: string, opts?: { dedupKey?: string }) => {
    logged.messages.push({ key: opts?.dedupKey, text: String(message) });
  },
}));

const bridge = await import("../src/lib/telephony/liveVoiceBridge.js");
const sync = await import("../src/ai/elevenLabsAgentSync.js");
const { PROPERTY_TOOLS } = await import("../src/lib/telephony/liveVoicePropertyTools.js");
const { TRANSFER_TOOL } = await import("../src/lib/telephony/liveVoiceTransfer.js");
const persona = await import("../src/ai/liveVoiceConsultantPersona.js");

describe("очередь исходящего звука (сбой 5)", () => {
  const fakeSession = () =>
    ({ outQueue: [], outSeq: 0, outTimestamp: 0, channelId: "ch", queueOverflowLogged: false, queueOverflowDropped: 0 }) as never as Parameters<
      typeof bridge.enqueueOutFrame
    >[0];

  it("длинная реплика целиком (40 с, ElevenLabs отдаёт звук быстрее реального времени) помещается без потерь", () => {
    const session = fakeSession();
    const frames = 40_000 / 20;
    for (let i = 0; i < frames; i++) expect(bridge.enqueueOutFrame(session, new Int16Array(160))).toBe(true);
    expect(session.outQueue).toHaveLength(frames);
    expect(session.queueOverflowDropped).toBe(0);
  });

  it("потолок — предохранитель не меньше минуты; сверх него кадр выбрасывается", () => {
    expect(bridge.MAX_QUEUED_FRAMES * 20).toBeGreaterThanOrEqual(60_000);
    const session = fakeSession();
    for (let i = 0; i < bridge.MAX_QUEUED_FRAMES; i++) bridge.enqueueOutFrame(session, new Int16Array(160));
    expect(bridge.enqueueOutFrame(session, new Int16Array(160))).toBe(false);
    expect(session.queueOverflowDropped).toBe(1);
  });
});

describe("перевод на агента: звук человека не перебивает вызов (сбой 10)", () => {
  it("пока идёт transfer_to_agent, звук глушится; другие функции и пустой список — нет", () => {
    expect(bridge.callerAudioMutedByTransfer(new Map([["a", "transfer_to_agent"]]))).toBe(true);
    expect(
      bridge.callerAudioMutedByTransfer(
        new Map([
          ["a", "search_properties"],
          ["b", "transfer_to_agent"],
        ])
      )
    ).toBe(true);
    expect(bridge.callerAudioMutedByTransfer(new Map([["a", "search_properties"]]))).toBe(false);
    expect(bridge.callerAudioMutedByTransfer(new Map())).toBe(false);
  });

  it("описание перевода: один вызов, «соединяю» не повторять", () => {
    expect(TRANSFER_TOOL.description).toMatch(/ОДИН раз/);
    expect(TRANSFER_TOOL.description).toMatch(/второй раз не говори/);
  });
});

describe("обещание поиска и вызов в одном ходе (сбой 7)", () => {
  it("описание search_properties требует вызова в том же ответе", () => {
    const search = PROPERTY_TOOLS.find((t) => t.name === "search_properties")!;
    expect(search.description).toMatch(/В ОДНОМ ХОДЕ/);
    expect(search.description).toMatch(/не заканчивая ход на обещании/);
  });

  it("промпт консультанта: правило в манере речи и в хвосте", () => {
    expect(persona.CONSULTANT_TAIL_RULES).toMatch(/search_properties вызывается в ЭТОМ ЖЕ ходе/);
    expect(persona.consultantHumanManner(true)).toMatch(/ФРАЗА И ВЫЗОВ ФУНКЦИИ — В ОДНОМ ХОДЕ/);
  });
});

describe("PATCH агента ElevenLabs (сбой 11)", () => {
  const timeouts: number[] = [];
  let responses: Array<number | "timeout">;
  let patchCalls: number;

  beforeEach(() => {
    logged.messages.length = 0;
    timeouts.length = 0;
    patchCalls = 0;
    sync.resetElevenLabsSyncCacheForTests();
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return realTimeout(ms);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) => {
        if (init?.method === "PATCH") {
          patchCalls++;
          const next = responses.shift() ?? 200;
          if (next === "timeout") throw new Error("The operation was aborted due to timeout");
          return new Response(next === 200 ? "{}" : "err", { status: next });
        }
        return new Response(JSON.stringify({ conversation_config: { agent: { prompt: {} } } }), { status: 200 });
      })
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    sync.resetElevenLabsSyncCacheForTests();
  });

  it("PATCH ждёт 30 с, GET — прежние 8 с", async () => {
    responses = [];
    await sync.elevenLabsRequest("k", "GET", "/v1/x");
    await sync.elevenLabsRequest("k", "PATCH", "/v1/x", {});
    expect(timeouts).toEqual([sync.ELEVENLABS_HTTP_TIMEOUT_MS, sync.ELEVENLABS_PATCH_TIMEOUT_MS]);
    expect(sync.ELEVENLABS_PATCH_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
  });

  it("таймаут, затем 503, затем успех: три попытки, агент подготовлен", async () => {
    responses = ["timeout", 503, 200];
    await sync.patchElevenLabsAgent("k", "/v1/agent", {}, { pauseMs: 1 });
    expect(patchCalls).toBe(3);
  });

  it("отказ по сути (403) не повторяется", async () => {
    responses = [403];
    await expect(sync.patchElevenLabsAgent("k", "/v1/agent", {}, { pauseMs: 1 })).rejects.toThrow(/403|прав/);
    expect(patchCalls).toBe(1);
  });

  it("все попытки исчерпаны — ошибка наружу, а не молчание", async () => {
    responses = ["timeout", "timeout", "timeout", "timeout"];
    await expect(sync.patchElevenLabsAgent("k", "/v1/agent", {}, { pauseMs: 1 })).rejects.toThrow(/нет ответа/);
    expect(patchCalls).toBe(sync.ELEVENLABS_PATCH_ATTEMPTS);
  });

  it("повтор подготовки — через 30 с, а не 5 минут", () => {
    expect(sync.ELEVENLABS_SYNC_RETRY_PAUSE_MS).toBeLessThanOrEqual(30_000);
  });

  it("не подготовленный агент добивается в фоне сам, без звонка; после трёх неудач — одна тревога", async () => {
    vi.useFakeTimers();
    responses = Array(50).fill(403);
    expect(await sync.ensureElevenLabsAgentReady("k", "agent_bg", [])).toBeNull();
    expect(patchCalls).toBe(1);
    expect(logged.messages.some((m) => m.key === "elevenlabs-agent-sync")).toBe(true);

    for (const expected of [2, 3, 4, 4]) {
      await vi.advanceTimersByTimeAsync(sync.ELEVENLABS_SYNC_RETRY_PAUSE_MS + 10);
      expect(patchCalls).toBe(expected);
    }
    expect(logged.messages.filter((m) => m.key === "elevenlabs-agent-sync-gave-up")).toHaveLength(1);
  });

  it("фоновый повтор, когда причину починили, доводит агента до готовности", async () => {
    vi.useFakeTimers();
    responses = [403];
    expect(await sync.ensureElevenLabsAgentReady("k", "agent_ok", [])).toBeNull();
    responses = [];
    await vi.advanceTimersByTimeAsync(sync.ELEVENLABS_SYNC_RETRY_PAUSE_MS + 10);
    const before = patchCalls;
    expect(await sync.ensureElevenLabsAgentReady("k", "agent_ok", [])).toEqual(new Map());
    expect(patchCalls).toBe(before);
    expect(logged.messages.some((m) => m.key === "elevenlabs-agent-sync-gave-up")).toBe(false);
  });
});

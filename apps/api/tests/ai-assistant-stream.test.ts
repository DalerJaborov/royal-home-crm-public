import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ПОТОК ТОКЕНОВ ПОМОЩНИКА (31.10.2026, П1 задача 1.6,
 * docs/design/internal-assistant-architecture-2026-10-31.md).
 *
 * Сеть к Google подменена (fetch отдаёт ReadableStream кусками), всё остальное —
 * настоящее: разбор SSE, сборка вызовов инструментов, повторы и резервная модель,
 * отмена, цикл раундов помощника и маршрут POST /api/v1/ai/assistant.
 */

vi.mock("../src/ai/geminiSettings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiSettings.js")>()),
  resolveGeminiRuntime: async () => ({
    keys: ["fake-gemini-key"],
    model: "gemini-3.6-flash",
    fallbackModels: [],
    transcribeModels: [],
    imageModel: "unused",
    liteModel: "",
    explicitCaching: false,
  }),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn(async () => {}),
}));

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { callGeminiToolsStream, GeminiStreamInterruptedError } = await import("../src/ai/geminiClient.js");
const { createSseDataReader } = await import("../src/ai/geminiStream.js");
const { runAssistantDetailed } = await import("../src/ai/assistant.js");
const { resetAssistantRuntimeCache } = await import("../src/ai/assistant/runtime.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

type Runtime = Parameters<typeof callGeminiToolsStream>[0]["runtime"];

const runtime = (fallbackModels: string[] = []): Runtime => ({
  keys: ["fake-gemini-key"],
  model: "gemini-3.6-flash",
  fallbackModels,
  transcribeModels: [],
  imageModel: "unused",
  liteModel: "",
  explicitCaching: false,
});

const actor = {
  id: "stream-test-actor",
  role: "AGENT",
  canViewAllClients: false,
  canViewPhone: false,
  canViewReports: false,
  canViewFinance: false,
  canViewAllDeals: false,
};

/** Тело SSE так, как его отдаёт Google: `data: <json>` и пустая строка (CRLF). */
const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join("");
const textChunk = (text: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: "model", parts: [{ text }] }, ...extra }],
});

/**
 * Поток из готовых кусков БАЙТОВ. `tail`: "close" — конец потока, "error" — обрыв
 * сети, "hang" — не кончается никогда (только отменой; onCancel скажет о ней).
 */
function streamResponse(
  pieces: Uint8Array[],
  tail: "close" | "error" | "hang" = "close",
  onCancel?: () => void,
): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < pieces.length) {
        controller.enqueue(pieces[i++]);
        return;
      }
      if (tail === "close") controller.close();
      else if (tail === "error") controller.error(new TypeError("socket hang up"));
      else return new Promise<void>(() => {}); // висит до отмены
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Нарезать строку на куски по `size` БАЙТ — режет посреди JSON и посреди букв. */
function bytesInPieces(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.slice(at, at + size));
  return out;
}

const baseParams = {
  apiKey: "fake-gemini-key",
  system: "sys",
  contents: [{ role: "user" as const, parts: [{ text: "вопрос" }] }],
  tools: [{ name: "search_clients", description: "поиск" }],
  timeoutMs: 5_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("разбор SSE", () => {
  it("склеивает строку, разрезанную посреди CRLF, и несколько строк data одного события", () => {
    const reader = createSseDataReader();
    expect(reader.push('data: {"a":')).toEqual([]);
    expect(reader.push('1}\r')).toEqual([]);
    expect(reader.push("\n\r\n: комментарий\r\ndata: x\r\ndata: y\r\n")).toEqual(['{"a":1}']);
    expect(reader.end()).toEqual(["x\ny"]);
  });
});

describe("1.6 — callGeminiToolsStream", () => {
  it("куски режутся посреди JSON и посреди буквы — текст собирается целиком, дельты уходят по мере прихода", async () => {
    const body = sse(
      textChunk("Нашёл "),
      textChunk("трёх клиентов: Умед, "),
      textChunk("Шахло и Фарход.", { finishReason: "STOP" }),
      { usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 12 } },
    );
    // 7 байт — режет и JSON, и двухбайтные кириллические буквы.
    const fetchMock = vi.fn(async () => streamResponse(bytesInPieces(body, 7)));
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];

    const turn = await callGeminiToolsStream({ ...baseParams, runtime: runtime(), onToken: (d) => deltas.push(d) });

    expect(turn.text).toBe("Нашёл трёх клиентов: Умед, Шахло и Фарход.");
    expect(deltas.join("")).toBe(turn.text);
    expect(deltas.length).toBeGreaterThan(1);
    expect(turn.calls).toEqual([]);
    expect(turn.tokens).toBe(52);
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("gemini-3.6-flash:streamGenerateContent?alt=sse");
  });

  it("вызовы инструментов по частям в разных событиях собираются целиком; подписи и порядок частей не тронуты", async () => {
    const parts = [
      { text: "черновик", thought: true },
      { functionCall: { name: "search_clients", args: { query: "Умед" }, id: "c1" }, thoughtSignature: "sig-1" },
      { functionCall: { name: "get_client_summary", args: { clientId: "x" }, id: "c2" } },
      { text: "", thoughtSignature: "sig-tail" },
    ];
    const body = sse(
      { candidates: [{ content: { role: "model", parts: [parts[0]] } }] },
      { candidates: [{ content: { role: "model", parts: [parts[1]] } }] },
      { candidates: [{ content: { role: "model", parts: [parts[2]] } }] },
      { candidates: [{ content: { role: "model", parts: [parts[3]] }, finishReason: "STOP" }] },
    );
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse(bytesInPieces(body, 13))));
    const deltas: string[] = [];

    const turn = await callGeminiToolsStream({ ...baseParams, runtime: runtime(), onToken: (d) => deltas.push(d) });

    expect(turn.calls).toEqual([
      { name: "search_clients", args: { query: "Умед" }, id: "c1" },
      { name: "get_client_summary", args: { clientId: "x" }, id: "c2" },
    ]);
    expect(turn.modelParts).toEqual(parts);
    // Размышление человеку не показывается и в текст ответа не попадает.
    expect(deltas).toEqual([]);
    expect(turn.text).toBe("");
  });

  it("поток кончился без finishReason посреди вызова инструмента — вызов не исполняется, попытка повторяется", async () => {
    const broken = sse({ candidates: [{ content: { parts: [{ functionCall: { name: "create_task", args: {} } }] } }] });
    const good = sse(textChunk("Готово.", { finishReason: "STOP" }));
    const fetchMock = vi.fn(async () =>
      fetchMock.mock.calls.length === 1 ? streamResponse(bytesInPieces(broken, 50)) : streamResponse(bytesInPieces(good, 50)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const turn = await callGeminiToolsStream({ ...baseParams, runtime: runtime(), onToken: () => {} });

    expect(turn.calls).toEqual([]);
    expect(turn.text).toBe("Готово.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ошибка до первого токена — повтор на запасной модели", async () => {
    const good = sse(textChunk("Ответ резервной.", { finishReason: "STOP" }));
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes("gemini-3.6-flash")
        ? new Response("model not found", { status: 404 })
        : streamResponse(bytesInPieces(good, 9)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];

    const turn = await callGeminiToolsStream({
      ...baseParams,
      runtime: runtime(["gemini-fallback-test"]),
      onToken: (d) => deltas.push(d),
    });

    expect(turn.text).toBe("Ответ резервной.");
    expect(deltas.join("")).toBe("Ответ резервной.");
    const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("gemini-fallback-test:streamGenerateContent?alt=sse");
  });

  it("обрыв сети ДО первого токена — та же модель ещё раз, без ошибки наружу", async () => {
    const good = sse(textChunk("Со второй попытки.", { finishReason: "STOP" }));
    const fetchMock = vi.fn(async () =>
      fetchMock.mock.calls.length === 1 ? streamResponse([], "error") : streamResponse(bytesInPieces(good, 11)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const turn = await callGeminiToolsStream({ ...baseParams, runtime: runtime(), onToken: () => {} });

    expect(turn.text).toBe("Со второй попытки.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("обрыв ПОСЛЕ первого токена — без повтора, ошибка с кодом stream_interrupted и retryable", async () => {
    const started = sse(textChunk("Нашёл двух"));
    const fetchMock = vi.fn(async () => streamResponse(bytesInPieces(started, 8), "error"));
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];

    const err = await callGeminiToolsStream({
      ...baseParams,
      runtime: runtime(["gemini-fallback-test"]),
      onToken: (d) => deltas.push(d),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GeminiStreamInterruptedError);
    expect((err as InstanceType<typeof GeminiStreamInterruptedError>).code).toBe("stream_interrupted");
    expect((err as InstanceType<typeof GeminiStreamInterruptedError>).retryable).toBe(true);
    expect(deltas.join("")).toBe("Нашёл двух");
    // Ни повтора той же модели, ни резервной: второй текст поверх показанного недопустим.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("отмена по signal останавливает чтение потока, а не ждёт конца генерации", async () => {
    let cancelled = false;
    const started = sse(textChunk("Ищу"));
    const fetchMock = vi.fn(async () => streamResponse(bytesInPieces(started, 100), "hang", () => (cancelled = true)));
    vi.stubGlobal("fetch", fetchMock);
    const outer = new AbortController();
    const reason = new Error("клиент ушёл");

    const pending = callGeminiToolsStream({
      ...baseParams,
      runtime: runtime(["gemini-fallback-test"]),
      signal: outer.signal,
      onToken: () => outer.abort(reason),
    });

    await expect(pending).rejects.toBe(reason);
    expect(cancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("1.6 — помощник целиком", () => {
  it("runAssistantDetailed с onToken: обрыв после токена — код stream_interrupted, повтор предлагается", async () => {
    resetAssistantRuntimeCache();
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse(bytesInPieces(sse(textChunk("Начало")), 5), "error")));
    const tokens: unknown[] = [];

    const outcome = await runAssistantDetailed([{ role: "user", content: "Сколько у меня клиентов?" }], actor, {
      onToken: (t) => tokens.push(t),
    });

    expect(outcome).toEqual({ ok: false, code: "stream_interrupted", retryable: true });
    expect(tokens).toEqual([{ text: "Начало" }]);
  });

  it("без onToken — прежний generateContent, поток не используется", async () => {
    resetAssistantRuntimeCache();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(textChunk("Обычный ответ.", { finishReason: "STOP" })), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await runAssistantDetailed([{ role: "user", content: "Привет" }], actor);

    expect(outcome).toEqual({ ok: true, reply: "Обычный ответ." });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain(":generateContent");
  });
});

describe("1.6 — маршрут POST /ai/assistant", () => {
  let server: http.Server;
  let agentId = "";
  let token = "";
  let savedEnabled = false;

  beforeAll(async () => {
    const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
    savedEnabled = settings.aiAssistantEnabled;
    await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantEnabled: true } });
    resetAssistantRuntimeCache();
    const runId = Date.now();
    const agent = await prisma.agent.create({
      data: {
        fullName: `Агент потока токенов ${runId}`,
        phone: `+99278${String(runId).slice(-7)}`,
        role: "AGENT",
        passwordHash: "x",
      },
    });
    agentId = agent.id;
    token = signAccessToken({ sub: agentId, role: "AGENT" });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantEnabled: savedEnabled } });
    resetAssistantRuntimeCache();
    await deleteAgentsWithTraces([agentId]);
    await prisma.$disconnect();
  });

  it("события token приходят ДО done, а done несёт полный текст", async () => {
    // Сеть к Google подменена, а к своему серверу нужен настоящий fetch.
    const realFetch = globalThis.fetch;
    const body = sse(textChunk("Привет, "), textChunk("это помощник.", { finishReason: "STOP" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) =>
        String(url).includes("generativelanguage") || String(url).includes(":streamGenerateContent")
          ? streamResponse(bytesInPieces(body, 6))
          : realFetch(url as string, init),
      ),
    );
    const { port } = server.address() as AddressInfo;

    const res = await realFetch(`http://127.0.0.1:${port}/api/v1/ai/assistant`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "Кто ты?" }] }),
    });
    const text = await res.text();

    const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)].map((m) => ({ event: m[1], data: JSON.parse(m[2]) }));
    const names = events.map((e) => e.event);
    expect(names).toContain("token");
    expect(names.lastIndexOf("token")).toBeLessThan(names.indexOf("done"));
    const streamed = events.filter((e) => e.event === "token").map((e) => e.data.text).join("");
    expect(streamed).toBe("Привет, это помощник.");
    expect(events.find((e) => e.event === "done")?.data).toEqual({ reply: "Привет, это помощник." });
  });
});

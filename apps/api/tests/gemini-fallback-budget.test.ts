import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotTurnTracePayload } from "@royal-home/shared";

/**
 * РЕЗЕРВНАЯ МОДЕЛЬ ОБЯЗАНА ПОЛУЧИТЬ СВОЙ ШАНС (16.08.2026).
 *
 * В этот день основная модель (gemini-3.7-flash) отвечала 503 «high demand» весь
 * день, а резервная (gemini-3.6-flash) работала. Журнал прода при этом показывал
 * два новых вида отказов, которых не должно было быть вовсе:
 *
 *  1. «Gemini не ответил за отведённые 75 с» — общий бюджет времени тратился строго
 *     по порядку, и висящая основная модель выедала его целиком; до резервной
 *     очередь не доходила ни разу.
 *  2. «не вернул tool-call/JSON ... finishReason=MALFORMED_FUNCTION_CALL» — 30 штук
 *     за день. Повтор на такой ответ утром того же дня добавили, но резервной
 *     модели полагалась РОВНО ОДНА попытка, и повторять было некуда.
 *
 * Здесь закреплено оба: резерв времени под запасную модель и полноценные повторы
 * у неё же, с расширением потолка ответа (обрыв на полуслове тем же потолком не
 * лечится). Состав промта и схема инструмента на повторе не меняются — обязательные
 * правила бота и сверка цен не должны зависеть от номера попытки.
 */

const logSystemError = vi.fn();
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: (...a: unknown[]) => logSystemError(...a) }));

const aiLogCreate = vi.fn(() => Promise.resolve({}));
vi.mock("../src/db.js", () => ({
  prisma: {
    settings: { findUnique: () => Promise.resolve(null) },
    aiLog: { create: (...a: unknown[]) => aiLogCreate(...a) },
    // tests/setup.ts закрывает соединения после каждого файла — заглушке тоже нужен.
    $disconnect: () => Promise.resolve(),
  },
}));

const PRIMARY = "gemini-3.7-flash";
const FALLBACK = "gemini-3.6-flash";

const SCHEMA = { type: "object", properties: { reply: { type: "string" } }, required: ["reply"] };

type Call = { url: string; body: Record<string, unknown> };

/** Ответ Gemini с готовым вызовом инструмента — то, чего мы ждём в норме. */
function toolCallResponse(args: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: "submit_reply", args } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/** HTTP 200, но модель оборвалась на полуслове: ни текста, ни вызова инструмента. */
function malformedResponse(): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL" }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 0, thoughtsTokenCount: 700 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/** Модель, которая не отвечает вовсе, — ровно то, что делала основная 16.08. */
function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
  });
}

/** HTTP 200, но candidates[0] не пришёл вовсе — ни причины, ни текста (25.08.2026:
 *  card-fill/score-client отказали ровно так, оба раза у резервной модели). */
function emptyCandidatesResponse(): Response {
  return new Response(
    JSON.stringify({ candidates: [], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 0 } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/** То же самое, но Google прямо назвал причину — блокировку промта. Повтор тем же
 *  промтом её не обойдёт. */
function blockedResponse(reason: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [],
      promptFeedback: { blockReason: reason },
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 0 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function loadClient(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  delete process.env.GEMINI_PROXY_URL;
  delete process.env.GEMINI_PROXY_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.GEMINI_API_KEY_2;
  process.env.GEMINI_MODEL = PRIMARY;
  process.env.GEMINI_FALLBACK_MODEL = FALLBACK;
  vi.resetModules();
  return import("../src/ai/geminiClient.js");
}

describe("Gemini: резерв времени и повторы на запасной модели", () => {
  it.each(["wrong-name", "multiple-calls"])("rejects %s instead of accepting arbitrary tool arguments", async (kind) => {
    const { callGemini } = await loadClient({ GEMINI_TOTAL_BUDGET_MS: "20000" });
    // loadClient resets modules: use the same fresh ALS instance as Gemini.
    const { withBotTurnTrace } = await import("../src/lib/botTurnTrace.js");
    const traces: BotTurnTracePayload[] = [];
    let requests = 0;
    stubFetch(async () => {
      requests++;
      if (requests > 1) return toolCallResponse({ reply: "valid" });
      const calls = kind === "wrong-name"
        ? [{ functionCall: { name: "delete_client", args: { reply: "untrusted" } } }]
        : [1, 2].map(() => ({ functionCall: { name: "submit_reply", args: { reply: "untrusted" } } }));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: calls }, finishReason: "STOP" }] }), { status: 200 });
    });
    const result = await withBotTurnTrace({ channel: "WEBSITE" }, () => callGemini({ endpoint: "lead-qualify", system: "rules", user: "hello", maxTokens: 500, schema: SCHEMA }), { enabled: true, text: false, secret: "fictional-protocol-trace-key-only-test-0000", write: (row) => { traces.push(row); } });
    expect(result).toEqual({ reply: "valid" });
    expect(requests).toBeGreaterThan(1);
    const fault = kind === "wrong-name" ? "wrong_tool" : "multiple_calls";
    expect(traces.at(-1)?.modelAttempts[0]).toMatchObject({ outcome: fault, protocolIssue: fault });
    expect(traces.at(-1)?.modelAttempts.at(-1)?.outcome).toBe("parsed");
    expect(JSON.stringify(traces)).not.toMatch(/delete_client|untrusted|test-key/);
  });
  const originalFetch = globalThis.fetch;
  let calls: Call[];

  beforeEach(() => {
    calls = [];
    logSystemError.mockReset();
    aiLogCreate.mockReset();
    aiLogCreate.mockImplementation(() => Promise.resolve({}));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function stubFetch(handler: (call: Call, signal: AbortSignal | null | undefined) => Promise<Response>) {
    globalThis.fetch = vi.fn((url: unknown, init: unknown) => {
      const req = init as { body?: string; signal?: AbortSignal };
      const call: Call = { url: String(url), body: JSON.parse(req?.body ?? "{}") as Record<string, unknown> };
      calls.push(call);
      return handler(call, req?.signal);
    }) as unknown as typeof fetch;
  }

  it("висящая основная модель не съедает бюджет целиком — резервная получает своё окно", async () => {
    const { callGemini } = await loadClient({
      GEMINI_ATTEMPT_TIMEOUT_MS: "200",
      GEMINI_TOTAL_BUDGET_MS: "2000",
      GEMINI_FALLBACK_RESERVE_MS: "1000",
    });

    stubFetch((call, signal) =>
      call.url.includes(PRIMARY) ? hang(signal) : Promise.resolve(toolCallResponse({ reply: "готово" }))
    );

    const result = await callGemini<{ reply: string }>({
      endpoint: "lead-qualify",
      system: "правила бота",
      user: "здравствуйте",
      maxTokens: 500,
      schema: SCHEMA,
    });

    expect(result).toEqual({ reply: "готово" });
    expect(calls.some((c) => c.url.includes(FALLBACK))).toBe(true);
    // И расход записан на ту модель, которая его сделала, а не на основную.
    expect(aiLogCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ model: FALLBACK }) }));
  });

  it("MALFORMED_FUNCTION_CALL у резервной модели повторяется, а не убивает ход диалога", async () => {
    const { callGemini } = await loadClient({
      GEMINI_ATTEMPT_TIMEOUT_MS: "200",
      GEMINI_TOTAL_BUDGET_MS: "20000",
      GEMINI_FALLBACK_RESERVE_MS: "8000",
    });

    stubFetch((call) => {
      if (call.url.includes(PRIMARY)) {
        return Promise.resolve(new Response("high demand", { status: 503 }));
      }
      const fallbackCalls = calls.filter((c) => c.url.includes(FALLBACK)).length;
      return Promise.resolve(fallbackCalls === 1 ? malformedResponse() : toolCallResponse({ reply: "со второй" }));
    });

    const result = await callGemini<{ reply: string }>({
      endpoint: "lead-qualify",
      system: "правила бота",
      user: "здравствуйте",
      maxTokens: 500,
      schema: SCHEMA,
    });

    expect(result).toEqual({ reply: "со второй" });
    const fallbackCalls = calls.filter((c) => c.url.includes(FALLBACK));
    expect(fallbackCalls).toHaveLength(2);

    // Повтор просит БОЛЬШЕ места на ответ: обрыв на полуслове тем же потолком не лечится.
    const cap = (c: Call) => (c.body.generationConfig as { maxOutputTokens: number }).maxOutputTokens;
    expect(cap(fallbackCalls[1])).toBeGreaterThan(cap(fallbackCalls[0]));

    // ...и при этом на повторе НЕ меняется ничего, кроме числа токенов: тот же
    // системный промт (обязательные правила, сверка цен) и та же схема инструмента.
    expect(fallbackCalls[1].body.systemInstruction).toEqual(fallbackCalls[0].body.systemInstruction);
    expect(fallbackCalls[1].body.tools).toEqual(fallbackCalls[0].body.tools);
    expect(fallbackCalls[1].body.contents).toEqual(fallbackCalls[0].body.contents);
  }, 20_000);

  it("пустой candidates без blockReason повторяется — не убивает ход диалога как раньше", async () => {
    const { callGemini } = await loadClient({
      GEMINI_ATTEMPT_TIMEOUT_MS: "200",
      GEMINI_TOTAL_BUDGET_MS: "20000",
      GEMINI_FALLBACK_RESERVE_MS: "8000",
    });

    stubFetch((call) => {
      if (call.url.includes(PRIMARY)) {
        return Promise.resolve(new Response("high demand", { status: 503 }));
      }
      const fallbackCalls = calls.filter((c) => c.url.includes(FALLBACK)).length;
      return Promise.resolve(fallbackCalls === 1 ? emptyCandidatesResponse() : toolCallResponse({ reply: "со второй" }));
    });

    const result = await callGemini<{ reply: string }>({
      endpoint: "card-fill",
      system: "правила бота",
      user: "здравствуйте",
      maxTokens: 500,
      schema: SCHEMA,
    });

    expect(result).toEqual({ reply: "со второй" });
    expect(calls.filter((c) => c.url.includes(FALLBACK))).toHaveLength(2);
  }, 20_000);

  it("пустой candidates С blockReason НЕ повторяется — промт тот же, ответ будет тем же", async () => {
    const { callGemini } = await loadClient({
      GEMINI_ATTEMPT_TIMEOUT_MS: "200",
      GEMINI_TOTAL_BUDGET_MS: "2000",
      GEMINI_FALLBACK_RESERVE_MS: "1000",
    });

    stubFetch((call) =>
      Promise.resolve(call.url.includes(PRIMARY) ? blockedResponse("SAFETY") : blockedResponse("SAFETY"))
    );

    const result = await callGemini<{ reply: string }>({
      endpoint: "card-fill",
      system: "правила бота",
      user: "здравствуйте",
      maxTokens: 500,
      schema: SCHEMA,
    });

    // Провал, не исключение: callGemini сигналит отказ через null (см. вызывающий
    // client.ts), а не бросает — здесь просто убеждаемся, что ответа нет.
    expect(result).toBeNull();
    // Ровно одна попытка на модель — блокировка промта не лечится повтором.
    expect(calls.filter((c) => c.url.includes(PRIMARY))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes(FALLBACK))).toHaveLength(1);
  });

  it("успех на резервной модели остаётся заметным в «Здоровье системы»", async () => {
    const { callGemini } = await loadClient({
      GEMINI_ATTEMPT_TIMEOUT_MS: "200",
      GEMINI_TOTAL_BUDGET_MS: "2000",
      GEMINI_FALLBACK_RESERVE_MS: "1000",
    });

    stubFetch((call) =>
      Promise.resolve(
        call.url.includes(PRIMARY)
          ? new Response("high demand", { status: 503 })
          : toolCallResponse({ reply: "ответ" })
      )
    );

    await callGemini<{ reply: string }>({
      endpoint: "lead-qualify",
      system: "правила бота",
      user: "здравствуйте",
      maxTokens: 500,
      schema: SCHEMA,
    });

    const messages = logSystemError.mock.calls.map((c) => String(c[1])).join("\n");
    expect(messages).toContain("РЕЗЕРВНОЙ модели");
    expect(messages).toContain(FALLBACK);
  }, 20_000);

  /**
   * ЛОЖНАЯ ТРЕВОГА «РЕЗЕРВНАЯ» (аудит ботов 10.10.2026, P1-9): запись делалась на
   * любой HTTP 200 резервной модели — до проверки blockReason. 233 записи за месяц,
   * а резерв реально ответил ~25 раз.
   */
  it("блокировка промта на обеих моделях — НЕ «ответила резервная», а запись о блокировке с id и задачей", async () => {
    const { callGemini } = await loadClient({
      GEMINI_ATTEMPT_TIMEOUT_MS: "200",
      GEMINI_TOTAL_BUDGET_MS: "2000",
      GEMINI_FALLBACK_RESERVE_MS: "1000",
    });
    stubFetch(() => Promise.resolve(blockedResponse("PROHIBITED_CONTENT")));

    const result = await callGemini<{ reply: string }>({
      endpoint: "off-crm-pause-check",
      system: "правила",
      user: "переписка",
      maxTokens: 200,
      schema: SCHEMA,
      clientId: "client-123",
      conversationId: "conv-456",
    });

    expect(result).toBeNull();
    const messages = logSystemError.mock.calls.map((c) => String(c[1])).join("\n");
    expect(messages).not.toContain("РЕЗЕРВНОЙ");
    expect(messages).toContain("blockReason=PROHIBITED_CONTENT");
    expect(messages).toContain("off-crm-pause-check");
    expect(messages).toContain("клиент client-123");
    expect(messages).toContain("диалог conv-456");
    // Одна строка в неделю на задачу и клиента, без пуша директору.
    const blockedCall = logSystemError.mock.calls.find((c) => String(c[1]).includes("blockReason"));
    expect(blockedCall?.[2]).toMatchObject({ dedupKey: "gemini-blocked:off-crm-pause-check", silent: true });
  });

  it("резервная вернула 200 без разбираемого ответа — «ответила резервная» не пишется", async () => {
    const { callGemini } = await loadClient({
      GEMINI_ATTEMPT_TIMEOUT_MS: "200",
      GEMINI_TOTAL_BUDGET_MS: "3000",
      GEMINI_FALLBACK_RESERVE_MS: "1500",
    });
    stubFetch((call) =>
      Promise.resolve(call.url.includes(PRIMARY) ? new Response("high demand", { status: 503 }) : emptyCandidatesResponse())
    );

    const result = await callGemini<{ reply: string }>({
      endpoint: "lead-qualify",
      system: "правила бота",
      user: "здравствуйте",
      maxTokens: 500,
      schema: SCHEMA,
    });

    expect(result).toBeNull();
    const messages = logSystemError.mock.calls.map((c) => String(c[1])).join("\n");
    expect(messages).not.toContain("РЕЗЕРВНОЙ");
  }, 20_000);

  it("три 524 подряд у основной модели — предохранитель открывается, следующий ход не тратит на неё попытки", async () => {
    // Правка ревью 24.09.2026: 502/504/524/408 стали повторяемыми статусами
    // (isRetryableGeminiStatus, geminiTransport.ts — «лежащий прокси, а не отказ
    // модели»), но noteGeminiModelFailure раньше считала отказом только 503/429.
    // Лежащий прокси (524 у Cloudflare-воркера) жёг ATTEMPTS_PER_MODEL попыток и
    // все паузы между ними НА КАЖДЫЙ ход бота, вместо того чтобы после серии
    // открыть предохранитель и уходить на резерв сразу же, как для 503/429.
    const { callGemini } = await loadClient({
      GEMINI_ATTEMPT_TIMEOUT_MS: "200",
      GEMINI_TOTAL_BUDGET_MS: "20000",
      GEMINI_FALLBACK_RESERVE_MS: "8000",
    });

    stubFetch((call) =>
      Promise.resolve(
        call.url.includes(PRIMARY)
          ? new Response("gateway timeout", { status: 524 })
          : toolCallResponse({ reply: "резерв" })
      )
    );

    const first = await callGemini<{ reply: string }>({
      endpoint: "lead-qualify",
      system: "правила бота",
      user: "первый ход",
      maxTokens: 500,
      schema: SCHEMA,
    });
    expect(first).toEqual({ reply: "резерв" });
    // Первый ход ещё тратит попытки на основную (предохранитель взводится ВНУТРИ
    // него, по трём отказам подряд) — их несколько, это ожидаемо.
    expect(calls.filter((c) => c.url.includes(PRIMARY)).length).toBeGreaterThanOrEqual(3);

    calls.length = 0; // второй ход считаем отдельно, с чистого счётчика вызовов

    const second = await callGemini<{ reply: string }>({
      endpoint: "lead-qualify",
      system: "правила бота",
      user: "второй ход",
      maxTokens: 500,
      schema: SCHEMA,
    });
    expect(second).toEqual({ reply: "резерв" });
    // Предохранитель открыт — второй ход вообще не обращается к основной модели.
    expect(calls.some((c) => c.url.includes(PRIMARY))).toBe(false);
    expect(calls.filter((c) => c.url.includes(FALLBACK))).toHaveLength(1);
  }, 20_000);
});

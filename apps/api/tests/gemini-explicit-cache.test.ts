import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ЯВНЫЙ КЭШ СИСТЕМНОГО ПРОМТА (30.08.2026, тумблер geminiExplicitCachingEnabled).
 *
 * Три инварианта, которые нельзя потерять:
 *  1. ТУМБЛЕР ВЫКЛЮЧЕН — тело запроса к Gemini ровно прежнее, побайтово:
 *     systemInstruction со склейкой stable+dynamic, tools/toolConfig на месте,
 *     ни одного обращения к cachedContents. Регресс здесь = изменение поведения
 *     бота у ВСЕХ клиентов без их ведома.
 *  2. ТУМБЛЕР ВКЛЮЧЁН — стабильная часть уезжает в кэш, а сам запрос генерации
 *     несёт cachedContent и НЕ несёт systemInstruction/tools/toolConfig: Google
 *     отвечает 400 на их сочетание (задокументированное ограничение API).
 *  3. КЭШ СЛОМАЛСЯ (создание отклонено, ссылка протухла) — вызов доезжает до
 *     ответа обычным путём: кэш — оптимизация, а не точка отказа.
 */

const logSystemError = vi.fn();
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: (...a: unknown[]) => logSystemError(...a) }));

// Тумблер и запись кэша переключаются per-тест через эти переменные.
let explicitCachingEnabled = false;
let storedCache: { hash: string; name: string; model: string; expiresAt: Date } | null = null;

// Тумблер явного кэша — константа с 01.11.2026 (lib/settingsConstants.ts); тест
// переключает её геттером, а не полем Settings, которое сервер больше не читает.
vi.mock("../src/lib/settingsConstants.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/settingsConstants.js")>();
  const mocked = { ...actual, GEMINI_LITE_MODEL_OVERRIDE: null };
  Object.defineProperty(mocked, "GEMINI_EXPLICIT_CACHING_ENABLED", { get: () => explicitCachingEnabled, enumerable: true });
  return mocked;
});

const aiLogCreate = vi.fn(() => Promise.resolve({}));
vi.mock("../src/db.js", () => ({
  prisma: {
    settings: {
      findUnique: () =>
        Promise.resolve({
          geminiApiKey: null,
          geminiApiKey2: null,
          geminiApiKeysExtra: [],
        }),
    },
    aiLog: { create: (...a: unknown[]) => aiLogCreate(...a) },
    geminiCache: {
      findUnique: () => Promise.resolve(storedCache),
      upsert: vi.fn((args: { create: typeof storedCache }) => {
        storedCache = args.create;
        return Promise.resolve(storedCache);
      }),
      deleteMany: vi.fn(() => {
        storedCache = null;
        return Promise.resolve({ count: 1 });
      }),
    },
    // tests/setup.ts закрывает соединения после каждого файла — заглушке тоже нужен.
    $disconnect: () => Promise.resolve(),
  },
}));

const PRIMARY = "gemini-3.7-flash";
const SCHEMA = { type: "object", properties: { reply: { type: "string" } }, required: ["reply"] };
// Кэш включается только от 8000 символов стабильной части (см. geminiClient.ts).
const LONG_STABLE = "ПРАВИЛА БОТА. ".repeat(700); // ~9800 символов
const DYNAMIC = "\n\nКУРС ДОЛЛАРА: 1 USD = 11.9 TJS.";

type Call = { url: string; body: Record<string, unknown> };

function toolCallResponse(args: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: "submit_reply", args } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 80 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function cacheCreatedResponse(name: string): Response {
  return new Response(JSON.stringify({ name }), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function loadClient() {
  delete process.env.GEMINI_PROXY_URL;
  delete process.env.GEMINI_PROXY_KEY;
  delete process.env.GEMINI_FALLBACK_MODEL;
  process.env.GEMINI_MODEL = PRIMARY;
  process.env.GEMINI_API_KEY = "test-key";
  vi.resetModules();
  return import("../src/ai/geminiClient.js");
}

describe("Явный кэш системного промта Gemini", () => {
  const originalFetch = globalThis.fetch;
  let calls: Call[];

  beforeEach(() => {
    calls = [];
    explicitCachingEnabled = false;
    storedCache = null;
    logSystemError.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function stubFetch(handler: (call: Call) => Promise<Response>) {
    globalThis.fetch = vi.fn((url: unknown, init: unknown) => {
      const req = init as { body?: string };
      const call: Call = { url: String(url), body: JSON.parse(req?.body ?? "{}") as Record<string, unknown> };
      calls.push(call);
      return handler(call);
    }) as unknown as typeof fetch;
  }

  it("тумблер ВЫКЛЮЧЕН: запрос прежней формы, cachedContents не трогается вовсе", async () => {
    const { callGemini } = await loadClient();
    stubFetch(() => Promise.resolve(toolCallResponse({ reply: "ок" })));

    const result = await callGemini<{ reply: string }>({
      endpoint: "lead-qualify",
      systemStable: LONG_STABLE,
      system: DYNAMIC,
      user: "салом",
      maxTokens: 500,
      schema: SCHEMA,
    });

    expect(result).toEqual({ reply: "ок" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(":generateContent");
    // Склейка stable+dynamic — побайтово, как жила в ai/client.ts до этого модуля.
    const sys = calls[0].body.systemInstruction as { parts: { text: string }[] };
    expect(sys.parts[0].text).toBe(LONG_STABLE + DYNAMIC);
    expect(calls[0].body.tools).toBeDefined();
    expect(calls[0].body.toolConfig).toBeDefined();
    expect(calls[0].body.cachedContent).toBeUndefined();
  });

  it("тумблер ВКЛЮЧЁН: кэш создаётся, генерация ссылается на него и не несёт system/tools", async () => {
    explicitCachingEnabled = true;
    const { callGemini } = await loadClient();
    stubFetch((call) =>
      Promise.resolve(
        call.url.includes("cachedContents")
          ? cacheCreatedResponse("cachedContents/test-abc")
          : toolCallResponse({ reply: "из кэша" })
      )
    );

    const result = await callGemini<{ reply: string }>({
      endpoint: "lead-qualify",
      systemStable: LONG_STABLE,
      system: DYNAMIC,
      user: "салом",
      maxTokens: 500,
      schema: SCHEMA,
    });

    expect(result).toEqual({ reply: "из кэша" });
    expect(calls).toHaveLength(2);

    // Создание кэша: стабильный текст и схема инструмента ложатся ВНУТРЬ кэша.
    const create = calls[0];
    expect(create.url).toContain("cachedContents");
    const cachedSys = create.body.systemInstruction as { parts: { text: string }[] };
    expect(cachedSys.parts[0].text).toBe(LONG_STABLE);
    expect(create.body.tools).toBeDefined();
    expect(create.body.ttl).toBe("3600s");

    // Генерация: ссылка на кэш, БЕЗ systemInstruction/tools/toolConfig (иначе 400
    // от Google), переменная часть — служебным ходом в начале contents.
    const gen = calls[1];
    expect(gen.url).toContain(":generateContent");
    expect(gen.body.cachedContent).toBe("cachedContents/test-abc");
    expect(gen.body.systemInstruction).toBeUndefined();
    expect(gen.body.tools).toBeUndefined();
    expect(gen.body.toolConfig).toBeUndefined();
    const contents = gen.body.contents as { role: string; parts: { text?: string }[] }[];
    expect(contents[0].parts[0].text).toContain(DYNAMIC);
    expect(contents[contents.length - 1].parts[0].text).toBe("салом");
  });

  it("живой кэш из своей таблицы переиспользуется — второго создания нет", async () => {
    explicitCachingEnabled = true;
    storedCache = {
      hash: "irrelevant-in-mock",
      name: "cachedContents/alive",
      model: PRIMARY,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    };
    const { callGemini } = await loadClient();
    stubFetch(() => Promise.resolve(toolCallResponse({ reply: "ок" })));

    const result = await callGemini<{ reply: string }>({
      endpoint: "lead-qualify",
      systemStable: LONG_STABLE,
      system: DYNAMIC,
      user: "салом",
      maxTokens: 500,
      schema: SCHEMA,
    });

    expect(result).toEqual({ reply: "ок" });
    expect(calls).toHaveLength(1); // только generateContent, без cachedContents
    expect(calls[0].body.cachedContent).toBe("cachedContents/alive");
  });

  it("создание кэша отклонено — вызов доезжает обычным путём, клиент получает ответ", async () => {
    explicitCachingEnabled = true;
    const { callGemini } = await loadClient();
    stubFetch((call) =>
      Promise.resolve(
        call.url.includes("cachedContents")
          ? new Response("Cached content is too small. Minimum is 2048 tokens", { status: 400 })
          : Promise.resolve(toolCallResponse({ reply: "обычным путём" })).then((r) => r)
      )
    );

    const result = await callGemini<{ reply: string }>({
      endpoint: "lead-qualify",
      systemStable: LONG_STABLE,
      system: DYNAMIC,
      user: "салом",
      maxTokens: 500,
      schema: SCHEMA,
    });

    expect(result).toEqual({ reply: "обычным путём" });
    const gen = calls.find((c) => c.url.includes(":generateContent"));
    expect(gen).toBeDefined();
    // Обычная форма: полная склейка и инструменты на месте.
    const sys = gen!.body.systemInstruction as { parts: { text: string }[] };
    expect(sys.parts[0].text).toBe(LONG_STABLE + DYNAMIC);
    expect(gen!.body.cachedContent).toBeUndefined();
  });

  it("ссылка на кэш протухла у Google (400 про кэш) — повтор без кэша тем же вызовом", async () => {
    explicitCachingEnabled = true;
    storedCache = {
      hash: "irrelevant-in-mock",
      name: "cachedContents/dead",
      model: PRIMARY,
      expiresAt: new Date(Date.now() + 30 * 60_000), // по нашей записи ещё жив
    };
    const { callGemini } = await loadClient();
    stubFetch((call) => {
      if (call.body.cachedContent) {
        return Promise.resolve(new Response("CachedContent not found or expired", { status: 400 }));
      }
      return Promise.resolve(toolCallResponse({ reply: "после отката" }));
    });

    const result = await callGemini<{ reply: string }>({
      endpoint: "lead-qualify",
      systemStable: LONG_STABLE,
      system: DYNAMIC,
      user: "салом",
      maxTokens: 500,
      schema: SCHEMA,
    });

    expect(result).toEqual({ reply: "после отката" });
    // Протухшая запись стёрта — следующий ход создаст кэш заново.
    expect(storedCache).toBeNull();
  });

  it("короткая стабильная часть (< порога) кэш не включает даже при тумблере", async () => {
    explicitCachingEnabled = true;
    const { callGemini } = await loadClient();
    stubFetch(() => Promise.resolve(toolCallResponse({ reply: "ок" })));

    await callGemini<{ reply: string }>({
      endpoint: "card-fill",
      systemStable: "коротко",
      system: DYNAMIC,
      user: "текст",
      maxTokens: 500,
      schema: SCHEMA,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(":generateContent");
    expect(calls[0].body.cachedContent).toBeUndefined();
  });
});

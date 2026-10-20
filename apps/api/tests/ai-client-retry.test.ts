import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ИИ-КОНТУР, ПАЧКА 7 (11.09.2026) — ПОВТОР И БЮДЖЕТ НА УРОВНЕ callGemini.
 *
 * Два места дают повтор одному и тому же поставщику:
 *  1. ai/client.ts (callAiText) — если весь вызов callGeminiText вернул null
 *     (все ключи/модели/попытки исчерпаны), делается РОВНО ОДНА дополнительная
 *     попытка тем же путём (см. докстринг «ПОВТОР У ТОГО ЖЕ ПОСТАВЩИКА»).
 *  2. ai/geminiClient.ts (callGemini) — внутри ОДНОЙ модели/ключа: 400/401/403/404
 *     не повторяются (isRetryableGeminiStatus, geminiTransport.ts), только
 *     503/429/500 стоит того ждать и пробовать снова.
 *
 * gemini-fallback-budget.test.ts уже подробно покрывает резерв времени под
 * резервную модель и повторы НА 503/пустом ответе — здесь закрываем то, что не
 * покрыто: обратную сторону (400/404 НЕ повторяются) и внешний повтор client.ts.
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
    geminiCache: { deleteMany: () => Promise.resolve({}) },
    $disconnect: () => Promise.resolve(),
  },
}));

const SCHEMA = { type: "object", properties: { reply: { type: "string" } }, required: ["reply"] };

type Call = { url: string };

function toolCallResponse(args: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: "submit_reply", args } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function loadModules(env: Record<string, string>) {
  delete process.env.GEMINI_FALLBACK_MODEL; // одна модель — проверяем повтор/непровтор чисто
  delete process.env.GEMINI_PROXY_URL;
  delete process.env.GEMINI_PROXY_KEY;
  delete process.env.GEMINI_API_KEY_2;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "gemini-3.7-flash";
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  const geminiClient = await import("../src/ai/geminiClient.js");
  const client = await import("../src/ai/client.js");
  return { geminiClient, client };
}

describe("Повтор и бюджет callGemini/callAiText", () => {
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

  function stubFetch(handler: (call: Call) => Promise<Response>) {
    globalThis.fetch = vi.fn((url: unknown) => {
      const call: Call = { url: String(url) };
      calls.push(call);
      return handler(call);
    }) as unknown as typeof fetch;
  }

  it("HTTP 400 не повторяется внутри модели — одна попытка, не четыре", async () => {
    const { geminiClient } = await loadModules({
      GEMINI_ATTEMPT_TIMEOUT_MS: "200",
      GEMINI_TOTAL_BUDGET_MS: "2000",
    });
    stubFetch(() => Promise.resolve(new Response("bad request", { status: 400 })));

    const result = await geminiClient.callGemini<{ reply: string }>({
      endpoint: "lead-qualify",
      system: "правила бота",
      user: "здравствуйте",
      maxTokens: 500,
      schema: SCHEMA,
    });

    expect(result).toBeNull();
    // Только один ключ и одна модель настроены — цикл заканчивается после первой
    // попытки, а не после ATTEMPTS_PER_MODEL (4): 400 от паузы не изменится.
    expect(calls).toHaveLength(1);
  });

  it("HTTP 404 не повторяется внутри модели — одна попытка, имя модели считается неизвестным Google", async () => {
    const { geminiClient } = await loadModules({
      GEMINI_ATTEMPT_TIMEOUT_MS: "200",
      GEMINI_TOTAL_BUDGET_MS: "2000",
    });
    stubFetch(() => Promise.resolve(new Response("model not found", { status: 404 })));

    const result = await geminiClient.callGemini<{ reply: string }>({
      endpoint: "lead-qualify",
      system: "правила бота",
      user: "здравствуйте",
      maxTokens: 500,
      schema: SCHEMA,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("HTTP 503 (перегрузка) — единственная модель ПОВТОРЯЕТСЯ несколько раз, не сдаётся с первой", async () => {
    const { geminiClient } = await loadModules({
      GEMINI_ATTEMPT_TIMEOUT_MS: "200",
      GEMINI_TOTAL_BUDGET_MS: "20000",
    });
    stubFetch((call) => {
      const count = calls.filter((c) => c.url === call.url).length;
      return Promise.resolve(count <= 2 ? new Response("overloaded", { status: 503 }) : toolCallResponse({ reply: "ок" }));
    });

    const result = await geminiClient.callGemini<{ reply: string }>({
      endpoint: "lead-qualify",
      system: "правила бота",
      user: "здравствуйте",
      maxTokens: 500,
      schema: SCHEMA,
    });

    expect(result).toEqual({ reply: "ок" });
    expect(calls.length).toBeGreaterThan(1);
  }, 20_000);

  it("callAiText (client.ts): первый вызов пуст → РОВНО одна дополнительная попытка, не бесконечный повтор", async () => {
    const { client } = await loadModules({
      GEMINI_ATTEMPT_TIMEOUT_MS: "200",
      GEMINI_TOTAL_BUDGET_MS: "2000",
    });
    // Каждый ПОЛНЫЙ вызов callGemini (не HTTP-запрос) должен провалиться первый раз
    // и на второй раз ответить — 400 гарантирует ровно один HTTP-запрос за вызов
    // callGemini (см. тест выше), поэтому 2 HTTP-запроса = 2 полных вызова = 1 повтор.
    stubFetch((call) => {
      const count = calls.filter((c) => c.url === call.url).length;
      return Promise.resolve(count === 1 ? new Response("bad", { status: 400 }) : toolCallResponse({ reply: "со второго раза" }));
    });

    const result = await client.callAiText<{ reply: string }>({
      endpoint: "lead-qualify",
      system: "правила бота",
      user: "здравствуйте",
      maxTokens: 500,
      schema: SCHEMA,
    });

    expect(result).toEqual({ reply: "со второго раза" });
    expect(calls).toHaveLength(2); // ровно 1 первая попытка + 1 повтор, не больше
    const messages = logSystemError.mock.calls.map((c) => String(c[1])).join("\n");
    expect(messages).toContain("помог повтор");
  });

  it("callAiText (client.ts): обе попытки пусты → null, повтор был РОВНО один раз", async () => {
    const { client } = await loadModules({
      GEMINI_ATTEMPT_TIMEOUT_MS: "200",
      GEMINI_TOTAL_BUDGET_MS: "2000",
    });
    stubFetch(() => Promise.resolve(new Response("bad", { status: 400 })));

    const result = await client.callAiText<{ reply: string }>({
      endpoint: "lead-qualify",
      system: "правила бота",
      user: "здравствуйте",
      maxTokens: 500,
      schema: SCHEMA,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(2); // первая попытка + ровно одна дополнительная
    const messages = logSystemError.mock.calls.map((c) => String(c[1])).join("\n");
    expect(messages).toContain("повтор тоже не помог");
  });
});

/**
 * БЮДЖЕТ 75 СЕКУНД ПО УМОЛЧАНИЮ (TOTAL_BUDGET_MS в geminiClient.ts).
 *
 * Прогонять реальные 75 секунд ожидания ради проверки одной константы — плохая
 * сделка для набора тестов, который гоняют на каждый PR (см. правило `npm run
 * precheck`, ~1,5 мин на весь прогон). Функционально бюджет уже покрыт
 * (gemini-fallback-budget.test.ts проверяет, что деньги времени режутся именно по
 * GEMINI_TOTAL_BUDGET_MS/GEMINI_FALLBACK_RESERVE_MS с ЛЮБЫМ значением) — здесь
 * закрепляем только САМО число по умолчанию, чтобы правка «75_000» → «7_500» не
 * прошла тесты молча.
 */
describe("Бюджет Gemini по умолчанию", () => {
  it("TOTAL_BUDGET_MS по умолчанию — 75 секунд (75_000 мс)", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, "../src/ai/geminiClient.ts"), "utf8");
    const match = /envMs\("GEMINI_TOTAL_BUDGET_MS",\s*([\d_]+)\)/.exec(source);
    expect(match).not.toBeNull();
    expect(Number(match![1].replace(/_/g, ""))).toBe(75_000);
  });
});

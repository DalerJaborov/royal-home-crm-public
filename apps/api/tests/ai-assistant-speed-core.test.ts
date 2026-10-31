import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Скорость и надёжность ядра помощника CRM (31.10.2026, пачка П1, задачи 1.1, 1.3,
 * 1.4, 1.7 — docs/design/internal-assistant-architecture-2026-10-31.md).
 *
 *  - 1.1: срок 25 с на весь диалог — зависшая модель не держит человека дольше;
 *  - 1.3: настройки помощника кэшируются на 15 с и не дольше;
 *  - 1.4: инструменты чтения одного раунда идут параллельно, ответы — в порядке вызовов;
 *  - 1.7: длинная история не даёт 400, а режется до окна.
 *
 * geminiClient подменён (сеть к Google не бьём), ключи — подменой
 * resolveGeminiRuntime; повторы и запасная модель на настоящем клиенте — в
 * ai-assistant-tools-retry.test.ts.
 */

const callGeminiTools = vi.fn();
const callGeminiGrounded = vi.fn();
vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiClient.js")>()),
  callGeminiTools,
  callGeminiGrounded,
}));
vi.mock("../src/ai/geminiSettings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiSettings.js")>()),
  resolveGeminiRuntime: async () => ({
    keys: ["fake-gemini-key"],
    model: "gemini-test",
    fallbackModels: [],
    transcribeModels: [],
    imageModel: "unused",
    liteModel: "",
    explicitCaching: false,
  }),
}));
const semanticPropertySearch = vi.fn();
vi.mock("../src/lib/embeddingSearch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/embeddingSearch.js")>()),
  semanticPropertySearch,
}));

const { prisma } = await import("../src/db.js");
const { assistantRequestSchema, ASSISTANT_HISTORY_WINDOW } = await import("@royal-home/shared");
const { runAssistant, runAssistantDetailed, ASSISTANT_DEADLINE_MS, MAX_TOOL_ROUNDS } = await import("../src/ai/assistant.js");
const { loadAssistantSettings, resetAssistantRuntimeCache, ASSISTANT_RUNTIME_TTL_MS } = await import(
  "../src/ai/assistant/runtime.js"
);

const actor = {
  id: "speed-core-test-actor",
  role: "DIRECTOR",
  canViewAllClients: true,
  canViewPhone: false,
  canViewReports: true,
  canViewFinance: true,
  canViewAllDeals: true,
};

let saved: { aiAssistantEnabled: boolean; semanticSearchEnabled: boolean; groundedSearchEnabled: boolean };

beforeAll(async () => {
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = {
    aiAssistantEnabled: settings.aiAssistantEnabled,
    semanticSearchEnabled: settings.semanticSearchEnabled,
    groundedSearchEnabled: settings.groundedSearchEnabled,
  };
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  resetAssistantRuntimeCache();
  await prisma.$disconnect();
});

function textTurn(text: string) {
  return { text, calls: [], modelParts: [{ text }], tokens: 1 };
}

describe("1.1 — срок на весь диалог", () => {
  it("срок по умолчанию — 25 секунд, раундов не больше четырёх", () => {
    expect(ASSISTANT_DEADLINE_MS).toBe(25_000);
    expect(MAX_TOOL_ROUNDS).toBe(4);
  });

  it("модель зависла дольше срока — человек получает «слишком долго» в срок, а вызов модели отменён", async () => {
    resetAssistantRuntimeCache();
    callGeminiTools.mockReset();
    // Подменённая модель НЕ слушает сигнал и не отвечает 30 с — срок обязан
    // соблюдаться, даже если вызванное повисло.
    callGeminiTools.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(textTurn("поздно")), 30_000).unref()),
    );

    const started = Date.now();
    const outcome = await runAssistantDetailed([{ role: "user", content: "Сводка за месяц" }], actor, { deadlineMs: 300 });
    const elapsed = Date.now() - started;

    expect(outcome).toEqual({ ok: false, code: "deadline", retryable: true });
    expect(elapsed).toBeLessThan(2_000);
    const params = callGeminiTools.mock.calls[0][0] as { signal: AbortSignal; deadlineAt: number };
    expect(params.signal.aborted).toBe(true);
    expect(params.deadlineAt - started).toBeLessThanOrEqual(300 + 50);
  });

  it("внешняя отмена (клиент ушёл) — код aborted, вызов модели получает отменённый сигнал", async () => {
    resetAssistantRuntimeCache();
    callGeminiTools.mockReset();
    callGeminiTools.mockImplementation(() => new Promise(() => {}));
    const client = new AbortController();

    const pending = runAssistantDetailed([{ role: "user", content: "Найди клиента" }], actor, { signal: client.signal });
    await vi.waitFor(() => expect(callGeminiTools).toHaveBeenCalledTimes(1));
    client.abort();
    const outcome = await pending;

    expect(outcome).toEqual({ ok: false, code: "aborted", retryable: true });
    expect((callGeminiTools.mock.calls[0][0] as { signal: AbortSignal }).signal.aborted).toBe(true);
  });

  it("обычный ответ после срока не задерживается: таймер срока снимается", async () => {
    resetAssistantRuntimeCache();
    callGeminiTools.mockReset().mockResolvedValue(textTurn("Готово."));
    const outcome = await runAssistantDetailed([{ role: "user", content: "Привет" }], actor);
    expect(outcome).toEqual({ ok: true, reply: "Готово." });
  });
});

describe("1.3 — настройки помощника: одно чтение на 15 секунд", () => {
  it("выключенный рубильник виден не позже чем через 15 секунд", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantEnabled: true } });
    resetAssistantRuntimeCache();
    expect((await loadAssistantSettings()).enabled).toBe(true);

    await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantEnabled: false } });
    // В пределах срока кэша — прежнее значение (это и есть экономия чтений).
    expect((await loadAssistantSettings()).enabled).toBe(true);

    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + ASSISTANT_RUNTIME_TTL_MS + 1);
    try {
      expect((await loadAssistantSettings()).enabled).toBe(false);
    } finally {
      clock.mockRestore();
    }
    expect(ASSISTANT_RUNTIME_TTL_MS).toBe(15_000);
  });

  it("одновременные запросы делят одно чтение Settings", async () => {
    resetAssistantRuntimeCache();
    const spy = vi.spyOn(prisma.settings, "findUnique");
    try {
      await Promise.all([loadAssistantSettings(), loadAssistantSettings(), loadAssistantSettings()]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("на весь диалог из двух раундов — не больше двух чтений Settings", async () => {
    resetAssistantRuntimeCache();
    callGeminiTools
      .mockReset()
      .mockResolvedValueOnce({
        text: "",
        calls: [{ name: "get_company_stats", args: {} }],
        modelParts: [{ functionCall: { name: "get_company_stats", args: {} } }],
        tokens: 1,
      })
      .mockResolvedValueOnce(textTurn("Сводка готова."));
    const spy = vi.spyOn(prisma.settings, "findUnique");
    try {
      const reply = await runAssistant([{ role: "user", content: "Сводка за месяц" }], actor);
      expect(reply).toBe("Сводка готова.");
      // Тумблеры помощника — одно чтение; ключи и модели подменены здесь, в проде
      // это второе. get_company_stats сам Settings не читает.
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("1.4 — инструменты чтения одного раунда параллельно", () => {
  it("два чтения стартуют вместе, ответы возвращаются модели в порядке её вызовов", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { semanticSearchEnabled: true } });
    resetAssistantRuntimeCache();

    // Барьер: каждый поиск ждёт, пока стартуют ОБА. Последовательное исполнение
    // здесь зависло бы на первом вызове и упёрлось в срок диалога.
    let started = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    semanticPropertySearch.mockReset().mockImplementation(async () => {
      started += 1;
      if (started === 2) release();
      await bothStarted;
      return [];
    });

    const callA = { name: "search_properties", args: { semanticQuery: "тихий двор" }, id: "call-a" };
    const callB = { name: "search_properties", args: { semanticQuery: "рядом парк", type: "HOUSE" }, id: "call-b" };
    callGeminiTools
      .mockReset()
      .mockResolvedValueOnce({
        text: "",
        calls: [callA, callB],
        modelParts: [{ functionCall: callA }, { functionCall: callB }],
        tokens: 1,
      })
      .mockResolvedValueOnce(textTurn("Нашёл."));

    const outcome = await runAssistantDetailed([{ role: "user", content: "Подбери варианты" }], actor, { deadlineMs: 5_000 });

    expect(outcome).toEqual({ ok: true, reply: "Нашёл." });
    expect(semanticPropertySearch).toHaveBeenCalledTimes(2);
    const second = callGeminiTools.mock.calls[1][0] as { contents: { role: string; parts: { functionResponse?: { id?: string } }[] }[] };
    const responses = second.contents[second.contents.length - 1];
    expect(responses.role).toBe("user");
    expect(responses.parts.map((p) => p.functionResponse?.id)).toEqual(["call-a", "call-b"]);
  });
});

describe("1.7 — окно истории", () => {
  const longHistory = Array.from({ length: 30 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `реплика ${i + 1}`,
  }));

  it("схема: 30 сообщений — не 400, а последние сообщения окна, начиная с реплики пользователя", () => {
    const parsed = assistantRequestSchema.safeParse({ messages: [...longHistory, { role: "user", content: "реплика 31" }] });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.messages.length).toBeLessThanOrEqual(ASSISTANT_HISTORY_WINDOW);
    expect(ASSISTANT_HISTORY_WINDOW).toBe(12);
    expect(parsed.data.messages[0].role).toBe("user");
    expect(parsed.data.messages.at(-1)?.content).toBe("реплика 31");
  });

  it("в модель при прямом вызове уходит не больше 12 сообщений", async () => {
    resetAssistantRuntimeCache();
    callGeminiTools.mockReset().mockResolvedValue(textTurn("Ок."));

    await runAssistant(longHistory, actor);

    const params = callGeminiTools.mock.calls[0][0] as { contents: { role: string }[] };
    expect(params.contents.length).toBeLessThanOrEqual(12);
    expect(params.contents[0].role).toBe("user");
  });
});

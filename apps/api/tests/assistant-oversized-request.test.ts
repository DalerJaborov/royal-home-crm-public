import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * СЛИШКОМ БОЛЬШОЙ ЗАПРОС ПОМОЩНИЦЫ — СЖАТИЕ, А НЕ «ЛИМИТ ВЫЗОВОВ» (прод 19.11.2026).
 *
 * Директор попросил «подробный список» обращений за день: на втором шаге хода в запрос
 * легли два больших результата инструментов, вход перевалил за предел токенов, и
 * человеку ушло «Лимит вызовов ИИ достигнут или учёт расходов недоступен» при
 * потраченных 1,47 $ из 30. Здесь ход идёт по настоящему циклу помощницы с настоящей
 * денежной защитой (createAssistantMoneyGuard + кошелёк хода); подменены только
 * вызов Google (callGeminiTools зовёт beforeAttempt, как настоящий клиент) и ответ
 * countTokens (fetch) — живых запросов к Gemini нет.
 */

const callGeminiTools = vi.fn();
vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiClient.js")>()),
  callGeminiTools,
}));
vi.mock("../src/ai/geminiSettings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiSettings.js")>()),
  resolveGeminiRuntime: async () => ({
    keys: ["fake-gemini-key"],
    model: "gemini-3.1-pro-preview",
    fallbackModels: [],
    transcribeModels: [],
    imageModel: "unused",
    liteModel: "",
    explicitCaching: false,
  }),
}));

const { prisma } = await import("../src/db.js");
const { dushanbeDayKey } = await import("@royal-home/shared");
const { runAssistantDetailed, assistantErrorMessage, ASSISTANT_ERROR_MESSAGES, ASSISTANT_ERROR_MESSAGES_TG } = await import("../src/ai/assistant.js");
const { createAssistantMoneyWallet } = await import("../src/ai/assistant/moneyBudget.js");
const { MAX_ASSISTANT_INPUT_TOKENS } = await import("../src/ai/assistant/moneyPolicy.js");
const { registerAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { resetAssistantRuntimeCache } = await import("../src/ai/assistant/runtime.js");
const { waitFor } = await import("./helpers/waitFor.js");
const { AssistantAttemptLimitError } = await import("../src/ai/assistant/attemptLimit.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");

const runId = String(Date.now()).slice(-8);
let actorId = "";
const actor = {
  get id() { return actorId; },
  role: "AGENT",
  canViewAllClients: false,
  canViewPhone: false,
  canViewReports: false,
  canViewFinance: false,
  canViewAllDeals: false,
  canAssignClients: false,
  canEditForeignProperties: false,
  canModerate: false,
  canRequestChange: false,
  permissions: new Set<never>(),
};

const BIG_A = `big_requests_${runId}`;
const BIG_B = `big_calls_${runId}`;
const MID_A = `mid_requests_${runId}`;
const MID_B = `mid_calls_${runId}`;
/** Записи без поля code: иначе срыв отдал бы частичный ответ, а тест проверяет отказ. */
const bigList = (prefix: string, n: number) => ({
  total: n,
  items: Array.from({ length: n }, (_, i) => ({ n: i + 1, title: `${prefix} обращение ${i + 1}: клиент спрашивает квартиру в Сино`, note: "x".repeat(160) })),
});
const off: Array<() => void> = [];

/**
 * countTokens: токены = знаки запроса / 3. fixedTokens добавляется, когда в запросе уже
 * есть ответы инструментов, — неужимаемая часть хода (система, описания, вопрос),
 * которая одна почти съедает предел.
 */
let fixedTokens = 0;
const countCalls: number[] = [];
function stubCountTokens(): void {
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = String(init?.body ?? "");
    const tokens = (body.includes("functionResponse") ? fixedTokens : 0) + Math.ceil(body.length / 3);
    countCalls.push(tokens);
    return new Response(JSON.stringify({ totalTokens: tokens }));
  }));
}

type ToolsParams = {
  apiKey: string; system: string; contents: { role: string; parts: Record<string, unknown>[] }[];
  tools: unknown[]; maxTokens?: number; beforeAttempt?: (attempt: unknown) => Promise<void>; signal?: AbortSignal;
};

/** Как настоящий клиент: сначала beforeAttempt (подсчёт + резерв), потом «ответ Google». */
function scriptModel(answer: (params: ToolsParams) => { text: string; calls: { name: string; args: Record<string, unknown> }[] }) {
  callGeminiTools.mockImplementation(async (params: ToolsParams) => {
    const body = {
      contents: params.contents,
      systemInstruction: { parts: [{ text: params.system }] },
      tools: [{ functionDeclarations: params.tools }],
      generationConfig: { maxOutputTokens: params.maxTokens ?? 1500 },
    };
    await params.beforeAttempt?.({ model: "gemini-3.1-pro-preview", body, apiKey: params.apiKey, signal: params.signal, kind: "generate" });
    const turn = answer(params);
    return {
      text: turn.text,
      calls: turn.calls,
      modelParts: turn.calls.length ? turn.calls.map((c) => ({ functionCall: c })) : [{ text: turn.text }],
      tokens: 1,
    };
  });
}

const hasToolResults = (params: ToolsParams) => params.contents.some((c) => c.parts.some((p) => "functionResponse" in p));
const twoBigTools = (params: ToolsParams) => hasToolResults(params)
  ? { text: "За день 900 обращений, вот первые из них.", calls: [] }
  : { text: "", calls: [{ name: BIG_A, args: {} }, { name: BIG_B, args: {} }] };

function lastResults(): unknown[] {
  const params = callGeminiTools.mock.calls.at(-1)![0] as ToolsParams;
  return params.contents.flatMap((c) => c.parts)
    .filter((p) => "functionResponse" in p)
    .map((p) => (p.functionResponse as { response: { result: unknown } }).response.result);
}

/** Строка журнала хода этого теста (вопрос в журнале проходит маску номеров — ищем по времени). */
async function turnLogOf(since: Date) {
  return waitFor(() => prisma.aiAssistantTurnLog.findFirst({ where: { agentId: actorId, createdAt: { gte: since } }, orderBy: { createdAt: "desc" } }));
}

function walletWith(daily: (amount: number) => Promise<boolean>) {
  const reserved: number[] = [];
  const wallet = createAssistantMoneyWallet({
    dailyUsd: "30", turnUsd: "1",
    reserveDaily: async (amount) => { reserved.push(amount); return daily(amount); },
  });
  return { wallet, reserved };
}

beforeAll(async () => {
  actorId = await createTestAgent(`Слишком большой запрос ${runId}`);
  for (const [name, n] of [[BIG_A, 450], [BIG_B, 450], [MID_A, 200], [MID_B, 200]] as const) {
    off.push(registerAssistantToolPlugin({
      name, level: "A", description: "Тестовый большой список", statusPhrase: "Смотрю…",
      run: async () => bigList(name, n),
    } as never));
  }
  await prisma.settings.upsert({ where: { id: "singleton" }, update: { aiAssistantEnabled: true }, create: { id: "singleton", aiAssistantEnabled: true } });
  resetAssistantRuntimeCache();
});

afterEach(() => {
  callGeminiTools.mockReset();
  vi.unstubAllGlobals();
  countCalls.length = 0;
  fixedTokens = 0;
});

afterAll(async () => {
  while (off.length) off.pop()!();
  await prisma.aiAssistantTurnLog.deleteMany({ where: { agentId: actorId } });
  await cleanupAssistantActionAgents([actorId]);
  await prisma.$disconnect();
});

describe("слишком большой вход — сжатие и повтор, а не отказ", () => {
  it("два больших результата инструментов: помощница отвечает, список обрезан и модель об этом знает", async () => {
    stubCountTokens();
    scriptModel(twoBigTools);
    const { wallet, reserved } = walletWith(async () => true);
    const question = `Покажи подробный список обращений ${runId}-1`;
    const since = new Date();
    const outcome = await runAssistantDetailed([{ role: "user", content: question }], actor, { moneyWallet: wallet, maxRounds: 4 });

    expect(outcome).toEqual({ ok: true, reply: "За день 900 обращений, вот первые из них." });
    // Шаг 1 (вызов инструментов), шаг 2 — не влез, шаг 2 — после сжатия.
    expect(callGeminiTools).toHaveBeenCalledTimes(3);
    expect(countCalls[1]).toBeGreaterThan(MAX_ASSISTANT_INPUT_TOKENS);
    expect(countCalls[2]).toBeLessThanOrEqual(MAX_ASSISTANT_INPUT_TOKENS);
    // Деньги резервируются только под пущенные вызовы, отказ «велик вход» денег не берёт.
    expect(reserved).toHaveLength(2);
    const results = lastResults() as { items: unknown[]; _обрезано?: string }[];
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.items.length).toBeLessThan(450);
      expect(result.items.length).toBeGreaterThan(0);
      expect(result._обрезано).toMatch(new RegExp(`показаны первые ${result.items.length} из 450`));
      expect(result._обрезано).toMatch(/сузить вопрос/);
    }
    const log = await turnLogOf(since);
    expect(log).toMatchObject({ outcome: "answer", reason: "input_shrunk" });
  });

  it("не влезает даже после сжатия: «сузьте вопрос», причина input_too_large, повторов не больше двух", async () => {
    stubCountTokens();
    fixedTokens = MAX_ASSISTANT_INPUT_TOKENS - 2_000;
    scriptModel(twoBigTools);
    const { wallet, reserved } = walletWith(async () => true);
    const question = `Покажи подробный список обращений ${runId}-2`;
    const messages = [{ role: "user" as const, content: question }];
    const since = new Date();
    const outcome = await runAssistantDetailed(messages, actor, { moneyWallet: wallet, maxRounds: 4 });

    expect(outcome).toEqual({ ok: false, code: "too_large", retryable: false });
    expect(assistantErrorMessage("too_large", messages)).toBe(
      "Ответ получается слишком большим. Сузьте вопрос: например, один день, один агент или первые 10 строк.",
    );
    // Шаг 1 и три попытки шага 2 (исходная + два сжатия) — и всё: цикла нет.
    expect(callGeminiTools).toHaveBeenCalledTimes(4);
    expect(reserved).toHaveLength(1);
    const log = await turnLogOf(since);
    expect(log).toMatchObject({ outcome: "error", reason: "input_too_large" });
  });

  it("без переполнения — как раньше: два шага, без сжатия, причина пустая", async () => {
    stubCountTokens();
    scriptModel((params) => hasToolResults(params)
      ? { text: "Нашла.", calls: [] }
      : { text: "", calls: [{ name: `small_${runId}`, args: {} }] });
    off.push(registerAssistantToolPlugin({
      name: `small_${runId}`, level: "A", description: "Тестовый короткий список", statusPhrase: "Смотрю…",
      run: async () => bigList("short", 3),
    } as never));
    const { wallet, reserved } = walletWith(async () => true);
    const question = `Сколько обращений сегодня ${runId}-3`;
    const since = new Date();
    const outcome = await runAssistantDetailed([{ role: "user", content: question }], actor, { moneyWallet: wallet, maxRounds: 4 });

    expect(outcome).toEqual({ ok: true, reply: "Нашла." });
    expect(callGeminiTools).toHaveBeenCalledTimes(2);
    expect(reserved).toHaveLength(2);
    const results = lastResults() as { items: unknown[]; _обрезано?: string }[];
    expect(results[0].items).toHaveLength(3);
    expect(results[0]._обрезано).toBeUndefined();
    const log = await turnLogOf(since);
    expect(log).toMatchObject({ outcome: "answer", reason: null });
  });
});

describe("дневной предел расходов действительно исчерпан", () => {
  it("человеку — «продолжим завтра», в журнал хода money_daily, руководству одна запись в день", async () => {
    const dedupKey = `assistant-money_daily:${dushanbeDayKey(Date.now())}`;
    await prisma.errorLog.deleteMany({ where: { dedupKey } });
    stubCountTokens();
    scriptModel(() => ({ text: "не должно дойти", calls: [] }));
    for (const suffix of ["a", "b"]) {
      const { wallet } = walletWith(async () => false);
      const question = `Имрӯз чанд муроҷиат омад ${runId}-4${suffix}`;
      const messages = [{ role: "user" as const, content: question }];
      const since = new Date();
    const outcome = await runAssistantDetailed(messages, actor, { moneyWallet: wallet, maxRounds: 2 });
      expect(outcome).toEqual({ ok: false, code: "daily_limit", retryable: false });
      expect(assistantErrorMessage("daily_limit", messages)).toBe(ASSISTANT_ERROR_MESSAGES_TG.daily_limit);
      const log = await turnLogOf(since);
      expect(log).toMatchObject({ outcome: "error", reason: "money_daily" });
    }
    expect(ASSISTANT_ERROR_MESSAGES.daily_limit).toBe("На сегодня предел расходов на ИИ исчерпан, продолжим завтра. Руководителю уже сообщено.");
    expect(ASSISTANT_ERROR_MESSAGES_TG.daily_limit).toBe("Имрӯз ҳадди хароҷоти ИИ тамом шуд, пагоҳ идома медиҳем. Ба роҳбар хабар дода шуд.");
    await waitFor(() => prisma.errorLog.findFirst({ where: { dedupKey } }));
    // Второй отказ того же дня новой записи (и нового пуша) не даёт.
    await new Promise((r) => setTimeout(r, 300));
    expect(await prisma.errorLog.count({ where: { dedupKey } })).toBe(1);
  });

  it("учёт расходов недоступен — «временно недоступна, уже чиним», причина accounting_unavailable", async () => {
    stubCountTokens();
    scriptModel(() => ({ text: "не должно дойти", calls: [] }));
    const { wallet } = walletWith(async () => { throw new Error("db down"); });
    const dayKey = `assistant-accounting_unavailable:${dushanbeDayKey(Date.now())}`;
    await prisma.errorLog.deleteMany({ where: { dedupKey: dayKey } });
    const question = `Сводка за день ${runId}-5`;
    const messages = [{ role: "user" as const, content: question }];
    const since = new Date();
    const outcome = await runAssistantDetailed(messages, actor, { moneyWallet: wallet, maxRounds: 2 });
    expect(outcome).toEqual({ ok: false, code: "unavailable", retryable: false });
    expect(assistantErrorMessage("unavailable", messages)).toBe("Помощница временно недоступна, уже чиним.");
    const log = await turnLogOf(since);
    expect(log).toMatchObject({ outcome: "error", reason: "accounting_unavailable" });
    // В ключе дедупа — день: второй сбой учёта через месяц снова дойдёт до руководства пушем.
    expect(await waitFor(() => prisma.errorLog.findFirst({ where: { dedupKey: dayKey } }))).toBeTruthy();
  });
});

describe("потолок попыток и отмена — правдой (ревью 19.11.2026)", () => {
  it("попытки съели повторы после 503 — не «сузьте вопрос», а «ИИ перегружен»", async () => {
    stubCountTokens();
    // Как клиент Gemini при 503: попытка (подсчёт + резерв), отказ Google, снова попытка — пока
    // потолок попыток хода не скажет «хватит».
    callGeminiTools.mockImplementation(async (params: ToolsParams) => {
      const body = { contents: params.contents, systemInstruction: { parts: [{ text: params.system }] },
        tools: [{ functionDeclarations: params.tools }], generationConfig: { maxOutputTokens: 1500 } };
      for (;;) await params.beforeAttempt?.({ model: "gemini-3.1-pro-preview", body, apiKey: params.apiKey, signal: params.signal, kind: "generate" });
    });
    const { wallet } = walletWith(async () => true);
    const question = `Сколько обращений ${runId}-6`;
    const messages = [{ role: "user" as const, content: question }];
    const since = new Date();
    const outcome = await runAssistantDetailed(messages, actor, { moneyWallet: wallet, maxRounds: 4 });
    expect(outcome).toEqual({ ok: false, code: "provider_unavailable", retryable: true });
    expect(assistantErrorMessage("provider_unavailable", messages)).not.toMatch(/Сузьте/);
    const log = await turnLogOf(since);
    expect(log).toMatchObject({ outcome: "error", reason: "attempt_cap" });
  });

  it("попытку оборвал её таймер, а не человек — «слишком долго», ошибка в журнале, не «отменено»", async () => {
    stubCountTokens();
    const prefix = "Ассистент CRM не ответил (aborted)";
    await prisma.errorLog.deleteMany({ where: { message: { startsWith: prefix } } });
    callGeminiTools.mockImplementation(async (params: ToolsParams) => {
      const attemptTimer = new AbortController();
      attemptTimer.abort(); // таймер попытки geminiClient сработал, ход человеком не отменён
      await params.beforeAttempt?.({ model: "gemini-3.1-pro-preview", apiKey: params.apiKey, signal: attemptTimer.signal, kind: "generate",
        body: { contents: params.contents, systemInstruction: { parts: [{ text: params.system }] }, tools: [{ functionDeclarations: params.tools }], generationConfig: { maxOutputTokens: 1500 } } });
      return { text: "не должно дойти", calls: [], modelParts: [{ text: "x" }], tokens: 1 };
    });
    const { wallet } = walletWith(async () => true);
    const question = `Сводка ${runId}-7`;
    const since = new Date();
    const outcome = await runAssistantDetailed([{ role: "user", content: question }], actor, { moneyWallet: wallet, maxRounds: 2 });
    expect(outcome).toEqual({ ok: false, code: "deadline", retryable: true });
    const log = await turnLogOf(since);
    expect(log).toMatchObject({ outcome: "error", reason: "aborted" });
    expect(await waitFor(() => prisma.errorLog.findFirst({ where: { message: { startsWith: prefix } } }))).toBeTruthy();
  });

  it("конверт хода кончается, но ужатый запрос влезает в остаток — сжатие, а не отказ", async () => {
    stubCountTokens();
    scriptModel((params) => hasToolResults(params)
      ? { text: "Вот первые обращения.", calls: [] }
      : { text: "", calls: [{ name: MID_A, args: {} }, { name: MID_B, args: {} }] });
    // Кошелёк по тому же договору: после первого шага в остатке хода — ровно на 20 000 входных токенов.
    const reserved: number[] = [];
    let turn = 0;
    const wallet = {
      remaining: () => Math.max(0, turn - reserved.reduce((a, b) => a + b, 0)),
      async reserve(amount: number) {
        if (!reserved.length) turn = amount + 20_000 * 2 + 1_500 * 12;
        if (reserved.reduce((a, b) => a + b, 0) + amount > turn) throw new AssistantAttemptLimitError("money_turn", "Конверт хода");
        reserved.push(amount);
      },
    };
    const question = `Подробный список ${runId}-8`;
    const since = new Date();
    const outcome = await runAssistantDetailed([{ role: "user", content: question }], actor, { moneyWallet: wallet, maxRounds: 4 });
    expect(outcome).toEqual({ ok: true, reply: "Вот первые обращения." });
    expect(reserved).toHaveLength(2);
    const results = lastResults() as { items: unknown[]; _обрезано?: string }[];
    expect(results.some((r) => r._обрезано && r.items.length < 200)).toBe(true);
    const log = await turnLogOf(since);
    expect(log).toMatchObject({ outcome: "answer", reason: "input_shrunk" });
  });
});

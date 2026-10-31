import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Повторы, запасная модель и отмена на НАСТОЯЩЕМ клиенте Gemini (31.10.2026,
 * пачка П1 задачи 1.1 и 1.2, docs/design/internal-assistant-architecture-2026-10-31.md).
 *
 * До этого путь инструментов помощника делал одну попытку на модель: первый же
 * 429 у Google без запасной модели давал отказ всего ответа. Здесь сеть к Google
 * подменена (fetch), а всё остальное — настоящее: callGeminiTools, политика
 * повторов, срок, отмена, маршрут POST /api/v1/ai/assistant.
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
const { callGeminiTools } = await import("../src/ai/geminiClient.js");
const { runAssistantDetailed } = await import("../src/ai/assistant.js");
const { resetAssistantRuntimeCache } = await import("../src/ai/assistant/runtime.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const actor = {
  id: "tools-retry-test-actor",
  role: "AGENT",
  canViewAllClients: false,
  canViewPhone: false,
  canViewReports: false,
  canViewFinance: false,
  canViewAllDeals: false,
};

function textResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("1.2 — повторы на пути инструментов", () => {
  it("429 → 200: помощник отвечает со второй попытки той же моделью, а не отказом", async () => {
    resetAssistantRuntimeCache();
    const fetchMock = vi.fn(async () => (fetchMock.mock.calls.length === 1 ? new Response("quota", { status: 429 }) : textResponse("Готово.")));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await runAssistantDetailed([{ role: "user", content: "Сколько у меня клиентов?" }], actor);

    expect(outcome).toEqual({ ok: true, reply: "Готово." });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(urls[0]).toBe(urls[1]);
  });

  it("400 — запрос неверен, повтор не поможет: один запрос и код provider_rejected без «повторить»", async () => {
    resetAssistantRuntimeCache();
    const fetchMock = vi.fn(async () => new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await runAssistantDetailed([{ role: "user", content: "Сводка" }], actor);

    expect(outcome).toEqual({ ok: false, code: "provider_rejected", retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("503 без конца — повторы укладываются в срок, после него ни попытки, ни паузы", async () => {
    const fetchMock = vi.fn(async () => new Response("overloaded", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const started = Date.now();
    await expect(
      callGeminiTools({
        apiKey: "fake-gemini-key",
        system: "правила",
        contents: [{ role: "user", parts: [{ text: "Сводка" }] }],
        tools: [],
        deadlineAt: started + 1_200,
      }),
    ).rejects.toMatchObject({ status: 503 });

    // 0 с, +1 с — две попытки; пауза в 2 с уже не помещается в срок и режется.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it("внешняя отмена прерывает паузу перед повтором — без новой попытки", async () => {
    const fetchMock = vi.fn(async () => new Response("overloaded", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const stop = new AbortController();
    setTimeout(() => stop.abort(new Error("клиент ушёл")), 200);

    const started = Date.now();
    await expect(
      callGeminiTools({
        apiKey: "fake-gemini-key",
        system: "правила",
        contents: [{ role: "user", parts: [{ text: "Сводка" }] }],
        tools: [],
        signal: stop.signal,
      }),
    ).rejects.toThrow("клиент ушёл");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(900);
  });
});

describe("1.1 — закрытие соединения клиентом прерывает раунд", () => {
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
        fullName: `Агент закрытия соединения ${runId}`,
        phone: `+99277${String(runId).slice(-7)}`,
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

  it("клиент закрыл соединение посреди вызова модели — запрос к Google отменён и не повторён", async () => {
    const signals: AbortSignal[] = [];
    // Google «думает» бесконечно, пока запрос не отменят.
    const fetchMock = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const signal = init?.signal as AbortSignal;
          signals.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { port } = server.address() as AddressInfo;
    const body = JSON.stringify({ messages: [{ role: "user", content: "Найди клиента Умеда" }] });
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/api/v1/ai/assistant",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: `Bearer ${token}`,
      },
    });
    request.on("error", () => {}); // destroy() ниже — намеренно
    const firstEvent = new Promise<string>((resolve) => {
      request.on("response", (res) => {
        res.setEncoding("utf8");
        res.once("data", (chunk: string) => resolve(chunk));
      });
    });
    request.end(body);

    // Первый статус пришёл и запрос к модели ушёл — теперь клиент уходит.
    expect(await firstEvent).toContain("event: status");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    request.destroy();

    await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true), { timeout: 5_000 });
    // Отмена — не отказ модели: повторной попытки после неё нет.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ИСТОРИЯ ДИАЛОГА ДОХОДИТ ДО МОДЕЛИ ЦЕЛОЙ И НЕПУСТОЙ.
 *
 * Проверка родилась 12.08.2026 на другом поставщике: ветка «простой задачи»
 * собирала запрос ТОЛЬКО из params.user, а переданный messages молча
 * выбрасывался. Снаружи это не ломалось (все вызывающие тогда передавали user),
 * но первый же вызов с разговором ушёл бы к модели с пустым сообщением — и ответ
 * пришёл бы «ни о чём», без единой строки в журнале.
 *
 * ПОЧЕМУ ТЕСТ ПЕРЕПИСАН (22.08.2026). Прежний файл (tests/haiku-messages.test.ts)
 * проверял ветку Anthropic/Haiku, а её удалили 20.08.2026 вместе со вторым
 * поставщиком (решение владельца: «поставщик один — Google»). Тест удалить забыли,
 * и он падал с «callHaiku is not a function» — ровно та же болезнь «починили в
 * одном месте, забыли в другом», из-за которой затеян аудит 22.08.
 * Само требование при этом никуда не делось: оно просто переехало на Gemini,
 * поэтому файл не выброшен, а переписан на живой путь.
 *
 * Сеть подменена: тест проверяет, ЧТО мы отправляем, а не токены и не Google.
 */

const logSystemError = vi.fn();
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: (...a: unknown[]) => logSystemError(...a) }));

vi.mock("../src/db.js", () => ({
  prisma: {
    settings: { findUnique: () => Promise.resolve(null) },
    aiLog: { create: () => Promise.resolve({}) },
    // tests/setup.ts закрывает соединения после каждого файла — заглушке тоже нужен.
    $disconnect: () => Promise.resolve(),
  },
}));

const { callAiText } = await import("../src/ai/client.js");

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

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

const fetchMock = vi.fn();

/** Реплики, ушедшие в модель последним запросом, в виде {role, текст}. */
function sentTurns(): { role: string; text: string }[] {
  const body = JSON.parse(String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body));
  return (body.contents as { role: string; parts: { text?: string }[] }[]).map((c) => ({
    role: c.role,
    text: c.parts.map((p) => p.text ?? "").join(""),
  }));
}

beforeEach(() => {
  process.env.GEMINI_API_KEY = "test-key";
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(toolCallResponse({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  logSystemError.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Модель получает историю диалога", () => {
  it("простая задача с messages не уходит пустым запросом", async () => {
    const result = await callAiText<{ ok: boolean }>({
      endpoint: "test:simple-with-history",
      system: "Ты разбираешь переписку.",
      simple: true,
      messages: [
        { role: "user", content: "Салом, хона даркор" },
        { role: "assistant", content: "Кадом тараф?" },
        { role: "user", content: "Сино, 3 хона" },
      ],
      schema: SCHEMA,
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const turns = sentTurns();
    expect(turns).toHaveLength(3);
    expect(turns.map((t) => t.text).join("\n")).toContain("Сино, 3 хона");
    // Главное: ни одной пустой реплики. Ровно так выглядел бы старый запрос.
    expect(turns.some((t) => t.text === "")).toBe(false);
    // Роль ассистента у Gemini называется "model" — перевод обязан состояться,
    // иначе поставщик молча теряет ход бота из истории.
    expect(turns.map((t) => t.role)).toEqual(["user", "model", "user"]);
  });

  it("история, кончающаяся репликой бота, дополняется словами клиента", async () => {
    await callAiText({
      endpoint: "test:assistant-tail",
      system: "Ты продолжаешь разговор.",
      messages: [
        { role: "user", content: "Салом" },
        { role: "assistant", content: "Кадом тараф?" },
      ],
      schema: SCHEMA,
    });

    const turns = sentTurns();
    expect(turns).toHaveLength(3);
    expect(turns[turns.length - 1].role).toBe("user");
  });

  it("вызов без истории работает как прежде — одной репликой клиента", async () => {
    await callAiText({
      endpoint: "test:plain-user",
      system: "Классифицируй.",
      user: "Сино, 3 хона",
      schema: SCHEMA,
    });

    expect(sentTurns()).toEqual([{ role: "user", text: "Сино, 3 хона" }]);
  });
});

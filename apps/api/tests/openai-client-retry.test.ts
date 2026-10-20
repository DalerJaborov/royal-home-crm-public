import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiError, openAiPost, rateLimitWaitMs } from "../src/ai/openaiClient.js";

/**
 * Обрыв связи ПОСЛЕ заголовков, во время чтения тела (живой случай 29.09.2026:
 * «Перерисовать» → «terminated (ECONNRESET)»): картинка приходит мегабайтами,
 * и такой обрыв должен повторяться так же, как обрыв до ответа.
 */
function brokenBody(): Response {
  const err = new TypeError("terminated", { cause: new Error("read ECONNRESET") });
  return { ok: true, status: 200, text: () => Promise.reject(err) } as unknown as Response;
}
const good = () => new Response(JSON.stringify({ data: [{ b64_json: "AAAA" }] }), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openAiPost: обрыв при чтении ответа", () => {
  it("повторяет запрос и возвращает ответ со второй попытки", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(brokenBody()).mockResolvedValueOnce(good());
    vi.stubGlobal("fetch", fetchMock);
    const res = await openAiPost<{ data: { b64_json: string }[] }>("/images/edits", { body: { a: 1 }, timeoutMs: 5_000, apiKey: "sk-test", retryDelayMs: 0 });
    expect(res.data[0].b64_json).toBe("AAAA");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("обрывы на всех попытках — понятная ошибка «Нет связи» с настоящей причиной", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => brokenBody());
    vi.stubGlobal("fetch", fetchMock);
    const err = await openAiPost("/images/edits", { body: { a: 1 }, timeoutMs: 5_000, apiKey: "sk-test", retryDelayMs: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiError);
    expect((err as OpenAiError).message).toBe("Нет связи с OpenAI: terminated (read ECONNRESET)");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

/**
 * 429 «слишком много картинок в минуту» (30.09.2026: лимит аккаунта 5 в минуту, 27 из 42
 * обложек падали после двух коротких повторов): ждём, сколько просит OpenAI, и повторяем.
 */
const limit429 = () =>
  new Response(
    JSON.stringify({ error: { message: "Rate limit reached for gpt-image on input-images per min: Limit 5, Used 5, Requested 1. Please try again in 12s.", code: "rate_limit_exceeded" } }),
    { status: 429 }
  );

describe("openAiPost: лимит запросов в минуту", () => {
  it("срок ожидания берётся из текста ошибки и заголовка Retry-After", () => {
    const body = { error: { message: "Please try again in 12s. Visit" } };
    expect(rateLimitWaitMs({}, body)).toBe(13_000);
    expect(rateLimitWaitMs({}, { error: { message: "try again in 250ms" } })).toBe(1_250);
    expect(rateLimitWaitMs({ headers: new Headers({ "retry-after": "20" }) }, body)).toBe(21_000);
    expect(rateLimitWaitMs({}, { error: { message: "slow down" } })).toBe(15_000);
    expect(rateLimitWaitMs({}, { error: { message: "try again in 600s" } })).toBe(65_000);
  });

  it("повторяет больше двух раз и возвращает ответ", async () => {
    let n = 0;
    const fetchMock = vi.fn().mockImplementation(async () => (++n <= 5 ? limit429() : good()));
    vi.stubGlobal("fetch", fetchMock);
    const res = await openAiPost<{ data: unknown[] }>("/images/edits", { body: { a: 1 }, timeoutMs: 5_000, apiKey: "sk-test", retryDelayMs: 0 });
    expect(res.data).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("«кончились деньги» (тоже 429) не повторяется", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () => new Response(JSON.stringify({ error: { message: "You exceeded your current quota", code: "insufficient_quota" } }), { status: 429 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const err = await openAiPost("/images/edits", { body: { a: 1 }, timeoutMs: 5_000, apiKey: "sk-test", retryDelayMs: 0 }).catch((e: unknown) => e);
    expect((err as OpenAiError).message).toMatch(/закончились деньги/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // 01.10.2026: у OpenAI кончились деньги, а ответ пришёл 429 «You have no credits
  // remaining» БЕЗ кода insufficient_quota — его принимали за лимит в минуту и ждали
  // до 4 минут на каждую картинку. Теперь отказ сразу, одним запросом, без ожидания.
  it.each([
    "You have no credits remaining. Add credits to continue.",
    "Your account is not active, please check your billing details.",
    "You exceeded your current quota, please check your plan.",
    "Insufficient funds on the account.",
  ])("429 «%s» без кода — сразу отказ, один запрос, без ожидания", async (message) => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: { message, type: "invalid_request_error", code: null } }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const started = Date.now();
    // retryDelayMs не ноль: ожидание лимита в минуту при нехватке денег включиться не должно
    const err = await openAiPost("/images/edits", { body: { a: 1 }, timeoutMs: 5_000, apiKey: "sk-test", retryDelayMs: 50 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiError);
    expect((err as OpenAiError).message).toMatch(/закончились деньги.*platform\.openai\.com/);
    expect((err as OpenAiError).code).toBe("insufficient_quota");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("после восьми повторов сдаётся понятной ошибкой", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => limit429());
    vi.stubGlobal("fetch", fetchMock);
    const err = await openAiPost("/images/edits", { body: { a: 1 }, timeoutMs: 5_000, apiKey: "sk-test", retryDelayMs: 0 }).catch((e: unknown) => e);
    expect((err as OpenAiError).message).toMatch(/просит подождать/);
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 429 TOO MANY REQUESTS ОТ TELEGRAM (аудит «монтажёр ↔ CRM», 21.09.2026).
 *
 * До этой правки ни call() (JSON-вызовы вроде sendMessage), ни sendDocumentFile/
 * sendVideoFile (multipart, свой fetch в обход call()) вовсе не смотрели на
 * retry_after — первый же лимит ронял отправку без единой попытки повторить.
 * Монтажёру уходят исходники по одному сообщению НА КАЖДЫЙ ролик (см.
 * dispatchToEditor в lib/videoHandoff.ts), а объекту разрешено до 30 роликов
 * (Settings.propertyVideoMaxCount) — на пачке 15-30 файлов подряд лимит реально
 * задевается.
 *
 * Тест подменяет глобальный fetch и таймеры — в настоящий Telegram не ходит.
 */

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "test-token-rate-limit";

const { sendDocumentFile, sendMessageWithButtons } = await import("../src/telegram/api.js");

function telegramJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const rateLimited = (retryAfterSec: number) =>
  telegramJson({ ok: false, error_code: 429, description: "Too Many Requests: retry after N", parameters: { retry_after: retryAfterSec } });

describe("Telegram 429 — retry_after уважается и повтор доводит отправку до конца", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it("call() (JSON-вызов, sendMessageWithButtons) — ждёт retry_after и повторяет один раз, дальше успех", async () => {
    fetchSpy
      .mockResolvedValueOnce(rateLimited(2))
      .mockResolvedValueOnce(telegramJson({ ok: true, result: { message_id: 1 } }));

    const promise = sendMessageWithButtons("123", "текст", [[{ text: "ок", callback_data: "ok" }]]);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ message_id: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("sendDocumentFile (multipart, ролик монтажёру) — тот же повтор, файл в итоге ДОШЁЛ", async () => {
    fetchSpy
      .mockResolvedValueOnce(rateLimited(1))
      .mockResolvedValueOnce(telegramJson({ ok: true, result: { message_id: 2 } }));

    const promise = sendDocumentFile("123", Buffer.from("сырой ролик"), "ОБ-000109_1из2_IMG_0241.mov", "подпись");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ message_id: 2 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("лимит попыток исчерпан — честная ошибка, а не бесконечное ожидание", async () => {
    // mockImplementation, а не mockResolvedValue: Response.json() читает тело один
    // раз, и один и тот же объект Response на четыре вызова подряд упал бы на
    // втором с "Body is unusable" — нужен свежий Response на каждый fetch.
    fetchSpy.mockImplementation(async () => rateLimited(1));

    const promise = sendDocumentFile("123", Buffer.from("сырой ролик"), "ролик.mp4");
    const assertion = expect(promise).rejects.toThrow(/sendDocument/);
    await vi.runAllTimersAsync();
    await assertion;
    // MAX_RATE_LIMIT_RETRIES = 3 повтора поверх первой попытки — не больше и не меньше.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("отказ БЕЗ 429 (например «chat not found») — падает сразу, без ожидания и повтора", async () => {
    fetchSpy.mockResolvedValueOnce(telegramJson({ ok: false, description: "Bad Request: chat not found" }));

    await expect(sendDocumentFile("123", Buffer.from("сырой ролик"), "ролик.mp4")).rejects.toThrow(/chat not found/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it("durable narration single-attempt transport never waits/retries beyond its claim", async () => {
    fetchSpy.mockResolvedValueOnce(rateLimited(60));
    await expect(sendDocumentFile("123", Buffer.from("audio"), "narration.mp3", "version", 60000, true)).rejects.toThrow(/sendDocument/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

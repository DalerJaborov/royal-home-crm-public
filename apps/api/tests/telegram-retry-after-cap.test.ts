import { describe, expect, it } from "vitest";
import { telegramRetryDelayMs } from "../src/telegram/api.js";

/**
 * Аудит 23.09.2026, круг 3, №85: пауза по `retry_after` не имела потолка — при
 * flood-wait Telegram просит часы, и вся цепочка сообщений чата (или задача по
 * расписанию) стояла столько же.
 */
describe("ожидание по retry_after Telegram ограничено минутой", () => {
  it("обычная пауза в секунды — ждём и повторяем", () => {
    expect(telegramRetryDelayMs({ ok: false, error_code: 429, parameters: { retry_after: 5 } }, 0)).toBe(6_000);
  });

  it("пауза больше минуты — отказ сразу, без ожидания", () => {
    expect(telegramRetryDelayMs({ ok: false, error_code: 429, parameters: { retry_after: 3600 } }, 0)).toBeNull();
  });

  it("не 429 и исчерпанные попытки — не повторяем", () => {
    expect(telegramRetryDelayMs({ ok: false, error_code: 400 }, 0)).toBeNull();
    expect(telegramRetryDelayMs({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 3)).toBeNull();
  });
});

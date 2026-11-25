import { describe, expect, it } from "vitest";
import { ApiError } from "../apiError";
import { loginBlockInfo, loginBlockText, loginRetryAfterMs } from "../loginRetry";

describe("login resend deadline from API errors", () => {
  it("reads the server countdown from JSON data instead of the Error root", () => {
    expect(loginRetryAfterMs(new ApiError("old message: 3 seconds", 429, { resendAfterSec: 26 }, 30_000))).toBe(26_000);
  });
  it("uses remaining transport cooldown when a repeat is blocked locally", () => {
    expect(loginRetryAfterMs(new ApiError("retry", 429, undefined, 2_000))).toBe(2_000);
  });
  it("does not mistake auth/provider errors for an ordinary cooldown", () => {
    expect(loginRetryAfterMs(new ApiError("unavailable", 503, {}))).toBeNull();
    expect(loginRetryAfterMs(new Error("network"))).toBeNull();
  });
  it("rejects invalid server values and retains a bounded fallback", () => {
    expect(loginRetryAfterMs(new ApiError("retry", 429, { resendAfterSec: -5 }, 4000))).toBe(4000);
    expect(loginRetryAfterMs(new ApiError("retry", 429, { resendAfterSec: "3" }))).toBe(60_000);
  });
});

describe("блок «5 кодов за час» (503 с retryAt)", () => {
  it("читает время снятия и Telegram, текст — в часах Душанбе (UTC+5)", () => {
    const info = loginBlockInfo(new ApiError("many", 503, { retryAt: "2026-11-25T07:05:00.000Z", telegramAvailable: true }));
    expect(info?.telegramAvailable).toBe(true);
    expect(loginBlockText(info!)).toBe(
      "Код уже запрашивали 5 раз за час. Подождите до 12:05 (по Душанбе) или попросите директора сбросить блок."
    );
  });
  it("без retryAt или с мусором — null, обычное сообщение остаётся", () => {
    expect(loginBlockInfo(new ApiError("many", 503, {}))).toBeNull();
    expect(loginBlockInfo(new ApiError("many", 503, { retryAt: "не дата" }))).toBeNull();
    expect(loginBlockInfo(new ApiError("x", 429, { retryAt: "2026-11-25T07:05:00.000Z" }))).toBeNull();
  });
});

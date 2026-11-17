import { describe, expect, it } from "vitest";
import { ApiError } from "../apiError";
import { loginRetryAfterMs } from "../loginRetry";

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

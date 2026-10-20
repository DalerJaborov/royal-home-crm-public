import { describe, expect, it } from "vitest";
import { pushRefreshDue } from "../usePushSubscriptionRefresh";

describe("освежение подписки на уведомления", () => {
  const now = 10 * 24 * 3600 * 1000;
  it("не чаще раза в сутки", () => {
    expect(pushRefreshDue(now, { getItem: () => String(now - 3600_000) })).toBe(false);
    expect(pushRefreshDue(now, { getItem: () => String(now - 25 * 3600_000) })).toBe(true);
  });
  it("нет метки или хранилище недоступно — освежаем", () => {
    expect(pushRefreshDue(now, { getItem: () => null })).toBe(true);
    expect(pushRefreshDue(now, null)).toBe(true);
    expect(pushRefreshDue(now, { getItem: () => { throw new Error("denied"); } })).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { shouldReportScreen } from "../screenSeen";

/**
 * Ночная проверка 24.09.2026, находка №12: `useScreenSeen` стоит в App.tsx
 * выше `ProtectedRoute`, который восстанавливает `accessToken` асинхронно —
 * без проверки токена ручка `/_seen` звалась ещё до входа и получала 401 на
 * каждой холодной загрузке. `shouldReportScreen` — чистая часть решения, без
 * React и без сети.
 */
describe("shouldReportScreen", () => {
  it("без токена не отправляет, даже на защищённом экране", () => {
    expect(shouldReportScreen("/dashboard", false)).toBe(false);
    expect(shouldReportScreen("/clients", false)).toBe(false);
  });

  it("с токеном на защищённом экране — отправляет", () => {
    expect(shouldReportScreen("/dashboard", true)).toBe(true);
    expect(shouldReportScreen("/clients/1", true)).toBe(true);
  });

  it("публичные экраны не отправляет никогда — токен не меняет решения", () => {
    expect(shouldReportScreen("/login", true)).toBe(false);
    expect(shouldReportScreen("/login", false)).toBe(false);
    expect(shouldReportScreen("/l/abc123", true)).toBe(false);
  });
});

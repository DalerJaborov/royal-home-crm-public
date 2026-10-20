import { describe, expect, it } from "vitest";
import { networkFailureError, retryAfterMessage } from "../api";

/**
 * Тексты сбоев не обещают того, чего не будет, и не говорят по-английски
 * (аудит 23.09.2026, №14 и №15).
 */
describe("тексты сбоев связи", () => {
  it("429 на чтении обещает повтор — его делает сама CRM", () => {
    expect(retryAfterMessage(3_000, "GET")).toContain("повторим через 3 с");
  });

  it("429 на записи не обещает повтора — просит нажать ещё раз", () => {
    const text = retryAfterMessage(3_000, "POST");
    expect(text).not.toContain("повторим");
    expect(text).toContain("не сохранилось");
  });

  it("обрыв браузера («Failed to fetch», «Load failed») — по-русски", () => {
    for (const raw of ["Failed to fetch", "Load failed"]) {
      const err = networkFailureError(new TypeError(raw), "GET") as Error;
      expect(err.message).not.toMatch(/fetch|Load failed/);
      expect(err.message).toContain("Нет связи");
    }
  });

  it("обрыв на записи честно говорит, что изменение не сохранилось", () => {
    const err = networkFailureError(new TypeError("Failed to fetch"), "PATCH") as Error;
    expect(err.message).toContain("не сохранилось");
    const timeout = networkFailureError(new Error("Связь пропала — попробуем ещё раз"), "POST") as Error;
    expect(timeout.message).not.toContain("попробуем");
  });

  it("чужие ошибки не подменяются", () => {
    const own = new Error("что-то своё");
    expect(networkFailureError(own, "GET")).toBe(own);
  });
});

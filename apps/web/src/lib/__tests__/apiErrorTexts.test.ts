import { afterEach, describe, expect, it, vi } from "vitest";
import { api, networkFailureError, retryAfterMessage } from "../api";

afterEach(() => vi.unstubAllGlobals());

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

  it.each(["POST", "PATCH", "PUT", "DELETE"])("%s: обрыв и таймаут требуют проверить результат перед повтором", (method) => {
    for (const failure of [new TypeError("Failed to fetch"), new Error("Связь пропала — попробуем ещё раз")]) {
      const err = networkFailureError(failure, method) as Error;
      expect(err.message).toContain("Не удалось подтвердить результат");
      expect(err.message).toContain("Перед повтором проверьте");
      expect(err.message).not.toContain("изменение не сохранилось");
      expect(err.message).not.toContain("попробуем");
    }
  });

  it("потеря ответа после записи не утверждает, что запись не произошла", async () => {
    const stored: unknown[] = [];
    const transport = vi.fn(async (_url: string, options?: RequestInit) => {
      stored.push(JSON.parse(String(options?.body)));
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", transport);
    await expect(api("/clients/test-only/notes", { method: "POST", body: { text: "test-only" } }))
      .rejects.toThrow("Перед повтором проверьте");
    expect(stored).toEqual([{ text: "test-only" }]);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("чужие ошибки не подменяются", () => {
    const own = new Error("что-то своё");
    expect(networkFailureError(own, "GET")).toBe(own);
  });
});

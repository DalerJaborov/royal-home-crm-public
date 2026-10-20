import { describe, expect, it, vi } from "vitest";

/**
 * Ключ повтора не сбрасывается ответом «первая попытка ещё выполняется»
 * (аудит Codex 04.10.2026, WEB-06). Сброс отдавал следующему нажатию новый ключ и
 * обходил защиту от дубля, ради которой ключ и существует.
 */
vi.mock("react", () => ({
  useRef: <T,>(v: T) => ({ current: v }),
  useMemo: <T,>(f: () => T) => f(),
}));
vi.mock("../../lib/api", async () => {
  let n = 0;
  const { ApiError } = await import("../../lib/apiError");
  return { ApiError, newIdempotencyKey: () => `key-${++n}` };
});

import { ApiError } from "../../lib/apiError";
import { useRetryKey } from "../useRetryKey";

describe("useRetryKey.settle", () => {
  it("ключ живёт через обрыв и через 409 inProgress, сбрасывается обычным отказом", () => {
    const rk = useRetryKey();
    const k1 = rk.current();
    rk.settle(new Error("таймаут")); // не ApiError: сервер не ответил
    expect(rk.current()).toBe(k1);
    rk.settle(new ApiError("выполняется", 409, { inProgress: true }));
    expect(rk.current()).toBe(k1);
    rk.settle(new ApiError("неверные данные", 400, {}));
    expect(rk.current()).not.toBe(k1);
  });

  it("409 без признака inProgress (конфликт состояния) ключ сбрасывает", () => {
    const rk = useRetryKey();
    const k1 = rk.current();
    rk.settle(new ApiError("конфликт", 409, {}));
    expect(rk.current()).not.toBe(k1);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { consumeUpdateNotice, markUpdateApplied } from "../appUpdateNotice";

/**
 * Тихая строка «Приложение обновлено» переживает перезагрузку меткой в
 * sessionStorage (полноэкранный экран обновления убран 10.09.2026). Тест
 * закрепляет два свойства, на которых держится всё поведение: строка
 * показывается ровно один раз и только если сборка действительно сменилась.
 */
function installStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
}

describe("метка «обновление применилось»", () => {
  beforeEach(installStorage);

  it("без метки строку не показываем", () => {
    expect(consumeUpdateNotice("build-2")).toBe(false);
  });

  it("метка есть и сборка сменилась -> показываем", () => {
    markUpdateApplied("build-1");
    expect(consumeUpdateNotice("build-2")).toBe(true);
  });

  it("показываем один раз: второй старт вкладки уже молчит", () => {
    markUpdateApplied("build-1");
    expect(consumeUpdateNotice("build-2")).toBe(true);
    expect(consumeUpdateNotice("build-2")).toBe(false);
  });

  it("подмена не состоялась (та же сборка) -> молчим и снимаем метку", () => {
    markUpdateApplied("build-1");
    expect(consumeUpdateNotice("build-1")).toBe(false);
    // Метка снята: обновление до build-2 позже не должно отчитаться дважды.
    expect(consumeUpdateNotice("build-2")).toBe(false);
  });

  it("недоступное хранилище не роняет старт вкладки", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("private mode");
      },
    });
    expect(() => markUpdateApplied("build-1")).not.toThrow();
    expect(consumeUpdateNotice("build-2")).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { briefingSeenKey, isBriefingWindow } from "@royal-home/shared";
import { briefingCardMode, markBriefingSeen, readBriefingSeen } from "../briefingView";

/**
 * Карточка «Утренний брифинг»: окно показа и ключ «уже слышал сегодня».
 *
 * vitest в apps/web работает в режиме node (jsdom не установлен), поэтому
 * проверяется именно чистая логика — компонент её только вызывает. Ровно так же
 * сделан тест троттлинга звука пульта (lib/__tests__/pultSound.test.ts).
 */

describe("окно показа брифинга: 08:00–12:00 по Душанбе", () => {
  it("до восьми утра карточка свёрнута", () => {
    expect(isBriefingWindow(7)).toBe(false);
    expect(briefingCardMode(7, false)).toBe("collapsed");
  });

  it("с восьми до двенадцати развёрнута, пока не прослушана", () => {
    for (const hour of [8, 9, 10, 11]) {
      expect(isBriefingWindow(hour)).toBe(true);
      expect(briefingCardMode(hour, false)).toBe("expanded");
    }
  });

  it("ровно в двенадцать окно уже закрыто", () => {
    expect(isBriefingWindow(12)).toBe(false);
    expect(briefingCardMode(12, false)).toBe("collapsed");
  });

  it("прослушанный брифинг сворачивается даже в утреннее окно", () => {
    expect(briefingCardMode(9, true)).toBe("collapsed");
  });
});

describe("ключ localStorage привязан к дате по Душанбе", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("завтрашний день не наследует вчерашнюю отметку", () => {
    expect(briefingSeenKey("2026-09-14")).not.toBe(briefingSeenKey("2026-09-15"));
    expect(briefingSeenKey("2026-09-14")).toBe("rh:briefing:seen:2026-09-14");
  });

  it("читает и пишет отметку через localStorage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });

    expect(readBriefingSeen("2026-09-14")).toBe(false);
    markBriefingSeen("2026-09-14");
    expect(readBriefingSeen("2026-09-14")).toBe(true);
    // Другая дата — своя отметка, карточка назавтра развернётся сама.
    expect(readBriefingSeen("2026-09-15")).toBe(false);
  });

  it("недоступное хранилище не роняет экран", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("доступ к хранилищу запрещён");
      },
    });

    expect(readBriefingSeen("2026-09-14")).toBe(false);
    expect(() => markBriefingSeen("2026-09-14")).not.toThrow();
  });
});

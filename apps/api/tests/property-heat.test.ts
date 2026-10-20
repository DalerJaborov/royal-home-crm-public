import { describe, expect, it } from "vitest";
import {
  computePropertyHeat,
  HEAT_HOT_FROM,
  HEAT_WARM_FROM,
  HEAT_WORDS,
  type HeatInput,
} from "../src/lib/propertyHeat.js";

/**
 * Температура объекта — чистая формула (см. шапку lib/propertyHeat.ts). Проверяются: пустота, монотонность,
 * свежесть, вес «клиент сам прислал», границы слов и потолок 100.
 */

const none: HeatInput = { recent: {}, window: {}, clientShared: 0, exposures: 0 };

describe("computePropertyHeat", () => {
  it("нет событий — 0 и «холодный», причина названа", () => {
    const h = computePropertyHeat(none);
    expect(h.score).toBe(0);
    expect(h.label).toBe("cold");
    expect(h.word).toBe("холодный");
    expect(h.reasons[0]).toContain("касаний к объекту не было");
  });

  it("слова соответствуют порогам", () => {
    expect(HEAT_WORDS).toEqual({ cold: "холодный", warm: "тёплый", hot: "горячий" });
    const warm = computePropertyHeat({ ...none, recent: { SHOWING: 2 }, window: { SHOWING: 2 } }); // 10 очков → 28
    expect(warm.score).toBeGreaterThanOrEqual(HEAT_WARM_FROM);
    expect(warm.label).toBe("warm");
    const hot = computePropertyHeat({ ...none, recent: { SHOWING: 3, SHARE_OPENED: 4 }, window: { SHOWING: 3, SHARE_OPENED: 4 } }); // 27 очков → 59
    expect(hot.score).toBeGreaterThanOrEqual(HEAT_HOT_FROM);
    expect(hot.label).toBe("hot");
    expect(computePropertyHeat({ ...none, recent: { SHARE_SENT: 1 }, window: { SHARE_SENT: 1 } }).label).toBe("cold");
  });

  it("свежесть: то же число событий неделю назад греет сильнее, чем три недели назад", () => {
    const fresh = computePropertyHeat({ ...none, recent: { SHOWING: 3 }, window: { SHOWING: 3 } });
    const old = computePropertyHeat({ ...none, recent: {}, window: { SHOWING: 3 } });
    expect(fresh.score).toBeGreaterThan(old.score);
    expect(old.score).toBeGreaterThan(0);
  });

  it("вес вида события: показ греет сильнее отправки ссылки", () => {
    const showing = computePropertyHeat({ ...none, recent: { SHOWING: 2 }, window: { SHOWING: 2 } });
    const sent = computePropertyHeat({ ...none, recent: { SHARE_SENT: 2 }, window: { SHARE_SENT: 2 } });
    expect(showing.score).toBeGreaterThan(sent.score);
  });

  it("неизвестный вид события весит как единица, а не ломает расчёт", () => {
    expect(computePropertyHeat({ ...none, recent: { NEW_KIND: 4 }, window: { NEW_KIND: 4 } }).score).toBe(
      computePropertyHeat({ ...none, recent: { SHARE_SENT: 4 }, window: { SHARE_SENT: 4 } }).score
    );
  });

  it("«клиент сам прислал» греет заметно: три раза и треть отправок — уже тёплый объект без единого показа", () => {
    const h = computePropertyHeat({ ...none, clientShared: 3, exposures: 6 }); // 18 + бонус 4 = 22 очка → 52
    expect(h.label).toBe("warm");
    const lone = computePropertyHeat({ ...none, clientShared: 1, exposures: 10 }); // 6 очков → 18, без бонуса
    expect(lone.label).toBe("cold");
    expect(h.reasons.join(" ")).toContain("сами прислали");
  });

  it("монотонность и потолок: больше событий — не холоднее, и выше 100 не бывает", () => {
    let prev = -1;
    for (const n of [0, 1, 2, 5, 10, 50, 500, 100_000]) {
      const s = computePropertyHeat({ ...none, recent: { SHOWING: n }, window: { SHOWING: n } }).score;
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s).toBeLessThanOrEqual(100);
      prev = s;
    }
    expect(prev).toBe(100);
  });

  it("недельных событий больше, чем месячных (рассинхрон замеров), не уходит в минус", () => {
    const h = computePropertyHeat({ ...none, recent: { SHOWING: 2 }, window: { SHOWING: 1 } });
    expect(h.score).toBeGreaterThan(0);
  });
});

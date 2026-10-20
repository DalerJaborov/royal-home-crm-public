import { describe, expect, it } from "vitest";
import { geminiModelFamily, geminiThinkingConfig } from "../src/ai/geminiTransport.js";

/**
 * 16.08.2026: резервная модель (линейка 2.x, например gemini-2.5-flash-lite)
 * получала параметр линейки 3.x (`thinkingLevel`) и отвечала 400 «Thinking level
 * MINIMAL is not supported for this model». Обе линейки хотят РАЗНУЮ форму
 * параметра «не размышляй» — см. geminiTransport.ts.
 */
describe("семейство модели Gemini и форма thinkingConfig", () => {
  it("линейка 2.x (2.0, 2.5, ...) определяется по префиксу gemini-2.", () => {
    expect(geminiModelFamily("gemini-2.5-flash-lite")).toBe("2.x");
    expect(geminiModelFamily("gemini-2.5-flash")).toBe("2.x");
    expect(geminiModelFamily("gemini-2.0-flash")).toBe("2.x");
  });

  it("линейка 3.x и новее — всё остальное", () => {
    expect(geminiModelFamily("gemini-3.6-flash")).toBe("3.x");
    expect(geminiModelFamily("gemini-3.7-flash")).toBe("3.x");
    expect(geminiModelFamily("gemini-4.0-flash")).toBe("3.x");
  });

  it("2.x получает thinkingBudget: 0, а не thinkingLevel", () => {
    expect(geminiThinkingConfig("gemini-2.5-flash-lite")).toEqual({ thinkingBudget: 0 });
  });

  it("3.x получает thinkingLevel: minimal, а не thinkingBudget", () => {
    expect(geminiThinkingConfig("gemini-3.6-flash")).toEqual({ thinkingLevel: "minimal" });
  });

  // 18.08.2026: боевая проверка ключа показала, что gemini-3.7-flash отвечает 400
  // «Thinking level MINIMAL is not supported for this model», а на "low" — 200.
  // Из-за этого каждый ход уходил дважды и обслуживался резервной моделью.
  it("3.7 получает thinkingLevel: low — minimal она отвергает", () => {
    expect(geminiThinkingConfig("gemini-3.7-flash")).toEqual({ thinkingLevel: "low" });
  });
});

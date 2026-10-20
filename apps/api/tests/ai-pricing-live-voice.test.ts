import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "../src/ai/pricing.js";
import { GEMINI_KNOWN_MODELS, GEMINI_LIVE_LEGACY_MODEL } from "../src/ai/geminiTransport.js";

/**
 * ЦЕНА ЗВОНКА РОБОТА (03.10.2026). До этого дня у моделей живого голоса не было
 * строки в таблице цен, и каждый звонок писался в AiLog с costUsd=null — в
 * «расходах на ИИ» робот был бесплатным. У Live API звук и текст стоят по-разному:
 * звук — часть входа/выхода, а не сверх него.
 */
describe("цены живого голоса", () => {
  it("обе модели цепочки имеют цену", () => {
    for (const model of ["gemini-3.8-live", GEMINI_LIVE_LEGACY_MODEL]) {
      expect(estimateCostUsd(model, { inputTokens: 1_000_000 })).not.toBeNull();
    }
  });

  it("звук считается по своей ставке, текст — по своей", () => {
    const textOnly = estimateCostUsd("gemini-3.8-live", { inputTokens: 1_000_000, outputTokens: 1_000_000 })!;
    const audioOnly = estimateCostUsd("gemini-3.8-live", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      audioInputTokens: 1_000_000,
      audioOutputTokens: 1_000_000,
    })!;
    expect(textOnly).toBeCloseTo(0.5 + 2, 6);
    expect(audioOnly).toBeCloseTo(3 + 12, 6);
  });

  it("звука больше, чем всего входа, — не считается сверх входа", () => {
    expect(estimateCostUsd("gemini-3.8-live", { inputTokens: 100, audioInputTokens: 1_000_000 })).toBeCloseTo(
      (100 * 3) / 1_000_000,
      9
    );
  });

  it("у моделей без звуковой ставки звук идёт по обычной (поведение прежнее)", () => {
    expect(estimateCostUsd("gemini-3.6-flash", { inputTokens: 1_000_000, audioInputTokens: 1_000_000 })).toBeCloseTo(0.3, 6);
  });

  it("основная модель живого голоса — в списке известных", () => {
    expect(GEMINI_KNOWN_MODELS).toContain("gemini-3.8-live");
    expect(GEMINI_KNOWN_MODELS).toContain(GEMINI_LIVE_LEGACY_MODEL);
  });
});

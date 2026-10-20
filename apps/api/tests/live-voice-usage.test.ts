import { describe, expect, it } from "vitest";
import { modalityTokens, parseLiveVoiceServerMessage } from "../src/ai/liveVoiceClient.js";
import { estimateLiveVoiceUsage, GEMINI_AUDIO_TOKENS_PER_SECOND } from "../src/lib/telephony/liveVoiceBridge.js";
import { estimateCostUsd } from "../src/ai/pricing.js";

/**
 * Расход звонка робота (03.10.2026): у Live API выход называется responseTokenCount,
 * а звук отдельно лежит в *TokensDetails — по нему считается цена (ai/pricing.ts).
 */
describe("usageMetadata живого голоса", () => {
  it("responseTokenCount и звук по модальностям читаются; кэш звука вычитается из входа", () => {
    const update = parseLiveVoiceServerMessage({
      usageMetadata: {
        promptTokenCount: 1000,
        cachedContentTokenCount: 200,
        responseTokenCount: 300,
        promptTokensDetails: [
          { modality: "AUDIO", tokenCount: 700 },
          { modality: "TEXT", tokenCount: 300 },
        ],
        cacheTokensDetails: [{ modality: "TEXT", tokenCount: 200 }],
        responseTokensDetails: [{ modality: "AUDIO", tokenCount: 250 }],
      },
    });
    expect(update.usage).toEqual({
      inputTokens: 800,
      outputTokens: 300,
      cacheReadTokens: 200,
      audioInputTokens: 700,
      audioOutputTokens: 250,
    });
  });

  it("без разбивки звук — ноль (считается как текст), старое поле candidatesTokenCount работает", () => {
    const update = parseLiveVoiceServerMessage({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    expect(update.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, audioInputTokens: 0, audioOutputTokens: 0 });
  });

  it("звука не больше, чем всего токенов", () => {
    const update = parseLiveVoiceServerMessage({
      usageMetadata: { promptTokenCount: 100, responseTokenCount: 10, promptTokensDetails: [{ modality: "AUDIO", tokenCount: 999 }] },
    });
    expect(update.usage?.audioInputTokens).toBe(100);
  });

  it("modalityTokens терпит мусор", () => {
    expect(modalityTokens(undefined, "AUDIO")).toBe(0);
    expect(modalityTokens([{ modality: "AUDIO", tokenCount: "x" }, null], "AUDIO")).toBe(0);
  });
});

describe("оценка расхода без usageMetadata", () => {
  it("вход — всё время звонка, выход — речь бота, всё как звук", () => {
    const e = estimateLiveVoiceUsage(60_000, 8_000 * 10);
    expect(e.inputTokens).toBe(60 * GEMINI_AUDIO_TOKENS_PER_SECOND);
    expect(e.outputTokens).toBe(10 * GEMINI_AUDIO_TOKENS_PER_SECOND);
    expect(e.audioInputTokens).toBe(e.inputTokens);
    expect(e.audioOutputTokens).toBe(e.outputTokens);
  });

  it("цена оценки идёт по звуковой ставке и не ноль", () => {
    const e = estimateLiveVoiceUsage(120_000, 8_000 * 30);
    const audio = estimateCostUsd("gemini-3.8-live", e)!;
    const asText = estimateCostUsd("gemini-3.8-live", { ...e, audioInputTokens: 0, audioOutputTokens: 0 })!;
    expect(audio).toBeGreaterThan(asText);
    expect(audio).toBeGreaterThan(0);
  });

  it("отрицательные значения не дают минус", () => {
    const e = estimateLiveVoiceUsage(-5, -5);
    expect(e.inputTokens).toBe(0);
    expect(e.outputTokens).toBe(0);
  });
});

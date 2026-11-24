import { describe, expect, it, vi } from "vitest";

const calls: Array<Record<string, unknown>> = [];
vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiClient.js")>()),
  callGeminiTools: vi.fn(async (params: Record<string, unknown>) => { calls.push(params); return { calls: [{ name: "write_ad_script", args: { script: "Рудаки Тауэр. Звоните, расскажем подробнее." } }] }; }),
}));
vi.mock("../src/ai/assistant/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant/runtime.js")>()),
  loadAssistantGeminiRuntime: vi.fn(async () => ({ keys: ["test-key"], model: "gemini-3.6-flash", fallbackModels: [], liteModel: "" })),
}));
vi.mock("../src/ai/assistant/attemptBudget.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant/attemptBudget.js")>()),
  reserveAssistantGeminiAttempt: vi.fn(async () => true),
}));

import { AD_SCRIPT_MAX_OUTPUT_TOKENS, generateAdScript } from "../src/ai/assistant/adScript.js";
import { MAX_ASSISTANT_OUTPUT_TOKENS } from "../src/ai/assistant/moneyPolicy.js";

describe("рекламный текст: потолок ответа модели (прод 24.11: MAX_TOKENS три раза подряд)", () => {
  it("модели отдаётся достаточно токенов на мысли и текст, но не больше предела помощницы", async () => {
    expect(AD_SCRIPT_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(6_000);
    expect(AD_SCRIPT_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(MAX_ASSISTANT_OUTPUT_TOKENS);
    await generateAdScript({ facts: "Рудаки Тауэр, район Рудаки, звоните", wallet: { reserve: async () => {} }, maxChars: 1500 });
    expect(calls[0]?.maxTokens).toBe(AD_SCRIPT_MAX_OUTPUT_TOKENS);
  });
});

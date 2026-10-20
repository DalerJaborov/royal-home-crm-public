import { describe, expect, it } from "vitest";
import { decodeManagedGeminiToolsUsage } from "../src/ai/geminiManagedToolsUsage.js";
import { geminiReportedUsage } from "../src/ai/providerContract.js";

describe("qualified generateContent text-tools usage decoder", () => {
  it("preserves existing explicit complete counters without total", () => {
    const raw = { promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 10, thoughtsTokenCount: 5 };
    const result = decodeManagedGeminiToolsUsage(raw);
    expect(result.status).toBe("complete"); expect(result.usage).toEqual(geminiReportedUsage(raw, "tools"));
  });
  it("accepts omitted ProtoJSON zeros only with explicit positive prompt/candidates/total anchors", () => {
    const raw = { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 };
    expect(decodeManagedGeminiToolsUsage(raw)).toMatchObject({ status: "complete",
      defaultedFields: ["cachedContentTokenCount", "thoughtsTokenCount", "toolUsePromptTokenCount"],
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, thinkingTokens: 0 } });
    // This proposal DOES NOT change generic/default behavior for any endpoint.
    expect(geminiReportedUsage(raw, "tools").completeness).toBe("partial");
  });
  it("does not add cached tokens twice and retains implicit-cache hits even without explicit cachedContent", () => {
    expect(decodeManagedGeminiToolsUsage({ promptTokenCount: 100, candidatesTokenCount: 20,
      cachedContentTokenCount: 40, totalTokenCount: 120 })).toMatchObject({ status: "complete",
      usage: { inputTokens: 60, cacheReadTokens: 40, thinkingTokens: 0 } });
  });
  it("preserves nonzero thought tokens when only cache/tool-use zeros are omitted", () => {
    expect(decodeManagedGeminiToolsUsage({ promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 7,
      totalTokenCount: 127 })).toMatchObject({ status: "complete", usage: { thinkingTokens: 7, cacheReadTokens: 0 } });
  });
  it.each([undefined, null, {}, { totalTokenCount: 0 }, { promptTokenCount: 10 },
    { promptTokenCount: 10, candidatesTokenCount: 2 }, { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }])
  ("never refunds incomplete/empty metadata through a zero fallback: %j", raw => {
    const result = decodeManagedGeminiToolsUsage(raw);
    expect(result.status).toBe("unknown"); expect(result.usage.completeness).not.toBe("complete");
  });
  it.each([null, undefined, "0", -1, 0.1, NaN, Infinity, 2_147_483_648])
  ("does not reinterpret an explicitly malformed counter as omission: %j", bad => {
    expect(decodeManagedGeminiToolsUsage({ promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12,
      cachedContentTokenCount: bad }).status).toBe("unknown");
  });
  it("requires the total equation and cache subset, not merely plausible nonnegative numbers", () => {
    for (const raw of [
      { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 13 },
      { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12, cachedContentTokenCount: 11 },
      { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 22, cachedContentTokenCount: 10 },
      { promptTokenCount: 10, candidatesTokenCount: 2, cachedContentTokenCount: 0, thoughtsTokenCount: 5, totalTokenCount: 12 },
    ]) expect(decodeManagedGeminiToolsUsage(raw)).toMatchObject({ status: "unknown", reason: "inconsistent_totals" });
  });
  it("retains UNKNOWN for positive tool-use counts instead of hiding unpriced input", () => {
    const raw = { promptTokenCount: 10, candidatesTokenCount: 2, cachedContentTokenCount: 0,
      thoughtsTokenCount: 0, toolUsePromptTokenCount: 5, totalTokenCount: 17 };
    expect(decodeManagedGeminiToolsUsage(raw)).toMatchObject({ status: "unknown", reason: "unpriced_tool_input" });
    expect(decodeManagedGeminiToolsUsage(raw).usage.completeness).toBe("partial");
  });
  it("accepts explicit zero tool-use and matching text modality details", () => {
    expect(decodeManagedGeminiToolsUsage({ promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12,
      toolUsePromptTokenCount: 0, serviceTier: "standard", promptTokensDetails: [{ modality: "TEXT", tokenCount: 10 }],
      candidatesTokensDetails: [{ modality: "TEXT", tokenCount: 2 }] }).status).toBe("complete");
  });
  it("holds SDK/other-endpoint metadata, unknown fields, nonstandard tiers and nontext modalities", () => {
    for (const extra of [{ initialPromptTokenCount: 10 }, { trafficType: "ON_DEMAND" }, { futurePaidUnit: 1 },
      { serviceTier: "priority" }, { serviceTier: "flex" }, { promptTokensDetails: [{ modality: "AUDIO", tokenCount: 10 }] },
      { promptTokensDetails: [{ modality: "TEXT", tokenCount: 9 }] }]) {
      expect(decodeManagedGeminiToolsUsage({ promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12, ...extra }).status).toBe("unknown");
    }
  });
});

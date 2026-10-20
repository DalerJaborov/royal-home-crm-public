import { describe, expect, it } from "vitest";
import { managedGeminiMediaFeatures, decodeManagedGeminiMediaUsage } from "../src/ai/geminiManagedMedia.js";
import { createGeminiCapabilityRegistry } from "../src/ai/geminiCapabilities.js";
import type { ProviderAttemptSpec } from "../src/ai/providerContract.js";

describe("qualified customer multimodal wire", () => {
  it.each(["image/jpeg", "audio/ogg", "video/mp4", "application/pdf"])("detects actual %s bytes", mime => {
    const result = managedGeminiMediaFeatures([{ inline_data: { mime_type: mime, data: "YQ==" } }]);
    expect(result.modalities).toEqual([mime.startsWith("image") ? "image" : mime.startsWith("audio") ? "audio" : mime.startsWith("video") ? "video" : "document"]);
  });
  it.each(["application/zip", "text/html", "audio/not-real"])("rejects unqualified %s", mime => {
    expect(() => managedGeminiMediaFeatures([{ inline_data: { mime_type: mime, data: "YQ==" } }])).toThrow();
  });
  it.each(["http://localhost/a", "https://cdn.example.test/a"])("rejects externally fetched provider URI %s", uri => {
    expect(() => managedGeminiMediaFeatures([{ file_data: { mime_type: "image/jpeg", file_uri: uri } }])).toThrow();
  });
  it("does not let audio bypass a text-only capability", () => {
    const registry = createGeminiCapabilityRegistry([{ revision: "test", model: "gemini-3.6-flash", api: "generateContent",
      adapters: ["tools"], modalities: ["text"], tools: "function", structuredReply: false, thinking: "level", explicitCache: false, grounding: false, maxOutputTokens: 2048 }]);
    const spec = { provider: "google", api: "generateContent", adapter: "tools", model: "gemini-3.6-flash", profileRevision: "test", endpoint: "assistant-tools",
      maxOutputTokens: 2048, features: { functions: true, modalities: ["audio"] } } as unknown as ProviderAttemptSpec;
    expect(registry.supports(spec)).toBe(false);
  });
  const usage = { promptTokenCount: 30, candidatesTokenCount: 3, totalTokenCount: 33,
    promptTokensDetails: [{ modality: "TEXT", tokenCount: 10 }, { modality: "AUDIO", tokenCount: 20 }] };
  it("settles qualified mixed input tokens exactly once", () => {
    expect(decodeManagedGeminiMediaUsage(usage)).toMatchObject({ completeness: "complete", inputTokens: 30, outputTokens: 3, audioInputTokens: null });
  });
  it("retains unknown reserve for inconsistent details", () => {
    expect(decodeManagedGeminiMediaUsage({ ...usage, promptTokensDetails: [{ modality: "AUDIO", tokenCount: 29 }] }).completeness).not.toBe("complete");
  });
  it("retains unknown reserve for unpriced tool-input units", () => {
    expect(decodeManagedGeminiMediaUsage({ ...usage, toolUsePromptTokenCount: 2, totalTokenCount: 35 }).completeness).not.toBe("complete");
  });
});

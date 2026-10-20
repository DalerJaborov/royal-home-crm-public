import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderOperation, geminiReportedUsage, geminiFunctionResponsePart, providerDayDeadline, ProviderOperationError, type ProviderAttemptSpec, type ProviderAccountant } from "../src/ai/providerContract.js";
import { createGeminiCapabilityRegistry, type GeminiCapabilityProfile } from "../src/ai/geminiCapabilities.js";
import { calculateProviderCost } from "../src/ai/providerBudget.js";

const spec: ProviderAttemptSpec = { provider: "google", api: "generateContent", adapter: "text", model: "fixture-model", profileRevision: "fixture-v1", endpoint: "fixture", maxOutputTokens: 20 };
const profile: GeminiCapabilityProfile = { revision: "fixture-v1", model: "fixture-model", api: "generateContent", adapters: ["text"], modalities: ["text"], tools: "none", structuredReply: false,
  thinking: "none", explicitCache: false, grounding: false, maxOutputTokens: 100 };
const usage = { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 3, cachedContentTokenCount: 4 };
afterEach(() => vi.useRealTimers());
function harness(overrides: Partial<Parameters<typeof createProviderOperation>[0]> = {}) {
  const reserve = vi.fn<ProviderAccountant["reserve"]>().mockResolvedValue(true);
  const settle = vi.fn<ProviderAccountant["settle"]>().mockResolvedValue();
  const operation = createProviderOperation({ deadlineAt: Date.now() + 5000, maxAttempts: 2, managed: true,
    supports: createGeminiCapabilityRegistry([profile]).supports, accountant: { reserve, settle }, profileRevision: "fixture-v1", ...overrides });
  return { operation, reserve, settle };
}
describe("managed provider operation contract", () => {
  it("pins actual modality arrays across caller mutation after reservation", async () => {
    const modalities: ("image" | "audio")[] = ["image"];
    const { operation, settle } = harness({ supports: () => true });
    const attempt = await operation.begin({ ...spec, features: { images: true, modalities } }, 1000);
    modalities[0] = "audio";
    attempt.reportUsage(usage); await attempt.finish("success");
    expect(settle.mock.calls[0][0].features?.modalities).toEqual(["image"]);
    expect(Object.isFrozen(settle.mock.calls[0][0].features?.modalities)).toBe(true);
  });
  it("image wire support cannot turn complete token totals into a known text-only cost", async () => {
    const ratePolicy = { pricingSource: "reference" as const, rates: [{ model: spec.model, api: spec.api, adapter: spec.adapter,
      inputUsdPerMillion: "1", outputUsdPerMillion: "2", thinkingUsdPerMillion: "3", cacheReadUsdPerMillion: "0.1" }] };
    const reported = geminiReportedUsage(usage);
    // Positive text control proves that the denial is specifically image billing.
    expect(calculateProviderCost(ratePolicy, spec, reported)).toBe(19_400n);
    const imageSpec = { ...spec, features: { images: true } };
    expect(calculateProviderCost(ratePolicy, imageSpec, reported)).toBeNull();
    const { operation, settle } = harness({ supports: () => true });
    const attempt = await operation.begin(imageSpec, 1000); attempt.reportUsage(usage); await attempt.finish("success");
    expect(settle.mock.calls[0][0]).toMatchObject({ outcome: "success", usage: { source: "reported", completeness: "partial", inputTokens: 6, thinkingTokens: 3 } });
    expect(calculateProviderCost(ratePolicy, imageSpec, settle.mock.calls[0][0].usage)).toBeNull();
  });
  it("finite managed deadline is pinned once to Dushanbe day without extending a shorter deadline", () => {
    const now = new Date("2026-10-14T18:59:59.900Z"), midnight = Date.parse("2026-10-14T19:00:00Z");
    expect(providerDayDeadline(now.getTime() + 10_000, now)).toBe(midnight);
    expect(providerDayDeadline(now.getTime() + 20, now)).toBe(now.getTime() + 20);
  });
  it("function result preserves the exact optional provider call ID without inventing one", () => {
    expect(geminiFunctionResponsePart({ name: "fixture", id: "call-a" }, { ok: true })).toEqual({ functionResponse: { name: "fixture", id: "call-a", response: { result: { ok: true } } } });
    expect(geminiFunctionResponsePart({ name: "fixture" }, null)).toEqual({ functionResponse: { name: "fixture", response: { result: null } } });
  });
  it("missing usage differs from explicit reported zero and thinking is retained separately", () => {
    expect(geminiReportedUsage(undefined)).toMatchObject({ source: "missing", completeness: "missing", outputTokens: null });
    expect(geminiReportedUsage({ promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, cachedContentTokenCount: 0 }))
      .toMatchObject({ source: "reported", completeness: "complete", inputTokens: 0, outputTokens: 0 });
    expect(geminiReportedUsage(usage)).toMatchObject({ inputTokens: 6, cacheReadTokens: 4, outputTokens: 2, thinkingTokens: 3 });
    expect(geminiReportedUsage({ promptTokenCount: 10, candidatesTokenCount: 2 }).completeness).toBe("partial");
  });
  it("invalid negative and inconsistent cache values cannot become a complete free observation", () => {
    expect(geminiReportedUsage({ ...usage, promptTokenCount: -1 }).completeness).toBe("partial");
    expect(geminiReportedUsage({ ...usage, cachedContentTokenCount: 11 }).inputTokens).toBeNull();
    expect(geminiReportedUsage(usage, "grounded").completeness).toBe("partial");
  });
  it("one context shares the ordinal and ceiling across retries, then denies before reserve", async () => {
    const { operation, reserve, settle } = harness();
    const a = await operation.begin(spec, 1000); a.reportUsage(usage); await a.finish("invalid");
    const b = await operation.begin(spec, 1000); b.reportUsage(usage); await b.finish("success");
    await expect(operation.begin(spec, 1000)).rejects.toMatchObject({ reason: "attempt_budget" });
    expect(reserve.mock.calls.map(([input]) => input.attemptNo)).toEqual([1, 2]); expect(settle).toHaveBeenCalledTimes(2);
  });
  it("original cancellation before start performs no reservation", async () => {
    const controller = new AbortController(); controller.abort();
    const { operation, reserve } = harness({ signal: controller.signal });
    await expect(operation.begin(spec, 1000)).rejects.toMatchObject({ reason: "cancelled" }); expect(reserve).not.toHaveBeenCalled();
  });
  it("abort during retry sleep prevents a new attempt without waiting for the full delay", async () => {
    const controller = new AbortController(); const { operation, reserve } = harness({ signal: controller.signal });
    const waiting = operation.sleep(4000); controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(ProviderOperationError); expect(reserve).not.toHaveBeenCalled();
  });
  it("absolute deadline survives successive invocations and cache/retry pauses", async () => {
    vi.useFakeTimers(); const { operation, reserve } = harness({ deadlineAt: Date.now() + 50 });
    const waiting = operation.sleep(80); const assertion = expect(waiting).rejects.toMatchObject({ reason: "deadline" });
    await vi.advanceTimersByTimeAsync(50); await assertion;
    await expect(operation.begin(spec, 100)).rejects.toMatchObject({ reason: "deadline" }); expect(reserve).not.toHaveBeenCalled();
  });
  it("late response after an individual attempt timeout cannot be accepted", async () => {
    vi.useFakeTimers(); const { operation, settle } = harness();
    const attempt = await operation.begin(spec, 20); await vi.advanceTimersByTimeAsync(25);
    attempt.reportUsage(usage); expect(() => attempt.check()).toThrow("timed out"); await attempt.finish("success");
    expect(settle.mock.calls[0][0]).toMatchObject({ outcome: "timeout", usage: { thinkingTokens: 3 } });
  });
  it("settlement is once-only even when finally and consumer both finish", async () => {
    const { operation, settle } = harness(); const attempt = await operation.begin(spec, 1000);
    await Promise.all([attempt.finish("unknown"), attempt.finish("success")]); expect(settle).toHaveBeenCalledTimes(1);
  });
  it("reserve outage and denial fail closed before a provider attempt exists", async () => {
    const reserve = vi.fn().mockRejectedValue(new Error("fixture DB unavailable"));
    const { operation } = harness({ accountant: { reserve, settle: vi.fn() } });
    await expect(operation.begin(spec, 100)).rejects.toMatchObject({ reason: "accounting_unavailable" });
    const denied = harness({ accountant: { reserve: vi.fn().mockResolvedValue(false), settle: vi.fn() } });
    await expect(denied.operation.begin(spec, 100)).rejects.toMatchObject({ reason: "budget_denied" });
  });
  it("settlement outage stops managed retry rather than silently allowing another paid call", async () => {
    const h = harness({ accountant: { reserve: vi.fn().mockResolvedValue(true), settle: vi.fn().mockRejectedValue(new Error("fixture")) } });
    const attempt = await h.operation.begin(spec, 1000);
    await expect(attempt.finish("success")).rejects.toMatchObject({ reason: "accounting_unavailable" });
    await expect(h.operation.begin(spec, 1000)).rejects.toBeInstanceOf(ProviderOperationError);
  });
  it("unknown model/API/unsupported features are denied without reservation", async () => {
    const { operation, reserve } = harness();
    expect(operation.supports({ ...spec, features: { functions: true } })).toBe(false);
    expect(operation.supports({ ...spec, api: "bidiGenerateContent", adapter: "live" })).toBe(false);
    await expect(operation.begin({ ...spec, model: "fixture-unknown" }, 100)).rejects.toMatchObject({ reason: "unsupported" });
    expect(reserve).not.toHaveBeenCalled();
  });
  it("closing prevents subsequent attempts and calls the server accountant close once per invocation", async () => {
    const close = vi.fn().mockResolvedValue(undefined); const { operation } = harness({ accountant: { reserve: vi.fn(), settle: vi.fn(), close } });
    await operation.close(); expect(close).toHaveBeenCalledWith(operation.id);
    await expect(operation.begin(spec, 1000)).rejects.toBeInstanceOf(ProviderOperationError);
  });
  it("registry does not infer Live or another API from a familiar model string", () => {
    const registry = createGeminiCapabilityRegistry([profile]);
    expect(registry.supports({ ...spec, api: "bidiGenerateContent", adapter: "live" })).toBe(false);
    expect(registry.supports({ ...spec, profileRevision: "another" })).toBe(false);
    expect(() => createGeminiCapabilityRegistry([profile, profile])).toThrow("Duplicate");
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { createManagedProviderOperation, providerDayKey, providerUsdUnits, type ProviderBudgetPolicy } from "../src/ai/providerBudget.js";
import type { ProviderAttemptSpec } from "../src/ai/providerContract.js";

// Deliberately invented fixture prices/model names. They are not provider rates
// or production policy. Tests perform real SQL reservations, NO provider I/O.
const policyKeys: string[] = [];
function policy(overrides: Partial<ProviderBudgetPolicy> = {}): ProviderBudgetPolicy {
  const policyKey = `qa-provider:${randomUUID()}`; policyKeys.push(policyKey);
  return { enabled: true, policyKey, maxOperationUsd: "0.10", maxDailyUsd: "0.15", maxAttemptUsd: "0.03", maxAttempts: 5,
    profileRevision: "fixture-profile-v1", pricingRevision: "fixture-rates-v1", pricingSource: "estimate",
    profiles: ["fixture-a", "fixture-b"].map(model => ({ revision: "fixture-profile-v1", model, api: "generateContent", adapters: ["text"], modalities: ["text"],
      tools: "none", structuredReply: false, thinking: "none", explicitCache: false, grounding: false, maxOutputTokens: 2000 })),
    rates: ["fixture-a", "fixture-b"].map((model, index) => ({ model, api: "generateContent", adapter: "text",
      inputUsdPerMillion: index === 0 ? "0.01" : "0.02", outputUsdPerMillion: "0.02", thinkingUsdPerMillion: "0.02", cacheReadUsdPerMillion: "0.001" })), ...overrides };
}
const spec = (model = "fixture-a"): ProviderAttemptSpec => ({ provider: "google", api: "generateContent", adapter: "text", model,
  profileRevision: "fixture-profile-v1", pricingRevision: "fixture-rates-v1", endpoint: "qa-provider-only", maxOutputTokens: 1000 });
const usage = (prompt = 1_000_000) => ({ promptTokenCount: prompt, candidatesTokenCount: 0, thoughtsTokenCount: 0, cachedContentTokenCount: 0 });
const operation = (p: ProviderBudgetPolicy, operationId?: string) => createManagedProviderOperation(p, { operationId, deadlineAt: Date.now() + 60_000 });
afterAll(async () => {
  const rows = await prisma.aiProviderOperation.findMany({ where: { policyKey: { in: policyKeys } }, select: { id: true } });
  await prisma.aiLog.deleteMany({ where: { operationId: { in: rows.map(row => row.id) } } });
  await prisma.aiProviderOperation.deleteMany({ where: { policyKey: { in: policyKeys } } });
  await prisma.aiProviderDailyBudget.deleteMany({ where: { policyKey: { in: policyKeys } } });
});
describe("managed provider budget actual PostgreSQL", () => {
  it("image totals without an image billing profile retain full reserve after successful generation", async () => {
    const p = policy();
    p.profiles = p.profiles.map(profile => ({ ...profile, modalities: ["text", "image"] }));
    const op = operation(p), a = await op.begin({ ...spec(), features: { images: true } }, 5000);
    a.reportUsage(usage()); await a.finish("success"); await op.close();
    const row = await prisma.aiLog.findFirstOrThrow({ where: { operationId: op.id } });
    expect(row).toMatchObject({ attemptState: "UNKNOWN", usageSource: "REPORTED", usageCompleteness: "PARTIAL", costStatus: "UNKNOWN", settledUsd: null, costUsd: null });
    expect(row.reservedUsd?.toString()).toBe("0.03");
    const saved = await prisma.aiProviderOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(saved.status).toBe("HELD"); expect(saved.reservedUsd.toString()).toBe("0.03"); expect(saved.settledUsd.toString()).toBe("0");
  });
  it("stores each model and exact cost separately, including a billed invalid attempt", async () => {
    const p = policy(), op = operation(p);
    const a = await op.begin(spec(), 5000); a.reportUsage(usage()); await a.finish("invalid");
    const b = await op.begin(spec("fixture-b"), 5000); b.reportUsage(usage()); await b.finish("success"); await op.close();
    const rows = await prisma.aiLog.findMany({ where: { operationId: op.id }, orderBy: { attemptNo: "asc" } });
    expect(rows.map(row => [row.model, row.settledUsd?.toString(), row.attemptState, row.costStatus])).toEqual([
      ["fixture-a", "0.01", "SETTLED", "ESTIMATED"], ["fixture-b", "0.02", "SETTLED", "ESTIMATED"],
    ]);
    const saved = await prisma.aiProviderOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(saved.settledUsd.toString()).toBe("0.03"); expect(saved.reservedUsd.toString()).toBe("0"); expect(saved.status).toBe("CLOSED");
  });
  it("missing usage retains the durable reservation and is never zero/free", async () => {
    const p = policy(), op = operation(p), a = await op.begin(spec(), 5000); await a.finish("error"); await op.close();
    const row = await prisma.aiLog.findFirstOrThrow({ where: { operationId: op.id } });
    expect(row).toMatchObject({ attemptState: "UNKNOWN", usageSource: "MISSING", costStatus: "UNKNOWN", settledUsd: null, costUsd: null });
    const bucket = await prisma.aiProviderDailyBudget.findUniqueOrThrow({ where: { policyKey_dayKey: { policyKey: p.policyKey, dayKey: providerDayKey() } } });
    expect(bucket.reservedUsd.toString()).toBe("0.03"); expect(bucket.settledUsd.toString()).toBe("0");
    expect((await prisma.aiProviderOperation.findUniqueOrThrow({ where: { id: op.id } })).status).toBe("HELD");
  });
  it("provider-reported complete true zero settles as zero and releases reserve", async () => {
    const p = policy(), op = operation(p), a = await op.begin(spec(), 5000); a.reportUsage(usage(0)); await a.finish("success");
    const row = await prisma.aiLog.findFirstOrThrow({ where: { operationId: op.id } });
    expect(row.attemptState).toBe("SETTLED"); expect(row.settledUsd?.toString()).toBe("0"); expect(row.inputTokens).toBe(0);
    expect((await prisma.aiProviderOperation.findUniqueOrThrow({ where: { id: op.id } })).reservedUsd.toString()).toBe("0");
  });
  it("concurrent operations cannot overspend the same stable day bucket", async () => {
    const p = policy({ maxDailyUsd: "0.05", maxOperationUsd: "0.03", maxAttempts: 1 });
    const a = operation(p), b = operation(p); const results = await Promise.allSettled([a.begin(spec(), 5000), b.begin(spec(), 5000)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    for (const result of results) if (result.status === "fulfilled") { result.value.reportUsage(usage(0)); await result.value.finish("success"); }
    const logs = await prisma.aiLog.count({ where: { operationId: { in: [a.id, b.id] } } }); expect(logs).toBe(1);
  });
  it("idempotent finish cannot settle or refund one attempt twice", async () => {
    const p = policy(), op = operation(p), a = await op.begin(spec(), 5000); a.reportUsage(usage());
    await Promise.all([a.finish("success"), a.finish("success")]);
    const saved = await prisma.aiProviderOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(saved.settledUsd.toString()).toBe("0.01"); expect(saved.reservedUsd.toString()).toBe("0");
  });
  it("policy or cap changes do not reset or increase the existing day bucket", async () => {
    const p = policy(), op = operation(p), a = await op.begin(spec(), 5000); a.reportUsage(usage()); await a.finish("success");
    const changed = operation({ ...p, maxDailyUsd: "0.20", pricingRevision: "fixture-rates-v2" });
    await expect(changed.begin({ ...spec(), pricingRevision: "fixture-rates-v2" }, 1000)).rejects.toMatchObject({ reason: "budget_denied" });
    const bucket = await prisma.aiProviderDailyBudget.findUniqueOrThrow({ where: { policyKey_dayKey: { policyKey: p.policyKey, dayKey: providerDayKey() } } });
    expect(bucket.capUsd?.toString()).toBe("0.15"); expect(bucket.settledUsd.toString()).toBe("0.01");
  });
  it("a measured over-reserve cost is recorded and held instead of rolling accounting back", async () => {
    const p = policy(), op = operation(p), a = await op.begin(spec(), 5000); a.reportUsage(usage(4_000_000)); await a.finish("success");
    const row = await prisma.aiLog.findFirstOrThrow({ where: { operationId: op.id } }); expect(row.settledUsd?.toString()).toBe("0.04");
    const saved = await prisma.aiProviderOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(saved.status).toBe("HELD"); expect(saved.settledUsd.toString()).toBe("0.04");
    await expect(op.begin(spec(), 1000)).rejects.toMatchObject({ reason: "budget_denied" });
  });
  it("nanodollar math and Dushanbe boundary do not round tiny charges into free operations", () => {
    expect(providerUsdUnits("0.000000001")).toBe(1n);
    expect(providerDayKey(new Date("2026-10-14T18:59:59Z"))).toBe("2026-10-14");
    expect(providerDayKey(new Date("2026-10-14T19:00:00Z"))).toBe("2026-10-15");
  });
});

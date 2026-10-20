import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { createManagedProviderOperation, recoverManagedProviderOperation, providerDayKey } from "../src/ai/providerBudget.js";
import { createCustomerAgentProviderSnapshot, createCustomerAgentMediaProviderSnapshot, decodeCustomerAgentProviderSnapshot,
  customerAgentProviderBudgetPolicy } from "../src/ai/customerAgentProviderConfig.js";
import type { ProviderAttemptSpec } from "../src/ai/providerContract.js";

// Actual normal-PG tests, no provider I/O/mocked DB/authority grant.
const keys: string[] = [];
function fixture(legacy = false, media = false) {
  const snapshot = legacy ? decodeCustomerAgentProviderSnapshot(JSON.parse(readFileSync(
    new URL("./fixtures/customer-agent-provider-usage-v1.json", import.meta.url), "utf8"))) : media ? createCustomerAgentMediaProviderSnapshot() : createCustomerAgentProviderSnapshot();
  const policy = customerAgentProviderBudgetPolicy(snapshot);
  policy.policyKey = "qa-provider-usage:" + randomUUID(); keys.push(policy.policyKey);
  const spec: ProviderAttemptSpec = { provider: "google", api: "generateContent", adapter: "tools", model: "gemini-3.6-flash",
    endpoint: "assistant-tools", profileRevision: policy.profileRevision, pricingRevision: policy.pricingRevision,
    maxOutputTokens: 128, features: { functions: true, thinking: "level", images: false } };
  const operation = createManagedProviderOperation(policy, { deadlineAt: Date.now() + 60_000 });
  return { policy, spec, operation, original: { operationId: operation.id, deadlineAt: operation.deadlineAt, dayKey: providerDayKey() } };
}
async function state(f: ReturnType<typeof fixture>) {
  const operation = await prisma.aiProviderOperation.findUniqueOrThrow({ where: { id: f.operation.id } });
  const daily = await prisma.aiProviderDailyBudget.findUniqueOrThrow({ where: { policyKey_dayKey: {
    policyKey: f.policy.policyKey, dayKey: f.original.dayKey,
  } } });
  const logs = await prisma.aiLog.findMany({ where: { operationId: operation.id }, orderBy: { attemptNo: "asc" } });
  return { operation, daily, logs };
}
afterAll(async () => {
  const own = await prisma.aiProviderOperation.findMany({ where: { policyKey: { in: keys } }, select: { id: true } });
  await prisma.aiLog.deleteMany({ where: { operationId: { in: own.map(row => row.id) } } });
  await prisma.aiProviderOperation.deleteMany({ where: { policyKey: { in: keys } } });
  await prisma.aiProviderDailyBudget.deleteMany({ where: { policyKey: { in: keys } } });
});

describe("pinned usage protocol settlement/recovery — normal PostgreSQL", () => {
  const actualImageUsage = { promptTokenCount: 1570, candidatesTokenCount: 67, totalTokenCount: 1637,
    promptTokensDetails: [{ modality: "IMAGE", tokenCount: 1064 }, { modality: "TEXT", tokenCount: 506 }], serviceTier: "standard" };
  it("settles the actual Gemini image counters under the original qualified media policy", async () => {
    const f = fixture(false, true);
    const attempt = await f.operation.begin({ ...f.spec, features: { ...f.spec.features, images: true, modalities: ["image"] } }, 5000);
    attempt.reportUsage(actualImageUsage); await attempt.finish("success"); await f.operation.close();
    const actual = await state(f);
    expect(actual.logs[0]).toMatchObject({ attemptState: "SETTLED", usageCompleteness: "COMPLETE", costStatus: "CALCULATED", inputTokens: 1570, outputTokens: 67 });
    expect(actual.operation.settledUsd.toString()).toBe("0.00142875");
    expect(actual.operation.reservedUsd.toString()).toBe("0");
  });
  it("does not qualify actual image counters under an archived text-only policy", async () => {
    const f = fixture();
    // Existing text-only profile can accept image wire, but has no image billing qualification.
    f.policy.profiles = f.policy.profiles.map(row => ({ ...row, modalities: ["text" as const, "image" as const] }));
    const operation = createManagedProviderOperation(f.policy, { deadlineAt: f.operation.deadlineAt });
    const attempt = await operation.begin({ ...f.spec, features: { ...f.spec.features, images: true, modalities: ["image"] } }, 5000);
    attempt.reportUsage(actualImageUsage); await attempt.finish("success"); await operation.close();
    const log = await prisma.aiLog.findFirstOrThrow({ where: { operationId: operation.id } });
    expect(log.attemptState).toBe("UNKNOWN"); expect(log.usageCompleteness).toBe("PARTIAL");
    expect(log.reservedUsd.toString()).toBe("0.032256");
  });
  it("settles qualified omitted zeros and fresh-process recovery uses the SAME policy/UUID/deadline at ordinal two", async () => {
    const f = fixture(), attempt = await f.operation.begin(f.spec, 5000);
    attempt.reportUsage({ promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 });
    await attempt.finish("success");
    const first = await state(f);
    expect(first.logs[0]).toMatchObject({ attemptState: "SETTLED", usageCompleteness: "COMPLETE",
      inputTokens: 100, outputTokens: 20, thinkingTokens: 0, cacheReadTokens: 0 });
    expect(first.operation.reservedUsd.toString()).toBe("0");
    expect(first.daily.reservedUsd.toString()).toBe("0");
    expect(first.operation.settledUsd.toString()).toBe("0.00015"); // Existing pinned reference rates, not an invoice.
    const removedProtocol = { ...f.policy }; delete removedProtocol.usageProtocol;
    expect(await recoverManagedProviderOperation(removedProtocol, f.original)).toEqual({ status: "held", reason: "policy_mismatch" });
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx",
      fileURLToPath(new URL("./helpers/provider-budget-usage-child.mts", import.meta.url)),
      JSON.stringify({ policy: f.policy, original: f.original, spec: f.spec })], {
      env: { ...process.env }, timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    const line = stdout.split(/\r?\n/).find(value => value.startsWith("RH_USAGE_RECOVERY "));
    expect(line).toBeTruthy();
    expect(JSON.parse(line!.slice("RH_USAGE_RECOVERY ".length))).toEqual({ id: f.operation.id,
      deadlineAt: f.original.deadlineAt, attemptNo: 2 });
    const second = await state(f);
    expect(second.logs.map(row => [row.attemptNo, row.attemptState, row.usageCompleteness]))
      .toEqual([[1, "SETTLED", "COMPLETE"], [2, "SETTLED", "COMPLETE"]]);
    expect(second.operation.attemptsReserved).toBe(2); expect(second.operation.reservedUsd.toString()).toBe("0");
    expect(second.operation.deadlineAt.getTime()).toBe(f.original.deadlineAt);
  });
  it.each([undefined, { promptTokenCount: "100", candidatesTokenCount: 20, totalTokenCount: 120 },
    { promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 0, thoughtsTokenCount: 0,
      toolUsePromptTokenCount: 5, totalTokenCount: 125 }])
  ("retains the exact reserve for missing/malformed/unpriced-tool usage: %j", async raw => {
    const f = fixture(), attempt = await f.operation.begin(f.spec, 5000);
    attempt.reportUsage(raw); await attempt.finish("success");
    const held = await state(f);
    expect(held.logs[0].attemptState).toBe("UNKNOWN");
    expect(held.operation.reservedUsd.toString()).toBe("0.032256");
    expect(held.daily.reservedUsd.toString()).toBe("0.032256");
    expect(held.operation.settledUsd.toString()).toBe("0");
    expect(await recoverManagedProviderOperation(f.policy, f.original)).toEqual({ status: "held", reason: "usage_unresolved" });
    // Preserve existing SAME-operation continuation under cumulative bounds;
    // unknown cost is not silently refunded or a permanently reset attempt.
    const second = await f.operation.begin(f.spec, 5000);
    second.reportUsage({ promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 0, thoughtsTokenCount: 0 });
    await second.finish("success");
    expect((await state(f)).operation.reservedUsd.toString()).toBe("0.032256");
    await f.operation.close(); expect((await state(f)).operation.status).toBe("HELD");
  });
  it("keeps a real v1 policy generic and denies protocol injection on recovery without changing ledger rows", async () => {
    const f = fixture(true), attempt = await f.operation.begin(f.spec, 5000);
    attempt.reportUsage({ promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 });
    await attempt.finish("success");
    const before = await state(f);
    expect(Object.hasOwn(f.policy, "usageProtocol")).toBe(false);
    expect(before.logs[0].attemptState).toBe("UNKNOWN");
    const newProtocol = createCustomerAgentProviderSnapshot().budget.usageProtocol;
    expect(await recoverManagedProviderOperation({ ...f.policy, usageProtocol: newProtocol }, f.original))
      .toEqual({ status: "held", reason: "policy_mismatch" });
    expect((await state(f)).operation.reservedUsd.toString()).toBe(before.operation.reservedUsd.toString());
    expect((await state(f)).operation.attemptsReserved).toBe(1);
  });
  it("does not normalize an unqualified text endpoint even under a policy carrying the closed protocol", async () => {
    const f = fixture();
    f.policy.profiles = f.policy.profiles.map(row => ({ ...row, adapters: ["text" as const], tools: "none" as const }));
    f.policy.rates = f.policy.rates.map(row => ({ ...row, adapter: "text" as const }));
    const op = createManagedProviderOperation(f.policy, { deadlineAt: f.operation.deadlineAt });
    const attempt = await op.begin({ ...f.spec, adapter: "text", endpoint: "unqualified-text", features: {} }, 5000);
    attempt.reportUsage({ promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 });
    await attempt.finish("success");
    const log = await prisma.aiLog.findFirstOrThrow({ where: { operationId: op.id } });
    expect(log.attemptState).toBe("UNKNOWN"); expect(log.usageCompleteness).toBe("PARTIAL");
  });
  it("pins original actual spec/policy against caller mutation after reserve", async () => {
    const f = fixture(), attempt = await f.operation.begin(f.spec, 5000);
    f.spec.model = "caller-mutated-model"; f.spec.features = { images: true };
    Reflect.set(f.policy, "usageProtocol", "caller-mutated-protocol");
    attempt.reportUsage({ promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 });
    await attempt.finish("success");
    const actual = await state(f);
    expect(actual.logs[0]).toMatchObject({ model: "gemini-3.6-flash", attemptState: "SETTLED", usageCompleteness: "COMPLETE" });
    expect(actual.operation.reservedUsd.toString()).toBe("0");
  });
  it("rejects an unknown protocol at factory/recovery boundary without creating an operation or bucket", async () => {
    const f = fixture();
    Reflect.set(f.policy, "usageProtocol", "future-unreviewed");
    expect(() => createManagedProviderOperation(f.policy, { deadlineAt: f.original.deadlineAt })).toThrow(/usage protocol/);
    expect(await recoverManagedProviderOperation(f.policy, f.original)).toEqual({ status: "held", reason: "policy_invalid" });
    expect(await prisma.aiProviderOperation.count({ where: { policyKey: f.policy.policyKey } })).toBe(0);
    expect(await prisma.aiProviderDailyBudget.count({ where: { policyKey: f.policy.policyKey } })).toBe(0);
  });
});

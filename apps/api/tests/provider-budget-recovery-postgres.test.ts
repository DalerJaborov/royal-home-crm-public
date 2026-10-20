import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { createManagedProviderOperation, recoverManagedProviderOperation, providerDayKey,
  type ProviderBudgetPolicy } from "../src/ai/providerBudget.js";
import type { ProviderAttempt, ProviderAttemptSpec } from "../src/ai/providerContract.js";

const keys: string[] = [];
const spec: ProviderAttemptSpec = { provider: "google", api: "generateContent", adapter: "text", model: "recovery-fixture",
  profileRevision: "recovery-profile-1", pricingRevision: "recovery-price-1", endpoint: "qa-recovery-only", maxOutputTokens: 100 };
const zero = { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, cachedContentTokenCount: 0 };
function fixture(maxAttempts = 4, maxDailyUsd: string | null = "0.15") {
  const policyKey = "qa-provider-recovery:" + randomUUID(); keys.push(policyKey);
  const policy: ProviderBudgetPolicy = { enabled: true, policyKey, maxOperationUsd: "0.10", maxDailyUsd,
    maxAttemptUsd: "0.03", maxAttempts, profileRevision: spec.profileRevision, pricingRevision: spec.pricingRevision!,
    pricingSource: "estimate", profiles: [{ revision: spec.profileRevision, model: spec.model, api: "generateContent",
      adapters: ["text"], modalities: ["text"], tools: "none", structuredReply: false, thinking: "none",
      explicitCache: false, grounding: false, maxOutputTokens: 1000 }],
    rates: [{ model: spec.model, api: "generateContent", adapter: "text", inputUsdPerMillion: "0.01",
      outputUsdPerMillion: "0.02", thinkingUsdPerMillion: "0.02", cacheReadUsdPerMillion: "0.001" }] };
  const operation = createManagedProviderOperation(policy, { deadlineAt: Date.now() + 60_000 });
  return { policy, operation, original: { operationId: operation.id, deadlineAt: operation.deadlineAt, dayKey: providerDayKey() } };
}
afterAll(async () => {
  const rows = await prisma.aiProviderOperation.findMany({ where: { policyKey: { in: keys } }, select: { id: true } });
  await prisma.aiLog.deleteMany({ where: { operationId: { in: rows.map(row => row.id) } } });
  await prisma.aiProviderOperation.deleteMany({ where: { policyKey: { in: keys } } });
  await prisma.aiProviderDailyBudget.deleteMany({ where: { policyKey: { in: keys } } });
});
async function settleFirst(f: ReturnType<typeof fixture>) {
  const attempt = await f.operation.begin(spec, 5000);
  expect(attempt.attemptNo).toBe(1); // Existing fresh entry point remains counter-zero.
  attempt.reportUsage(zero); await attempt.finish("invalid");
}
async function snapshot(f: ReturnType<typeof fixture>) {
  const op = await prisma.aiProviderOperation.findUniqueOrThrow({ where: { id: f.operation.id } });
  const day = await prisma.aiProviderDailyBudget.findUniqueOrThrow({ where: {
    policyKey_dayKey: { policyKey: f.policy.policyKey, dayKey: f.original.dayKey },
  } });
  return { attempts: op.attemptsReserved, opReserved: op.reservedUsd.toString(), dayReserved: day.reservedUsd.toString(),
    dayCap: day.capUsd?.toString() ?? null, deadlineAt: op.deadlineAt.getTime(), dayKey: op.dayKey, status: op.status };
}

describe("managed provider recovery, normal PostgreSQL, NO provider I/O", () => {
  it("explicit daily observe mode retains real reservations, operation caps and restart ordinals without a fake daily cap", async () => {
    const f = fixture(4, null);
    const other = createManagedProviderOperation(f.policy, { deadlineAt: f.original.deadlineAt });
    const pending: ProviderAttempt[] = [];
    try {
      for (const operation of [f.operation, other]) {
        for (let index = 0; index < 3; index++) pending.push(await operation.begin(spec, 15_000));
      }
      const day = await prisma.aiProviderDailyBudget.findUniqueOrThrow({ where: {
        policyKey_dayKey: { policyKey: f.policy.policyKey, dayKey: f.original.dayKey },
      } });
      expect(day.capUsd).toBeNull();
      expect(day.reservedUsd.toString()).toBe("0.18"); // No manufactured 0.15/large daily ceiling.
      await expect(f.operation.begin(spec, 5000)).rejects.toMatchObject({ reason: "budget_denied" });
      expect((await snapshot(f))).toMatchObject({ attempts: 3, opReserved: "0.09", dayReserved: "0.18", dayCap: null });
      expect(await recoverManagedProviderOperation(f.policy, f.original)).toEqual({ status: "held", reason: "attempt_in_flight" });
    } finally {
      for (const attempt of pending) { attempt.reportUsage(zero); await attempt.finish("invalid"); }
    }
    const loaded = await recoverManagedProviderOperation(f.policy, f.original);
    if (loaded.status !== "ready") throw new Error("Expected settled observe-mode recovery");
    const fourth = await loaded.operation.begin(spec, 5000);
    expect(fourth.attemptNo).toBe(4);
    fourth.reportUsage(zero); await fourth.finish("invalid");
    expect((await snapshot(f))).toMatchObject({ attempts: 4, opReserved: "0", dayReserved: "0", dayCap: null });
    expect(await recoverManagedProviderOperation({ ...f.policy, maxDailyUsd: "0.15" }, f.original))
      .toEqual({ status: "held", reason: "policy_mismatch" });
  });

  it("fresh Node process continues settled N as N+1 with the SAME UUID/deadline/day", async () => {
    const f = fixture(); await settleFirst(f);
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx",
      fileURLToPath(new URL("./helpers/provider-budget-recovery-child.mts", import.meta.url)),
      JSON.stringify({ policy: f.policy, original: f.original, spec })], {
      env: { ...process.env }, timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    const line = stdout.split(/\r?\n/).find(row => row.startsWith("RH_PROVIDER_RECOVERY_RESULT "));
    expect(line).toBeTruthy();
    expect(JSON.parse(line!.slice("RH_PROVIDER_RECOVERY_RESULT ".length))).toEqual({
      status: "settled", attemptNo: 2, id: f.operation.id, deadlineAt: f.original.deadlineAt,
    });
    expect((await snapshot(f))).toMatchObject({ attempts: 2, opReserved: "0", dayReserved: "0",
      deadlineAt: f.original.deadlineAt, dayKey: f.original.dayKey, dayCap: "0.15", status: "OPEN" });
    expect((await prisma.aiLog.findMany({ where: { operationId: f.operation.id }, orderBy: { attemptNo: "asc" } }))
      .map(row => row.attemptNo)).toEqual([1, 2]);
  });

  it("two independently hydrated contexts race the existing next-ordinal SQL CAS: exactly one reserves N+1", async () => {
    const f = fixture(); await settleFirst(f);
    const recovered = await Promise.all([recoverManagedProviderOperation(f.policy, f.original), recoverManagedProviderOperation(f.policy, f.original)]);
    const [a, b] = recovered;
    if (a.status !== "ready" || b.status !== "ready") throw new Error("Expected two pre-reservation snapshots");
    const results = await Promise.allSettled([a.operation.begin(spec, 5000), b.operation.begin(spec, 5000)]);
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(row => row.status === "rejected")).toHaveLength(1);
    for (const row of results) {
      if (row.status === "fulfilled") { expect(row.value.attemptNo).toBe(2); row.value.reportUsage(zero); await row.value.finish("invalid"); }
      else expect(row.reason).toMatchObject({ reason: "budget_denied" });
    }
    expect((await snapshot(f)).attempts).toBe(2);
    expect(await prisma.aiLog.count({ where: { operationId: f.operation.id } })).toBe(2);
  });

  it("STARTED after process loss is held and retains the FULL reservation, without lease stealing/refund/retry", async () => {
    const f = fixture(), attempt = await f.operation.begin(spec, 5000);
    const before = await snapshot(f);
    try {
      expect(await recoverManagedProviderOperation(f.policy, f.original)).toEqual({ status: "held", reason: "attempt_in_flight" });
      expect(await snapshot(f)).toEqual(before);
      expect(before).toMatchObject({ attempts: 1, opReserved: "0.03", dayReserved: "0.03" });
      expect(await prisma.aiLog.count({ where: { operationId: f.operation.id } })).toBe(1);
    } finally { await attempt.finish("cancelled"); } // Clear local timer AFTER retained STARTED assertions.
  });

  it("UNKNOWN usage is explicitly held after restart and is never refunded as zero", async () => {
    const f = fixture(), attempt = await f.operation.begin(spec, 5000);
    await attempt.finish("error"); // No reported usage: existing accountant persists UNKNOWN.
    const before = await snapshot(f);
    expect(await recoverManagedProviderOperation(f.policy, f.original)).toEqual({ status: "held", reason: "usage_unresolved" });
    expect(await snapshot(f)).toEqual(before);
    expect(before).toMatchObject({ attempts: 1, opReserved: "0.03", dayReserved: "0.03", status: "OPEN" });
  });

  it("deadline/policy/day changes cannot renew a durable operation or create a new budget bucket", async () => {
    const f = fixture(); await settleFirst(f); const before = await snapshot(f);
    expect(await recoverManagedProviderOperation(f.policy, { ...f.original, deadlineAt: f.original.deadlineAt + 1000 }))
      .toEqual({ status: "held", reason: "policy_mismatch" });
    expect(await recoverManagedProviderOperation({ ...f.policy, pricingRevision: "different-price" }, f.original))
      .toEqual({ status: "held", reason: "policy_mismatch" });
    expect(await recoverManagedProviderOperation(f.policy, { ...f.original, dayKey: "1999-01-01" }))
      .toEqual({ status: "held", reason: "day_changed" });
    expect(await snapshot(f)).toEqual(before);
    expect(await prisma.aiProviderDailyBudget.count({ where: { policyKey: f.policy.policyKey } })).toBe(1);
    expect(await prisma.aiProviderOperation.count({ where: { policyKey: f.policy.policyKey } })).toBe(1);
  });

  it("an expired or cancelled original request cannot obtain a renewed operation", async () => {
    const f = fixture(); await settleFirst(f); const before = await snapshot(f);
    const now = vi.spyOn(Date, "now").mockReturnValue(f.original.deadlineAt);
    try {
      expect(await recoverManagedProviderOperation(f.policy, f.original)).toEqual({ status: "held", reason: "expired" });
    } finally { now.mockRestore(); }
    const abort = new AbortController(); abort.abort();
    expect(await recoverManagedProviderOperation(f.policy, { ...f.original, signal: abort.signal }))
      .toEqual({ status: "held", reason: "cancelled" });
    expect(await snapshot(f)).toEqual(before);
  });

  it("attempt exhaustion, CLOSED and missing IDs never manufacture a new OPEN operation", async () => {
    const f = fixture(1); await settleFirst(f);
    expect(await recoverManagedProviderOperation(f.policy, f.original)).toEqual({ status: "held", reason: "attempt_budget" });
    await f.operation.close();
    expect(await recoverManagedProviderOperation(f.policy, f.original)).toEqual({ status: "held", reason: "operation_not_open" });
    expect(await recoverManagedProviderOperation(f.policy, { ...f.original, operationId: randomUUID() }))
      .toEqual({ status: "held", reason: "missing" });
    expect((await snapshot(f))).toMatchObject({ attempts: 1, status: "CLOSED", opReserved: "0", dayReserved: "0" });
    expect(await prisma.aiProviderOperation.count({ where: { policyKey: f.policy.policyKey } })).toBe(1);
  });
});

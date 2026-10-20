import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { createProviderOperation, createRecoveredProviderOperation, type ProviderOperation, providerDayKey, providerDayDeadline, type ProviderAccountant, type ProviderAttemptSpec, type ProviderAttemptRecord, type ProviderApi, type ProviderAdapter, type ProviderUsage } from "./providerContract.js";
export { providerDayKey } from "./providerContract.js";
import { createGeminiCapabilityRegistry, type GeminiCapabilityProfile } from "./geminiCapabilities.js";
import { GEMINI_MANAGED_TOOLS_USAGE_PROTOCOL, decodeManagedGeminiToolsUsage } from "./geminiManagedToolsUsage.js";
import { GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL, decodeManagedGeminiMediaUsage } from "./geminiManagedMedia.js";
import { geminiReportedUsage } from "./providerContract.js";

const SCALE = 1_000_000_000n;
/** Exact nanodollars, matching Decimal(18,9). No price/cap default lives here. */
export function providerUsdUnits(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,9})?$/.test(value)) throw new TypeError("Invalid USD amount");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(9, "0"));
}
export function providerUsdString(value: bigint): string {
  if (value < 0n) throw new TypeError("Negative USD amount");
  return `${value / SCALE}.${(value % SCALE).toString().padStart(9, "0")}`;
}
export interface ProviderRate {
  model: string; api: ProviderApi; adapter: ProviderAdapter;
  inputUsdPerMillion: string; outputUsdPerMillion: string;
  thinkingUsdPerMillion: string; cacheReadUsdPerMillion: string;
}
export interface ProviderBudgetPolicy {
  /** Server approval only. No settings/env/customer/model auto-enablement. */
  enabled: boolean;
  policyKey: string;
  maxOperationUsd: string;
  /** Explicit null observes daily cost/reservations without a daily ceiling.
   * Operation/attempt/deadline limits remain enforced. No default/auto-enable. */
  maxDailyUsd: string | null;
  maxAttemptUsd: string;
  maxAttempts: number;
  profileRevision: string;
  pricingRevision: string;
  pricingSource: "reference" | "estimate";
  rates: readonly ProviderRate[];
  profiles: readonly GeminiCapabilityProfile[];
  /** Closed, original policy protocol. Absent must not upgrade old ledger rows. */
  usageProtocol?: typeof GEMINI_MANAGED_TOOLS_USAGE_PROTOCOL | typeof GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL;
}

/** This is a policy-rate calculation, NEVER a provider invoice. Missing usage
 * or unpriced components remain unknown; cache creation/storage/search/audio/image
 * deliberately have no manufactured text-only rate in this adapter. */
export function calculateProviderCost(policy: Pick<ProviderBudgetPolicy, "rates" | "pricingSource" | "usageProtocol">,
  spec: Pick<ProviderAttemptSpec, "model" | "api" | "adapter" | "features">, usage: ProviderUsage): bigint | null {
  const media = !!spec.features?.images || !!spec.features?.modalities?.length;
  if (media && (policy.usageProtocol !== GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL || spec.model !== "gemini-3.6-flash" ||
      spec.adapter !== "tools") || usage.completeness !== "complete" || spec.api !== "generateContent" ||
      !["text", "tools"].includes(spec.adapter) || usage.audioInputTokens !== null || usage.audioOutputTokens !== null || usage.searchUnits !== null) return null;
  const rate = policy.rates.find(row => row.model === spec.model && row.api === spec.api && row.adapter === spec.adapter);
  if (!rate || usage.inputTokens === null || usage.outputTokens === null || usage.thinkingTokens === null || usage.cacheReadTokens === null) return null;
  const numerator = BigInt(usage.inputTokens) * providerUsdUnits(rate.inputUsdPerMillion) +
    BigInt(usage.outputTokens) * providerUsdUnits(rate.outputUsdPerMillion) +
    BigInt(usage.thinkingTokens) * providerUsdUnits(rate.thinkingUsdPerMillion) +
    BigInt(usage.cacheReadTokens) * providerUsdUnits(rate.cacheReadUsdPerMillion);
  const cost = (numerator + 999_999n) / 1_000_000n;
  return cost <= 999_999_999_999_999_999n ? cost : null;
}
type AmountRow = { reserved: string; settled: string; cap: string | null };
type OperationRow = AmountRow & { status: string; policyHash: string; attemptsReserved: number; deadlineAt: Date; dayKey: string; policyKey: string; maxAttempts: number };
type AttemptRow = { id: string; state: string | null; reserved: string | null; model: string | null; api: string | null; profileRevision: string | null; pricingRevision: string | null };
const sameDailyCap = (stored: string | null, approved: bigint | null): boolean =>
  approved === null ? stored === null : stored !== null && providerUsdUnits(stored) === approved;

/** Sole durable accountant for explicit managed operations. SQL is bounded and
 * transaction-only; no provider call, customer identity or prompt is stored. */
type ManagedProviderOperationInput = { operationId?: string; deadlineAt: number; signal?: AbortSignal };
function prepareManagedProviderPolicy(rawPolicy: ProviderBudgetPolicy) {
  const policy = structuredClone(rawPolicy);
  if (Object.hasOwn(policy, "usageProtocol") && policy.usageProtocol !== GEMINI_MANAGED_TOOLS_USAGE_PROTOCOL && policy.usageProtocol !== GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL) {
    throw new TypeError("Unsupported provider usage protocol");
  }
  if (!policy.enabled || !policy.policyKey.trim() || policy.policyKey.length > 200 || !policy.profileRevision.trim() || !policy.pricingRevision.trim()) {
    throw new TypeError("Managed provider policy is disabled or incomplete");
  }
  const maxOperation = providerUsdUnits(policy.maxOperationUsd);
  const dailyCap = policy.maxDailyUsd === null ? null : providerUsdUnits(policy.maxDailyUsd);
  const reserve = providerUsdUnits(policy.maxAttemptUsd);
  if (reserve <= 0n || reserve > maxOperation || (dailyCap !== null && maxOperation > dailyCap)) throw new TypeError("Invalid explicit provider caps");
  for (const rate of policy.rates) {
    providerUsdUnits(rate.inputUsdPerMillion); providerUsdUnits(rate.outputUsdPerMillion);
    providerUsdUnits(rate.thinkingUsdPerMillion); providerUsdUnits(rate.cacheReadUsdPerMillion);
  }
  if (new Set(policy.rates.map(rate => `${rate.model}:${rate.api}:${rate.adapter}`)).size !== policy.rates.length) throw new TypeError("Duplicate provider rate");
  const registry = createGeminiCapabilityRegistry(policy.profiles);
  return { policy, maxOperation, dailyCap, reserve, registry };
}
export function createManagedProviderOperation(rawPolicy: ProviderBudgetPolicy, input: ManagedProviderOperationInput) {
  return buildManagedProviderOperation(rawPolicy, input, 0);
}
function buildManagedProviderOperation(rawPolicy: ProviderBudgetPolicy, input: ManagedProviderOperationInput, completedAttempts: number) {
  const { policy, maxOperation, dailyCap, reserve, registry } = prepareManagedProviderPolicy(rawPolicy);
  const operationId = input.operationId ?? randomUUID(), now = new Date(), dayKey = providerDayKey(now);
  const deadlineAt = providerDayDeadline(input.deadlineAt, now);
  const policyHash = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  const reservation = providerUsdString(reserve), maxCost = providerUsdString(maxOperation);
  const cap = dailyCap === null ? null : providerUsdString(dailyCap);
  const accountant: ProviderAccountant = {
    async close(id) {
      if (id !== operationId) throw new Error("Provider operation mismatch");
      await prisma.$executeRaw`UPDATE "AiProviderOperation" SET "status"=CASE WHEN "reservedUsd">0 THEN 'HELD' ELSE 'CLOSED' END,"updatedAt"=NOW()
        WHERE "id"=${operationId} AND "policyHash"=${policyHash} AND "status"='OPEN'`;
    },
    async reserve(spec) {
      if (spec.operationId !== operationId || spec.deadlineAt !== deadlineAt || Date.now() >= deadlineAt || spec.pricingRevision !== policy.pricingRevision ||
          providerDayKey() !== dayKey || input.signal?.aborted || !registry.supports(spec)) return false;
      return prisma.$transaction(async tx => {
        // Deterministic lock order: daily budget, operation, attempt. A new
        // AgentRevision never changes the stable billing policyKey/day bucket.
        await tx.$executeRaw`INSERT INTO "AiProviderDailyBudget" ("id","policyKey","dayKey","capUsd","reservedUsd","settledUsd","createdAt","updatedAt")
          VALUES (${randomUUID()},${policy.policyKey},${dayKey},${cap}::numeric,0,0,NOW(),NOW()) ON CONFLICT ("policyKey","dayKey") DO NOTHING`;
        const [daily] = await tx.$queryRaw<AmountRow[]>`SELECT "reservedUsd"::text AS reserved,"settledUsd"::text AS settled,"capUsd"::text AS cap
          FROM "AiProviderDailyBudget" WHERE "policyKey"=${policy.policyKey} AND "dayKey"=${dayKey} FOR UPDATE`;
        if (!daily || !sameDailyCap(daily.cap, dailyCap) || (dailyCap !== null &&
            providerUsdUnits(daily.reserved) + providerUsdUnits(daily.settled) + reserve > dailyCap)) return false;
        await tx.$executeRaw`INSERT INTO "AiProviderOperation" ("id","policyKey","policyHash","dayKey","deadlineAt","maxAttempts","attemptsReserved","maxCostUsd","reservedUsd","settledUsd","status","createdAt","updatedAt")
          VALUES (${operationId},${policy.policyKey},${policyHash},${dayKey},${new Date(deadlineAt)},${policy.maxAttempts},0,${maxCost}::numeric,0,0,'OPEN',NOW(),NOW()) ON CONFLICT ("id") DO NOTHING`;
        const [op] = await tx.$queryRaw<OperationRow[]>`SELECT "reservedUsd"::text AS reserved,"settledUsd"::text AS settled,"maxCostUsd"::text AS cap,
          "status","policyHash","attemptsReserved","deadlineAt","dayKey","policyKey","maxAttempts" FROM "AiProviderOperation" WHERE "id"=${operationId} FOR UPDATE`;
        if (!op || op.status !== "OPEN" || op.policyHash !== policyHash || op.dayKey !== dayKey || op.policyKey !== policy.policyKey ||
            op.maxAttempts !== policy.maxAttempts || op.deadlineAt.getTime() !== deadlineAt || op.cap === null || providerUsdUnits(op.cap) !== maxOperation ||
            op.attemptsReserved >= policy.maxAttempts || spec.attemptNo !== op.attemptsReserved + 1 ||
            providerUsdUnits(op.reserved) + providerUsdUnits(op.settled) + reserve > maxOperation) return false;
        if (input.signal?.aborted || Date.now() >= deadlineAt || providerDayKey() !== dayKey) return false;
        await tx.$executeRaw`INSERT INTO "AiLog" ("id","endpoint","model","ms","ok","operationId","attemptNo","provider","api","profileRevision","pricingRevision",
          "attemptState","usageSource","usageCompleteness","costStatus","reservedUsd","createdAt") VALUES
          (${randomUUID()},${spec.endpoint},${spec.model},0,false,${operationId},${spec.attemptNo},${spec.provider},${spec.api},${spec.profileRevision},${spec.pricingRevision ?? null},
          'STARTED','MISSING','MISSING','UNKNOWN',${reservation}::numeric,NOW())`;
        await tx.$executeRaw`UPDATE "AiProviderOperation" SET "attemptsReserved"="attemptsReserved"+1,"reservedUsd"="reservedUsd"+${reservation}::numeric,"updatedAt"=NOW() WHERE "id"=${operationId}`;
        await tx.$executeRaw`UPDATE "AiProviderDailyBudget" SET "reservedUsd"="reservedUsd"+${reservation}::numeric,"updatedAt"=NOW() WHERE "policyKey"=${policy.policyKey} AND "dayKey"=${dayKey}`;
        return true;
      }, { maxWait: 3000, timeout: 5000 });
    },
    async settle(record: ProviderAttemptRecord) {
      if (record.operationId !== operationId) throw new Error("Provider operation mismatch");
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "AiProviderDailyBudget" WHERE "policyKey"=${policy.policyKey} AND "dayKey"=${dayKey} FOR UPDATE`;
        const [op] = await tx.$queryRaw<{ policyHash: string }[]>`SELECT "policyHash" FROM "AiProviderOperation" WHERE "id"=${operationId} FOR UPDATE`;
        if (!op || op.policyHash !== policyHash) throw new Error("Provider policy changed");
        const [attempt] = await tx.$queryRaw<AttemptRow[]>`SELECT "id","attemptState" AS state,"reservedUsd"::text AS reserved,"model","api","profileRevision","pricingRevision"
          FROM "AiLog" WHERE "operationId"=${operationId} AND "attemptNo"=${record.attemptNo} FOR UPDATE`;
        if (!attempt || attempt.model !== record.model || attempt.api !== record.api || attempt.profileRevision !== record.profileRevision ||
            attempt.pricingRevision !== (record.pricingRevision ?? null)) throw new Error("Provider attempt changed");
        if (attempt.state === "SETTLED") return;
        const cost = calculateProviderCost(policy, record, record.usage);
        const costString = cost === null ? null : providerUsdString(cost), heldReserve = providerUsdUnits(attempt.reserved ?? "0");
        const usage = record.usage;
        const sum = [usage.inputTokens, usage.outputTokens, usage.thinkingTokens, usage.cacheReadTokens].every(value => value !== null)
          ? usage.inputTokens! + usage.outputTokens! + usage.thinkingTokens! + usage.cacheReadTokens! : null;
        const total = sum !== null && sum <= 2_147_483_647 ? sum : null;
        const legacyCost = cost !== null && cost <= 999_999_999_999_000n ? costString : null;
        await tx.$executeRaw`UPDATE "AiLog" SET "attemptState"=${cost === null ? "UNKNOWN" : "SETTLED"},"usageSource"=${usage.source.toUpperCase()},
          "usageCompleteness"=${usage.completeness.toUpperCase()},"costStatus"=${cost === null ? "UNKNOWN" : policy.pricingSource === "estimate" ? "ESTIMATED" : "CALCULATED"},
          "inputTokens"=${usage.inputTokens},"outputTokens"=${usage.outputTokens},"thinkingTokens"=${usage.thinkingTokens},"cacheReadTokens"=${usage.cacheReadTokens},
          "audioInputTokens"=${usage.audioInputTokens},"audioOutputTokens"=${usage.audioOutputTokens},"searchUnits"=${usage.searchUnits},
          "tokens"=${total},"costUsd"=${legacyCost}::numeric,"settledUsd"=${costString}::numeric,"providerOutcome"=${record.outcome},
          "ms"=${Math.min(2_147_483_647, record.elapsedMs)},"ok"=${record.outcome === "success"} WHERE "id"=${attempt.id}`;
        if (cost === null) {
          // Continue only within this SAME operation's remaining approved
          // cumulative reserve/attempt/deadline bounds. close() becomes HELD.
          return; // Missing usage is not a refund; original reservation remains.
        }
        const released = providerUsdString(heldReserve);
        await tx.$executeRaw`UPDATE "AiProviderOperation" SET "reservedUsd"="reservedUsd"-${released}::numeric,"settledUsd"="settledUsd"+${costString}::numeric,
          "status"=CASE WHEN ${cost > heldReserve} THEN 'HELD' ELSE "status" END,"updatedAt"=NOW() WHERE "id"=${operationId}`;
        await tx.$executeRaw`UPDATE "AiProviderDailyBudget" SET "reservedUsd"="reservedUsd"-${released}::numeric,"settledUsd"="settledUsd"+${costString}::numeric,
          "updatedAt"=NOW() WHERE "policyKey"=${policy.policyKey} AND "dayKey"=${dayKey}`;
        if (cost > heldReserve) console.error("[provider-budget] measured cost exceeded approved attempt reserve; operation held");
      }, { maxWait: 3000, timeout: 5000 });
    },
  };
  // Closure captures the original cloned policy/spec; reportUsage has no
  // caller-selected mode. Recovery enters this same factory AFTER exact hash CAS.
  const mediaProtocol = policy.usageProtocol === GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL;
  const decodeUsage = policy.usageProtocol === GEMINI_MANAGED_TOOLS_USAGE_PROTOCOL || mediaProtocol
    ? (raw: unknown, spec: Readonly<ProviderAttemptSpec>): ProviderUsage => {
      const profile = policy.profiles.length === 1 ? policy.profiles[0] : null;
      const qualified = spec.provider === "google" && spec.api === "generateContent" && spec.adapter === "tools" &&
        spec.model === "gemini-3.6-flash" && spec.endpoint === "assistant-tools" &&
        spec.profileRevision === policy.profileRevision && spec.pricingRevision === policy.pricingRevision &&
        spec.maxOutputTokens > 0 && spec.maxOutputTokens <= 2048 && spec.features?.functions === true &&
        spec.features.thinking === "level" && (mediaProtocol || !spec.features.images && !spec.features.modalities?.length) && !spec.features.cache && !spec.features.grounding &&
        !spec.features.structuredReply && !!profile && profile.revision === policy.profileRevision &&
        profile.api === "generateContent" && profile.model === spec.model && profile.adapters.length === 1 &&
        profile.adapters[0] === "tools" && (mediaProtocol ? profile.modalities.includes("text") && (spec.features.modalities ?? []).every(modality => profile.modalities.includes(modality))
          : profile.modalities.length === 1 && profile.modalities[0] === "text") &&
        profile.tools === "function" && profile.thinking === "level" && !profile.explicitCache && !profile.grounding;
      if (qualified) return mediaProtocol ? decodeManagedGeminiMediaUsage(raw) : decodeManagedGeminiToolsUsage(raw).usage;
      return { ...geminiReportedUsage(raw, spec.adapter), completeness: raw == null ? "missing" : "partial" };
    } : undefined;
  const options = { id: operationId, deadlineAt, maxAttempts: policy.maxAttempts, signal: input.signal,
    managed: true, accountant, supports: registry.supports, profileRevision: policy.profileRevision, pricingRevision: policy.pricingRevision, policyHash,
    ...(decodeUsage ? { decodeUsage } : {}) };
  return completedAttempts === 0 ? createProviderOperation(options) : createRecoveredProviderOperation({ ...options, completedAttempts });
}

export type ManagedProviderRecoveryReason = "invalid_request" | "policy_invalid" | "missing" | "policy_mismatch" |
  "day_changed" | "expired" | "cancelled" | "operation_not_open" | "attempt_budget" |
  "attempt_in_flight" | "usage_unresolved" | "inconsistent_ledger" | "storage_unavailable";
export type ManagedProviderRecoveryResult = { status: "ready"; operation: ProviderOperation } |
  { status: "held"; reason: ManagedProviderRecoveryReason };

/** Restore a finite budget context, never a model result/business tool/outbox.
 * No UUID/day/deadline/cap renewal, lease stealing, refund, or provider I/O. */
export async function recoverManagedProviderOperation(rawPolicy: ProviderBudgetPolicy, input: {
  operationId: string; deadlineAt: number; dayKey: string; signal?: AbortSignal;
}): Promise<ManagedProviderRecoveryResult> {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.operationId) ||
      !Number.isSafeInteger(input.deadlineAt) || !/^\d{4}-\d{2}-\d{2}$/.test(input.dayKey)) return { status: "held", reason: "invalid_request" };
  let prepared: ReturnType<typeof prepareManagedProviderPolicy>;
  try {
    prepared = prepareManagedProviderPolicy(rawPolicy);
    if (!Number.isSafeInteger(prepared.policy.maxAttempts) || prepared.policy.maxAttempts < 1 ||
        prepared.policy.maxAttempts > 1000) return { status: "held", reason: "policy_invalid" };
  } catch { return { status: "held", reason: "policy_invalid" }; }
  const { policy, maxOperation, dailyCap } = prepared;
  const policyHash = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  if (input.signal?.aborted) return { status: "held", reason: "cancelled" };
  if (Date.now() >= input.deadlineAt) return { status: "held", reason: "expired" };
  if (input.dayKey !== providerDayKey()) return { status: "held", reason: "day_changed" };
  type Loaded = { status: "loaded"; completedAttempts: number } | Extract<ManagedProviderRecoveryResult, { status: "held" }>;
  let loaded: Loaded;
  try {
    loaded = await prisma.$transaction(async (tx): Promise<Loaded> => {
      // Same existing lock order as reserve/settle. Read-only hydration creates no bucket/row.
      const [daily] = await tx.$queryRaw<AmountRow[]>`SELECT "reservedUsd"::text AS reserved,"settledUsd"::text AS settled,"capUsd"::text AS cap
        FROM "AiProviderDailyBudget" WHERE "policyKey"=${policy.policyKey} AND "dayKey"=${input.dayKey} FOR UPDATE`;
      const [op] = await tx.$queryRaw<OperationRow[]>`SELECT "reservedUsd"::text AS reserved,"settledUsd"::text AS settled,"maxCostUsd"::text AS cap,
        "status","policyHash","attemptsReserved","deadlineAt","dayKey","policyKey","maxAttempts"
        FROM "AiProviderOperation" WHERE "id"=${input.operationId} FOR UPDATE`;
      if (!op) return { status: "held", reason: "missing" };
      if (!daily || !sameDailyCap(daily.cap, dailyCap) || op.cap === null ||
          providerUsdUnits(op.cap) !== maxOperation || op.policyHash !== policyHash || op.policyKey !== policy.policyKey ||
          op.maxAttempts !== policy.maxAttempts || op.deadlineAt.getTime() !== input.deadlineAt || op.dayKey !== input.dayKey) {
        return { status: "held", reason: "policy_mismatch" };
      }
      if (op.status !== "OPEN") return { status: "held", reason: "operation_not_open" };
      if (!Number.isSafeInteger(op.attemptsReserved) || op.attemptsReserved < 0 ||
          op.attemptsReserved > policy.maxAttempts) return { status: "held", reason: "inconsistent_ledger" };
      const rows = await tx.$queryRaw<Array<{ attemptNo: number | null; state: string | null; settled: string | null }>>`
        SELECT "attemptNo","attemptState" AS state,"settledUsd"::text AS settled FROM "AiLog"
        WHERE "operationId"=${input.operationId} ORDER BY "attemptNo" FOR UPDATE`;
      if (rows.length !== op.attemptsReserved || rows.some((row, index) => row.attemptNo !== index + 1)) {
        return { status: "held", reason: "inconsistent_ledger" };
      }
      if (rows.some(row => row.state === "STARTED")) return { status: "held", reason: "attempt_in_flight" };
      if (rows.some(row => row.state === "UNKNOWN")) return { status: "held", reason: "usage_unresolved" };
      if (rows.some(row => row.state !== "SETTLED" || row.settled === null) || providerUsdUnits(op.reserved) !== 0n ||
          rows.reduce((sum, row) => sum + providerUsdUnits(row.settled!), 0n) !== providerUsdUnits(op.settled)) {
        return { status: "held", reason: "inconsistent_ledger" };
      }
      if (op.attemptsReserved >= policy.maxAttempts) return { status: "held", reason: "attempt_budget" };
      return { status: "loaded", completedAttempts: op.attemptsReserved };
    }, { maxWait: 3000, timeout: 5000 });
  } catch { return { status: "held", reason: "storage_unavailable" }; }
  if (loaded.status === "held") return loaded;
  if (input.signal?.aborted) return { status: "held", reason: "cancelled" };
  if (Date.now() >= input.deadlineAt) return { status: "held", reason: "expired" };
  if (input.dayKey !== providerDayKey()) return { status: "held", reason: "day_changed" };
  return { status: "ready", operation: buildManagedProviderOperation(policy,
    { operationId: input.operationId, deadlineAt: input.deadlineAt, signal: input.signal }, loaded.completedAttempts) };
}

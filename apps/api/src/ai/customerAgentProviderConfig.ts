// Server-only configuration shapes. No registration, provider I/O or activation.
// An explicit caller must validate archived identity/time before binding the runtime.
import { createHash } from "node:crypto";
import { z } from "zod";
import { frozenGeminiRuntimeProfileSchema, frozenGeminiRuntimeProfileHash } from "./geminiOperationRuntime.js";
import type { ProviderBudgetPolicy } from "./providerBudget.js";
import { GEMINI_MANAGED_TOOLS_USAGE_PROTOCOL } from "./geminiManagedToolsUsage.js";
import { GEMINI_FUNCTION_DECLARATION_PROTOCOL } from "./geminiFunctionDeclarations.js";
import { GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL, GEMINI_MANAGED_MEDIA_MAX_WIRE_BYTES } from "./geminiManagedMedia.js";

const usd = z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,9})?$/);
const rate = z.object({ model: z.literal("gemini-3.6-flash"), api: z.literal("generateContent"), adapter: z.literal("tools"),
  inputUsdPerMillion: usd, outputUsdPerMillion: usd, thinkingUsdPerMillion: usd, cacheReadUsdPerMillion: usd }).strict();
export const customerAgentProviderSnapshotSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  configRevision: z.enum(["royal-customer-g36-tools-20261015-v1", "royal-customer-g36-tools-20261015-v2", "royal-customer-g36-media-20261017-v3"]),
  profile: frozenGeminiRuntimeProfileSchema,
  budget: z.object({ enabled: z.literal(true), policyKey: z.literal("royal-customer-gemini"),
    maxOperationUsd: usd, maxDailyUsd: z.null(), maxAttemptUsd: usd, maxAttempts: z.literal(4),
    pricingRevision: z.literal("google-standard-reference-20261015-through-20261231-v1"),
    pricingSource: z.literal("reference"), rates: z.array(rate).length(1),
    usageProtocol: z.enum([GEMINI_MANAGED_TOOLS_USAGE_PROTOCOL, GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL]).optional() }).strict(),
  wire: z.object({ api: z.literal("generateContent"), model: z.literal("gemini-3.6-flash"),
    thinkingLevel: z.literal("minimal"), maxOutputTokens: z.literal(2048),
    maxUtf8RequestBytes: z.union([z.literal(131072), z.literal(GEMINI_MANAGED_MEDIA_MAX_WIRE_BYTES)]), maxCountedInputTokens: z.literal(32768),
    countTokensRequired: z.literal(true), countTimeoutMs: z.union([z.literal(2000), z.literal(8000)]),
    maxCountRequests: z.literal(4), functionDeclarationProtocol: z.literal(GEMINI_FUNCTION_DECLARATION_PROTOCOL).optional(),
    explicitCache: z.literal(false),
    grounding: z.literal(false), media: z.boolean(),
    validFrom: z.literal("2026-10-15T00:00:00Z"), validUntil: z.literal("2027-01-01T00:00:00Z") }).strict(),
  turn: z.object({ maxRounds: z.literal(3), maxToolCalls: z.literal(4), maxInputChars: z.literal(64000),
    maxOutputChars: z.literal(3000), deadlineMs: z.literal(120000) }).strict(),
}).strict().superRefine((value, ctx) => {
  const p = value.profile;
  const v2 = value.version >= 2, media = value.version === 3;
  const protocol = media ? GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL : GEMINI_MANAGED_TOOLS_USAGE_PROTOCOL;
  const expectedRevision = media ? "royal-customer-g36-media-20261017-v3" : `royal-customer-g36-tools-20261015-v${value.version}`;
  if (value.configRevision !== expectedRevision || value.wire.media !== media ||
      value.wire.maxUtf8RequestBytes !== (media ? GEMINI_MANAGED_MEDIA_MAX_WIRE_BYTES : 131072) ||
      value.wire.countTimeoutMs !== (media ? 8000 : 2000) ||
      (v2 ? p.usageProtocol !== protocol || value.budget.usageProtocol !== protocol
        : Object.hasOwn(p, "usageProtocol") || Object.hasOwn(value.budget, "usageProtocol"))) {
    ctx.addIssue({ code: "custom", message: "Original usage protocol/archive version mismatch" });
  }
  const count = p.countTokens;
  if (v2 ? count?.functionDeclarationProtocol !== GEMINI_FUNCTION_DECLARATION_PROTOCOL ||
      value.wire.functionDeclarationProtocol !== GEMINI_FUNCTION_DECLARATION_PROTOCOL
    : Object.hasOwn(count ?? {}, "functionDeclarationProtocol") || Object.hasOwn(value.wire, "functionDeclarationProtocol")) {
    ctx.addIssue({ code: "custom", message: "Original function declaration protocol/archive mismatch" });
  }
  if (!count || count.version !== 1 || count.maxUtf8RequestBytes !== value.wire.maxUtf8RequestBytes ||
      count.maxCountedInputTokens !== value.wire.maxCountedInputTokens || count.timeoutMs !== value.wire.countTimeoutMs ||
      count.maxRequests !== value.wire.maxCountRequests || count.maxOutputTokens !== value.wire.maxOutputTokens ||
      count.thinkingLevel !== value.wire.thinkingLevel) ctx.addIssue({ code: "custom", message: "Exact counted wire profile required" });
  if (p.profileRevision !== value.configRevision || p.runtime.model !== value.wire.model || p.runtime.fallbackModels.length ||
      p.runtime.explicitCaching || p.runtime.liteModel !== "" || p.capabilities.length !== 1) {
    ctx.addIssue({ code: "custom", message: "Exact customer runtime/profile mismatch" });
  }
  const c = p.capabilities[0];
  if (!c || c.revision !== p.profileRevision || c.model !== value.wire.model || c.api !== value.wire.api ||
      c.adapters.length !== 1 || c.adapters[0] !== "tools" || JSON.stringify(c.modalities) !== JSON.stringify(media ? ["text", "image", "audio", "video", "document"] : ["text"]) ||
      c.tools !== "function" || c.structuredReply || c.thinking !== "level" || c.explicitCache || c.grounding || c.maxOutputTokens !== 2048) {
    ctx.addIssue({ code: "custom", message: "Unqualified customer capability" });
  }
  const r = value.budget.rates[0];
  if (r.inputUsdPerMillion !== "0.75" || r.outputUsdPerMillion !== "3.75" || r.thinkingUsdPerMillion !== "3.75" ||
      r.cacheReadUsdPerMillion !== "0.075" || value.budget.maxAttemptUsd !== "0.032256000" ||
      value.budget.maxOperationUsd !== "0.129024000") ctx.addIssue({ code: "custom", message: "Reference reserve/rate mismatch" });
});
export type CustomerAgentProviderSnapshot = z.infer<typeof customerAgentProviderSnapshotSchema>;
function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
export function decodeCustomerAgentProviderSnapshot(raw: unknown): Readonly<CustomerAgentProviderSnapshot> {
  return freezeTree(customerAgentProviderSnapshotSchema.parse(structuredClone(raw)));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  const result = JSON.stringify(value); if (result === undefined) throw new TypeError("Non-JSON provider snapshot"); return result;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** The property order below is deliberate: EXISTING providerBudget SHA256(JSON.stringify(policy))
 * compatibility. Do not substitute canonical snapshotHash for the budget ledger policyHash. */
export function customerAgentProviderBudgetPolicy(value: CustomerAgentProviderSnapshot): ProviderBudgetPolicy {
  return { enabled: value.budget.enabled, policyKey: value.budget.policyKey,
    maxOperationUsd: value.budget.maxOperationUsd, maxDailyUsd: value.budget.maxDailyUsd,
    maxAttemptUsd: value.budget.maxAttemptUsd, maxAttempts: value.budget.maxAttempts,
    profileRevision: value.profile.profileRevision, pricingRevision: value.budget.pricingRevision,
    pricingSource: value.budget.pricingSource, rates: structuredClone(value.budget.rates),
    profiles: structuredClone(value.profile.capabilities),
    ...(value.version >= 2 ? { usageProtocol: value.budget.usageProtocol! } : {}) };
}
export function customerAgentProviderIdentities(raw: unknown) {
  const snapshot = customerAgentProviderSnapshotSchema.parse(raw);
  const policy = customerAgentProviderBudgetPolicy(snapshot);
  return { snapshotHash: hash(canonicalJson(snapshot)),
    providerProfileHash: frozenGeminiRuntimeProfileHash(snapshot.profile),
    providerPolicyHash: hash(JSON.stringify(policy)) };
}

/** Explicit construction only. Exporting this snapshot does not select/register
 * it for customers, approve a new capability, resolve keys or mutate Settings. */
export function createCustomerAgentProviderSnapshot(): Readonly<CustomerAgentProviderSnapshot> {
  const revision = "royal-customer-g36-tools-20261015-v2";
  return decodeCustomerAgentProviderSnapshot({
    version: 2, configRevision: revision,
    profile: { version: 1, profileRevision: revision, usageProtocol: GEMINI_MANAGED_TOOLS_USAGE_PROTOCOL,
      runtime: { model: "gemini-3.6-flash", fallbackModels: [], transcribeModels: [],
        imageModel: "gemini-3-pro-image", liteModel: "", explicitCaching: false },
      capabilities: [{ revision, model: "gemini-3.6-flash", api: "generateContent", adapters: ["tools"],
        modalities: ["text"], tools: "function", structuredReply: false, thinking: "level",
        explicitCache: false, grounding: false, maxOutputTokens: 2048 }],
      countTokens: { version: 1, maxUtf8RequestBytes: 131072, maxCountedInputTokens: 32768, timeoutMs: 2000,
        maxRequests: 4, maxOutputTokens: 2048, thinkingLevel: "minimal",
        functionDeclarationProtocol: GEMINI_FUNCTION_DECLARATION_PROTOCOL } },
    budget: { enabled: true, policyKey: "royal-customer-gemini", maxOperationUsd: "0.129024000", maxDailyUsd: null,
      maxAttemptUsd: "0.032256000", maxAttempts: 4,
      pricingRevision: "google-standard-reference-20261015-through-20261231-v1", pricingSource: "reference",
      rates: [{ model: "gemini-3.6-flash", api: "generateContent", adapter: "tools", inputUsdPerMillion: "0.75",
        outputUsdPerMillion: "3.75", thinkingUsdPerMillion: "3.75", cacheReadUsdPerMillion: "0.075" }],
      usageProtocol: GEMINI_MANAGED_TOOLS_USAGE_PROTOCOL },
    wire: { api: "generateContent", model: "gemini-3.6-flash", thinkingLevel: "minimal", maxOutputTokens: 2048,
      maxUtf8RequestBytes: 131072, maxCountedInputTokens: 32768, countTokensRequired: true, countTimeoutMs: 2000,
      maxCountRequests: 4, functionDeclarationProtocol: GEMINI_FUNCTION_DECLARATION_PROTOCOL,
      explicitCache: false, grounding: false, media: false,
      validFrom: "2026-10-15T00:00:00Z", validUntil: "2027-01-01T00:00:00Z" },
    turn: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 64000, maxOutputChars: 3000, deadlineMs: 120000 },
  });
}

/** Separate explicit capability upgrade. Never mutates a previously archived
 * text profile or spends a larger per-attempt/operation budget. */
export function createCustomerAgentMediaProviderSnapshot(): Readonly<CustomerAgentProviderSnapshot> {
  const prior = structuredClone(createCustomerAgentProviderSnapshot());
  const revision = "royal-customer-g36-media-20261017-v3";
  return decodeCustomerAgentProviderSnapshot({ ...prior, version: 3, configRevision: revision,
    profile: { ...prior.profile, profileRevision: revision, usageProtocol: GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL,
      capabilities: prior.profile.capabilities.map(row => ({ ...row, revision, modalities: ["text", "image", "audio", "video", "document"] })),
      countTokens: { ...prior.profile.countTokens!, maxUtf8RequestBytes: GEMINI_MANAGED_MEDIA_MAX_WIRE_BYTES, timeoutMs: 8000 } },
    budget: { ...prior.budget, usageProtocol: GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL },
    wire: { ...prior.wire, media: true, maxUtf8RequestBytes: GEMINI_MANAGED_MEDIA_MAX_WIRE_BYTES, countTimeoutMs: 8000 } });
}

/** Deliberately narrow owner-approved upgrade: same model/rates/budget/tools,
 * same knowledge and business permissions are checked independently by caller. */
export function isCustomerAgentMediaProfileUpgrade(prior: unknown, next: unknown): boolean {
  const old = customerAgentProviderSnapshotSchema.safeParse(prior), replacement = customerAgentProviderSnapshotSchema.safeParse(next);
  return old.success && replacement.success && canonicalJson(old.data) === canonicalJson(createCustomerAgentProviderSnapshot()) &&
    canonicalJson(replacement.data) === canonicalJson(createCustomerAgentMediaProviderSnapshot());
}

/** Archive validation only, not an execution/customer authority. The immutable
 * manifest hash pair comes from the original pinned AgentRevision, never model JSON. */
export function loadCustomerAgentProviderSnapshot(raw: unknown, expected: {
  snapshotHash: string; providerProfileHash: string; providerPolicyHash: string; nowMs: number;
}): Readonly<CustomerAgentProviderSnapshot> {
  const value = decodeCustomerAgentProviderSnapshot(raw), identity = customerAgentProviderIdentities(value);
  if (!Number.isSafeInteger(expected.nowMs) || expected.nowMs < Date.parse(value.wire.validFrom) ||
      expected.nowMs >= Date.parse(value.wire.validUntil)) throw new TypeError("Provider snapshot outside its original validity window");
  if (identity.snapshotHash !== expected.snapshotHash || identity.providerProfileHash !== expected.providerProfileHash ||
      identity.providerPolicyHash !== expected.providerPolicyHash) throw new TypeError("Pinned provider snapshot mismatch");
  return value;
}

// Expected counted-response boundary. Unknown scalar/property fields are rejected by default;
// modality detail fields may be added only after endpoint-specific schema/fixture review.
export const customerAgentCountResponseSchema = z.object({
  totalTokens: z.number().int().nonnegative().max(1048576),
  cachedContentTokenCount: z.number().int().nonnegative().max(1048576).optional(),
  promptTokensDetails: z.array(z.object({ modality: z.literal("TEXT"), tokenCount: z.number().int().nonnegative() }).strict()).max(1).optional(),
  cacheTokensDetails: z.array(z.object({ modality: z.literal("TEXT"), tokenCount: z.number().int().nonnegative() }).strict()).max(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.totalTokens > 32768 || (value.cachedContentTokenCount ?? 0) !== 0 || value.cacheTokensDetails?.length) {
    ctx.addIssue({ code: "custom", message: "Unqualified counted request/cache" });
  }
  if ((value.promptTokensDetails?.reduce((sum, row) => sum + row.tokenCount, 0) ?? 0) > value.totalTokens) {
    ctx.addIssue({ code: "custom", message: "Inconsistent counted token details" });
  }
});

// Minimal future wire ABI ONLY, not a new engine/implemented grant factory.
// Prepare the actual tools body ONCE in callGeminiToolsOnce (before reserve/POST).
// Count {generateContentRequest:{model:`models/${model}`,...sameBody}}, NOT contents-only.
// Keep exact full system/tools/opaque original thought Parts/function results in sameBody.
// Measure Buffer.byteLength(JSON.stringify(sameBody),"utf8") <= maxUtf8RequestBytes;
// this is a memory/size guard, NEVER a token/financial proof.
// Counted witness is WeakMap-only, bound to UUID/day/deadline/profile+policy hashes,
// model/key-binding identity, exact UTF8 body digest, original deadline, local consumed bit.
// Before count: controller/current IN+facts and begin the durable P13 attempt/reservation FIRST.
// Its ordinal also bounds count substeps across crash/restart; do not add a RAM-only retry counter.
// Count failure retains the unconfirmed reserve (no manufactured provider usage/refund).
// After await: original abort/time/controller+same digest.
// Before each physical generate POST: require/consume SAME attempt-bound witness and
// fresh original OUT proof. No await may rebuild body or change thinking/cache/model afterwards.
// Timeout/invalid count/body change => HELD, no generate POST/no zero-cost assumption.
// Every retry/round needs its own <=2s count, total <=4; deadline is never renewed.

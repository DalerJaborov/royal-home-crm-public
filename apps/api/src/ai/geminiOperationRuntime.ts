import { createHash } from "node:crypto";
import { z } from "zod";
import { resolveGeminiRuntime, type GeminiRuntime } from "./geminiSettings.js";
import { ProviderOperationError, type ProviderOperation } from "./providerContract.js";
import { createGeminiCapabilityRegistry } from "./geminiCapabilities.js";
import { geminiGenerateUrlFor, geminiProxyHeaders } from "./geminiTransport.js";
import { GEMINI_MANAGED_TOOLS_USAGE_PROTOCOL } from "./geminiManagedToolsUsage.js";
import { GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL, GEMINI_MANAGED_MEDIA_MAX_WIRE_BYTES } from "./geminiManagedMedia.js";
import { GEMINI_FUNCTION_DECLARATION_PROTOCOL } from "./geminiFunctionDeclarations.js";

const operationRuntimes = new WeakMap<ProviderOperation, { runtime: Promise<GeminiRuntime>; binding?: Readonly<GeminiRuntimeBindingIdentity>; count?: Readonly<BoundGeminiCountContext> }>();
const runtimeName = z.string().trim().min(1).max(200);
/** Public server configuration only. Credentials never enter the manifest hash.
 * Parsing/content identity does NOT approve capabilities, money or an actor. */
export const frozenGeminiRuntimeProfileSchema = z.object({
  version: z.literal(1), profileRevision: runtimeName,
  usageProtocol: z.enum([GEMINI_MANAGED_TOOLS_USAGE_PROTOCOL, GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL]).optional(),
  runtime: z.object({ model: runtimeName, fallbackModels: z.array(runtimeName).max(20),
    transcribeModels: z.array(runtimeName).max(20), imageModel: runtimeName,
    liteModel: z.string().trim().max(200), explicitCaching: z.boolean() }).strict(),
  capabilities: z.array(z.object({ revision: runtimeName, model: runtimeName,
    api: z.enum(["generateContent", "cachedContents", "bidiGenerateContent", "embedContent"]),
    adapters: z.array(z.enum(["text", "tools", "grounded", "cache", "media", "transcribe", "tts", "embeddings", "live"])).min(1).max(9),
    modalities: z.array(z.enum(["text", "image", "audio", "video", "document"])).min(1).max(5),
    tools: z.enum(["none", "function"]), structuredReply: z.boolean(), thinking: z.enum(["none", "budget", "level"]),
    explicitCache: z.boolean(), grounding: z.boolean(), maxOutputTokens: z.number().int().positive().max(2_147_483_647),
  }).strict()).min(1).max(100),
  countTokens: z.object({ version: z.literal(1), maxUtf8RequestBytes: z.number().int().positive().max(GEMINI_MANAGED_MEDIA_MAX_WIRE_BYTES),
    maxCountedInputTokens: z.number().int().positive().max(32768), timeoutMs: z.number().int().positive().max(8000),
    maxRequests: z.number().int().positive().max(4), maxOutputTokens: z.number().int().positive().max(2048),
    thinkingLevel: z.enum(["minimal", "low"]),
    functionDeclarationProtocol: z.literal(GEMINI_FUNCTION_DECLARATION_PROTOCOL).optional(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.countTokens && (value.countTokens.maxUtf8RequestBytes > 131072 || value.countTokens.timeoutMs > 2000) &&
      value.usageProtocol !== GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL) ctx.addIssue({ code: "custom", message: "Larger media wire requires its original media protocol" });
});
export type FrozenGeminiRuntimeProfile = z.infer<typeof frozenGeminiRuntimeProfileSchema>;
export interface GeminiRuntimeBindingIdentity { profileRevision: string; profileHash: string }
export interface BoundGeminiCountTarget {
  readonly model: string; readonly generateUrl: string; readonly countUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}
export interface BoundGeminiCountContext {
  readonly usageProtocol?: FrozenGeminiRuntimeProfile["usageProtocol"];
  readonly identity: Readonly<GeminiRuntimeBindingIdentity>;
  readonly providerPolicyHash: string;
  readonly policy: Readonly<NonNullable<FrozenGeminiRuntimeProfile["countTokens"]>>;
  readonly operationId: string; readonly deadlineAt: number;
  readonly selectedModels: readonly string[];
  /** Server-issued frozen route/key/header membership, never caller routing.
   * All URLs/proxy headers are captured at binding, before any async work. */
  readonly selectTarget: (model: string, key: string) => Readonly<BoundGeminiCountTarget> | null;
  /** Captured genuine ORIGINAL-IN/facts closure, not supplied by model JSON. */
  readonly assertCurrent: (wait: { signal: AbortSignal; deadlineAt: number }) => Promise<boolean>;
}

function canonicalProfile(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalProfile).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalProfile((value as Record<string, unknown>)[key])}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Non-JSON provider profile");
  return encoded;
}
export function frozenGeminiRuntimeProfileHash(value: unknown): string {
  return createHash("sha256").update(canonicalProfile(frozenGeminiRuntimeProfileSchema.parse(value))).digest("hex");
}
/** Server registration closure supplies already approved content/hash/keys.
 * One binding, BEFORE even starting a settings lookup; no replacement after an
 * await or a retry. Legacy/unbound operations retain their existing behavior. */
export function bindGeminiRuntimeToOperation(operation: ProviderOperation, input: {
  profile: unknown; expectedProfileRevision: string; expectedProfileHash: string; keys: readonly string[];
  countContext?: { expectedProviderPolicyHash: string; assertCurrent: BoundGeminiCountContext["assertCurrent"] };
}): void {
  operation.check();
  if (!operation.managed || operationRuntimes.has(operation)) throw new Error("Provider runtime already used or unmanaged");
  const profile = frozenGeminiRuntimeProfileSchema.parse(structuredClone(input.profile));
  const hash = frozenGeminiRuntimeProfileHash(profile);
  if (profile.profileRevision !== input.expectedProfileRevision || operation.profileRevision !== input.expectedProfileRevision ||
      !/^[a-f0-9]{64}$/.test(input.expectedProfileHash) || hash !== input.expectedProfileHash ||
      profile.capabilities.some(row => row.revision !== profile.profileRevision)) throw new Error("Approved provider profile mismatch");
  const keys = z.array(z.string().min(1).max(8192)).min(1).max(256).parse([...input.keys]);
  const registry = createGeminiCapabilityRegistry(profile.capabilities);
  const models = [profile.runtime.model, ...profile.runtime.fallbackModels];
  if (new Set(models).size !== models.length) throw new TypeError("Duplicate selected provider model");
  for (const model of models) {
    // This binding feeds the customer tools adapter. Actual attempt parameters
    // still pass the ORIGINAL operation registry/accountant before any I/O.
    const spec = { provider: "google" as const, api: "generateContent" as const, adapter: "tools" as const, model,
      profileRevision: profile.profileRevision, pricingRevision: operation.pricingRevision, endpoint: "assistant-tools",
      features: { functions: true }, maxOutputTokens: 1 };
    if (!registry.supports(spec) || !operation.supports(spec)) throw new ProviderOperationError("unsupported");
  }
  const runtime: GeminiRuntime = { ...profile.runtime, keys };
  let count: Readonly<BoundGeminiCountContext> | undefined;
  if (profile.countTokens) {
    const context = input.countContext;
    if (!context || typeof context.assertCurrent !== "function" || !/^[a-f0-9]{64}$/.test(context.expectedProviderPolicyHash) ||
        operation.policyHash !== context.expectedProviderPolicyHash) throw new Error("Counted original policy/context required");
    const selectedModels = Object.freeze([...models]);
    const proxyHeaders = Object.freeze({ ...geminiProxyHeaders() });
    const routes = new Map(selectedModels.map(model => {
      const generateUrl = geminiGenerateUrlFor(model);
      return [model, Object.freeze({ generateUrl, countUrl: generateUrl.replace(/:generateContent$/, ":countTokens") })] as const;
    }));
    const headersByKey = new Map(keys.map(key => [key, Object.freeze({ "Content-Type": "application/json", "x-goog-api-key": key, ...proxyHeaders })] as const));
    const selectTarget = (model: string, key: string): Readonly<BoundGeminiCountTarget> | null => {
      const route = routes.get(model), headers = headersByKey.get(key);
      return route && headers ? Object.freeze({ model, ...route, headers }) : null;
    };
    count = Object.freeze({ ...(profile.usageProtocol ? { usageProtocol: profile.usageProtocol } : {}), identity: Object.freeze({ profileRevision: profile.profileRevision, profileHash: hash }),
      providerPolicyHash: context.expectedProviderPolicyHash, policy: Object.freeze({ ...profile.countTokens }),
      operationId: operation.id, deadlineAt: operation.deadlineAt, selectedModels, selectTarget, assertCurrent: context.assertCurrent });
  } else if (input.countContext) throw new Error("Unexpected counted context on an uncounted profile");
  // The clone is private: neither caller mutation nor later Settings reads can
  // change a selected model, fallback, cache mode or credential on this turn.
  const frozen = structuredClone(runtime);
  Object.freeze(frozen.keys); Object.freeze(frozen.fallbackModels); Object.freeze(frozen.transcribeModels); Object.freeze(frozen);
  operationRuntimes.set(operation, { runtime: Promise.resolve(frozen), binding: Object.freeze({ profileRevision: profile.profileRevision, profileHash: hash }), count });
}
export function isGeminiRuntimeBound(operation: ProviderOperation, expected: GeminiRuntimeBindingIdentity): boolean {
  const bound = operationRuntimes.get(operation)?.binding;
  return !!bound && !operation.stopped && bound.profileRevision === expected.profileRevision && bound.profileHash === expected.profileHash;
}
/** Internal server wire lookup only, never a customer/model authorization. */
export function boundGeminiCountContext(operation: ProviderOperation): Readonly<BoundGeminiCountContext> | null {
  return operationRuntimes.get(operation)?.count ?? null;
}
export function assertBoundGeminiRuntimeKey(operation: ProviderOperation | undefined, runtime: GeminiRuntime, apiKey: string): void {
  if (operation && operationRuntimes.get(operation)?.binding && !runtime.keys.includes(apiKey)) throw new ProviderOperationError("unsupported");
}
export function resolveGeminiOperationRuntime(operation?: ProviderOperation): Promise<GeminiRuntime> {
  if (!operation) return resolveGeminiRuntime();
  let entry = operationRuntimes.get(operation);
  if (!entry) { entry = { runtime: resolveGeminiRuntime().then(value => structuredClone(value)) }; operationRuntimes.set(operation, entry); }
  return entry.runtime;
}
